/**
 * credential_request（lib/request.js）单测。
 *
 * 起一个**真实的本地 HTTP 服务器**（不是 mock）：被测的正是「值有没有进请求头、
 * 有没有从响应里脱敏、重定向有没有被自动跟随」这些跨进程边界，mock 断言不了。
 * 凭据全是内存里的假值，不碰真实 credentials.yaml。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequestService } from '../lib/request.js'
import { secretEnvKey } from '../lib/accounts.js'

/** 起一台记请求头的本地服务器。 */
async function startEchoServer() {
  /** @type {Array<{method: string, url: string, headers: Record<string, string>, body: string}>} */
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (req.url === '/leak') {
        // 故意把收到的凭据回显出来：验证响应脱敏
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('token=' + String(req.headers.authorization ?? ''))
        return
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/elsewhere' })
        res.end()
        return
      }
      if (req.url === '/elsewhere') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('should-not-be-reached')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, auth: req.headers.authorization ?? null }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { seen, base: `http://127.0.0.1:${port}`, close: () => server.close() }
}

/** 账号服务替身：固定一张表。 */
function makeAccounts(table) {
  return {
    async get(id) {
      return table[id]
    },
    async listSummaries() {
      return {
        accounts: Object.entries(table).map(([id, a]) => ({ id, kind: a.kind, hasTotp: false })),
      }
    },
  }
}

const logs = []
const logger = {
  error: (m) => logs.push(String(m)),
  warn: (m) => logs.push(String(m)),
  info: (m) => logs.push(String(m)),
}

test('headerEnv 把账号 env 键的值注入请求头，模型看不到值', async () => {
  const s = await startEchoServer()
  try {
    const svc = createRequestService({
      ctx: { logger },
      accounts: makeAccounts({
        api: { id: 'api', kind: 'env', env: { API_TOKEN: 'sekret-abc-123' } },
      }),
      logger,
    })
    const r = await svc.request({
      accountId: 'api',
      url: s.base + '/v1/thing',
      method: 'POST',
      headerEnv: { Authorization: 'API_TOKEN' },
      body: '{"a":1}',
    })
    assert.equal(r.error, undefined)
    assert.equal(r.status, 200)
    assert.equal(s.seen[0].headers.authorization, 'sekret-abc-123', '凭据值应真的进了请求头')
    assert.equal(s.seen[0].body, '{"a":1}')
    assert.deepEqual(r.headersFromKeys, ['API_TOKEN'])
    assert.ok(!JSON.stringify(r).includes('sekret-abc-123'), '值不该出现在返回给模型的结果里')
  } finally {
    s.close()
  }
})

test('响应里回显了凭据 → 返回给模型前已脱敏', async () => {
  const s = await startEchoServer()
  try {
    const svc = createRequestService({
      ctx: { logger },
      accounts: makeAccounts({
        api: { id: 'api', kind: 'env', env: { API_TOKEN: 'sekret-abc-123' } },
      }),
      logger,
    })
    const r = await svc.request({
      accountId: 'api',
      url: s.base + '/leak',
      headerEnv: { Authorization: 'API_TOKEN' },
    })
    assert.equal(r.status, 200)
    assert.ok(!r.body.includes('sekret-abc-123'), '响应里的凭据必须被替换')
    assert.ok(r.body.includes('[REDACTED]'))
    assert.equal(r.redacted, true)
  } finally {
    s.close()
  }
})

test('3xx 重定向不自动跟随（防止把凭据带到别的 host）', async () => {
  const s = await startEchoServer()
  try {
    const svc = createRequestService({
      ctx: { logger },
      accounts: makeAccounts({
        api: { id: 'api', kind: 'env', env: { API_TOKEN: 'sekret-abc-123' } },
      }),
      logger,
    })
    const r = await svc.request({
      accountId: 'api',
      url: s.base + '/redirect',
      headerEnv: { Authorization: 'API_TOKEN' },
    })
    assert.equal(r.status, 302)
    assert.equal(r.location, '/elsewhere')
    assert.ok(!r.body.includes('should-not-be-reached'), '不该自动跟到 /elsewhere')
    assert.equal(s.seen.length, 1, '只应发出一次请求')
  } finally {
    s.close()
  }
})

test('域白名单：host 不命中 → 拒绝，不发请求', async () => {
  const s = await startEchoServer()
  try {
    const svc = createRequestService({
      ctx: { logger },
      accounts: makeAccounts({
        api: { id: 'api', kind: 'env', domains: ['api.example.com'], env: { API_TOKEN: 'x' } },
      }),
      logger,
    })
    const r = await svc.request({ accountId: 'api', url: s.base + '/v1' })
    assert.ok(r.error.includes('domains 白名单'))
    assert.equal(s.seen.length, 0, '被拒时不该发出任何请求')
  } finally {
    s.close()
  }
})

test('只支持 http/https', async () => {
  const svc = createRequestService({
    ctx: { logger },
    accounts: makeAccounts({ api: { id: 'api', kind: 'env', env: { API_TOKEN: 'x' } } }),
    logger,
  })
  const r = await svc.request({ accountId: 'api', url: 'file:///etc/passwd' })
  assert.ok(r.error.includes('只支持 http/https'))
})

test('headerEnv 指向不存在的键 → 报错并列出可注入键', async () => {
  const svc = createRequestService({
    ctx: { logger },
    accounts: makeAccounts({ api: { id: 'api', kind: 'env', env: { API_TOKEN: 'x' } } }),
    logger,
  })
  const r = await svc.request({
    accountId: 'api',
    url: 'https://api.example.com/v1',
    headerEnv: { Authorization: 'NOPE' },
  })
  assert.ok(r.error.includes('NOPE'))
  assert.deepEqual(r.injectableKeys, ['API_TOKEN'])
})

test('secret 单值令牌账号：用合成键发请求（0.4.0 新增能力）', async () => {
  const s = await startEchoServer()
  try {
    const svc = createRequestService({
      ctx: { logger },
      accounts: makeAccounts({
        'my-token': { id: 'my-token', kind: 'secret', value: 'single-secret-999' },
      }),
      logger,
    })
    assert.equal(secretEnvKey('my-token'), 'DSH_ACCOUNT_MY_TOKEN')
    const r = await svc.request({
      accountId: 'my-token',
      url: s.base + '/v1',
      headerEnv: { Authorization: 'DSH_ACCOUNT_MY_TOKEN' },
    })
    assert.equal(r.error, undefined)
    assert.equal(s.seen[0].headers.authorization, 'single-secret-999')
    assert.ok(!JSON.stringify(r).includes('single-secret-999'))
  } finally {
    s.close()
  }
})

test('envKeys 收窄可注入的键：被排除的键引用不了，且报错精确', async () => {
  const s = await startEchoServer()
  try {
    const svc = createRequestService({
      ctx: { logger },
      accounts: makeAccounts({
        api: { id: 'api', kind: 'env', env: { A_TOKEN: 'a-secret-value', B_TOKEN: 'b-secret-value' } },
      }),
      logger,
    })
    // envKeys 只留 A_TOKEN，headerEnv 却想用 B_TOKEN → 必须在发出请求前被拒
    const r = await svc.request({
      accountId: 'api',
      url: s.base + '/v1',
      headerEnv: { Authorization: 'B_TOKEN' },
      envKeys: ['A_TOKEN'],
    })
    assert.ok(r.error.includes('B_TOKEN'), '报错要点名被拒的键')
    assert.ok(r.error.includes('A_TOKEN'), '报错要列出收窄后还能用的键')
    assert.equal(s.seen.length, 0, '被拒时不该发出任何请求')
  } finally {
    s.close()
  }
})

test('envKeys 收窄后，用范围内的键可以正常发请求', async () => {
  const s = await startEchoServer()
  try {
    const svc = createRequestService({
      ctx: { logger },
      accounts: makeAccounts({
        api: { id: 'api', kind: 'env', env: { A_TOKEN: 'a-secret-value', B_TOKEN: 'b-secret-value' } },
      }),
      logger,
    })
    const r = await svc.request({
      accountId: 'api',
      url: s.base + '/v1',
      headerEnv: { Authorization: 'A_TOKEN' },
      envKeys: ['A_TOKEN'],
    })
    assert.equal(r.error, undefined)
    assert.equal(s.seen[0].headers.authorization, 'a-secret-value')
  } finally {
    s.close()
  }
})

test('账号不存在：报错含可用账号 id', async () => {
  const svc = createRequestService({
    ctx: { logger },
    accounts: makeAccounts({ api: { id: 'api', kind: 'env', env: { A: 'x' } } }),
    logger,
  })
  const r = await svc.request({ accountId: 'nope', url: 'https://example.com/' })
  assert.ok(r.error.includes('不存在'))
  assert.deepEqual(r.availableAccounts, ['api'])
})
