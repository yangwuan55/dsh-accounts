/**
 * 组件库契约测试：拿**真包**核对 settings-ui.js 用到的每一个组件名。
 *
 * 为什么需要这一条：0.3.0 的「账号」分区空白，是 `IconPlusOutline16` 这个
 * `@deepseek-ai/dsh-client-ui-primitives` 里并不存在的导出名让 React 在首屏抛错，
 * 而宿主把抛错的 entry 除名——导航行还在、正文空白、控制台零报错。单测全绿，因为
 * mock 照着代码写，自证自洽。本测试不再造 mock：它读真实组件包导出的名字清单，逐个核对
 * bundle 从中取的每一个名字。宿主改图标命名（就像 16 → Medium 那次）时，这里立刻红。
 *
 * 取不到真实组件包时（本机没装 DSH、CI 上）整条跳过，不制造假红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE = '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 定位本机装的 DSH 里那个组件包。
 * @returns {string|null} 包目录；找不到返回 null。
 */
function locatePrimitives() {
  const candidates = []
  // dsh 的全局安装目录（brew / npm / pnpm 都落在这里）。
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', PACKAGE))
  } catch {
    // npm 不在 PATH 或执行失败：交给下面的候选。
  }
  // web profile 的运行时依赖。
  candidates.push(join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'node_modules', PACKAGE))
  return candidates.find((dir) => existsSync(join(dir, 'lib', 'index.js'))) ?? null
}

/**
 * 从 `export { A, B as C } from '…'` 这样的花括号列表里取名字。
 * @param {string} body 花括号内的原文。
 * @returns {string[]} 名字数组（已取 as 之后的本地名）。
 */
function namesFromBraceList(body) {
  const names = []
  for (const piece of body.split(',')) {
    const part = piece.trim()
    if (part.length === 0) continue
    const aliased = part.split(/\s+as\s+/)
    const name = (aliased[1] ?? aliased[0]).trim()
    if (name.length > 0) names.push(name)
  }
  return names
}

/**
 * 解析包的**运行时入口**，抽出它对外导出的名字。
 *
 * 刻意读 `lib/index.js` 而不是 `lib/types/index.d.ts`：`require()` 拿到的是运行时
 * 导出表，而类型入口靠 `export * from './icons/index.tsx'` 转发图标——只认花括号列表的
 * 解析器会把那批图标整体漏掉，于是好名字被误报成不存在（反向也会漏掉真删掉的名字）。
 * 运行时入口是一条巨大的 `export { … }`，是唯一权威。
 *
 * @param {string} dir 包目录。
 * @returns {Set<string>} 导出名集合。
 */
function exportedValueNames(dir) {
  const source = readFileSync(join(dir, 'lib', 'index.js'), 'utf8')

  const names = new Set()
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const name of namesFromBraceList(match[1])) names.add(name)
  }
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(match[1])
  }
  return names
}

/**
 * 跑一遍 bundle 的 factory，录下它向组件库要过的每一个名字。
 * @returns {Promise<string[]>} 被取用的组件名。
 */
async function requestedNames() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) { captured = registration },
    },
  }
  // 动态 import：bundle 在模块求值时就调用 window.__ModuleLoader__.load，window 必须先就位。
  await import(join(REPO, 'lib', 'settings-ui.js'))
  assert.ok(captured !== undefined, 'bundle 没有调用 window.__ModuleLoader__.load')

  // 假 React 只为让 factory 能跑完；组件库换成记录代理，取什么名字都「有」。
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    Component: class { constructor(props) { this.props = props; this.state = {} } },
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const asked = []
  const recorder = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      asked.push(String(prop))
      return function Stub() { return null }
    },
  })

  captured.factory((specifier) => {
    if (specifier === 'react') return react
    if (specifier === PACKAGE) return recorder
    throw new Error(`测试未提供说明符: ${specifier}`)
  })
  return asked
}

test('settings-ui.js 用到的每个组件名都真实存在于 @deepseek-ai/dsh-client-ui-primitives', async (t) => {
  const dir = locatePrimitives()
  if (dir === null) {
    t.skip(`本机找不到 ${PACKAGE}（没装 DSH？），跳过真包契约核对`)
    return
  }

  const available = exportedValueNames(dir)
  assert.ok(available.size > 0, `没能从 ${dir} 解析出任何导出名，解析器该修了`)

  const asked = await requestedNames()
  assert.ok(asked.length > 0, 'bundle 一个组件名都没取，契约测试失去意义')

  const missing = asked.filter((name) => !available.has(name))
  assert.deepEqual(
    missing,
    [],
    `这些名字在 ${PACKAGE} 里不存在：${missing.join(', ')}。` +
    '宿主改名后请同步更新；名字对不上会在真实界面里让分区渲染抛错、变成一片空白。',
  )
})
