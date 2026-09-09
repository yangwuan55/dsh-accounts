/**
 * dsh-accounts/manage — 网页管理界面（同包三插件的第三入口）。
 *
 * 挂在 DSH webServer 上（仅 web profile 存在该服务）：浏览器打开
 * http://127.0.0.1:3080/dsh-accounts/ 即可增删改查账号。
 *
 * cordis inject 硬门禁语义：
 * - inject=['credentials','webServer']；headless profile 无 webServer 服务
 *   → 本插件静默不加载，管理页自然缺席，现有两个入口零改动。
 * - apply 里只访问这两个服务，不碰 tools/systemPrompt/browser。
 *
 * 安全模型：
 * - 管理页静态 HTML 不围栏（无值无危险）；/api/* 全部过 trust.js 四条围栏
 *   （loopback Host / 拒 cross-site / origin 同源 / 不通过 403）。
 * - GET /api/accounts/:id 返回**原始 payload 含值**（用户已确认的"可回显"信任级）；
 *   注意不能返回 validateAccountPayload 的归一化产物——它会附加 hasTotp 字段，
 *   用户原样 PUT 回去会因"未知顶层字段"被 400，编辑回路断裂。
 * - 错误路径绝不回显值：错误消息来自 validateAccountPayload 的字段级文案
 *   （本来就无值），日志只记 id 与字节长度，不打印 body。
 * - 写能力探测（capabilities.canWrite）= listRecords 与 modifyRecord 都存在且为函数。
 *   这是最诚实的探测；若运行时写入仍被拒，写接口返回 { error }，页面 toast 展示。
 */
import { createAccountsService, validateAccountPayload } from './accounts.js'
import { isTrustedManageRequest } from './trust.js'
import { MANAGE_PAGE_HTML } from './manage-page.js'

export const name = 'dsh-accounts/manage'
export const inject = ['credentials', 'webServer']

const ACCOUNT_SCOPE = 'dsh-accounts'
/** 段语法（credentials 键语法）：id 必须匹配 */
const ID_RE = /^[a-z][a-z0-9-]*$/
/** 请求体上限（字节） */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 管理页插件入口。
 * @param {any} ctx cordis 上下文（credentials / webServer，均由 inject 保证存在）
 * @param {{ enabled?: boolean }} [config] enabled=false 时不注册路由（显式关闭管理页）
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return

  const logger = {
    warn: (msg) => ctx?.logger?.warn?.(msg),
    info: (msg) => ctx?.logger?.info?.(msg),
    error: (msg) => ctx?.logger?.error?.(msg),
  }

  const credentials = ctx.credentials
  // manage 入口自持 accounts 服务实例（无状态读，不与其它入口共享）
  const accounts = createAccountsService(ctx, { logger })

  // 写能力探测：listRecords 可列出 + modifyRecord 存在 → 视为可写。
  // 不做真实写探测（合法探测键会真写文件）；运行时被拒时由写接口返回 { error } 反馈。
  const canWrite =
    typeof credentials?.listRecords === 'function' && typeof credentials?.modifyRecord === 'function'

  /** JSON 响应 */
  function json(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  /** 围栏拒绝：403 纯文本（无凭据信息回显） */
  function forbidden(res) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
  }

  /**
   * 收集请求体（≤256KB）。返回 { ok:true, text } 或 { ok:false, status, error }。
   */
  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      let done = false
      const finish = (result) => {
        if (!done) {
          done = true
          resolve(result)
        }
      }
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          finish({ ok: false, status: 413, error: '请求体超过 256KB 上限' })
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
      req.on('error', () => finish({ ok: false, status: 400, error: '请求体读取失败' }))
    })
  }

  /** 解析路径里的账号 id 段并校验段语法；非法返回 undefined（调用方 400） */
  function idFromPath(pathname, prefix) {
    const raw = pathname.slice(prefix.length)
    let id
    try {
      id = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    return ID_RE.test(id) ? id : undefined
  }

  /**
   * 管理页 + API 的统一 handler（Node 原生 req/res，自己 end）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handler(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase()
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      // 极端情况：url 解析失败按根处理 → 落 404
    }

    try {
      // ---- 管理页（静态 HTML，不围栏：无值无危险） ----
      if (method === 'GET' && (pathname === '/dsh-accounts' || pathname === '/dsh-accounts/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(MANAGE_PAGE_HTML)
        return
      }

      // ---- API（全部过围栏） ----
      const API_BASE = '/dsh-accounts/api'
      if (pathname === API_BASE || pathname.startsWith(`${API_BASE}/`)) {
        if (!isTrustedManageRequest(req)) {
          forbidden(res)
          return
        }

        // GET /api/capabilities
        if (method === 'GET' && pathname === `${API_BASE}/capabilities`) {
          json(res, 200, { canWrite, accountsScope: ACCOUNT_SCOPE })
          return
        }

        // GET /api/accounts（列表：valid+invalid 合并为带 valid 标记的数组）
        if (method === 'GET' && pathname === `${API_BASE}/accounts`) {
          const summary = await accounts.listSummaries()
          const merged = [
            ...(summary.accounts ?? []).map((a) => ({ ...a, valid: true })),
            ...(summary.invalid ?? []).map((e) => ({ id: e.id, valid: false, error: e.error })),
          ]
          json(res, 200, { accounts: merged })
          return
        }

        // /api/accounts/:id
        const ID_PREFIX = `${API_BASE}/accounts/`
        if (pathname.startsWith(ID_PREFIX)) {
          const id = idFromPath(pathname, ID_PREFIX)
          if (id === undefined) {
            json(res, 400, { error: '账号 id 非法：必须匹配 ^[a-z][a-z0-9-]*$（小写字母开头，仅小写字母/数字/连字符）' })
            return
          }
          const key = `${ACCOUNT_SCOPE}/${id}`

          if (method === 'GET') {
            // 直读原始记录（不走归一化，保持 PUT 回写等价）
            const record = await credentials.readRecord(key)
            if (record === undefined) {
              json(res, 404, { error: `账号 ${id} 不存在` })
              return
            }
            const payload = record.kind === 'grant' ? record.payload : record
            json(res, 200, { id, payload })
            return
          }

          if (method === 'PUT') {
            if (!canWrite) {
              json(res, 503, { error: '凭据存储为只读，无法写入' })
              return
            }
            const body = await readBody(req)
            if (!body.ok) {
              json(res, body.status, { error: body.error })
              return
            }
            let payload
            try {
              payload = JSON.parse(body.text)
            } catch {
              json(res, 400, { error: '请求体不是合法 JSON' })
              return
            }
            try {
              validateAccountPayload(payload, id)
            } catch (err) {
              json(res, 400, { error: err instanceof Error ? err.message : String(err) })
              return
            }
            try {
              await credentials.modifyRecord(key, () => ({ kind: 'grant', payload }))
            } catch (err) {
              // 与 guard.js 同纪律：原文只进 logger，API 拿固定文案（存储层错误可能带路径/errno，不外传）
              const message = err instanceof Error ? err.message : String(err)
              logger.warn(`[dsh-accounts/manage] 写入失败: ${key} — ${message}`)
              json(res, 500, { error: '写入凭据存储失败（详情见服务日志）' })
              return
            }
            logger.info(`[dsh-accounts/manage] PUT ${key}（${body.text.length} 字符）`)
            json(res, 200, { ok: true })
            return
          }

          if (method === 'DELETE') {
            if (typeof credentials.deleteRecord !== 'function') {
              json(res, 503, { error: '凭据存储不支持删除' })
              return
            }
            try {
              await credentials.deleteRecord(key)
            } catch (err) {
              // 同上：原文只进 logger，API 拿固定文案
              const message = err instanceof Error ? err.message : String(err)
              logger.warn(`[dsh-accounts/manage] 删除失败: ${key} — ${message}`)
              json(res, 500, { error: '删除凭据记录失败（详情见服务日志）' })
              return
            }
            logger.info(`[dsh-accounts/manage] DELETE ${key}`)
            json(res, 200, { ok: true })
            return
          }

          json(res, 405, { error: '不支持的请求方法' })
          return
        }

        json(res, 404, { error: '未找到该 API 路径' })
        return
      }

      // ---- 兜底 ----
      json(res, 404, { error: '未找到' })
    } catch (err) {
      // handler 拥有完整响应生命周期；未发出头时才补 500
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`[dsh-accounts/manage] 请求处理异常: ${method} ${pathname} — ${message}`)
      if (!res.headersSent) {
        json(res, 500, { error: '管理服务内部错误' })
      } else {
        res.end()
      }
    }
  }

  // prefix 语义：匹配 /dsh-accounts 与 /dsh-accounts/<anything>；path 无尾斜杠
  ctx.webServer.register({ kind: 'prefix', path: '/dsh-accounts', handler })
  logger.info('[dsh-accounts/manage] 管理页已注册：/dsh-accounts/（/api/* 已启用 browser-trust 围栏）')
}
