/**
 * lib/fill.js — 浏览器代填 + 武装窗口。
 *
 * 职责：
 *  1. 解析账号（lib/accounts.js，走 ctx.credentials，只读）；
 *  2. 复用/回退获取浏览器会话（优先 dsh-builtin-browser/tool-browser 的 internals.sessions 只读快照，
 *     回退 ctx.browser.open(taskKey)——回退自开是已知次优，见 README「安全模型」）；
 *  3. 域白名单检查（account.domains 与当前 tab host 后缀匹配）；
 *  4. CAPTCHA 防线：detectChallenge 命中 → 一个字段都不填，返回 needs-human；
 *  5. 逐条 mapping 用 ctx.browser.setValue 注入真值（值只在本插件进程内存中流转）；
 *  6. submit（click selector 或聚焦后 Enter）；
 *  7. 成功后 arm(sessionId, ttl) 开武装窗口（lib/guard.js 据此拦截读取类 browser_* 工具）。
 *
 * 返回值/错误路径绝不含任何凭据值。
 */
import { totp } from './totp.js'
import { hostMatchesDomains } from './accounts.js'

/** 内置浏览器会话快照的模块说明符（生产路径；测试可注入替换） */
const SESSIONS_MODULE = 'dsh-builtin-browser/tool-browser'

/** 从 URL 提取 host（非法 URL 返回 undefined） */
function hostFromUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname || undefined
  } catch {
    return undefined
  }
}

/**
 * 解析浏览器会话：优先复用模型正在用的会话，取不到再回退自开。
 * @param {{ browser?: any }} ctx
 * @param {string} taskKey
 * @param {{ warn?: (msg: string) => void, info?: (msg: string) => void }} logger
 * @returns {Promise<{ sessionId: string, reused: boolean }>}
 */
async function resolveBrowserSession(ctx, taskKey, logger, loadSessionsModule) {
  // 1) 优先：内置浏览器插件导出的只读会话快照（Map<taskKey, sessionId>）
  try {
    const mod = await (loadSessionsModule ? loadSessionsModule() : import(SESSIONS_MODULE))
    const sessions = mod?.internals?.sessions
    if (sessions && typeof sessions.get === 'function') {
      const existing = sessions.get(taskKey)
      if (typeof existing === 'string' && existing.length > 0) {
        return { sessionId: existing, reused: true }
      }
    }
  } catch (err) {
    // 包不存在 / 加载失败 → 回退。记日志，不中断。
    logger.warn?.(`[dsh-accounts] 复用内置浏览器会话失败（${err instanceof Error ? err.message : String(err)}），回退自开浏览器会话`)
  }
  // 2) 回退：自开会话（provider 不按 label 去重，可能产生新会话——已知次优，README 说明）
  const sessionId = await ctx.browser.open(taskKey)
  return { sessionId, reused: false }
}

/**
 * 拿当前 tab 的 URL：listTabs 返回的 tab 对象带 url 字段；拿不到返回 undefined。
 */
async function getCurrentUrl(ctx, sessionId, logger) {
  try {
    const tabs = await ctx.browser.listTabs(sessionId)
    if (Array.isArray(tabs) && tabs.length > 0) {
      const active = /** @type {any[]} */ (tabs).find((t) => t?.active === true) ?? tabs[0]
      if (typeof active?.url === 'string' && active.url.length > 0) {
        return active.url
      }
    }
  } catch (err) {
    logger.warn?.(`[dsh-accounts] listTabs 获取当前 URL 失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  return undefined
}

/**
 * 计算 mapping 单条的真值（绝不出现在任何返回值/日志里）。
 * @returns {string | undefined} 账号没有该字段时返回 undefined
 */
function computeFieldValue(account, field) {
  if (field === 'totp') {
    const secret = account.fields?.totpSecret
    return secret ? totp(secret) : undefined
  }
  return account.fields?.[field]
}

/**
 * 创建代填服务。
 * @param {object} deps
 * @param {any} deps.ctx DSH 插件上下文（用 ctx.browser）
 * @param {ReturnType<import('./accounts.js').createAccountsService>} deps.accounts
 * @param {ReturnType<import('./guard.js').createArmRegistry>} deps.armRegistry
 * @param {{ warn?: (msg: string) => void, info?: (msg: string) => void, error?: (msg: string) => void }} [deps.logger]
 * @param {{ armedWindowMs?: number }} [deps.config]
 * @param {() => Promise<any>} [deps.loadSessionsModule] 测试注入用：替代 import(SESSIONS_MODULE)
 */
export function createFillService({ ctx, accounts, armRegistry, logger = {}, config = {}, loadSessionsModule }) {
  const armedWindowMs = config.armedWindowMs ?? 120000
  /** 同一会话的 fill 串行化链（防并发代填互相踩） */
  const chains = new Map()

  /** @param {string} sessionId @param {() => Promise<any>} fn */
  function serialize(sessionId, fn) {
    const prev = chains.get(sessionId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    chains.set(sessionId, next)
    void next.catch(() => {}).then(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
    return next
  }

  /**
   * 代填入口（结构化错误以 { error } 返回，不抛——避免堆栈/上下文带值泄漏）。
   * @param {object} input
   * @param {string} input.accountId
   * @param {Array<{ selector: string, field: string }>} input.mapping
   * @param {{ selector?: string, key?: 'Enter' }} [input.submit]
   * @param {string} [input.agentId] DSH 会话 id（用于复用其浏览器会话）
   * @param {AbortSignal} [input.signal]
   */
  async function fill({ accountId, mapping, submit, agentId, signal }) {
    // browser 惰性检查：headless profile 没有 browser 服务，此时返回结构化错误（不抛裸异常）
    if (!ctx.browser || typeof ctx.browser.setValue !== 'function') {
      return { error: '浏览器服务在当前部署不可用' }
    }
    if (!Array.isArray(mapping) || mapping.length === 0) {
      return { error: 'mapping 不能为空（至少提供一条 { selector, field }）' }
    }

    // 1. 解析账号
    let account
    try {
      account = await accounts.get(accountId)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!account) {
      const { accounts: all } = await accounts.listSummaries()
      const validIds = all.filter((a) => !('error' in a)).map((a) => /** @type {{id: string}} */ (a).id)
      return {
        error: `账号 "${accountId}" 不存在`,
        availableAccounts: validIds,
      }
    }

    // 2. 浏览器会话（复用优先，回退自开）
    const taskKey = agentId ?? 'default'
    let session
    try {
      session = await resolveBrowserSession(ctx, taskKey, logger, loadSessionsModule)
    } catch (err) {
      return { error: `无法获取浏览器会话: ${err instanceof Error ? err.message : String(err)}` }
    }
    const { sessionId, reused } = session
    logger.info?.(`[dsh-accounts] 浏览器会话: ${reused ? '复用' : '回退自开'} (taskKey=${taskKey})`)

    // 3. 域白名单
    const url = await getCurrentUrl(ctx, sessionId, logger)
    if (url !== undefined) {
      const host = hostFromUrl(url)
      if (account.domains && account.domains.length > 0) {
        if (!host || !hostMatchesDomains(host, account.domains)) {
          return {
            error: `host 不在账号 "${accountId}" 的 domains 白名单（当前 host: ${host ?? '未知'}，白名单: ${account.domains.join('、')}）`,
          }
        }
      }
    } else {
      // 拿不到 URL → 当无域约束处理，但记日志（防御降级，README 说明）
      logger.warn?.(`[dsh-accounts] 无法获取当前页 URL，跳过域白名单检查 (session=${sessionId})`)
    }

    // 4. CAPTCHA 防线：命中人机验证 → 一个字段都不填
    if (typeof ctx.browser.detectChallenge === 'function') {
      try {
        const challenge = await ctx.browser.detectChallenge(sessionId)
        if (challenge) {
          logger.info?.(`[dsh-accounts] 检测到人机验证挑战，跳过代填 (session=${sessionId})`)
          return { challenge: 'needs-human', filled: [] }
        }
      } catch (err) {
        // 检测失败不阻塞代填，但记日志
        logger.warn?.(`[dsh-accounts] detectChallenge 失败（继续代填）: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 5. 逐条映射注入真值
    const filled = []
    const failed = []
    for (const item of mapping) {
      const selector = item?.selector
      const field = item?.field
      if (typeof selector !== 'string' || selector.length === 0 || typeof field !== 'string' || field.length === 0) {
        failed.push({ selector: String(selector ?? ''), reason: 'mapping 项缺少 selector 或 field' })
        continue
      }
      let value
      try {
        value = computeFieldValue(account, field)
      } catch (err) {
        // 例如 totpSecret 非法——错误信息不含值
        failed.push({ selector, reason: err instanceof Error ? err.message : String(err) })
        continue
      }
      if (value === undefined) {
        failed.push({ selector, reason: `账号 "${accountId}" 没有 "${field}" 字段` })
        continue
      }
      try {
        await ctx.browser.setValue(sessionId, { target: { by: 'css', value: selector }, value }, signal)
        filled.push(selector)
      } catch (err) {
        // setValue 的报错可能回显值？——统一脱敏防线：本层不透传原始错误文本
        failed.push({ selector, reason: 'setValue 失败（选择器未命中或不可写）' })
        logger.warn?.(`[dsh-accounts] setValue 失败 (selector=${selector}, field=${field})`)
      }
    }
    if (filled.length === 0) {
      return {
        error: '没有任何 mapping 项填充成功',
        failed,
        availableFields: Object.keys(account.fields ?? {}),
      }
    }

    // 6. 提交
    let submitted = false
    if (submit && typeof submit === 'object') {
      try {
        if (typeof submit.selector === 'string' && submit.selector.length > 0) {
          await ctx.browser.click(sessionId, { target: { by: 'css', value: submit.selector } })
          submitted = true
        } else if (submit.key === 'Enter') {
          // 聚焦最后填成功的字段（click 文本输入框会使其获得焦点），再按 Enter
          const focusTarget = filled[filled.length - 1]
          try {
            await ctx.browser.click(sessionId, { target: { by: 'css', value: focusTarget } })
          } catch {
            // 聚焦失败不放弃提交，仍按 Enter
            logger.warn?.(`[dsh-accounts] Enter 提交前聚焦失败 (selector=${focusTarget})`)
          }
          await ctx.browser.key(sessionId, { key: 'Enter' })
          submitted = true
        }
      } catch (err) {
        logger.warn?.(`[dsh-accounts] 提交失败: ${err instanceof Error ? err.message : String(err)}`)
        submitted = false
      }
    }

    // 7. 武装窗口：防代填后直读。即使 submit 结果未知也保持 armed（武装的意义就是防读）。
    armRegistry.arm(sessionId, armedWindowMs)
    logger.info?.(`[dsh-accounts] 已代填 ${filled.length} 个字段并武装窗口 ${armedWindowMs}ms (session=${sessionId})`)

    return {
      filled,
      ...(failed.length > 0 ? { failed } : {}),
      submitted,
    }
  }

  // 串行化以 taskKey 为键（agentId ?? 'default'）；同一 taskKey 的并发 fill 天然同会话。
  function fillGuarded(input) {
    const taskKey = input.agentId ?? 'default'
    return serialize(taskKey, () => fill(input))
  }

  return { fill: fillGuarded }
}
