/**
 * totp 单测：RFC 6238 附录 B SHA1 测试向量 + Base32 解码边界。
 * 测试向量 secret = "12345678901234567890"（ASCII）的 Base32 编码。
 * 该编码常量为公开测试向量（RFC 6238 附录 B），非任何真实密钥。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { totp, decodeBase32 } from '../lib/totp.js'

// RFC 6238 附录 B 的公开测试向量专用 secret（ASCII "12345678901234567890"）的 Base32
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('RFC 6238 SHA1 向量 T=59 → 287082', () => {
  assert.equal(totp(RFC_SECRET, { t: 59_000 }), '287082')
})

test('RFC 6238 SHA1 向量 T=1111111109 → 081804', () => {
  assert.equal(totp(RFC_SECRET, { t: 1111111109_000 }), '081804')
})

test('Base32 解码：小写、空格、无填充均可', () => {
  const expected = Buffer.from('12345678901234567890', 'ascii')
  assert.deepEqual(decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), expected)
  assert.deepEqual(decodeBase32('gezdgnbvgy3tqojqgezdgnbvgy3tqojq'), expected)
  assert.deepEqual(decodeBase32('GEZDGNB VGY3TQOJQ\tGEZDGNBVGY3TQOJQ\n'), expected)
  assert.deepEqual(decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ======'), expected)
})

test('Base32 解码：空输入与非法字符抛错，且错误不含输入原文', () => {
  assert.throws(() => decodeBase32(''), /为空/)
  try {
    decodeBase32('GEZDGNBV!!1')
    assert.fail('应当抛错')
  } catch (err) {
    assert.ok(err instanceof Error)
    assert.ok(/非法字符/.test(err.message))
    assert.ok(!err.message.includes('GEZDGNBV'), '错误信息不得回显输入')
  }
})

test('totp：非法时间戳抛错', () => {
  assert.throws(() => totp(RFC_SECRET, { t: Number.NaN }), /非法/)
})
