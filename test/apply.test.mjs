/**
 * apply 级单测（同包双插件架构）：
 * - 核心插件 lib/index.js：inject=['tools','credentials','systemPrompt']，注册 account_list/credential_run/guard/prompt 段，不注册 account_fill；
 * - 代填插件 lib/fill-plugin.js：inject=['tools','credentials','browser']，只注册 account_fill；
 * - getArmRegistry 模块级单例：两个插件共享同一武装窗口（guard 在核心、arm 在代填）；
 * - headless 语义：核心插件在无 browser ctx 下正常注册；代填插件 apply 也不依赖 browser（browser 仅 execute 时访问）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../lib/index.js'
import * as fillPlugin from '../lib/fill-plugin.js'
import { getArmRegistry } from '../lib/guard.js'

function makeMockCtx({ withSystemPrompt = true, withBrowser = false } = {}) {
  const registered = []
  let guardFn = null
  const sections = []
  const warns = []
  const credentials = {
    async listRecords() {
      return [{ key: 'dsh-accounts/test-site', kind: 'api-key' }]
    },
    async readRecord(key) {
      if (key === 'dsh-accounts/test-site') {
        return {
          kind: 'grant',
          payload: { kind: 'account', domains: ['test.example.com'], fields: { username: 'fake-user', password: 'fake-pass-1234' } },
        }
      }
      return undefined
    },
  }
  const browser = withBrowser
    ? {
        async listTabs() {
          return [{ url: 'https://test.example.com/login', active: true }]
        },
        async detectChallenge() {
          return undefined
        },
        async setValue() {},
        async click() {},
        async key() {},
        async open(label) {
          return `session-${label}`
        },
      }
    : undefined
  const ctx = {
    credentials,
    logger: { warn: (m) => warns.push(m), info: () => {}, error: () => {} },
    tools: {
      register(def) {
        registered.push(def)
      },
      guard(fn) {
        guardFn = fn
      },
    },
  }
  if (withSystemPrompt) ctx.systemPrompt = { section: (s) => sections.push(s) }
  if (browser) ctx.browser = browser
  return { ctx, registered, getGuard: () => guardFn, sections, warns, browser }
}

// ---- inject 断言 ----

test('核心插件 inject 三元素：tools/credentials/systemPrompt（不含 browser）', () => {
  assert.deepEqual(core.inject, ['tools', 'credentials', 'systemPrompt'])
  assert.equal(core.name, 'dsh-accounts')
})

test('代填插件 inject 三元素：tools/credentials/browser，name 用子路径语义', () => {
  assert.deepEqual(fillPlugin.inject, ['tools', 'credentials', 'browser'])
  assert.equal(fillPlugin.name, 'dsh-accounts/fill')
})

// ---- 核心插件注册面 ----

test('核心 apply：注册 account_list + credential_run + guard，不注册 account_fill，prompt 段注册', () => {
  const { ctx, registered, getGuard, sections } = makeMockCtx()
  core.apply(ctx, {})
  assert.deepEqual(registered.map((d) => d.name).sort(), ['account_list', 'credential_run'])
  assert.equal(typeof getGuard(), 'function')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'accounts:guidance')
  assert.equal(sections[0].order, 150)
})

test('headless 语义：核心插件在无 browser ctx 下正常注册（ctx.browser 完全缺席）', () => {
  const { ctx, registered, getGuard, sections } = makeMockCtx({ withBrowser: false })
  core.apply(ctx, {}) // 不得因 browser 缺失抛错或跳过
  assert.deepEqual(registered.map((d) => d.name).sort(), ['account_list', 'credential_run'])
  assert.equal(typeof getGuard(), 'function')
  assert.equal(sections.length, 1)
})

test('headless：account_list 执行正常（仅元数据，无值）', async () => {
  const { ctx, registered } = makeMockCtx()
  core.apply(ctx, {})
  const list = registered.find((d) => d.name === 'account_list')
  const result = await list.execute({}, {})
  assert.equal(result.accounts.length, 1)
  assert.equal(result.accounts[0].id, 'test-site')
  assert.ok(!JSON.stringify(result).includes('fake-pass'))
})

// ---- 代填插件注册面 ----

test('代填插件 apply（无 browser mock）正常注册 account_fill（browser 仅 execute 时访问）', () => {
  const { ctx, registered } = makeMockCtx({ withBrowser: false })
  fillPlugin.apply(ctx, {}) // apply 阶段不访问 ctx.browser —— inject 保证存在，单测无 mock 也应注册成功
  assert.deepEqual(registered.map((d) => d.name), ['account_fill'])
})

test('代填插件执行链路：account_fill 真跑通并 arm 到共享单例', async () => {
  const { ctx, registered } = makeMockCtx({ withBrowser: true })
  fillPlugin.apply(ctx, {})
  const fill = registered.find((d) => d.name === 'account_fill')
  const result = await fill.execute(
    { account: 'test-site', mapping: [{ selector: '#user', field: 'username' }] },
    { agent: { id: 'agent-1' } },
  )
  assert.deepEqual(result.filled, ['#user'])
  assert.equal(result.submitted, false)
  // 真值绝不出现在结果
  assert.ok(!JSON.stringify(result).includes('fake-user'))
  // arm 落在共享单例上（sessionId = mock browser.open 的返回值 session-agent-1）
  const registry = getArmRegistry()
  assert.equal(registry.isArmed('session-agent-1'), true)
  registry.disarm('session-agent-1') // 清理，避免影响其他用例
})

// ---- 跨插件共享武装窗口（单例身份 + 功能） ----

test('getArmRegistry 单例身份：多次调用返回同一实例', () => {
  assert.equal(getArmRegistry(), getArmRegistry())
})

test('跨插件功能：核心 guard 拦截代填插件 arm 的窗口', async () => {
  const coreCtx = makeMockCtx()
  core.apply(coreCtx.ctx, {})
  const guard = coreCtx.getGuard()

  const fillCtx = makeMockCtx({ withBrowser: true })
  fillPlugin.apply(fillCtx.ctx, {})
  const fill = fillCtx.registered.find((d) => d.name === 'account_fill')

  // 未武装：放行
  assert.equal(guard({ name: 'browser_snapshot' }), undefined)

  // 代填插件 arm（经共享单例）
  await fill.execute(
    { account: 'test-site', mapping: [{ selector: '#user', field: 'username' }] },
    { agent: { id: 'agent-x' } },
  )
  // 核心插件的 guard 拦截读取类工具 —— 证明两个插件拿到同一注册表
  for (const tool of ['browser_get_value', 'browser_execute', 'browser_a11y', 'browser_snapshot', 'browser_scrape']) {
    const reason = guard({ name: tool })
    assert.ok(typeof reason === 'string' && reason.includes('dsh-accounts'), `${tool} 应被跨插件拦截`)
  }
  getArmRegistry().disarm('session-agent-x') // 清理
  assert.equal(guard({ name: 'browser_snapshot' }), undefined)
})
