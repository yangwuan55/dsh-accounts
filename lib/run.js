/**
 * lib/run.js — env 注入执行本地 CLI + 输出脱敏。
 *
 * 职责：
 *  1. 解析账号，确定可注入的 env 键（统一规则：只有账号 env 映射里的键可被注入）；
 *  2. 在插件进程内 spawn 目标命令（不经过 bash 工具），env = {...process.env, ...注入值}，
 *     cwd = 用户主目录，stdio ['ignore','pipe','pipe']；
 *  3. stdout/stderr 收集后经脱敏器（env 值、fields 值、secret value、totp 现算码）替换为
 *     [REDACTED] 再返回；
 *  4. 超时 SIGTERM，2 秒后仍存活则 SIGKILL；输出超过 maxOutputChars 截断并注明。
 *
 * 完整未脱敏错误只进 ctx.logger.error；返回给模型的一切（结果/错误）都先过脱敏。
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createRedactor, wrapError } from './redact.js'
import { totp } from './totp.js'

const DEFAULT_RUN_TIMEOUT_MS = 60000
const DEFAULT_MAX_OUTPUT_CHARS = 50000
/** SIGTERM 后宽限期，届时 SIGKILL */
const KILL_GRACE_MS = 2000

/** 输出截断（在脱敏后的文本上做，注明截断事实） */
function truncate(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text
  return text.slice(0, max) + `\n[截断: 输出超过 maxOutputChars=${max} 字符，已丢弃其后内容]`
}

/**
 * 创建 run 服务。
 * @param {object} deps
 * @param {any} deps.ctx DSH 插件上下文（用 ctx.logger）
 * @param {ReturnType<import('./accounts.js').createAccountsService>} deps.accounts
 * @param {{ warn?: (msg: string) => void, info?: (msg: string) => void, error?: (msg: string) => void }} [deps.logger]
 * @param {{ runTimeoutMs?: number, maxOutputChars?: number }} [deps.config]
 */
export function createRunService({ ctx, accounts, logger = {}, config = {} }) {
  const defaultTimeout = config.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const maxOutputChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS

  /**
   * env 注入执行入口（结构化错误以 { error } 返回，不抛）。
   * @param {object} input
   * @param {string} input.accountId
   * @param {string} input.command
   * @param {string[]} [input.args]
   * @param {string[]} [input.envKeys] 要注入的 env 键；缺省=注入账号全部 env 键
   * @param {number} [input.timeoutMs]
   * @param {AbortSignal} [input.signal]
   */
  async function run({ accountId, command, args, envKeys, timeoutMs, signal }) {
    if (typeof command !== 'string' || command.length === 0) {
      return { error: 'command 必须是非空字符串' }
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
      return { error: `账号 "${accountId}" 不存在`, availableAccounts: validIds }
    }

    // 2. 确定注入映射：只有账号 env 里的键可被注入
    const accountEnv = account.env ?? {}
    const injectableKeys = Object.keys(accountEnv).sort()
    if (injectableKeys.length === 0) {
      return {
        error:
          `账号 "${accountId}"（kind=${account.kind}）没有 "env" 映射，无可注入的键。` +
          `credential_run 只注入账号 "env" 映射里的键；` +
          (account.kind === 'secret'
            ? `kind='secret' 的账号只有 value 主体，请在记录里补 env 映射才能注入。`
            : `请在记录里为该账号补 "env" 映射（键为环境变量名）。`),
        injectableKeys,
      }
    }

    /** @type {Record<string, string>} */
    let injected
    if (envKeys === undefined || envKeys === null) {
      injected = { ...accountEnv }
    } else {
      if (!Array.isArray(envKeys) || envKeys.some((k) => typeof k !== 'string')) {
        return { error: 'envKeys 必须是字符串数组' }
      }
      injected = {}
      const missing = []
      for (const key of envKeys) {
        if (Object.prototype.hasOwnProperty.call(accountEnv, key)) {
          injected[key] = accountEnv[key]
        } else {
          missing.push(key)
        }
      }
      if (Object.keys(injected).length === 0) {
        return {
          error:
            `envKeys 与账号 "${accountId}" 的 env 映射无交集。` +
            `该账号可注入的键: ${injectableKeys.length > 0 ? injectableKeys.join('、') : '（无）'}；` +
            `未匹配的 envKeys: ${missing.join('、')}`,
          injectableKeys,
        }
      }
    }

    // 3. 收集本账号全部秘密值建脱敏器（env 值、fields 值、secret value、totp 现算码）
    const secrets = [
      ...Object.values(accountEnv),
      ...Object.values(account.fields ?? {}),
      ...(account.value !== undefined ? [account.value] : []),
    ]
    let totpCode = ''
    try {
      if (account.fields?.totpSecret) {
        totpCode = totp(account.fields.totpSecret)
        secrets.push(totpCode)
      }
    } catch {
      // totpSecret 非法时跳过现算码（注入不了 totp 也不影响 env 注入）
    }
    const redactor = createRedactor(secrets, { logger })

    // 4. spawn（插件进程内直接执行，不经过 bash 工具）
    const effectiveTimeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeout
    const childArgs = Array.isArray(args) ? args.map(String) : []

    return await new Promise((resolve) => {
      let child
      try {
        child = spawn(command, childArgs, {
          env: { ...process.env, ...injected },
          cwd: homedir(),
          signal,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        // spawn 同步抛错（如参数非法）
        const full = err instanceof Error ? err : new Error(String(err))
        ctx?.logger?.error?.(`[dsh-accounts] credential_run spawn 失败(同步): ${full.stack ?? full.message}`)
        resolve({ error: wrapError(full, redactor.redact).message })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let killTimer = null

      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        if (killTimer) clearTimeout(killTimer)
        resolve(result)
      }

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })

      const timeoutTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
          killTimer = setTimeout(() => {
            try {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            } catch {
              /* 进程已退出 */
            }
          }, KILL_GRACE_MS)
        } catch {
          /* 进程已退出 */
        }
      }, effectiveTimeout)

      child.on('error', (err) => {
        // spawn ENOENT 等异步错误
        const full = `credential_run 启动失败 (command=${command}): ${err.stack ?? err.message}`
        ctx?.logger?.error?.(`[dsh-accounts] ${full}`)
        finish({ error: wrapError(err, redactor.redact).message })
      })

      child.on('close', (code, exitSignal) => {
        const exitCode = code ?? -1
        // 超时路径：进程被我们的 SIGTERM/SIGKILL 以信号终止（code 为 null）
        const timedOut = code === null && (exitSignal === 'SIGTERM' || exitSignal === 'SIGKILL')
        finish({
          exitCode,
          stdout: truncate(redactor.redact(stdout), maxOutputChars),
          stderr: truncate(redactor.redact(stderr), maxOutputChars),
          ...(timedOut ? { timedOut: true } : {}),
        })
      })
    })
  }

  return { run }
}
