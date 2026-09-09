/**
 * lib/redact.js — 秘密脱敏器。
 *
 * createRedactor(secrets) 收集所有非空秘密（去重、长度 >= 4 才启用以避免灾难性误伤），
 * 按长度降序依次 replaceAll 为 '[REDACTED]'（长秘密先替换，防止短值先吃掉长值的一段）。
 *
 * 导出：
 *   createRedactor(secrets, { logger }?) -> { redact(text), hasSecrets(), skipped }
 *   wrapError(err, redact) -> Error  新 Error 的 message 已脱敏；原始错误由调用方记录日志
 */
const REDACTED = '[REDACTED]'
/** 短于此长度的秘密不参与脱敏（避免把普通词误伤成 [REDACTED]） */
const MIN_SECRET_LENGTH = 4

/**
 * @param {string[]} secrets 秘密值列表（env 值、fields 值、totp 现算码等）
 * @param {{ logger?: { warn?: (msg: string) => void } }} [opts] logger.warn 记录被跳过的短值（只记长度）
 * @returns {{ redact: (text: string) => string, hasSecrets: () => boolean, skipped: number[] }}
 */
export function createRedactor(secrets, opts = {}) {
  const skipped = []
  const unique = []
  const seen = new Set()
  for (const raw of secrets ?? []) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (raw.length < MIN_SECRET_LENGTH) {
      skipped.push(raw.length)
      continue
    }
    if (!seen.has(raw)) {
      seen.add(raw)
      unique.push(raw)
    }
  }
  if (skipped.length > 0 && typeof opts.logger?.warn === 'function') {
    // 只记录长度与数量，绝不记录值本身
    opts.logger.warn(`[dsh-accounts] 脱敏器跳过 ${skipped.length} 个过短（< ${MIN_SECRET_LENGTH} 字符）的秘密值，长度分布: ${skipped.join(',')}`)
  }
  // 长秘密优先替换
  unique.sort((a, b) => b.length - a.length)

  return {
    /** @param {string} text */
    redact(text) {
      if (typeof text !== 'string') return text
      let out = text
      for (const secret of unique) {
        if (out.includes(secret)) {
          out = out.replaceAll(secret, REDACTED)
        }
      }
      return out
    },
    hasSecrets() {
      return unique.length > 0
    },
    skipped,
  }
}

/**
 * 包装一个错误：新 Error 的 message 经过脱敏。
 * 不复制原始 stack（stack 可能包含敏感上下文）；调用方应自行把原始错误写入 logger。
 * @param {unknown} err
 * @param {(text: string) => string} redact
 * @returns {Error}
 */
export function wrapError(err, redact) {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const wrapped = new Error(redact(rawMessage))
  if (err instanceof Error && err.name && err.name !== 'Error') {
    wrapped.name = err.name
  }
  // 复制非敏感的结构化属性（如 errno / code / syscall），跳过 message / stack
  if (err instanceof Error) {
    for (const [key, value] of Object.entries(err)) {
      if (key === 'message' || key === 'stack') continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        wrapped[key] = value
      }
    }
  }
  return wrapped
}
