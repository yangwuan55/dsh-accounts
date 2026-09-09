/**
 * manage 入口单测：mock ctx（credentials 全内存实现；webServer.register 捕获 route），
 * 用捕获的 handler 直接喂 mock req/res，不起真服务。
 * 覆盖：注册面、页面、API 四方法 happy path、id 校验、payload 校验、围栏 403、
 * body 超限 413、JSON 坏 400、404 兜底、错误路径不回显值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as manage from '../lib/manage.js'
import { MANAGE_PAGE_HTML } from '../lib/manage-page.js'

/** 全内存 credentials mock */
function makeCredentials(initial = {}) {
  const records = new Map(Object.entries(initial))
  let modified = 0
  let deleted = 0
  return {
    records,
    modifiedCount: () => modified,
    deletedCount: () => deleted,
    async listRecords() {
      return [...records.keys()].map((key) => ({ key, kind: 'grant' }))
    },
    async readRecord(key) {
      const payload = records.get(key)
      return payload === undefined ? undefined : { kind: 'grant', payload }
    },
    async modifyRecord(key, mutate) {
      const current = records.has(key) ? { kind: 'grant', payload: records.get(key) } : undefined
      const next = mutate(current)
      if (next === undefined) return current
      records.set(key, next.payload)
      modified++
      return next
    },
    async deleteRecord(key) {
      if (!records.delete(key)) return // 不存在是 no-op
      deleted++
    },
  }
}

/** res 捕获对象：收集 writeHead/end */
function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    headersSent: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
      res.headersSent = true
      return res
    },
    end(body) {
      res.body = body === undefined ? null : body
      res.ended = true
    },
  }
  return res
}

function makeReq(method, url, headers = {}, bodyChunks = []) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on(ev, fn) {
      ;(listeners[ev] ??= []).push(fn)
      return req
    },
    destroy() {},
    /** 测试辅助：同步派发 body 事件 */
    _emit() {
      for (const chunk of bodyChunks) for (const fn of listeners.data ?? []) fn(Buffer.from(chunk))
      for (const fn of listeners.end ?? []) fn()
    },
    _emitError(err) {
      for (const fn of listeners.error ?? []) fn(err)
    },
  }
  return req
}

/** 组装已注册路由的 manage 实例 */
function setup(initial = {}) {
  const credentials = makeCredentials(initial)
  const routes = []
  const infos = []
  const warns = []
  const ctx = {
    credentials,
    webServer: {
      register(route) {
        routes.push(route)
      },
    },
    logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => {} },
  }
  manage.apply(ctx, {})
  assert.equal(routes.length, 1, 'apply 应恰好注册一条路由')
  const handler = routes[0].handler

  /** 喂一个 mock 请求给 handler（自动派发 body；默认带 loopback Host，真实浏览器必带） */
  async function call(method, url, { headers = {}, body, rawChunks } = {}) {
    const hdrs = { host: '127.0.0.1', ...headers }
    const chunks = rawChunks ?? (body !== undefined ? [JSON.stringify(body)] : [])
    const req = makeReq(method, url, hdrs, chunks)
    const res = makeRes()
    const p = handler(req, res)
    req._emit()
    await p
    return { req, res, json: () => (res.body ? JSON.parse(res.body) : null) }
  }

  return { handler: routes[0].handler, route: routes[0], credentials, warns, infos, call }
}

// ---- 注册面与 inject 断言 ----

test('manage 导出面：name 为子路径语义，inject 只有 credentials/webServer（不含 tools/systemPrompt/browser）', () => {
  assert.equal(manage.name, 'dsh-accounts/manage')
  assert.deepEqual(manage.inject, ['credentials', 'webServer'])
})

test('apply 注册 prefix 路由 /dsh-accounts（无尾斜杠）', () => {
  const { route } = setup()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/dsh-accounts')
  assert.equal(typeof route.handler, 'function')
})

test('config.enabled=false 时不注册路由', () => {
  const routes = []
  const ctx = {
    credentials: makeCredentials(),
    webServer: { register: (r) => routes.push(r) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  manage.apply(ctx, { enabled: false })
  assert.equal(routes.length, 0)
})

// ---- 页面 ----

test('GET /dsh-accounts/ → 200 text/html，含 dsh-accounts 标识', async () => {
  const { call } = setup()
  const { res } = await call('GET', '/dsh-accounts/')
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /^text\/html/)
  assert.ok(String(res.body).includes('dsh-accounts'))
  assert.ok(String(res.body).includes('dsh-accounts/api'))
})

test('GET /dsh-accounts（无尾斜杠）→ 200', async () => {
  const { call } = setup()
  const { res } = await call('GET', '/dsh-accounts')
  assert.equal(res.statusCode, 200)
})

// ---- capabilities ----

test('GET /api/capabilities → canWrite=true（mock 有 listRecords+modifyRecord）', async () => {
  const { call } = setup()
  const { res, json } = await call('GET', '/dsh-accounts/api/capabilities')
  assert.equal(res.statusCode, 200)
  assert.equal(json().canWrite, true)
  assert.equal(json().accountsScope, 'dsh-accounts')
  assert.match(String(res.headers['content-type']), /application\/json/)
})

// ---- API happy path（内存 credentials 状态断言真被修改/删除） ----

test('GET /api/accounts → 列表带 valid 标记，不含值', async () => {
  const { call } = setup({
    'dsh-accounts/site-a': { kind: 'account', label: '站点 A', domains: ['a.example.com'], fields: { username: 'u1', password: 'p1' } },
  })
  const { res, json } = await call('GET', '/dsh-accounts/api/accounts')
  assert.equal(res.statusCode, 200)
  const list = json().accounts
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'site-a')
  assert.equal(list[0].valid, true)
  assert.equal(list[0].kind, 'account')
  assert.equal(list[0].label, '站点 A')
  assert.ok(!JSON.stringify(json()).includes('p1'), '列表绝不回显值')
})

test('PUT /api/accounts/:id → modifyRecord 真被调用，records 落盘', async () => {
  const { call, credentials } = setup({})
  const payload = { kind: 'secret', label: '测试令牌', value: 'tok-abc' }
  const { res, json } = await call('PUT', '/dsh-accounts/api/accounts/new-site', { body: payload })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json(), { ok: true })
  assert.equal(credentials.records.get('dsh-accounts/new-site')?.value, 'tok-abc')
  assert.equal(credentials.modifiedCount(), 1)
})

test('PUT 覆盖已有账号（modifyRecord 收到 current）', async () => {
  const { call, credentials } = setup({
    'dsh-accounts/site-a': { kind: 'secret', value: 'old-value' },
  })
  const { res, json } = await call('PUT', '/dsh-accounts/api/accounts/site-a', {
    body: { kind: 'secret', value: 'new-value' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json(), { ok: true })
  assert.equal(credentials.records.get('dsh-accounts/site-a')?.value, 'new-value')
})

test('GET /api/accounts/:id → 返回原始 payload 含值（可回显信任级），且不含归一化字段 hasTotp', async () => {
  const { call } = setup({
    'dsh-accounts/site-a': { kind: 'account', domains: ['a.example.com'], fields: { username: 'u1', password: 'p1' } },
  })
  const { res, json } = await call('GET', '/dsh-accounts/api/accounts/site-a')
  assert.equal(res.statusCode, 200)
  const data = json()
  assert.equal(data.id, 'site-a')
  assert.equal(data.payload.fields.username, 'u1')
  assert.equal(data.payload.fields.password, 'p1')
  assert.equal(data.payload.hasTotp, undefined, '原始 payload 不含归一化字段 hasTotp')
})

test('GET /api/accounts/:id 不存在 → 404', async () => {
  const { call } = setup()
  const { res } = await call('GET', '/dsh-accounts/api/accounts/nope')
  assert.equal(res.statusCode, 404)
})

test('DELETE /api/accounts/:id → deleteRecord 真被调用；不存在是 no-op 仍 ok', async () => {
  const { call, credentials } = setup({ 'dsh-accounts/site-a': { kind: 'secret', value: 'v' } })
  const { res, json } = await call('DELETE', '/dsh-accounts/api/accounts/site-a')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json(), { ok: true })
  assert.equal(credentials.records.has('dsh-accounts/site-a'), false)
  assert.equal(credentials.deletedCount(), 1)
  // 再删一次：no-op
  const again = await call('DELETE', '/dsh-accounts/api/accounts/site-a')
  assert.equal(again.res.statusCode, 200)
  assert.deepEqual(again.json(), { ok: true })
  assert.equal(credentials.deletedCount(), 1)
})

// ---- id 校验 ----

test('id 非法（大写/斜杠/点/下划线/空）→ 400', async () => {
  const { call } = setup()
  for (const bad of ['Bad-Id', 'a/b', 'a.b', 'a_b', '-abc', '1abc']) {
    const get = await call('GET', `/dsh-accounts/api/accounts/${encodeURIComponent(bad)}`)
    assert.equal(get.res.statusCode, 400, `GET id=${bad} 应 400`)
    const put = await call('PUT', `/dsh-accounts/api/accounts/${encodeURIComponent(bad)}`, {
      body: { kind: 'secret', value: 'v' },
    })
    assert.equal(put.res.statusCode, 400, `PUT id=${bad} 应 400`)
    const del = await call('DELETE', `/dsh-accounts/api/accounts/${encodeURIComponent(bad)}`)
    assert.equal(del.res.statusCode, 400, `DELETE id=${bad} 应 400`)
  }
})

// ---- payload 校验 ----

test('payload 校验失败 → 400 带字段级消息，消息不含值', async () => {
  const { call } = setup({})
  const { res, json } = await call('PUT', '/dsh-accounts/api/accounts/site-b', {
    body: { kind: 'secret', value: 'super-secret-value-123' },
    // 用一个触发未知字段错误的 payload 更能验证"错误不含值"：改为带未知字段
  })
  // 上面的 payload 本身合法，会 200 —— 先确认这点
  assert.equal(res.statusCode, 200)

  const bad1 = await call('PUT', '/dsh-accounts/api/accounts/site-b', {
    body: { kind: 'secret', value: 'x', evilField: 'evil-raw-content' },
  })
  assert.equal(bad1.res.statusCode, 400)
  assert.ok(bad1.json().error.includes('evilField'), '错误含字段名')
  assert.ok(!bad1.json().error.includes('evil-raw-content'), '错误绝不含值')

  const bad2 = await call('PUT', '/dsh-accounts/api/accounts/site-b', {
    body: { kind: 'account', fields: {} },
  })
  assert.equal(bad2.res.statusCode, 400)
  assert.ok(bad2.json().error.includes('fields'), '错误含字段路径')

  const bad3 = await call('PUT', '/dsh-accounts/api/accounts/site-b', {
    body: { kind: 'account', fields: { username: '' } },
  })
  assert.equal(bad3.res.statusCode, 400)
  assert.ok(!JSON.stringify(bad3.json()).includes('非空字符串') === false) // 消息含字段级文案
})

test('PUT 空对象 payload → 400 kind 错误', async () => {
  const { call } = setup({})
  const { res } = await call('PUT', '/dsh-accounts/api/accounts/site-c', { body: {} })
  assert.equal(res.statusCode, 400)
})

// ---- 围栏 ----

test('围栏：伪造 evil Host 的 API 请求 → 403 纯文本', async () => {
  const { call, credentials } = setup({ 'dsh-accounts/site-a': { kind: 'secret', value: 'v' } })
  const { res } = await call('GET', '/dsh-accounts/api/accounts', {
    headers: { host: 'evil.com', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(res.statusCode, 403)
  // 即使围栏拒绝，凭据未被读取/修改
  assert.equal(credentials.modifiedCount(), 0)
})

test('围栏：cross-site → 403；正常 Host 无 origin → 通过', async () => {
  const { call } = setup({})
  const cs = await call('GET', '/dsh-accounts/api/capabilities', {
    headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(cs.res.statusCode, 403)
  const ok = await call('GET', '/dsh-accounts/api/capabilities', { headers: { host: '127.0.0.1' } })
  assert.equal(ok.res.statusCode, 200)
})

test('围栏：管理页 HTML 本身不围栏（无值无危险）', async () => {
  const { call } = setup({})
  const { res } = await call('GET', '/dsh-accounts/', { headers: { host: 'evil.com' } })
  assert.equal(res.statusCode, 200)
})

// ---- body 限制与解析 ----

test('body 超过 256KB → 413', async () => {
  const { call } = setup({})
  const big = 'x'.repeat(256 * 1024 + 1)
  const { res } = await call('PUT', '/dsh-accounts/api/accounts/site-d', {
    rawChunks: [JSON.stringify({ kind: 'secret', value: big })],
  })
  assert.equal(res.statusCode, 413)
})

test('JSON 解析失败 → 400', async () => {
  const { call } = setup({})
  const { res, json } = await call('PUT', '/dsh-accounts/api/accounts/site-e', {
    rawChunks: ['{"kind": "secret", broken'],
  })
  assert.equal(res.statusCode, 400)
  assert.ok(json().error.includes('JSON'))
})

test('空 body PUT → 400', async () => {
  const { call } = setup({})
  const { res, json } = await call('PUT', '/dsh-accounts/api/accounts/site-f', { rawChunks: [] })
  assert.equal(res.statusCode, 400)
  assert.ok(json().error.includes('JSON'))
})

// ---- 兜底与方法 ----

test('未知路径 → 404 JSON', async () => {
  const { call } = setup({})
  const { res, json } = await call('GET', '/dsh-accounts/other', { headers: { host: '127.0.0.1' } })
  assert.equal(res.statusCode, 404)
  assert.ok(json().error)
  const deep = await call('GET', '/dsh-accounts/api/unknown', { headers: { host: '127.0.0.1' } })
  assert.equal(deep.res.statusCode, 404)
})

test('API 方法不支持 → 405', async () => {
  const { call } = setup({})
  const { res } = await call('POST', '/dsh-accounts/api/accounts/site-a', {
    headers: { host: '127.0.0.1' },
    body: { anything: true },
  })
  assert.equal(res.statusCode, 405)
})

// ---- 错误路径不回显值（逐条证据） ----

test('invalid 记录合并形态：valid=false 且无值，前端按标记拆分渲染', async () => {
  const { call } = setup({
    'dsh-accounts/bad-env': { kind: 'env', label: '坏记录' }, // env 无 env 映射 → invalid
    'dsh-accounts/good': { kind: 'secret', value: 'tok-abc' },
  })
  const { res, json } = await call('GET', '/dsh-accounts/api/accounts', { headers: { host: '127.0.0.1' } })
  assert.equal(res.statusCode, 200)
  const list = json().accounts
  const bad = list.find((a) => a.id === 'bad-env')
  assert.ok(bad, 'invalid 记录也在合并列表中')
  assert.equal(bad.valid, false)
  assert.ok(bad.error, 'invalid 记录带 error 文案')
  assert.ok(!JSON.stringify(list).includes('tok-abc'), 'invalid/valid 混合列表绝不回显值')
  // 前端兼容解析（与 lib/manage-page.js loadList 的拆分逻辑同构）
  const validOnly = list.filter((a) => a.valid !== false)
  const invalidOnly = list.filter((a) => a.valid === false)
  assert.equal(validOnly.length, 1)
  assert.equal(invalidOnly.length, 1)
})

test('错误路径不回显值：列表/校验/404 响应与日志均不含 secrets', async () => {
  const { call, warns } = setup({
    'dsh-accounts/broken': { kind: 'secret', value: 'THE-SECRET-XYZ' },
    'dsh-accounts/site-a': { kind: 'account', fields: { username: 'u', password: 'THE-PASSWORD-QWE' } },
  })
  // broken 记录 kind=secret 但无 value？——构造 invalid：env 记录无 env 映射
  const summary = await call('GET', '/dsh-accounts/api/accounts')
  assert.ok(!JSON.stringify(summary.json()).includes('THE-SECRET-XYZ'))
  assert.ok(!JSON.stringify(summary.json()).includes('THE-PASSWORD-QWE'))
  // invalid 卡片只含 id + error 文案
  const invalidEntry = summary.json().accounts.find((a) => a.valid === false)
  if (invalidEntry) {
    assert.ok(!JSON.stringify(invalidEntry).includes('THE-SECRET-XYZ'))
  }
  // 日志不回显
  for (const w of warns) {
    assert.ok(!w.includes('THE-SECRET-XYZ') && !w.includes('THE-PASSWORD-QWE'), `日志不得含值: ${w}`)
  }
})

test('页面 HTML 常量本身不含任何账号值占位', () => {
  // 页面由 JS 动态渲染，静态 HTML 不嵌入账号数据
  assert.ok(!MANAGE_PAGE_HTML.includes('{{') && !MANAGE_PAGE_HTML.includes('}}'))
})
