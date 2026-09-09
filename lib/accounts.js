/**
 * lib/accounts.js — 从 ctx.credentials 读取并严格校验 dsh-accounts 账号记录。
 *
 * 账号真源：~/.dsh/.credentials.yaml 的 records: 空间里 scope 为 `dsh-accounts`
 * 的 grant 记录（文件 IO / 热重载 / 写锁由 credentials-local 负责，本模块只读）。
 *
 * 本模块绝不调用 set/unset/modifyRecord/deleteRecord。
 *
 * 导出：
 *   createAccountsService(ctx, { logger }) -> { listSummaries, get, resolveAll, invalidate }
 */
/** payload 顶层字段白名单——出现未知字段直接报错（不静默忽略） */
const TOP_LEVEL_FIELDS = Object.freeze(['kind', 'label', 'domains', 'fields', 'env', 'value'])
const ACCOUNT_SCOPE = 'dsh-accounts'
/** env 变量名规则 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** host 片段规则：小写字母数字与点和连字符，不以点/连字符开头结尾，无连续点 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/**
 * @typedef {Object} Account
 * @property {'account'|'env'|'secret'} kind
 * @property {string} [label]
 * @property {string[]} [domains]
 * @property {Record<string, string>} [fields]
 * @property {Record<string, string>} [env]
 * @property {string} [value]
 * @property {boolean} hasTotp
 */

/** 深比较（用于 JSON 往返等价防御） */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

/** 校验 host 片段（如 'github.com'、'127.0.0.1'） */
function isValidDomain(d) {
  return typeof d === 'string' && d.length > 0 && d.length <= 253 && DOMAIN_RE.test(d)
}

/**
 * 严格校验并归一化账号 payload。任何失败抛中文 Error；
 * 错误消息只含字段路径与账号 id，绝不含值本身。
 * @param {unknown} payload
 * @param {string} id 账号 id（用于错误定位）
 * @returns {Account}
 */
export function validateAccountPayload(payload, id) {
  const where = `账号 ${id}`
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${where}: payload 必须是普通对象`)
  }
  let roundTripped
  try {
    roundTripped = JSON.parse(JSON.stringify(payload))
  } catch {
    throw new Error(`${where}: payload 无法通过 JSON 往返`)
  }
  if (!deepEqual(payload, roundTripped)) {
    throw new Error(`${where}: payload 与其 JSON 往返结果不等价（含无法序列化的字段）`)
  }

  const p = /** @type {Record<string, unknown>} */ (payload)

  // 未知顶层字段直接报错，不静默
  const unknown = Object.keys(p).filter((k) => !TOP_LEVEL_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw new Error(`${where}: 存在未知的顶层字段 ${unknown.map((k) => `"${k}"`).join('、')}（允许的字段: ${TOP_LEVEL_FIELDS.join(', ')}）`)
  }

  const kind = p.kind
  if (kind !== 'account' && kind !== 'env' && kind !== 'secret') {
    throw new Error(`${where}: "kind" 必须是 'account' | 'env' | 'secret' 之一`)
  }

  // label
  if (p.label !== undefined) {
    if (typeof p.label !== 'string' || p.label.trim().length === 0) {
      throw new Error(`${where}: "label" 必须是非空字符串`)
    }
  }

  // domains
  /** @type {string[] | undefined} */
  let domains
  if (p.domains !== undefined) {
    if (!Array.isArray(p.domains) || p.domains.length === 0) {
      throw new Error(`${where}: "domains" 必须是非空字符串数组`)
    }
    for (let i = 0; i < p.domains.length; i++) {
      const d = p.domains[i]
      if (!isValidDomain(d)) {
        throw new Error(`${where}: "domains[${i}]" 不是合法的 host 片段（小写字母数字与点和连字符）`)
      }
    }
    domains = /** @type {string[]} */ (p.domains)
  }

  // fields
  /** @type {Record<string, string> | undefined} */
  let fields
  if (p.fields !== undefined) {
    if (p.fields === null || typeof p.fields !== 'object' || Array.isArray(p.fields)) {
      throw new Error(`${where}: "fields" 必须是对象`)
    }
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (p.fields))
    if (entries.length === 0) {
      throw new Error(`${where}: "fields" 不能为空对象（kind='account' 时必须含 username/password 等字段）`)
    }
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.trim().length === 0) {
        throw new Error(`${where}: "fields" 存在空键名`)
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${where}: "fields.${key}" 必须是非空字符串`)
      }
    }
    fields = Object.fromEntries(entries)
  }

  // env
  /** @type {Record<string, string> | undefined} */
  let env
  if (p.env !== undefined) {
    if (p.env === null || typeof p.env !== 'object' || Array.isArray(p.env)) {
      throw new Error(`${where}: "env" 必须是对象`)
    }
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (p.env))
    for (const [key, value] of entries) {
      if (!ENV_KEY_RE.test(key)) {
        throw new Error(`${where}: "env" 的键 "${key}" 不是合法环境变量名（[A-Za-z_][A-Za-z0-9_]*）`)
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${where}: "env.${key}" 必须是非空字符串`)
      }
    }
    env = Object.fromEntries(entries)
  }

  // 按 kind 收紧主体字段
  if (kind === 'account' && fields === undefined) {
    throw new Error(`${where}: kind='account' 必须提供 "fields"（至少包含 username/password 之一等字段）`)
  }
  if (kind === 'secret') {
    if (typeof p.value !== 'string' || p.value.length === 0) {
      throw new Error(`${where}: kind='secret' 必须提供非空字符串 "value"`)
    }
  }
  if (kind === 'env' && env === undefined) {
    throw new Error(`${where}: kind='env' 必须提供 "env" 映射`)
  }

  const hasTotp = fields !== undefined && Object.prototype.hasOwnProperty.call(fields, 'totpSecret')

  return {
    kind,
    ...(p.label !== undefined ? { label: /** @type {string} */ (p.label) } : {}),
    ...(domains !== undefined ? { domains } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(kind === 'secret' ? { value: /** @type {string} */ (p.value) } : {}),
    hasTotp,
  }
}

/**
 * 创建账号服务：封装 listRecords/readRecord + 校验 + 缓存 + record-updated 失效。
 * @param {{ credentials?: any, on?: (event: string, handler: (key: unknown) => void) => void }} ctx
 * @param {{ logger?: { warn?: (msg: string) => void, info?: (msg: string) => void } }} [opts]
 */
export function createAccountsService(ctx, opts = {}) {
  const logger = opts.logger ?? { warn() {}, info() {} }
  const credentials = ctx.credentials
  /** @type {Map<string, { account: Account }>} key -> 校验结果缓存 */
  const cache = new Map()

  // 监听记录更新：仅作日志 + 缓存失效（无需主动刷新，读取时再拉）
  if (typeof ctx.on === 'function') {
    ctx.on('credentials/record-updated', (key) => {
      const keyText = String(key)
      if (!keyText.startsWith(`${ACCOUNT_SCOPE}/`)) return
      cache.delete(keyText)
      logger.info(`[dsh-accounts] 账号记录已更新，缓存失效: ${keyText.slice(ACCOUNT_SCOPE.length + 1)}`)
    })
  }

  /**
   * 拉取全部 dsh-accounts 记录并校验。
   * @returns {Promise<{ accounts: Array<{ id: string, key: string, account: Account }>, errors: Array<{ id: string, error: string }> }>}
   */
  async function resolveAll() {
    const entries = await credentials.listRecords()
    const accounts = []
    const errors = []
    for (const entry of entries ?? []) {
      if (typeof entry?.key !== 'string' || !entry.key.startsWith(`${ACCOUNT_SCOPE}/`)) continue
      const id = entry.key.slice(ACCOUNT_SCOPE.length + 1)
      const cached = cache.get(entry.key)
      if (cached) {
        accounts.push({ id, key: entry.key, account: cached.account })
        continue
      }
      try {
        const record = await credentials.readRecord(entry.key)
        if (record === undefined) {
          throw new Error('记录不存在（可能刚被删除）')
        }
        const payload = record.kind === 'grant' ? record.payload : record
        const account = validateAccountPayload(payload, id)
        cache.set(entry.key, { account })
        accounts.push({ id, key: entry.key, account })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ id, error: message })
        logger.warn(`[dsh-accounts] 账号记录解析失败: ${id} — ${message}`)
      }
    }
    return { accounts, errors }
  }

  /**
   * account_list 工具的摘要视图（绝不含值）。
   */
  async function listSummaries() {
    const { accounts, errors } = await resolveAll()
    return {
      accounts: accounts.map(({ id, account }) => ({
        id,
        kind: account.kind,
        ...(account.label !== undefined ? { label: account.label } : {}),
        hasTotp: account.hasTotp,
        ...(account.domains !== undefined ? { domains: account.domains } : {}),
      })),
      ...(errors.length > 0 ? { invalid: errors } : {}),
    }
  }

  /**
   * 按 id 取账号；不存在返回 undefined，解析失败抛错（消息不含值）。
   * 成功时直接返回 Account 本体（调用方不需要包装元数据）。
   * @param {string} id
   * @returns {Promise<Account | undefined>}
   */
  async function get(id) {
    const { accounts, errors } = await resolveAll()
    const hit = accounts.find((a) => a.id === id)
    if (hit) return hit.account
    if (errors.some((e) => e.id === id)) {
      const detail = errors.find((e) => e.id === id)?.error
      throw new Error(`账号 "${id}" 存在但解析失败：${detail}`)
    }
    return undefined
  }

  /** 清空缓存（测试/手动刷新用） */
  function invalidate() {
    cache.clear()
  }

  return { listSummaries, get, resolveAll, invalidate }
}

/**
 * host 是否命中 domains 白名单（host === domain 或 host 以 '.' + domain 结尾）。
 * @param {string} host
 * @param {string[]} domains
 */
export function hostMatchesDomains(host, domains) {
  if (typeof host !== 'string' || host.length === 0) return false
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}
