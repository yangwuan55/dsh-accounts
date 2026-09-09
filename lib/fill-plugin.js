/**
 * dsh-accounts/fill — 代填子插件（同包双插件架构的子路径入口）。
 *
 * cordis 的 inject 是硬门禁：把 browser 放进核心插件会让 headless（无 browser
 * 服务）下整个插件无法加载。因此代填独立成入口，inject=['tools','credentials','browser']：
 * - web profile：核心插件 + 本插件都加载，account_fill 可用；
 * - headless profile：本插件因 browser 缺失静默不加载，account_fill 自然缺席，
 *   核心插件的 account_list / credential_run / guard 不受影响。
 *
 * 模块说明符语义（name='dsh-accounts/fill'）参考 dsh-builtin-browser 的子路径行。
 * apply 里不需要 systemPrompt/browser 存在性检查——inject 已保证；
 * account_fill 执行时仍保留 browser 能力兜底检查（返回结构化错误，不抛裸异常）。
 *
 * 武装窗口注册表通过 guard.js 的模块级单例 getArmRegistry() 与核心插件共享
 * （guard 在核心插件注册，arm 在本插件的代填成功路径调用）。
 */
import { createAccountsService } from './accounts.js'
import { getArmRegistry, DEFAULT_BLOCKED_TOOLS } from './guard.js'
import { createFillService } from './fill.js'

export const name = 'dsh-accounts/fill'
export const inject = ['tools', 'credentials', 'browser']

/** 生成多行文本 content block（模型与 UI 同看的形态） */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * 代填插件入口。
 * @param {any} ctx cordis 上下文（tools / credentials / browser，均由 inject 保证存在）
 * @param {{ armedWindowMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const logger = {
    warn: (msg) => ctx?.logger?.warn?.(msg),
    info: (msg) => ctx?.logger?.info?.(msg),
    error: (msg) => ctx?.logger?.error?.(msg),
  }

  const accounts = createAccountsService(ctx, { logger })
  // 与核心插件共享的武装窗口单例（跨插件：这里 arm，核心插件的 guard 据此拦截）
  const armRegistry = getArmRegistry()
  const fillService = createFillService({ ctx, accounts, armRegistry, logger, config })

  // ---- account_fill（本插件唯一工具） ----
  ctx.tools.register({
    name: 'account_fill',
    description:
      '在内置浏览器当前页面代填登录表单：从凭据存储取账号值，直接注入输入框，值不经过模型与对话。' +
      '成功后开启短暂的武装窗口（期间读取类 browser_* 工具会被拦截）。' +
      '登录页含人机验证（CAPTCHA）时不填任何字段，需人工完成。' +
      '参数 mapping 描述「CSS 选择器 → 字段」映射，field 可用 username / password / totp 或账号自定义字段名。',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: '账号 id（先用 account_list 查看）' },
        mapping: {
          type: 'array',
          description: 'CSS 选择器到字段的映射',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: '输入框 CSS 选择器' },
              field: { type: 'string', description: "字段名：'username' | 'password' | 'totp' | 账号自定义字段" },
            },
            required: ['selector', 'field'],
          },
        },
        submit: {
          type: 'object',
          description: '可选提交方式（二选一）',
          properties: {
            selector: { type: 'string', description: '提交按钮 CSS 选择器' },
            key: { type: 'string', enum: ['Enter'], description: '聚焦后按 Enter 提交' },
          },
        },
      },
      required: ['account', 'mapping'],
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const result = await fillService.fill({
        accountId: args?.account,
        mapping: args?.mapping,
        submit: args?.submit,
        agentId: exec?.agent?.id,
        signal: exec?.signal,
      })
      return result
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          filled: { type: 'array', items: { type: 'string' } },
          failed: { type: 'array', items: { type: 'object', properties: { selector: { type: 'string' }, reason: { type: 'string' } } } },
          submitted: { type: 'boolean' },
          challenge: { type: 'string' },
          error: { type: 'string' },
          availableAccounts: { type: 'array', items: { type: 'string' } },
          availableFields: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        if (value?.challenge === 'needs-human') {
          return textBlock('检测到人机验证（CAPTCHA/人机检查），未填任何字段。请在浏览器窗口人工完成验证后，再让我继续（可先刷新页面）。')
        }
        if (value?.error) {
          let text = `代填失败: ${value.error}`
          if (value.availableAccounts?.length) text += `\n可用账号: ${value.availableAccounts.join('、')}`
          if (value.availableFields?.length) text += `\n该账号可填字段: ${value.availableFields.join('、')}`
          if (value.failed?.length) text += `\n失败项: ${value.failed.map((f) => `${f.selector}（${f.reason}）`).join('、')}`
          return textBlock(text)
        }
        const lines = [`已代填 ${value.filled.length} 个字段: ${value.filled.join('、')}`]
        if (value.failed?.length) lines.push(`未填充: ${value.failed.map((f) => `${f.selector}（${f.reason}）`).join('、')}`)
        lines.push(value.submitted ? '已提交表单。' : '未提交（未提供 submit 或提交未确认）。')
        lines.push('注：代填期间读取表单值的 browser_* 工具被临时拦截（武装窗口），请勿尝试读取表单内容。')
        return textBlock(lines.join('\n'))
      },
    },
  })

  logger.info(
    `[dsh-accounts/fill] 代填插件已加载（account_fill；armedWindowMs=${config.armedWindowMs ?? 120000}；` +
      `武装窗口与核心插件共享，拦截工具: ${DEFAULT_BLOCKED_TOOLS.join(', ')}）`,
  )
}
