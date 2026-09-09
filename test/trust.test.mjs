/**
 * trust.js 单测——按官方 browser-trust fence 四条语义逐条验证。
 * mock req 只需 { headers }。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedManageRequest, isLoopbackHostname } from '../lib/trust.js'

function req(headers) {
  return { headers }
}

// ---- 围栏 1：Host 必须存在且 hostname 为 loopback ----

test('围栏1 Host: 127.0.0.1 → 通过', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1' })), true)
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1:3080' })), true)
})

test('围栏1 Host: evil.com → 拒绝（DNS-rebinding 防御）', () => {
  assert.equal(isTrustedManageRequest(req({ host: 'evil.com' })), false)
  assert.equal(isTrustedManageRequest(req({ host: 'evil.com:3080' })), false)
})

test('围栏1 无 Host 头 → 拒绝', () => {
  assert.equal(isTrustedManageRequest(req({})), false)
  assert.equal(isTrustedManageRequest(req({ host: '' })), false)
})

test('围栏1 IPv6：::1 与 [::1] → 通过', () => {
  assert.equal(isTrustedManageRequest(req({ host: '[::1]:3080' })), true)
  assert.equal(isTrustedManageRequest(req({ host: '[::1]' })), true)
})

test('围栏1 localhost 与 .localhost 后缀 → 通过', () => {
  assert.equal(isTrustedManageRequest(req({ host: 'localhost' })), true)
  assert.equal(isTrustedManageRequest(req({ host: 'localhost:3080' })), true)
  assert.equal(isTrustedManageRequest(req({ host: 'foo.localhost' })), true)
})

test('围栏1 127.0.0.0/8 全段 → 通过（127.x 逐段判断）', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.255.255.254' })), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
})

test('围栏1 相邻内网地址不误放（128.x/10.x/192.168）→ 拒绝', () => {
  assert.equal(isLoopbackHostname('128.0.0.1'), false)
  assert.equal(isLoopbackHostname('10.0.0.1'), false)
  assert.equal(isLoopbackHostname('192.168.1.1'), false)
})

// ---- 围栏 2：sec-fetch-site: cross-site → 拒绝（即使 Host 合法） ----

test('围栏2 sec-fetch-site: cross-site → 拒绝（Host 合法也一样拒）', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1', 'sec-fetch-site': 'cross-site' })), false)
})

test('围栏2 sec-fetch-site: same-origin / none → 通过', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1', 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1', 'sec-fetch-site': 'none' })), true)
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1' })), true) // 无该头也通过
})

// ---- 围栏 3：origin 必须与 Host 完全同源；origin: null 拒绝；无 origin 可以 ----

test('围栏3 origin 同源（http://127.0.0.1:3080，Host 127.0.0.1:3080）→ 通过', () => {
  assert.equal(
    isTrustedManageRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })),
    true,
  )
})

test('围栏3 origin 跨站（不同端口）→ 拒绝', () => {
  assert.equal(
    isTrustedManageRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })),
    false,
  )
})

test('围栏3 origin 跨站（不同 host，即使 loopback）→ 拒绝', () => {
  assert.equal(
    isTrustedManageRequest(req({ host: '127.0.0.1:3080', origin: 'http://localhost:3080' })),
    false,
  )
})

test('围栏3 origin: "null"（沙箱 iframe / file:）→ 拒绝', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1', origin: 'null' })), false)
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1', origin: 'NULL' })), false)
})

test('围栏3 无 origin 头 → 通过（Host fence 已绑定请求）', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1:3080' })), true)
})

test('围栏3 origin 默认端口省略归一化：origin http://127.0.0.1 与 Host 127.0.0.1:80 等价', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1:80', origin: 'http://127.0.0.1' })), true)
})

test('围栏3 origin 本身非 loopback → 拒绝', () => {
  assert.equal(
    isTrustedManageRequest(req({ host: '127.0.0.1:3080', origin: 'http://evil.com:3080' })),
    false,
  )
})

test('围栏3 origin 非法 URL → 拒绝', () => {
  assert.equal(isTrustedManageRequest(req({ host: '127.0.0.1', origin: 'not a url' })), false)
})
