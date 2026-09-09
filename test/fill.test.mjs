/**
 * fill 状态机单测：mock ctx.browser 与 credentials（不真开浏览器）。
 * 覆盖：arm/disarm/armed 过期/guard 拒绝/复用与回退会话/域白名单/CAPTCHA/串行化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createArmRegistry, createGuardCallback } from '../lib/guard.js'
import { createFillService } from '../lib/fill.js'
import { createAccountsService } from '../lib/accounts.js'

/** 可控时钟 */
function makeClock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

/** mock credentials（一个账号） */
function mockCredentials() {
  return {
    async listRecords() {
      return [
        { key: 'dsh-accounts/test-site', kind: 'api-key' },
        { key: 'dsh-accounts/broken', kind: 'api-key' },
        { key: 'other-scope/xxx', kind: 'api-key' },
      ]
    },
    async readRecord(key) {
      if (key === 'dsh-accounts/test-site') {
        return {
          kind: 'grant',
          payload: {
            kind: 'account',
            domains: ['test.example.com'],
            fields: { username: 'fake-user', password: 'fake-pass-1234' },
          },
        }
      }
      if (key === 'dsh-accounts/broken') {
        return { kind: 'grant', payload: { kind: 'nonsense' } }
      }
      return undefined
    },
  }
}

/** mock browser */
function mockBrowser({ url = 'https://test.example.com/login', challenge = undefined } = {}) {
  const calls = { setValue: [], click: [], key: [], open: 0 }
  return {
    calls,
    async listTabs() {
      return [{ url, active: true }]
    },
    async detectChallenge() {
      return challenge
    },
    async setValue(sessionId, request) {
      calls.setValue.push({ sessionId, request })
    },
    async click(sessionId, request) {
      calls.click.push({ sessionId, request })
    },
    async key(sessionId, request) {
      calls.key.push({ sessionId, request })
    },
    async open(label) {
      calls.open += 1
      return `self-opened-${label}`
    },
  }
}

function makeCtx({ browser } = {}) {
  return { credentials: mockCredentials(), browser: browser ?? mockBrowser() }
}

function makeFillWithAccounts(opts = {}) {
  const clock = opts.clock ?? makeClock()
  const browser = opts.browser ?? mockBrowser(opts.browserOpts)
  const ctx = makeCtx({ browser })
  const armRegistry = createArmRegistry({ now: clock.now })
  const logs = []
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }
  const accounts = createAccountsService(ctx, { logger })
  const fillService = createFillService({
    ctx,
    accounts,
    armRegistry,
    logger,
    loadSessionsModule: opts.loadSessionsModule,
  })
  return { ctx, browser, armRegistry, accounts, fill: fillService.fill, logs, clock }
}

const MAPPING = [
  { selector: '#user', field: 'username' },
  { selector: '#pass', field: 'password' },
]

test('fill 成功：setValue 注入真值（不外泄）、返回只有 selector、arm 生效', async () => {
  const { browser, armRegistry, fill } = makeFillWithAccounts()
  const result = await fill({
    accountId: 'test-site',
    mapping: MAPPING,
    submit: { selector: '#go' },
    agentId: 'agent-1',
  })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.filled, ['#user', '#pass'])
  assert.equal(result.submitted, true)
  // 真值确实被注入到浏览器（本插件内存 → browser mock），但绝不出现在返回值
  const injected = browser.calls.setValue.map((c) => c.request.value)
  assert.ok(injected.includes('fake-user') && injected.includes('fake-pass-1234'))
  assert.ok(!JSON.stringify(result).includes('fake-pass'))
  // 武装以解析到的 sessionId（mock 回退自开 → self-opened-agent-1）为键
  assert.ok(armRegistry.isArmed('self-opened-agent-1'))
  assert.ok(armRegistry.activeWindow(), '任意会话的武装窗口可被 guard 感知')
})

test('guard：武装窗口内拦截读取类工具，窗口外放行', async () => {
  const clock = makeClock()
  const { armRegistry, fill } = makeFillWithAccounts({ clock })
  const guard = createGuardCallback(armRegistry)

  // 未武装 → 放行
  assert.equal(guard({ name: 'browser_get_value' }), undefined)

  await fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'agent-1' })
  // 武装中 → 拦截并给出理由（含等待秒数）
  for (const tool of ['browser_get_value', 'browser_execute', 'browser_a11y', 'browser_snapshot', 'browser_scrape']) {
    const reason = guard({ name: tool })
    assert.ok(typeof reason === 'string' && reason.includes('dsh-accounts'), `${tool} 应被拦截`)
  }
  // 非名单工具 → 放行
  assert.equal(guard({ name: 'browser_click' }), undefined)
  assert.equal(guard({ name: 'browser_navigate' }), undefined)

  // 窗口过期（默认 120s 后）→ 放行
  clock.advance(121_000)
  assert.equal(guard({ name: 'browser_snapshot' }), undefined)
})

test('disarm 后 guard 放行；activeWindow 报告剩余时间', async () => {
  const clock = makeClock()
  const { armRegistry, fill } = makeFillWithAccounts({ clock })
  const guard = createGuardCallback(armRegistry)
  await fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'agent-1' })
  const win = armRegistry.activeWindow()
  assert.ok(win && win.remainingMs > 0 && win.remainingMs <= 120_000)
  armRegistry.disarm('self-opened-agent-1')
  assert.equal(guard({ name: 'browser_get_value' }), undefined)
})

test('fill 后 arm TTL 可调（armedWindowMs）', async () => {
  const clock = makeClock()
  const browser = mockBrowser()
  const ctx = makeCtx({ browser })
  const armRegistry = createArmRegistry({ now: clock.now })
  const accounts = createAccountsService(ctx, {})
  const svc = createFillService({ ctx, accounts, armRegistry, config: { armedWindowMs: 5000 } })
  await svc.fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'a' })
  clock.advance(6_000)
  assert.equal(armRegistry.isArmed('self-opened-a'), false)
})

test('CAPTCHA：detectChallenge 命中 → 不填任何字段', async () => {
  const browser = mockBrowser({ challenge: { type: 'cloudflare' } })
  const { fill, armRegistry } = makeFillWithAccounts({ browser })
  const result = await fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'a' })
  assert.deepEqual(result.filled, [])
  assert.equal(result.challenge, 'needs-human')
  assert.equal(browser.calls.setValue.length, 0)
  assert.equal(armRegistry.isArmed('default'), false)
})

test('域白名单：host 不匹配 → 拒绝', async () => {
  const browser = mockBrowser({ url: 'https://evil.example.net/login' })
  const { fill } = makeFillWithAccounts({ browser })
  const result = await fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'a' })
  assert.ok(result.error.includes('白名单'))
  assert.equal(browser.calls.setValue.length, 0)
})

test('域白名单：子域命中放行', async () => {
  const browser = mockBrowser({ url: 'https://www.test.example.com/login' })
  const { fill } = makeFillWithAccounts({ browser })
  const result = await fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'a' })
  assert.equal(result.error, undefined)
})

test('账号不存在：错误含可用 id 列表（仅名字，损坏记录不进列表）', async () => {
  const { fill } = makeFillWithAccounts()
  const result = await fill({ accountId: 'nope', mapping: MAPPING, agentId: 'a' })
  assert.ok(result.error.includes('不存在'))
  assert.ok(result.availableAccounts.includes('test-site'))
  // 损坏记录（解析失败）只进 availableAccounts 不安全——列表只含合法账号
  assert.ok(!result.availableAccounts.includes('broken'))
})

test('部分 selector 失败 → failed 记录原因，其余照填', async () => {
  const browser = mockBrowser()
  browser.setValue = async (sessionId, request) => {
    if (request.target.value === '#missing') {
      throw new Error('selector not found: #missing （这里故意带上敏感词 fake-pass-1234 测试不透传）')
    }
  }
  const { fill, logs } = makeFillWithAccounts({ browser })
  const result = await fill({
    accountId: 'test-site',
    mapping: [
      { selector: '#user', field: 'username' },
      { selector: '#missing', field: 'password' },
    ],
    agentId: 'a',
  })
  assert.deepEqual(result.filled, ['#user'])
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].selector, '#missing')
  assert.ok(!result.failed[0].reason.includes('fake-pass-1234'), '失败原因不得透传浏览器错误原文（可能含值）')
  assert.ok(!JSON.stringify(logs).includes('fake-pass-1234'), '日志不得含值')
})

test('账号缺字段 → failed 给出可填字段列表', async () => {
  const { fill } = makeFillWithAccounts()
  const result = await fill({
    accountId: 'test-site',
    mapping: [{ selector: '#totp', field: 'totp' }],
    agentId: 'a',
  })
  assert.equal(result.error, '没有任何 mapping 项填充成功')
  assert.ok(result.availableFields.includes('username'))
})

test('空 mapping 报错', async () => {
  const { fill } = makeFillWithAccounts()
  const result = await fill({ accountId: 'test-site', mapping: [], agentId: 'a' })
  assert.ok(result.error.includes('mapping'))
})

test('会话复用：loadSessionsModule 提供 sessions 快照时不开新会话', async () => {
  const browser = mockBrowser()
  const { fill } = makeFillWithAccounts({
    browser,
    loadSessionsModule: async () => ({ internals: { sessions: new Map([['agent-1', 'reused-session']]) } }),
  })
  const result = await fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'agent-1' })
  assert.equal(result.error, undefined)
  assert.equal(browser.calls.open, 0)
  assert.ok(browser.calls.setValue.every((c) => c.sessionId === 'reused-session'))
})

test('会话回退：快照取不到 → ctx.browser.open 自开（记日志）', async () => {
  const browser = mockBrowser()
  const { fill, logs } = makeFillWithAccounts({
    browser,
    loadSessionsModule: async () => ({ internals: { sessions: new Map() } }),
  })
  const result = await fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'agent-unknown' })
  assert.equal(result.error, undefined)
  assert.equal(browser.calls.open, 1)
  assert.ok(logs.some((l) => l.includes('回退自开')))
})

test('Enter 提交：聚焦最后字段 + key Enter', async () => {
  const browser = mockBrowser()
  const { fill } = makeFillWithAccounts({ browser })
  const result = await fill({ accountId: 'test-site', mapping: MAPPING, submit: { key: 'Enter' }, agentId: 'a' })
  assert.equal(result.submitted, true)
  assert.equal(browser.calls.key.length, 1)
  assert.equal(browser.calls.key[0].request.key, 'Enter')
})

test('并发 fill 同账号串行化：第二次 fill 等第一次完成', async () => {
  const browser = mockBrowser()
  let inFlight = 0
  let maxConcurrent = 0
  const origSetValue = browser.setValue.bind(browser)
  browser.setValue = async (...args) => {
    inFlight += 1
    maxConcurrent = Math.max(maxConcurrent, inFlight)
    await new Promise((r) => setTimeout(r, 20))
    await origSetValue(...args)
    inFlight -= 1
  }
  const { fill } = makeFillWithAccounts({ browser })
  const [r1, r2] = await Promise.all([
    fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'a' }),
    fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'a' }),
  ])
  assert.equal(r1.error, undefined)
  assert.equal(r2.error, undefined)
  assert.equal(maxConcurrent, 1, '同一 taskKey 的 fill 必须串行')
})

// ---- headless 场景（契约修正：inject 不含 browser，ctx.browser 运行时惰性访问）----

test('headless：无 browser 的 ctx → account_fill 返回结构化错误（不抛异常）', async () => {
  const ctx = makeCtx() // makeCtx 的 browser 默认存在，这里显式去掉
  delete ctx.browser
  const armRegistry = createArmRegistry()
  const accounts = createAccountsService(ctx, {})
  const fillService = createFillService({ ctx, accounts, armRegistry })
  const result = await fillService.fill({ accountId: 'test-site', mapping: MAPPING, agentId: 'a' })
  assert.deepEqual(result, { error: '浏览器服务在当前部署不可用' })
  // 不武装窗口、不访问凭据之外的服务
  assert.equal(armRegistry.activeWindow(), undefined)
})

test('headless：account_list / credential_run / guard 完全可用', async () => {
  const ctx = makeCtx() // browser 缺失由 delete 模拟，见上；这里构造 headless ctx
  delete ctx.browser
  const armRegistry = createArmRegistry()
  const accounts = createAccountsService(ctx, {})
  // account_list 摘要可用（仅元数据）
  const summary = await accounts.listSummaries()
  assert.ok(summary.accounts.some((a) => a.id === 'test-site'))
  // guard：headless 永远无武装窗口 → 读取类工具放行
  const guard = createGuardCallback(armRegistry)
  for (const tool of ['browser_get_value', 'browser_snapshot']) {
    assert.equal(guard({ name: tool }), undefined)
  }
  // credential_run 可用（run.test.mjs 已详测；此处只验证服务可构造可执行）
  const { createRunService } = await import('../lib/run.js')
  const run = createRunService({ ctx, accounts, logger: {} }).run
  const result = await run({ accountId: 'cli-test-x', command: 'whatever' })
  assert.ok(result.error.includes('不存在'), 'headless 下 credential_run 正常走到账号解析')
})
