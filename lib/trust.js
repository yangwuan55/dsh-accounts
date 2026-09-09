/**
 * lib/trust.js — 管理页 API 的 browser-trust fence。
 *
 * 语义照抄 DSH 官方 host/webserver 的 client/connection API 信任围栏
 * （client/connection/src/api-request-trust.ts:96-130），自实现、零依赖：
 *
 * 1. Host 头必须存在且 hostname 是 loopback（DNS-rebinding 防御）；
 * 2. sec-fetch-site: cross-site → 拒绝；
 * 3. 带 origin 头时必须与请求 Host 完全同源（scheme+host+port 规范化比较）；
 *    origin: null（沙箱 iframe / file:）拒绝；无 origin 头可以（Host fence 已绑定请求）。
 * 4. 不通过 → 调用方返回 403 纯文本。
 *
 * 管理页静态 HTML 不做围栏（无值无危险），只有 /api/* 做。
 * Node 的 req.headers 键已全小写，这里直接按小写键读，不重复小写化。
 */

/** 默认端口省略规则：比较 origin 与 Host 时按 scheme 补默认端口 */
const DEFAULT_PORT = { 'http:': '80', 'https:': '443' }

/**
 * hostname 是否为回环地址。覆盖：
 * - `localhost`（精确，大小写不敏感）
 * - `*.localhost` 后缀（mDNS 风格）
 * - `127.0.0.0/8`（逐段判断 IPv4：第一段恒 127，其余 0-255 数字）
 * - `::1`、`[::1]`（IPv6 回环，含方括号形式）
 * - `::`（全零地址，一并放行）
 * @param {string} hostname 已去端口、去方括号的 hostname（调用方负责）
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false
  const h = hostname.trim().toLowerCase()
  if (h.length === 0) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::') return true
  // IPv4 127.0.0.0/8：形如 a.b.c.d 且 a === '127'
  const parts = h.split('.')
  if (parts.length === 4) {
    const [a, b, c, d] = parts
    const segs = [a, b, c, d]
    if (segs.every((s) => /^\d{1,3}$/.test(s) && Number(s) >= 0 && Number(s) <= 255)) {
      return Number(a) === 127
    }
  }
  return false
}

/**
 * 从 Host 头提取 hostname（去端口；IPv6 方括号形式去括号）。
 * @param {string} hostValue Host 头原始值，如 '127.0.0.1:3080' 或 '[::1]:3080'
 * @returns {string} hostname（IPv6 已去方括号），解析失败返回空串
 */
function hostnameFromHostHeader(hostValue) {
  if (typeof hostValue !== 'string' || hostValue.length === 0) return ''
  const v = hostValue.trim()
  // [::1]:3080 → [::1]；[::1] → [::1]
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    if (end === -1) return ''
    return v.slice(1, end)
  }
  // 冒号数 > 1 是无括号 IPv6（如 ::1），直接整体当 hostname
  if ((v.match(/:/g) ?? []).length > 1) return v
  const colon = v.lastIndexOf(':')
  if (colon === -1) return v
  return v.slice(0, colon)
}

/**
 * Host 头的 port（缺省时按 scheme 补默认端口；无 scheme 信息时按 http 处理）。
 * @param {string} hostValue
 * @param {string} scheme 'http' 或 'https'（Origin 解析出的 scheme）
 * @returns {string}
 */
function portFromHostHeader(hostValue, scheme) {
  const v = hostValue.trim()
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    const after = end >= 0 ? v.slice(end + 1) : ''
    if (after.startsWith(':')) return after.slice(1)
    return DEFAULT_PORT[`${scheme}:`] ?? '80'
  }
  const colon = v.lastIndexOf(':')
  if (colon !== -1 && (v.match(/:/g) ?? []).length === 1) return v.slice(colon + 1)
  return DEFAULT_PORT[`${scheme}:`] ?? '80'
}

/**
 * 判断请求是否来自可信管理面（本机浏览器直连 DSH webServer）。
 * @param {{ headers?: Record<string, string | string[] | undefined> }} req Node IncomingMessage（mock 只需 headers）
 * @returns {boolean}
 */
export function isTrustedManageRequest(req) {
  const headers = req?.headers ?? {}

  const read = (name) => {
    const v = headers[name]
    if (Array.isArray(v)) return v[0]
    return v
  }

  // ---- 围栏 1：Host 必须存在、可解析、hostname 为 loopback ----
  const hostHeader = read('host')
  if (typeof hostHeader !== 'string' || hostHeader.trim().length === 0) return false
  const hostname = hostnameFromHostHeader(hostHeader)
  if (!isLoopbackHostname(hostname)) return false

  // ---- 围栏 2：sec-fetch-site: cross-site → 拒绝 ----
  const site = read('sec-fetch-site')
  if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') return false

  // ---- 围栏 3：带 origin 时必须与 Host 完全同源 ----
  const origin = read('origin')
  if (origin !== undefined) {
    const originText = typeof origin === 'string' ? origin.trim() : String(origin)
    if (originText.length === 0 || originText.toLowerCase() === 'null') return false
    let parsed
    try {
      parsed = new URL(originText)
    } catch {
      return false
    }
    const scheme = parsed.protocol.replace(/:$/, '')
    const originHost = parsed.hostname.toLowerCase()
    if (!isLoopbackHostname(originHost)) return false
    const originPort = parsed.port || (DEFAULT_PORT[`${scheme}:`] ?? '')
    const hostPort = portFromHostHeader(hostHeader, scheme)
    if (originPort !== hostPort) return false
    if (originHost !== hostname.toLowerCase()) return false
  }

  return true
}
