/**
 * run 单测：env 注入 + 输出脱敏。用一个假 node -e 脚本验证，绝不含真实凭据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountsService } from '../lib/accounts.js'
import { createRunService } from '../lib/run.js'

function makeCtx(envAccount, extra = {}) {
  const credentials = {
    async listRecords() {
      return [{ key: 'dsh-accounts/cli-test', kind: 'api-key' }, { key: 'dsh-accounts/plain', kind: 'api-key' }]
    },
    async readRecord(key) {
      if (key === 'dsh-accounts/cli-test') {
        return {
          kind: 'grant',
          payload: {
            kind: 'env',
            env: { TEST_SECRET_TOKEN: 'fake-token-abcd-9999', TEST_REGION: 'r1' },
          },
        }
      }
      if (key === 'dsh-accounts/plain') {
        return { kind: 'grant', payload: { kind: 'account', fields: { username: 'fake-user' } } }
      }
      return undefined
    },
  }
  const logs = { error: [], warn: [], info: [] }
  const logger = {
    error: (m) => logs.error.push(m),
    warn: (m) => logs.warn.push(m),
    info: (m) => logs.info.push(m),
  }
  return {
    ctx: { credentials, logger, ...extra },
    logs,
  }
}

function makeRun(ctx) {
  const accounts = createAccountsService(ctx, { logger: ctx.logger })
  return createRunService({ ctx, accounts, logger: ctx.logger }).run
}

test('env 注入：子进程能读到注入的环境变量', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  // 子进程只回显「值是否等于预期」的布尔值，不把秘密印到 stdout
  // （stdout 里出现的秘密会被脱敏器替换——那是另一个测试的职责）
  const result = await run({
    accountId: 'cli-test',
    command: process.execPath,
    args: [
      '-e',
      'console.log(JSON.stringify({ t: process.env.TEST_SECRET_TOKEN === "fake-token-abcd-9999", r: process.env.TEST_REGION, hasToken: typeof process.env.TEST_SECRET_TOKEN === "string" && process.env.TEST_SECRET_TOKEN.length > 0 }))',
    ],
    timeoutMs: 15000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.exitCode, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.t, true)
  assert.equal(parsed.hasToken, true)
  assert.equal(parsed.r, 'r1')
})

test('输出脱敏：stdout 印出秘密 → 返回 [REDACTED]', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({
    accountId: 'cli-test',
    command: process.execPath,
    args: ['-e', 'console.log("token=" + process.env.TEST_SECRET_TOKEN)'],
    timeoutMs: 15000,
  })
  assert.equal(result.exitCode, 0)
  assert.ok(result.stdout.includes('[REDACTED]'), `stdout 应被脱敏: ${result.stdout}`)
  assert.ok(!result.stdout.includes('fake-token-abcd-9999'), '秘密值不得出现在结果中')
})

test('stderr 也脱敏', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({
    accountId: 'cli-test',
    command: process.execPath,
    args: ['-e', 'console.error("oops " + process.env.TEST_SECRET_TOKEN); process.exit(3)'],
    timeoutMs: 15000,
  })
  assert.equal(result.exitCode, 3)
  assert.ok(result.stderr.includes('[REDACTED]'))
  assert.ok(!result.stderr.includes('fake-token-abcd-9999'))
})

test('envKeys 过滤：只注入指定键', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({
    accountId: 'cli-test',
    command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify([process.env.TEST_SECRET_TOKEN, process.env.TEST_REGION]))'],
    envKeys: ['TEST_REGION'],
    timeoutMs: 15000,
  })
  const parsed = JSON.parse(result.stdout)
  // JSON.stringify 把 undefined 序列化为 null
  assert.equal(parsed[0], null, '未指定的键不得注入')
  assert.equal(parsed[1], 'r1')
})

test('envKeys 无交集：报错并列出可注入键名（仅键名）', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({
    accountId: 'cli-test',
    command: 'whatever',
    envKeys: ['NO_SUCH_KEY'],
  })
  assert.ok(result.error.includes('无交集'))
  assert.deepEqual(result.injectableKeys, ['TEST_REGION', 'TEST_SECRET_TOKEN'])
  assert.ok(!result.error.includes('fake-token'))
})

test('无 env 映射的账号：报错并列出可注入键（空）', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({ accountId: 'plain', command: 'whatever' })
  assert.ok(result.error.includes('没有 "env" 映射'))
  assert.deepEqual(result.injectableKeys, [])
})

test('账号不存在：报错含可用账号 id', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({ accountId: 'missing', command: 'whatever' })
  assert.ok(result.error.includes('不存在'))
  assert.ok(result.availableAccounts.includes('cli-test'))
})

test('spawn ENOENT：错误脱敏后返回，完整错误进 logger.error', async () => {
  const { ctx, logs } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({
    accountId: 'cli-test',
    command: 'definitely-not-a-real-binary-xyz',
    args: [],
    timeoutMs: 15000,
  })
  assert.ok(result.error, '应返回结构化错误')
  assert.ok(logs.error.length > 0, '完整错误应进 logger.error')
  assert.ok(!JSON.stringify(result).includes('fake-token'))
})

test('超时：SIGTERM 终止，返回 timedOut', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  const result = await run({
    accountId: 'cli-test',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 800,
  })
  assert.equal(result.timedOut, true)
})

test('非字符串 command 报错', async () => {
  const { ctx } = makeCtx()
  const run = makeRun(ctx)
  assert.ok((await run({ accountId: 'cli-test', command: '' })).error.includes('command'))
})
