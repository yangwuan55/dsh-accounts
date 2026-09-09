/**
 * lib/guard.js — 武装窗口状态机 + 浏览器读取类工具拦截。
 *
 * 武装窗口：account_fill 成功代填后的一段 TTL。窗口内拦截可能读取表单值的
 * browser_* 工具（get_value/execute/a11y/snapshot/scrape），防止模型在代填后
 * 立即把 password 输入框的值读回对话。
 *
 * 导出：
 *   createArmRegistry({ now }?) -> registry { arm, disarm, isArmed, activeWindow, sweep }
 *   createGuardCallback(registry, { blockedTools? }?) -> (execution) => string | undefined
 */
/** 默认拦截的浏览器读取类工具名（常量表，运行时发现实际名称不同可在此调整） */
export const DEFAULT_BLOCKED_TOOLS = Object.freeze([
  'browser_get_value',
  'browser_execute',
  'browser_a11y',
  'browser_snapshot',
  'browser_scrape',
])

/**
 * @typedef {{ sessionId: string, until: number }} ArmWindow
 */

/**
 * 创建武装窗口注册表（内存态，随插件进程存活）。
 * @param {{ now?: () => number }} [opts] now 可注入以便测试
 */
export function createArmRegistry(opts = {}) {
  const now = opts.now ?? (() => Date.now())
  /** @type {Map<string, ArmWindow>} sessionId -> 窗口 */
  const windows = new Map()

  return {
    /**
     * 武装一个会话窗口（重复 arm 覆盖 TTL）。
     * @param {string} sessionId
     * @param {number} ttlMs 必须为正数，否则忽略
     * @returns {ArmWindow | undefined}
     */
    arm(sessionId, ttlMs) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined
      const window = { sessionId, until: now() + ttlMs }
      windows.set(sessionId, window)
      return window
    },

    /**
     * 解除某会话的武装（找不到是无害 no-op）。
     * @param {string} sessionId
     */
    disarm(sessionId) {
      windows.delete(sessionId)
    },

    /**
     * 某会话当前是否处于未过期武装窗口。
     * @param {string} sessionId
     */
    isArmed(sessionId) {
      const window = windows.get(sessionId)
      if (!window) return false
      if (window.until <= now()) {
        windows.delete(sessionId)
        return false
      }
      return true
    },

    /**
     * 任意会话的未过期武装窗口（guard 用：不区分会话，一律拦截）。
     * 过期窗口顺手清理。
     * @returns {ArmWindow & { remainingMs: number } | undefined}
     */
    activeWindow() {
      const t = now()
      for (const window of windows.values()) {
        if (window.until <= t) {
          windows.delete(window.sessionId)
          continue
        }
        return { ...window, remainingMs: window.until - t }
      }
      return undefined
    },

    /** 清掉全部过期窗口（可周期调用，纯内存维护）。 */
    sweep() {
      const t = now()
      for (const window of windows.values()) {
        if (window.until <= t) windows.delete(window.sessionId)
      }
    },
  }
}

/**
 * 创建 tools.guard 回调：命中武装窗口 + 拦截名单 -> 返回拒绝理由（回给模型）；
 * 否则返回 undefined 放行。
 * @param {ReturnType<typeof createArmRegistry>} registry
 * @param {{ blockedTools?: string[] }} [opts]
 * @returns {(execution: { name?: string }) => string | undefined}
 */
export function createGuardCallback(registry, opts = {}) {
  const blockedTools = opts.blockedTools ?? DEFAULT_BLOCKED_TOOLS
  const blockedSet = new Set(blockedTools)
  return (execution) => {
    if (!execution || typeof execution.name !== 'string') return undefined
    if (!blockedSet.has(execution.name)) return undefined
    const window = registry.activeWindow()
    if (!window) return undefined
    const seconds = Math.max(1, Math.ceil(window.remainingMs / 1000))
    return (
      `登录表单刚由 dsh-accounts 代填（值不透明）。此工具可能读取表单值，已被临时拦截；` +
      `请直接提交或等待 ${seconds} 秒后重试。`
    )
  }
}

/**
 * 模块级单例：跨插件共享同一个武装窗口注册表。
 *
 * 同包双插件架构下，guard 在核心插件（dsh-accounts）注册、arm 在代填插件
 * （dsh-accounts/fill）调用——两者必须拿到同一个注册表实例。
 * 同一 node 进程的模块缓存保证 getArmRegistry() 恒等。
 */
let singleton
export function getArmRegistry() {
  singleton ??= createArmRegistry()
  return singleton
}
