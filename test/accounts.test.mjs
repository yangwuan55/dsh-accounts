/**
 * accounts 校验单测：三种 kind 合法通过；各类非法 payload 报错且错误信息不含值。
 * 全部使用假值（如 JBSWY3DPEHPK3PXP），不含任何真实凭据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAccountPayload, hostMatchesDomains } from '../lib/accounts.js'

const FAKE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP' // 经典示例 Base32（公开测试样例，非真实密钥）

function assertNoValueLeak(fn, values) {
  try {
    fn()
    assert.fail('应当抛错')
  } catch (err) {
    assert.ok(err instanceof Error)
    for (const value of values) {
      assert.ok(!err.message.includes(value), `错误信息泄露了值片段: ${value}`)
    }
  }
}

test('合法 account（含 totpSecret → hasTotp=true）', () => {
  const a = validateAccountPayload(
    {
      kind: 'account',
      label: '测试',
      domains: ['github.com'],
      fields: { username: 'u@example.com', password: 'fake-pass', totpSecret: FAKE_TOTP_SECRET },
    },
    'gh-main',
  )
  assert.equal(a.kind, 'account')
  assert.equal(a.hasTotp, true)
  assert.deepEqual(a.domains, ['github.com'])
})

test('合法 account 无 totpSecret → hasTotp=false', () => {
  const a = validateAccountPayload({ kind: 'account', fields: { username: 'u', password: 'p' } }, 'x')
  assert.equal(a.hasTotp, false)
})

test('合法 env', () => {
  const a = validateAccountPayload({ kind: 'env', env: { MY_TOKEN: 'fake-token', MY_REGION: 'r1' } }, 'cli')
  assert.equal(a.kind, 'env')
  assert.deepEqual(a.env, { MY_TOKEN: 'fake-token', MY_REGION: 'r1' })
})

test('合法 secret（附 env）', () => {
  const a = validateAccountPayload({ kind: 'secret', value: 'fake-api-key', env: { K: 'v' } }, 's')
  assert.equal(a.kind, 'secret')
  assert.equal(a.value, 'fake-api-key')
  assert.deepEqual(a.env, { K: 'v' })
})

test('缺 kind 报错', () => {
  // 用长一点的假值做泄露检查（单字符值无法与错误文案区分）
  assertNoValueLeak(() => validateAccountPayload({ fields: { username: 'user-value-xyz' } }, 'x'), ['user-value-xyz'])
})

test('kind 非法报错', () => {
  assert.throws(() => validateAccountPayload({ kind: 'password', value: 'x' }, 'x'), /kind/)
})

test('空值（fields 空 / secret 空值 / env 空值）各自报错', () => {
  assert.throws(() => validateAccountPayload({ kind: 'account', fields: {} }, 'x'), /fields/)
  assert.throws(() => validateAccountPayload({ kind: 'account' }, 'x'), /fields/)
  assertNoValueLeak(() => validateAccountPayload({ kind: 'secret', value: '' }, 'x'), [])
  assert.throws(() => validateAccountPayload({ kind: 'env', env: { A: '' } }, 'x'), /env/)
  assert.throws(() => validateAccountPayload({ kind: 'env' }, 'x'), /env/)
})

test('fields 值非字符串报错且不含值', () => {
  assertNoValueLeak(() => validateAccountPayload({ kind: 'account', fields: { password: 12345 } }, 'x'), ['12345'])
})

test('未知顶层字段报错（只报字段名，不报值）', () => {
  assertNoValueLeak(
    () => validateAccountPayload({ kind: 'secret', value: 'fake', mysteryField: 'should-not-echo' }, 'x'),
    ['should-not-echo', 'fake'],
  )
  try {
    validateAccountPayload({ kind: 'secret', value: 'fake', mysteryField: 'x' }, 'x')
    assert.fail('应当抛错')
  } catch (err) {
    assert.ok(err.message.includes('mysteryField'))
  }
})

test('env 键非法报错（键名可回显，因为键名不是秘密）', () => {
  assert.throws(() => validateAccountPayload({ kind: 'env', env: { '1BAD-KEY': 'v' } }, 'x'), /环境变量名/)
})

test('domains 非法报错', () => {
  assert.throws(() => validateAccountPayload({ kind: 'account', fields: { u: 'v' }, domains: [] }, 'x'), /domains/)
  assert.throws(() => validateAccountPayload({ kind: 'account', fields: { u: 'v' }, domains: ['Not A Host'] }, 'x'), /domains/)
  assert.throws(() => validateAccountPayload({ kind: 'account', fields: { u: 'v' }, domains: ['-bad.example.com'] }, 'x'), /domains/)
})

test('payload 非普通对象报错', () => {
  assert.throws(() => validateAccountPayload('string', 'x'), /对象/)
  assert.throws(() => validateAccountPayload(['array'], 'x'), /对象/)
  assert.throws(() => validateAccountPayload(null, 'x'), /对象/)
})

test('JSON 往返不等价报错（含函数/undefined 等不可序列化字段）', () => {
  const payload = { kind: 'secret', value: 'fake' }
  payload.hidden = undefined
  assert.throws(() => validateAccountPayload(payload, 'x'), /JSON 往返/)
})

test('hostMatchesDomains：精确与子域命中，其他拒绝', () => {
  assert.equal(hostMatchesDomains('github.com', ['github.com']), true)
  assert.equal(hostMatchesDomains('api.github.com', ['github.com']), true)
  assert.equal(hostMatchesDomains('notgithub.com', ['github.com']), false)
  assert.equal(hostMatchesDomains('evil.github.com.evil.io', ['github.com']), false)
  assert.equal(hostMatchesDomains('127.0.0.1', ['127.0.0.1']), true)
  assert.equal(hostMatchesDomains('', ['github.com']), false)
})
