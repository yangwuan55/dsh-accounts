/**
 * 回归：cordis 代理下直触 ctx.browser 会抛
 * `cannot get property "browser" without inject`（inject 不含 browser 时）。
 * fill 执行期必须全程使用经 ctx.get('browser') 取得的对象，绝不直触 ctx.browser。
 * （0.3.0 半截重构：fill-plugin 改用 ctx.get，但 fill.js 仍直触 ctx.browser，
 * 导致线上每次 account_fill 都抛该错；单测用普通对象 mock 抓不住。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fillPlugin from '../lib/fill-plugin.js'
import { getArmRegistry } from '../lib/guard.js'

function makeBrowserSvc() {
  return {
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
}

/** cordis 式代理：直触 .browser 即抛，但 .get('browser') 正常返回 */
function makeCordisLikeCtx(browserSvc) {
  const registered = []
  const target = {
    credentials: {
      async listRecords() {
        return [{ key: 'dsh-accounts/test-site', kind: 'api-key' }]
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
        return undefined
      },
    },
    tools: {
      register(def) {
        registered.push(def)
      },
      guard() {},
    },
    get(name) {
      if (name === 'browser') return browserSvc
      return undefined
    },
  }
  const proxy = new Proxy(target, {
    get(t, prop, recv) {
      if (prop === 'browser') {
        throw new Error('cannot get property "browser" without inject')
      }
      return Reflect.get(t, prop, recv)
    },
  })
  return { proxy, registered }
}

test('cordis 代理：直触 ctx.browser 抛 without inject（前提确认）', () => {
  const { proxy } = makeCordisLikeCtx(makeBrowserSvc())
  assert.throws(
    () => void proxy.browser,
    /without inject/,
  )
})

test('cordis 代理：apply 注册 account_fill 且 execute 全程不抛并成功代填', async () => {
  const browserSvc = makeBrowserSvc()
  const { proxy, registered } = makeCordisLikeCtx(browserSvc)
  fillPlugin.apply(proxy, {})
  assert.deepEqual(registered.map((d) => d.name), ['account_fill'])
  const fill = registered.find((d) => d.name === 'account_fill')
  const result = await fill.execute(
    { account: 'test-site', mapping: [{ selector: '#user', field: 'username' }] },
    { agent: { id: 'agent-cordis' } },
  )
  assert.deepEqual(result.filled, ['#user'])
  assert.equal(result.submitted, false)
  assert.ok(!JSON.stringify(result).includes('fake-user'))
  const registry = getArmRegistry()
  assert.equal(registry.isArmed('session-agent-cordis'), true)
  registry.disarm('session-agent-cordis')
})
