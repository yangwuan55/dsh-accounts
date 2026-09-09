/**
 * redact 单测：多秘密最长优先、去重、短值跳过、wrapError。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRedactor, wrapError } from '../lib/redact.js'

test('多秘密替换 + 最长优先', () => {
  const redactor = createRedactor(['short', 'a-longer-secret-value'])
  const input = 'token=a-longer-secret-value and short'
  assert.equal(redactor.redact(input), 'token=[REDACTED] and [REDACTED]')
})

test('最长优先：长秘密不被短值截断污染', () => {
  // 短值 'abc' 是长值前缀：若先替换短值会把长值破坏
  const redactor = createRedactor(['abc', 'abcdef-xyz'])
  assert.equal(redactor.redact('abcdef-xyz'), '[REDACTED]')
})

test('短值（<4 字符）跳过并记录长度', () => {
  const warns = []
  const redactor = createRedactor(['ab', 'abc', 'ok-secret-value-here'], {
    logger: { warn: (m) => warns.push(m) },
  })
  assert.equal(redactor.redact('ab abc ok-secret-value-here'), 'ab abc [REDACTED]')
  assert.equal(redactor.skipped.length, 2)
  assert.equal(warns.length, 1)
  assert.ok(!warns[0].includes('ab '), '日志不得包含值本身')
})

test('空串与非字符串秘密被忽略；重复秘密去重', () => {
  const redactor = createRedactor(['', 'dup-value-1234', 'dup-value-1234', null])
  assert.equal(redactor.redact('dup-value-1234'), '[REDACTED]')
  assert.equal(redactor.hasSecrets(), true)
})

test('非字符串输入原样返回', () => {
  const redactor = createRedactor(['secret-value'])
  assert.equal(redactor.redact(undefined), undefined)
  assert.equal(redactor.redact(42), 42)
})

test('wrapError：message 脱敏，保留 errno 类字段与 name', () => {
  const redactor = createRedactor(['super-secret-token-99'])
  const err = new Error('spawn failed: super-secret-token-99')
  err.code = 'ENOENT'
  err.name = 'SystemError'
  const wrapped = wrapError(err, redactor.redact)
  assert.equal(wrapped.message, 'spawn failed: [REDACTED]')
  assert.equal(wrapped.code, 'ENOENT')
  assert.equal(wrapped.name, 'SystemError')
  // 原始错误对象未被修改
  assert.equal(err.message, 'spawn failed: super-secret-token-99')
})

test('wrapError：非 Error 输入走 String() 路径', () => {
  const redactor = createRedactor(['leak-value-000'])
  const wrapped = wrapError('boom leak-value-000', redactor.redact)
  assert.equal(wrapped.message, 'boom [REDACTED]')
})
