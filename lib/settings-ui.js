/**
 * 浏览器半边：把账号管理面做成 DSH 设置面板里的一个分区（`settings.section`）。
 *
 * 为什么不复用 `manage.js` 那个独立页：该页要用户自己记住
 * `http://127.0.0.1:3080/dsh-accounts/` 这个网址；而 DSH 的设置面板本身支持插件
 * 注册分区（同 `dsh-mnemon` 的「记忆」、`dsh-im` 的「IM机器人」）。两者并存：
 * 页面仍在（直连、脚本友好），设置区只是多一个入口。
 *
 * 本文件是 **DSH 客户端模块系统的 bundle**，不是普通 ESM：Web 外壳以经典脚本加载
 * 它，`factory` 收到的 `require` 从 platform module 表解析依赖（React 与 UI 组件
 * 都在表里），因此本包**不新增任何依赖**、也不需要构建步骤——与宿主半边一样保持
 * 零依赖。
 *
 * 数据仍走本包自己那套 `/dsh-accounts/api`：同源请求恰好通过管理页的信任围栏
 * （loopback Host + 同源 origin），因此这里不重复实现读写逻辑，也不接触
 * credentials 服务。账号值只在一次 fetch 的往返里出现，不进模型上下文。
 *
 * 排版照 DSH 一方设置区的规范（`packages/client/ui-agent-preset` 的
 * AgentPresetSection.module.css）：分区限宽 720、gap 12，标题 18/600，说明 13 +
 * label-tertiary，分组小标题 12/600；颜色一律用 `--dsw-alias-*` 令牌而非
 * opacity，控件用组件的默认尺寸档。
 * @module dsh-accounts/settings-ui
 */
window.__ModuleLoader__.load({
  id: 'dsh-accounts',
  factory: (require) => {
    const React = require('react')
    const {
      Button,
      IconPlusOutline16,
      IconRefreshOutline16,
      Input,
      Modal,
      StateDot,
      Tag,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** 本包管理接口前缀。 */
    const API = '/dsh-accounts/api'

    /** 账号 id 规则，与宿主侧 `validateAccountPayload` 之前的路径校验一致。 */
    const ID_RE = /^[a-z][a-z0-9-]*$/

    /** 环境变量名规则，与宿主侧一致。 */
    const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

    /** 三种账号类型及其在宿主侧的语义。 */
    const KINDS = [
      { value: 'account', label: '登录表单', hint: '浏览器代填用的用户名/密码等字段' },
      { value: 'env', label: '环境变量', hint: 'credential_run 注入子进程的 KEY=VALUE' },
      { value: 'secret', label: '单值令牌', hint: '单个 API Key / Token' },
    ]

    /** 主题令牌：颜色一律走这里，深浅色主题才会自动跟随。 */
    const TOKEN = {
      primary: 'var(--dsw-alias-label-primary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      error: 'var(--dsw-alias-label-error)',
      border: 'var(--dsw-alias-border-subtle)',
      fill: 'var(--dsw-alias-fill-tsp-secondary)',
    }

    /** 分区外壳：与一方 section 同样的限宽与间距。 */
    const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, color: TOKEN.primary }

    /** 分区标题（18px/600）。 */
    const titleStyle = { margin: 0, fontSize: 18, fontWeight: 600 }

    /** 说明段落（13px + label-tertiary）。 */
    const introStyle = { margin: 0, fontSize: 13, color: TOKEN.tertiary, lineHeight: 1.5 }

    /** 分组小标题（12px/600）。 */
    const groupHeadStyle = { margin: 0, fontSize: 12, fontWeight: 600, color: TOKEN.tertiary }

    /** 表单字段标签，与分组小标题同档。 */
    const labelStyle = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: TOKEN.tertiary }

    /** 列表外框：细边框 + 圆角，行间只用分隔线。 */
    const listStyle = { border: `1px solid ${TOKEN.border}`, borderRadius: 10, overflow: 'hidden' }

    /** 等宽字体，用于展示 id 与凭据键。 */
    const monoStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }

    /** 一处内联提示：error 用 label-error，其余用 label-tertiary。 */
    function noticeStyle(tone) {
      return {
        padding: '8px 12px',
        borderRadius: 8,
        fontSize: 13,
        color: tone === 'error' ? TOKEN.error : TOKEN.tertiary,
        background: TOKEN.fill,
      }
    }

    /** 横向排布工具：默认两端对齐。 */
    function Row({ children, justify = 'space-between' }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: justify } }, children)
    }

    /**
     * 调一次管理接口。
     * @param {string} path 相对 `/dsh-accounts/api` 的路径。
     * @param {RequestInit} [init] 可选的 fetch 初始化。
     * @returns {Promise<any>} 解析后的 JSON 载荷。
     * @throws {Error} 非 2xx 时抛宿主返回的 `error` 文案。
     */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      let payload
      if (text.length > 0) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = undefined
        }
      }
      if (!response.ok) throw new Error(payload?.error ?? `管理接口返回 HTTP ${response.status}`)
      return payload
    }

    /** @returns {object} 新建草稿的初值。 */
    function emptyDraft() {
      return {
        id: '',
        kind: 'account',
        label: '',
        domains: '',
        fields: [{ name: 'username', value: '' }, { name: 'password', value: '' }],
        env: [{ name: '', value: '' }],
        value: '',
      }
    }

    /**
     * 由接口返回的 payload 还原成编辑草稿。
     * @param {string} id 账号 id。
     * @param {object|undefined} payload `GET /accounts/<id>` 返回的原始记录。
     * @returns {object} 可直接编辑的草稿。
     */
    function draftFrom(id, payload) {
      const rows = (record) => Object.entries(record ?? {}).map(([name, value]) => ({ name, value: String(value) }))
      return {
        id,
        kind: payload?.kind ?? 'account',
        label: payload?.label ?? '',
        domains: Array.isArray(payload?.domains) ? payload.domains.join(', ') : '',
        fields: rows(payload?.fields).length > 0 ? rows(payload.fields) : [{ name: '', value: '' }],
        env: rows(payload?.env).length > 0 ? rows(payload.env) : [{ name: '', value: '' }],
        value: typeof payload?.value === 'string' ? payload.value : '',
      }
    }

    /**
     * 按类型组装 PUT 载荷，并做与宿主同规则的即时校验。
     *
     * 这里只做"早失败"：真正的裁决仍在宿主 `validateAccountPayload`，本节不复制
     * 它的全部规则（例如域名的 host 片段校验），避免两处规则漂移。
     * @param {object} draft 编辑草稿。
     * @returns {object} PUT 载荷。
     * @throws {Error} 不合法时抛错，文案直接可展示。
     */
    function payloadOf(draft) {
      if (!ID_RE.test(draft.id)) throw new Error('账号 id 必须小写字母开头，仅小写字母/数字/连字符')
      const named = (list, check) => {
        const entries = []
        for (const row of list) {
          const name = row.name.trim()
          if (name.length === 0 && row.value.length === 0) continue
          if (name.length === 0) throw new Error('存在没有字段名的行')
          if (row.value.length === 0) throw new Error(`字段 "${name}" 的值不能为空`)
          if (check !== undefined && !check.test(name)) throw new Error(`"${name}" 不是合法环境变量名`)
          entries.push([name, row.value])
        }
        return Object.fromEntries(entries)
      }
      const base = draft.label.trim().length > 0 ? { label: draft.label.trim() } : {}
      if (draft.kind === 'account') {
        const domains = draft.domains.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        const fields = named(draft.fields)
        if (Object.keys(fields).length === 0) throw new Error('登录表单账号至少要有一个字段（如 username / password）')
        return { kind: 'account', ...base, ...(domains.length > 0 ? { domains } : {}), fields }
      }
      if (draft.kind === 'env') {
        const env = named(draft.env, ENV_RE)
        if (Object.keys(env).length === 0) throw new Error('环境变量账号至少要有一个 KEY=VALUE')
        return { kind: 'env', ...base, env }
      }
      if (draft.value.length === 0) throw new Error('单值令牌不能为空')
      return { kind: 'secret', ...base, value: draft.value }
    }

    /** 字段名 + 值（打码 + 显示/隐藏）+ 删除，一行。 */
    function FieldRow({ row, namePlaceholder, onChange, onRemove }) {
      const [shown, setShown] = useState(false)
      return h(
        Row,
        { justify: 'flex-start' },
        h('div', { style: { flex: '0 0 168px' } }, h(Input, {
          value: row.name,
          placeholder: namePlaceholder,
          onChange: (event) => onChange({ ...row, name: event.target.value }),
        })),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h(Input, {
          type: shown ? 'text' : 'password',
          value: row.value,
          placeholder: '值',
          autoComplete: 'off',
          onChange: (event) => onChange({ ...row, value: event.target.value }),
        })),
        h(Button, { variant: 'ghost', onClick: () => setShown((value) => !value) }, shown ? '隐藏' : '显示'),
        h(Button, { variant: 'ghost', onClick: onRemove }, '删除'),
      )
    }

    /**
     * 列表里的一行账号。
     * @param {object} props.account 列表项（含 valid / kind / label / domains / hasTotp）。
     * @param {boolean} props.first 是否首行（首行不画上分隔线）。
     */
    function AccountRow({ account, canWrite, first, onEdit, onDelete }) {
      const kind = KINDS.find((entry) => entry.value === account.kind)
      const meta = account.valid === true
        ? [
          account.label,
          Array.isArray(account.domains) && account.domains.length > 0 ? `域名：${account.domains.join(', ')}` : undefined,
        ].filter(Boolean).join(' · ') || '未填写描述'
        : account.error
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            borderTop: first ? 'none' : `1px solid ${TOKEN.border}`,
          },
        },
        h(StateDot, { state: account.valid ? 'done' : 'error' }),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            Row,
            { justify: 'flex-start' },
            h('span', { style: { ...monoStyle, fontSize: 13, fontWeight: 600 } }, account.id),
            h(Tag, { tone: 'outline' }, kind?.label ?? account.kind),
            account.hasTotp === true ? h(Tag, { tone: 'outline' }, 'TOTP') : null,
            account.valid !== true ? h(Tag, { tone: 'outline' }, '读取失败') : null,
          ),
          h(
            'div',
            {
              style: {
                fontSize: 12,
                color: TOKEN.tertiary,
                marginTop: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            meta,
          ),
        ),
        canWrite
          ? h(
            Row,
            { justify: 'flex-end' },
            h(Button, { variant: 'ghost', onClick: () => onEdit(account.id) }, '编辑'),
            h(Button, { variant: 'ghost', onClick: () => onDelete(account.id) }, '删除'),
          )
          : null,
      )
    }

    /** 设置面板里的账号分区。 */
    function AccountsSection() {
      const [accounts, setAccounts] = useState([])
      const [canWrite, setCanWrite] = useState(true)
      const [loading, setLoading] = useState(true)
      const [notice, setNotice] = useState(undefined)
      const [draft, setDraft] = useState(undefined)
      const [saving, setSaving] = useState(false)
      const [pendingDelete, setPendingDelete] = useState(undefined)

      /** 重新拉列表与可写能力。 */
      const refresh = useCallback(async () => {
        setLoading(true)
        try {
          const [list, capabilities] = await Promise.all([api('/accounts'), api('/capabilities')])
          setAccounts(Array.isArray(list?.accounts) ? list.accounts : [])
          setCanWrite(capabilities?.canWrite !== false)
          setNotice(undefined)
        } catch (error) {
          setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      /** 打开编辑：先按 id 取原始记录，保证值可预填（列表接口不回值）。 */
      const beginEdit = useCallback(async (id) => {
        try {
          const record = await api(`/accounts/${id}`)
          setDraft(draftFrom(id, record?.payload))
          setNotice(undefined)
        } catch (error) {
          setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      /** 保存草稿（PUT 幂等写入）。 */
      const save = useCallback(async () => {
        setSaving(true)
        try {
          const payload = payloadOf(draft)
          await api(`/accounts/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) })
          setDraft(undefined)
          // 刷新会把提示清空，所以成功文案在刷新之后再落，否则用户看不到它。
          await refresh()
          setNotice({ tone: 'ok', text: `已保存 ${draft.id}` })
        } catch (error) {
          setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setSaving(false)
        }
      }, [draft, refresh])

      /** 删除确认后执行。 */
      const confirmDelete = useCallback(async () => {
        const id = pendingDelete
        setPendingDelete(undefined)
        try {
          await api(`/accounts/${id}`, { method: 'DELETE' })
          await refresh()
          setNotice({ tone: 'ok', text: `已删除 ${id}` })
        } catch (error) {
          setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
        }
      }, [pendingDelete, refresh])

      const rows = useMemo(() => accounts, [accounts])
      const kindHint = KINDS.find((entry) => entry.value === draft?.kind)?.hint
      const isExisting = draft !== undefined && accounts.some((account) => account.id === draft.id)

      /** 改草稿里某一类行列表中的一行。 */
      const editRow = (listKey, index, next) => {
        setDraft((current) => {
          const list = [...current[listKey]]
          list[index] = next
          return { ...current, [listKey]: list }
        })
      }

      return h(
        'div',
        { style: sectionStyle },
        h('h2', { style: titleStyle }, '账号'),
        h(
          'p',
          { style: introStyle },
          '账号值存于本机凭据存储（',
          h('span', { style: monoStyle }, '~/.dsh/.credentials.yaml'),
          '，0600），模型只看得到名字与元数据。',
        ),
        h(
          Row,
          null,
          h('p', { style: groupHeadStyle }, rows.length > 0 ? `已配置 ${rows.length} 个账号` : '尚未配置账号'),
          h(
            Row,
            { justify: 'flex-end' },
            h(Button, { variant: 'ghost', icon: h(IconRefreshOutline16), onClick: () => void refresh(), disabled: loading }, '刷新'),
            h(Button, { variant: 'primary', icon: h(IconPlusOutline16), onClick: () => setDraft(emptyDraft()), disabled: !canWrite }, '新建账号'),
          ),
        ),
        notice !== undefined ? h('div', { style: noticeStyle(notice.tone) }, notice.text) : null,
        canWrite ? null : h('div', { style: noticeStyle('error') }, '凭据存储当前为只读，无法新建或修改账号。'),
        h(
          'div',
          { style: listStyle },
          rows.length === 0
            ? h('div', { style: { padding: 14, fontSize: 13, color: TOKEN.tertiary } },
              loading ? '正在读取…' : '暂无账号。点右上角「新建账号」添加。')
            : rows.map((account, index) => h(AccountRow, {
              key: account.id,
              account,
              canWrite,
              first: index === 0,
              onEdit: (id) => void beginEdit(id),
              onDelete: (id) => setPendingDelete(id),
            })),
        ),
        h(
          Modal,
          {
            open: draft !== undefined,
            onClose: () => setDraft(undefined),
            title: isExisting ? `编辑账号 ${draft.id}` : '新建账号',
            closeLabel: '关闭',
            description: 'id 决定凭据键 dsh-accounts/<id>，创建后不可修改。',
            footer: h(
              Row,
              { justify: 'flex-end' },
              h(Button, { variant: 'ghost', onClick: () => setDraft(undefined) }, '取消'),
              h(Button, { variant: 'primary', onClick: () => void save(), disabled: saving }, saving ? '保存中…' : '保存'),
            ),
          },
          draft === undefined ? null : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
            h('label', { style: labelStyle }, '账号 id', h(Input, {
              value: draft.id,
              placeholder: 'github-main',
              disabled: isExisting,
              onChange: (event) => setDraft({ ...draft, id: event.target.value }),
            })),
            h(
              'div',
              { style: labelStyle },
              '类型',
              h(
                Row,
                { justify: 'flex-start' },
                KINDS.map((entry) => h(Button, {
                  key: entry.value,
                  variant: draft.kind === entry.value ? 'primary' : 'outline',
                  onClick: () => setDraft({ ...draft, kind: entry.value }),
                }, entry.label)),
              ),
              kindHint !== undefined ? h('span', { style: { fontWeight: 400 } }, kindHint) : null,
            ),
            h('label', { style: labelStyle }, '描述（可选，模型可见）', h(Input, {
              value: draft.label,
              placeholder: 'GitHub 主账号',
              onChange: (event) => setDraft({ ...draft, label: event.target.value }),
            })),
            draft.kind === 'account' ? h(
              React.Fragment,
              null,
              h('label', { style: labelStyle }, '域名白名单（可选，逗号分隔；account_fill 只在这些域上代填）', h(Input, {
                value: draft.domains,
                placeholder: 'github.com, api.github.com',
                onChange: (event) => setDraft({ ...draft, domains: event.target.value }),
              })),
              h(
                'div',
                { style: labelStyle },
                '字段',
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 } },
                  draft.fields.map((row, index) => h(FieldRow, {
                    key: index,
                    row,
                    namePlaceholder: 'username',
                    onChange: (next) => editRow('fields', index, next),
                    onRemove: () => setDraft({ ...draft, fields: draft.fields.filter((_, at) => at !== index) }),
                  })),
                ),
                h('div', { style: { marginTop: 4 } }, h(Button, {
                  variant: 'ghost',
                  icon: h(IconPlusOutline16),
                  onClick: () => setDraft({ ...draft, fields: [...draft.fields, { name: '', value: '' }] }),
                }, '加字段')),
              ),
            ) : null,
            draft.kind === 'env' ? h(
              'div',
              { style: labelStyle },
              '环境变量（credential_run 注入）',
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 } },
                draft.env.map((row, index) => h(FieldRow, {
                  key: index,
                  row,
                  namePlaceholder: 'API_KEY',
                  onChange: (next) => editRow('env', index, next),
                  onRemove: () => setDraft({ ...draft, env: draft.env.filter((_, at) => at !== index) }),
                })),
              ),
              h('div', { style: { marginTop: 4 } }, h(Button, {
                variant: 'ghost',
                icon: h(IconPlusOutline16),
                onClick: () => setDraft({ ...draft, env: [...draft.env, { name: '', value: '' }] }),
              }, '加变量')),
            ) : null,
            draft.kind === 'secret' ? h('label', { style: labelStyle }, '令牌值', h(Input, {
              type: 'password',
              autoComplete: 'off',
              value: draft.value,
              placeholder: '粘贴 API Key / Token',
              onChange: (event) => setDraft({ ...draft, value: event.target.value }),
            })) : null,
          ),
        ),
        h(
          Modal,
          {
            open: pendingDelete !== undefined,
            onClose: () => setPendingDelete(undefined),
            title: `删除账号 ${pendingDelete ?? ''}`,
            closeLabel: '关闭',
            description: '这会从凭据存储里移除该账号及其全部字段值，无法撤销。',
            footer: h(
              Row,
              { justify: 'flex-end' },
              h(Button, { variant: 'ghost', onClick: () => setPendingDelete(undefined) }, '取消'),
              h(Button, { variant: 'primary', onClick: () => void confirmDelete() }, '删除'),
            ),
          },
          h('div', { style: { fontSize: 13 } }, '确认删除 ', h('span', { style: monoStyle }, pendingDelete), ' 吗？'),
        ),
      )
    }

    /**
     * 注册设置分区。
     * @param {object} ctx 客户端插件上下文；`slots` 由 inject 保证存在。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-accounts',
        // 排在 模型(10) / Agent 预设(20) / IM机器人(21) 之后：账号属于凭据类配置。
        order: 22,
        label: () => '账号',
        // 无 slot-entry 注入面：分区不读宿主半边的任何状态，传输由同源接口自己完成。
        inject: () => ({}),
      }, AccountsSection))
    }

    return { name: 'dsh-accounts', inject: ['slots'], apply }
  },
})
