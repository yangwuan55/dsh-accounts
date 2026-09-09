/**
 * lib/totp.js — RFC 6238 TOTP（HMAC-SHA1，6 位，30 秒步长），零依赖（仅 node:crypto）。
 *
 * secret 为 Base32（RFC 4648，无填充；大小写不敏感；忽略空白与 '='）。
 * 导出：
 *   decodeBase32(input) -> Buffer   Base32 解码（非法字符抛错，错误信息不含输入）
 *   totp(secret, { t = Date.now() }?) -> string  6 位零填充验证码
 */
import { createHmac } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** 30 秒时间步长（RFC 6238 默认） */
const STEP_SECONDS = 30
/** 验证码位数 */
const CODE_DIGITS = 6

/**
 * Base32（RFC 4648）解码。
 * - 大小写不敏感
 * - 忽略所有空白字符与 '=' 填充
 * - 非法字符抛错；错误信息只描述字符类别，不回显输入本身
 * @param {string} input
 * @returns {Buffer}
 */
export function decodeBase32(input) {
  if (typeof input !== 'string') {
    throw new Error('Base32 解码失败：secret 必须是字符串')
  }
  const cleaned = input.replace(/\s+/g, '').replace(/=/g, '').toUpperCase()
  if (cleaned.length === 0) {
    throw new Error('Base32 解码失败：secret 为空')
  }
  let bits = 0
  let value = 0
  const bytes = []
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) {
      // 不回显具体字符，避免把近似秘密的内容带进错误消息
      throw new Error('Base32 解码失败：secret 含非法字符（仅允许 A-Z、2-7）')
    }
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/**
 * 计算 TOTP 验证码（RFC 6238，SHA1，6 位）。
 * @param {string} secret Base32 编码的共享密钥
 * @param {{ t?: number }} [opts] t 为毫秒时间戳，默认 Date.now()
 * @returns {string} 6 位零填充验证码
 */
export function totp(secret, opts = {}) {
  const t = opts.t ?? Date.now()
  if (!Number.isFinite(t)) {
    throw new Error('TOTP 计算失败：时间戳非法')
  }
  const counter = Math.floor(t / 1000 / STEP_SECONDS)
  // 8 字节大端 counter（RFC 4226 §5.2）
  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', decodeBase32(secret)).update(counterBuf).digest()
  // 动态截断（RFC 4226 §5.3）
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(bin % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0')
}
