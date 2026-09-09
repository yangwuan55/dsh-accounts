/**
 * dsh-accounts — 核心插件（同包双插件架构的主入口）。
 *
 * cordis 的 inject 是硬门禁：apply 里访问未注入的服务（哪怕只是存在性检查）
 * 会抛 "cannot get property without inject"。因此本包按 cordis 原生语义拆成
 * 两个插件入口（见 lib/fill-plugin.js 与 README「部署形态」）：
 *
 * - 本文件 `dsh-accounts`：inject=['tools','credentials','systemPrompt']，
 *   注册 account_list、credential_run、guard、systemPrompt 指南。
 *   不访问 ctx.browser —— headless（无 browser 服务）下正常加载。
 * - `dsh-accounts/fill`（lib/fill-plugin.js）：inject=['tools','credentials','browser']，
 *   只注册 account_fill；headless 下该插件静默不加载，account_fill 自然缺席。
 *
 * 两个插件通过 guard.js 的模块级单例 getArmRegistry() 共享武装窗口注册表
 * （guard 在本插件注册、arm 在代填插件调用）。
 *
 * 值只在插件进程内存中流转：模型与对话只能看到账号名字与元数据，永远看不到值。
 */
import { createAccountsService } from './accounts.js'
import { createGuardCallback, DEFAULT_BLOCKED_TOOLS, getArmRegistry } from './guard.js'
import { createRunService } from './run.js'

export const name = 'dsh-accounts'
// 只声明本插件实际访问的服务。browser 属于代填插件（lib/fill-plugin.js）的 inject；
// 若在此声明 'browser'，headless profile 下本插件将永不加载，拖累 account_list/credential_run。
export const inject = ['tools', 'credentials', 'systemPrompt']

/** 生成多行文本 content block（模型与 UI 同看的形态） */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * 核心插件入口。
 * @param {any} ctx cordis 上下文（tools / credentials / systemPrompt / logger / on，均由 inject 保证存在）
 * @param {{ runTimeoutMs?: number, maxOutputChars?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const logger = {
    warn: (msg) => ctx?.logger?.warn?.(msg),
    info: (msg) => ctx?.logger?.info?.(msg),
    error: (msg) => ctx?.logger?.error?.(msg),
  }

  // ---- tools/credentials 兜底检查（正常部署由 inject 保证，不会触发） ----
  const hasCredentials = !!ctx.credentials
  const hasTools = !!ctx.tools && typeof ctx.tools.register === 'function'
  if (!hasCredentials) {
    logger.warn('[dsh-accounts] ctx.credentials 缺失，账号功能不可用，跳过工具注册')
    return
  }
  if (!hasTools) {
    logger.warn('[dsh-accounts] ctx.tools 缺失，无法注册任何工具')
    return
  }

  const accounts = createAccountsService(ctx, { logger })
  // 跨插件共享的武装窗口单例：guard 在这里注册，arm 在 dsh-accounts/fill 里调用
  const armRegistry = getArmRegistry()

  // ---- record-updated 监听（accounts 服务内部已注册：日志 + 缓存失效） ----

  // ---- guard：武装窗口内拦截读取类 browser_* 工具（根 ctx 注册 → 对所有 agent 生效） ----
  if (typeof ctx.tools.guard === 'function') {
    ctx.tools.guard(createGuardCallback(armRegistry))
  } else {
    logger.warn('[dsh-accounts] ctx.tools.guard 不可用，武装窗口拦截将不生效（代填仍可执行）')
  }

  // ---- account_list ----
  ctx.tools.register({
    name: 'account_list',
    description:
      '列出 dsh-accounts 插件管理的账号元数据（id / kind / label / 是否有 TOTP / 域白名单）。' +
      '只返回账号名字与元数据，绝不返回任何密码、密钥或验证码。需要用用户账号/API key 前先调用它看看有哪些账号。',
    parameters: { type: 'object', properties: {}, required: [] },
    timeoutMs: 10000,
    async execute() {
      const summary = await accounts.listSummaries()
      return summary
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: ['account', 'env', 'secret'] },
                label: { type: 'string' },
                hasTotp: { type: 'boolean' },
                domains: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'kind', 'hasTotp'],
            },
          },
          invalid: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, error: { type: 'string' } } } },
        },
        required: ['accounts'],
      },
      render(_args, value) {
        const list = value?.accounts ?? []
        if (list.length === 0 && !(value?.invalid?.length > 0)) {
          return textBlock('当前没有可用的 dsh-accounts 账号。可让用户在 ~/.dsh/.credentials.yaml 的 records 段添加 dsh-accounts/<id> 记录。')
        }
        const lines = list.map(
          (a) =>
            `- ${a.id}（kind=${a.kind}${a.label ? `，${a.label}` : ''}${a.hasTotp ? '，含 TOTP' : ''}${
              a.domains?.length ? `，域名白名单: ${a.domains.join('、')}` : ''
            }）`,
        )
        for (const bad of value?.invalid ?? []) {
          lines.push(`- ${bad.id}（记录损坏: ${bad.error}）`)
        }
        return textBlock(`共 ${list.length} 个账号（仅元数据，不含任何值）:\n${lines.join('\n')}`)
      },
    },
  })

  // ---- credential_run ----
  const runService = createRunService({ ctx, accounts, logger, config })
  ctx.tools.register({
    name: 'credential_run',
    description:
      '运行本地 CLI 并把账号的 API key/token 以环境变量注入（值不进对话、不进命令行参数）。' +
      '只注入账号 "env" 映射里声明的键；stdout/stderr 中的秘密值会被替换为 [REDACTED] 后返回。' +
      '适合运行需要 token 的 CLI（上传、发布、同步等），避免把密钥写进对话或 shell 历史。',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: '账号 id（先用 account_list 查看）' },
        command: { type: 'string', description: '可执行文件路径或名字（在 PATH 中查找）' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数' },
        envKeys: { type: 'array', items: { type: 'string' }, description: '要注入的环境变量键；缺省=账号 env 映射的全部键' },
        timeoutMs: { type: 'number', description: '超时毫秒数（默认 60000，超时先 SIGTERM 再 SIGKILL）' },
      },
      required: ['account', 'command'],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      return await runService.run({
        accountId: args?.account,
        command: args?.command,
        args: args?.args,
        envKeys: args?.envKeys,
        timeoutMs: args?.timeoutMs,
        signal: exec?.signal,
      })
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
          error: { type: 'string' },
          availableAccounts: { type: 'array', items: { type: 'string' } },
          injectableKeys: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        if (value?.error) {
          let text = `credential_run 失败: ${value.error}`
          if (value.availableAccounts?.length) text += `\n可用账号: ${value.availableAccounts.join('、')}`
          if (value.injectableKeys?.length) text += `\n该账号可注入的键: ${value.injectableKeys.join('、')}`
          return textBlock(text)
        }
        const parts = [`exitCode=${value.exitCode}${value.timedOut ? '（超时被终止）' : ''}`]
        if (value.stdout?.length) parts.push(`--- stdout ---\n${value.stdout}`)
        if (value.stderr?.length) parts.push(`--- stderr ---\n${value.stderr}`)
        parts.push('注：输出中的秘密值已替换为 [REDACTED]。')
        return textBlock(parts.join('\n'))
      },
    },
  })

  // ---- systemPrompt 指南（inject 保证 ctx.systemPrompt 存在，直接注册） ----
  ctx.systemPrompt.section({
    name: 'accounts:guidance',
    order: 150,
    text: [
      '## 账号与凭据使用（dsh-accounts）',
      '- 需要用用户的账号、密码或 API key 时，先用 account_list 查看有哪些账号（只看名字与元数据）。',
      '- 在浏览器登录页面时，用 account_fill 代填表单；永远不要向用户索要密码，也永远不要让用户把密码直接发在对话里。',
      '- 运行需要 token/API key 的本地 CLI 时，用 credential_run 以环境变量注入，不要把密钥放进命令参数或对话。',
      '- 账号的具体值（密码/密钥/验证码）对你不透明，也不要试图用其他工具读取它们；代填后的武装窗口内读取类 browser_* 工具会被拦截。',
    ].join('\n'),
  })

  logger.info(
    `[dsh-accounts] 核心插件已加载（account_list / credential_run / guard；` +
      `拦截工具: ${DEFAULT_BLOCKED_TOOLS.join(', ')}；` +
      `代填由 dsh-accounts/fill 提供）`,
  )
}
