/**
 * lib/request.js — 带账号凭据发 HTTP 请求。
 *
 * 为什么要有这个工具：0.3.0 只有 credential_run（跑本地 CLI）和 account_fill（填浏览器
 * 表单），**没有任何 HTTP 路径**。想带 token 调 API，模型得自己想出「用 credential_run
 * 去跑 curl」这个两跳推理；而 credential_run 的工具描述与 systemPrompt 指引通篇只写
 * 「本地 CLI」，一个 HTTP 字都没有——模型没有线索，就干脆不触发。
 *
 * 安全模型（与本包其它工具一致）：
 * - **值永不进对话**：请求头里的凭据由插件从账号 env 映射里取，模型只能指定
 *   「哪个头 用哪个键」（headerEnv），碰不到值本身。
 * - **不自动跟重定向**：3xx 原样返回（含 Location），由模型决定要不要再发一次。
 *   自动跟随等于把 Authorization 头带到攻击者指定的 host 上，是本工具最容易出的事故。
 * - **域白名单**：账号配了 domains 时，URL host 必须命中（与 account_fill 同一条规则），
 *   防止模型把 token 发去别的站点。
 * - **响应脱敏**：账号的全部秘密值在返回给模型前替换为 [REDACTED]。
 *
 * 返回值与错误一律不含任何凭据值。
 */
import http from 'node:http'
import https from 'node:https'
import { injectableEnv, secretEnvKey, hostMatchesDomains } from './accounts.js'
import { createRedactor, wrapError } from './redact.js'
import { totp } from './totp.js'

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_BODY_CHARS = 20000
/** 请求/响应体上限（字节），防把一个几百 MB 的下载读进内存 */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * 解析 URL 并拒绝非 http(s) 协议。
 * @param {string} raw
 * @returns {URL}
 * @throws {Error} 协议不支持或 URL 非法
 */
function parseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('url 不是合法的绝对 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http/https，收到 ${url.protocol}`)
  }
  return url
}

/**
 * 创建 HTTP 请求服务。
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文（仅用于 ctx.logger）
 * @param {ReturnType<import('./accounts.js').createAccountsService>} deps.accounts
 * @param {{ warn?: (m: string) => void, info?: (m: string) => void, error?: (m: string) => void }} [deps.logger]
 * @param {{ requestTimeoutMs?: number, maxResponseChars?: number }} [deps.config]
 */
export function createRequestService({ ctx, accounts, logger = {}, config = {} }) {
  const defaultTimeout = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseChars = config.maxResponseChars ?? DEFAULT_MAX_BODY_CHARS

  /**
   * 发一次请求。
   * @param {object} input
   * @param {string} input.accountId
   * @param {string} input.url
   * @param {string} [input.method] 默认 GET
   * @param {Record<string, string>} [input.headers] 明文请求头（不含凭据）
   * @param {Record<string, string>} [input.headerEnv] 头名 → 账号 env 键；值由插件注入
   * @param {string} [input.body]
   * @param {string[]} [input.envKeys] 只注入这些键；缺省=账号全部
   * @param {number} [input.timeoutMs]
   * @param {AbortSignal} [input.signal]
   * @returns {Promise<object>} 结构化结果（含 error 时用 error 文案）
   */
  async function request({
    accountId,
    url: rawUrl,
    method,
    headers,
    headerEnv,
    body,
    envKeys,
    timeoutMs,
    signal,
  }) {
    // ---- 1. 账号 ----
    let account
    try {
      account = await accounts.get(accountId)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!account) {
      const { accounts: all } = await accounts.listSummaries()
      const validIds = all.filter((a) => !('error' in a)).map((a) => /** @type {{id: string}} */ (a).id)
      return { error: `账号 "${accountId}" 不存在`, availableAccounts: validIds }
    }

    // ---- 2. 可注入的键 ----
    let accountEnv = injectableEnv(account)
    let injectableKeys = Object.keys(accountEnv).sort()
    if (envKeys !== undefined && envKeys !== null) {
      if (!Array.isArray(envKeys) || envKeys.some((k) => typeof k !== 'string')) {
        return { error: 'envKeys 必须是字符串数组' }
      }
      const picked = {}
      const missing = []
      for (const key of envKeys) {
        if (Object.prototype.hasOwnProperty.call(accountEnv, key)) picked[key] = accountEnv[key]
        else missing.push(key)
      }
      if (Object.keys(picked).length === 0) {
        return {
          error:
            `envKeys 与账号 "${accountId}" 的 env 映射无交集。` +
            `该账号可注入的键: ${injectableKeys.join('、')}；未匹配: ${missing.join('、')}`,
          injectableKeys,
        }
      }
      accountEnv = picked
      injectableKeys = Object.keys(picked).sort()
    }
    if (injectableKeys.length === 0) {
      return { error: `账号 "${accountId}" 没有任何可注入的键（kind=${account.kind}）`, injectableKeys }
    }

    // ---- 3. URL 与域白名单 ----
    let url
    try {
      url = parseUrl(rawUrl)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (Array.isArray(account.domains) && account.domains.length > 0) {
      if (!hostMatchesDomains(url.hostname, account.domains)) {
        return {
          error:
            `host ${url.hostname} 不在账号 "${accountId}" 的 domains 白名单` +
            `（${account.domains.join('、')}）。要换账号，或先在凭据记录里补域名。`,
          injectableKeys,
        }
      }
    }

    // ---- 4. 组装请求头：明文头 + 由账号 env 注入的头 ----
    const outHeaders = {}
    if (headers !== undefined && headers !== null) {
      if (typeof headers !== 'object' || Array.isArray(headers)) {
        return { error: 'headers 必须是对象' }
      }
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== 'string') return { error: `header "${name}" 的值必须是字符串` }
        outHeaders[name] = value
      }
    }
    const usedEnvKeys = []
    if (headerEnv !== undefined && headerEnv !== null) {
      if (typeof headerEnv !== 'object' || Array.isArray(headerEnv)) {
        return { error: 'headerEnv 必须是对象（头名 → 账号 env 键名）' }
      }
      for (const [headerName, envKey] of Object.entries(headerEnv)) {
        if (typeof envKey !== 'string') return { error: `headerEnv["${headerName}"] 必须是环境变量键名` }
        const value = accountEnv[envKey]
        if (value === undefined) {
          return {
            error:
              `headerEnv["${headerName}"] 指向的键 "${envKey}" 不在账号 "${accountId}" 的可注入键里。` +
              `可注入的键: ${injectableKeys.join('、')}`,
            injectableKeys,
          }
        }
        outHeaders[headerName] = value
        usedEnvKeys.push(envKey)
      }
    }

    // ---- 5. 脱敏器（响应与错误都要过）----
    let totpCode = ''
    try {
      const secret = account.fields?.totpSecret
      if (secret) totpCode = totp(secret)
    } catch {
      totpCode = ''
    }
    const redactor = createRedactor([
      ...Object.values(accountEnv),
      ...Object.values(account.fields ?? {}),
      ...(account.value !== undefined ? [account.value] : []),
      ...(totpCode ? [totpCode] : []),
    ])

    // ---- 6. 发请求（不自动跟重定向）----
    const effectiveMethod = (typeof method === 'string' && method.length > 0 ? method : 'GET').toUpperCase()
    const payload = typeof body === 'string' && body.length > 0 ? Buffer.from(body, 'utf8') : undefined
    if (payload !== undefined && outHeaders['content-length'] === undefined) {
      outHeaders['content-length'] = String(payload.length)
    }

    const effectiveTimeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeout

    return await new Promise((resolve) => {
      const transport = url.protocol === 'https:' ? https : http
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        req?.destroy(new Error(`请求超时（${effectiveTimeout}ms）`))
        finish({ error: `请求超时（${effectiveTimeout}ms）`, injectableKeys })
      }, effectiveTimeout)

      let req
      try {
        req = transport.request(
          url,
          {
            method: effectiveMethod,
            headers: outHeaders,
            signal,
          },
          (res) => {
            const chunks = []
            let bytes = 0
            res.on('data', (chunk) => {
              bytes += chunk.length
              // 超过上限就掐断：绝不把超大响应读进内存，更不会交给模型
              if (bytes <= MAX_BODY_BYTES) chunks.push(chunk)
              else req.destroy()
            })
            res.on('end', () => {
              const truncated = bytes > MAX_BODY_BYTES
              let text = Buffer.concat(chunks).toString('utf8')
              if (text.length > maxResponseChars) {
                text = text.slice(0, maxResponseChars) + `\n[截断: 响应超过 ${maxResponseChars} 字符]`
              }
              const result = {
                status: res.statusCode ?? 0,
                // 3xx 不自动跟随，把 Location 交给模型判断
                ...(res.headers.location ? { location: redactor.redact(String(res.headers.location)) } : {}),
                body: redactor.redact(text),
                ...(truncated ? { truncated: true } : {}),
                ...(usedEnvKeys.length > 0 ? { headersFromKeys: usedEnvKeys.sort() } : {}),
                injectableKeys,
                redacted: true,
              }
              finish(result)
            })
          },
        )
        req.on('error', (err) => {
          ctx?.logger?.error?.(`[dsh-accounts] credential_request 失败: ${err.stack ?? err.message}`)
          finish({ error: wrapError(err, redactor.redact).message, injectableKeys })
        })
        if (payload !== undefined) req.write(payload)
        req.end()
      } catch (err) {
        const full = err instanceof Error ? err : new Error(String(err))
        ctx?.logger?.error?.(`[dsh-accounts] credential_request 失败(同步): ${full.stack ?? full.message}`)
        finish({ error: wrapError(full, redactor.redact).message, injectableKeys })
      }
    })
  }

  return { request }
}

export { secretEnvKey }
