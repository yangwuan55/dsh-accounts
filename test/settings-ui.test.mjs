/**
 * 设置区（浏览器半边）单测：mock `window.__ModuleLoader__` 捕获 bundle 注册，
 * 用假 React（无依赖、无 DOM）执行 factory，再 mock `ctx.slots` 捕获分区注册。
 * 覆盖：bundle 格式（id/factory）、模块导出面（name/inject/apply）、
 * 注册参数（slot 名/id/order/label/component）、空态首屏渲染文案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 加载 bundle 并取回它的注册。
 *
 * bundle 只在模块求值时调用一次 `window.__ModuleLoader__.load`，而 ESM 会缓存该
 * 模块，因此这里把首次加载的注册缓存下来给所有用例复用。
 * @returns {Promise<{id: string, factory: Function}>} 捕获到的模块注册。
 */
let cachedBundle
async function loadBundle() {
  if (cachedBundle !== undefined) return cachedBundle
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        captured = registration
      },
    },
  }
  // 动态 import：bundle 在模块求值时就调用 window.__ModuleLoader__.load，
  // 所以 window 必须先就位。
  await import('../lib/settings-ui.js')
  assert.ok(captured !== undefined, 'bundle 没有调用 window.__ModuleLoader__.load')
  cachedBundle = captured
  return cachedBundle
}

/** 假 React：createElement 建普通对象树，hooks 取初始值且不产生副作用。 */
function makeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/** 假 UI 组件库：这些位置只作为 createElement 的 type 出现，取值即可。 */
function makePrimitives() {
  const component = (name) => function Stub() { return null }
  return {
    Button: component('Button'),
    Input: component('Input'),
    Modal: component('Modal'),
    Tag: component('Tag'),
    StateDot: component('StateDot'),
    IconPlusOutline16: component('IconPlusOutline16'),
    IconRefreshOutline16: component('IconRefreshOutline16'),
  }
}

/** bundle 内 require 的解析：只认 platform module 表里的那两个说明符。 */
function makeRequire() {
  const react = makeReact()
  const primitives = makePrimitives()
  return (specifier) => {
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`测试未提供说明符: ${specifier}`)
  }
}

/** 递归收集对象树里的字符串，用于断言渲染文案。 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'object' && 'children' in node) {
    for (const child of node.children) texts(child, out)
  }
  return out
}

test('bundle 以包名注册，factory 是函数', async () => {
  const registration = await loadBundle()
  assert.equal(registration.id, 'dsh-accounts')
  assert.equal(typeof registration.factory, 'function')
})

test('factory 返回 name/inject/apply，且只注入 slots', async () => {
  const registration = await loadBundle()
  const mod = registration.factory(makeRequire())
  assert.equal(mod.name, 'dsh-accounts')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply 注册 settings.section 分区，id/order 稳定', async () => {
  const registration = await loadBundle()
  const mod = registration.factory(makeRequire())
  const registered = []
  mod.apply({
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.section')
        // 真实 slots.inject 只在槽位就绪后回调；这里立即回调以捕获注册。
        callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  })
  assert.equal(registered.length, 1)
  const [{ options, component }] = registered
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-accounts')
  assert.equal(options.order, 22)
  assert.equal(options.label(), '账号')
  assert.equal(typeof component, 'function')
})

test('首屏渲染出标题、分组小标题与读取中占位', async () => {
  const registration = await loadBundle()
  const mod = registration.factory(makeRequire())
  let component
  mod.apply({
    slots: {
      inject(_name, callback) { callback() },
      register(_options, registered) { component = registered },
    },
  })
  const rendered = texts(component({}))
  assert.ok(rendered.includes('账号'), '缺少分区标题「账号」')
  assert.ok(rendered.some((text) => text.includes('尚未配置账号')), '缺少分组小标题')
  // 首屏 loading 为真，列表位显示读取中；拉取完成后才换成「暂无账号…」。
  assert.ok(rendered.some((text) => text.includes('正在读取')), '缺少读取中占位')
  assert.ok(rendered.some((text) => text.includes('.credentials.yaml')), '缺少凭据存储位置说明')
})
