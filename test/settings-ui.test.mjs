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
  // 与真实 React 一致：children 既进 props.children（单个子节点时就是它本身，
  // 这正是错误边界 render() 读的那份），也留在 children 数组里供本文件的迷你渲染器遍历。
  const createElement = (type, props, ...children) => {
    const flat = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
    const resolved = { ...(props ?? {}) }
    if (flat.length === 1) resolved.children = flat[0]
    else if (flat.length > 1) resolved.children = flat
    return { type, props: resolved, children: flat }
  }
  /** class 组件的最小基类：真实 React 的 `React.Component`，这里只要 props/state 槽位。 */
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  }
  return {
    createElement,
    Component,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/**
 * 假 UI 组件库，**用严格代理**。
 *
 * 为什么不能照着代码写：0.3.0 的「账号」分区空白，就是被一份照着代码写的 mock 放过的
 * ——mock 自己定义了 `IconPlusOutline16`，而真实组件库 `@deepseek-ai/dsh-client-ui-
 * primitives` 里根本没有这个名字（真名是 `IconPlusOutlineMedium`）。mock 附和代码，
 * 于是自证自洽、测试全绿，插件在真实宿主里却一画就炸。改用严格代理：清单外的一律
 * 抛错，mock 再也附和不了代码。清单的正确性由 test/primitives-contract.test.mjs 拿
 * 真包核对。
 */
function makePrimitives() {
  const component = () => function Stub() { return null }
  const known = {
    Button: component(),
    Input: component(),
    Modal: component(),
    Tag: component(),
    StateDot: component(),
    IconPlusOutlineMedium: component(),
    IconRefreshOutlineMedium: component(),
  }
  return new Proxy(known, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target) return target[prop]
      throw new Error(
        `@deepseek-ai/dsh-client-ui-primitives 没有导出 ${String(prop)}` +
        `；mock 只承认：${Object.keys(known).join(', ')}`,
      )
    },
  })
}

/**
 * bundle 内 require 的解析：只认 platform module 表里的那两个说明符。
 * @param {object} [options] `breakHooks` 让假 React 的 useState 抛错，
 *   用来模拟「分区首屏渲染炸掉」这一场景（验兜底边界是否真的接得住）。
 * @returns {Function} require 实现。
 */
function makeRequire(options = {}) {
  const react = makeReact()
  if (options.breakHooks === true) {
    react.useState = () => { throw new Error('模拟的首屏渲染异常') }
  }
  const primitives = makePrimitives()
  return (specifier) => {
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`测试未提供说明符: ${specifier}`)
  }
}

/**
 * 迷你渲染器：把组件跑成纯文本数组。
 *
 * 它刻意**复刻宿主的错误边界语义**：class 边界捕获子树抛错 → `getDerivedStateFromError`
 * 写回 state → 重新 render。「分区空白」的病根就是边界缺失（宿主会把抛错的 entry
 * 除名，导航还在、正文空、控制台无报错），所以测试必须能区分「正常渲染」与
 * 「渲染异常但有兜底」这两种结果，否则回归会静悄悄溜过去。
 *
 * @param {Function|object} component 已注册的分区组件（或一棵树）。
 * @param {object} [props] 传给组件的 owner props。
 * @returns {string[]} 渲染出的全部文本节点。
 */
function renderTexts(component, props = {}) {
  const out = []
  const visit = (node, boundary) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, boundary)
      return
    }
    if (typeof node === 'string') {
      out.push(node)
      return
    }
    if (typeof node !== 'object' || !('children' in node)) return
    const { type, props: elementProps } = node
    // 宿主组件（div/span/Symbol(Fragment)…）直接展开 children。
    if (typeof type !== 'function') {
      for (const child of node.children) visit(child, boundary)
      return
    }
    let next = boundary
    let result
    try {
      if (typeof type.prototype?.render === 'function') {
        const instance = new type(elementProps)
        instance.props = elementProps
        next = instance
        result = instance.render()
      } else {
        result = type(elementProps)
      }
    } catch (error) {
      // 没有边界兜底就原样抛出——这正是插件 0.3.0 的处境。
      if (boundary === null) throw error
      // 静态方法挂在边界类（构造函数）上，不是被抛错的那个子组件上。
      const derived = typeof boundary.constructor?.getDerivedStateFromError === 'function'
        ? boundary.constructor.getDerivedStateFromError(error)
        : {}
      boundary.state = { ...boundary.state, ...derived }
      next = boundary
      result = boundary.render()
    }
    visit(result, next)
  }
  visit(typeof component === 'function' ? component(props) : component, null)
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

/** 跑一次 factory + apply，交回注册到的分区组件。 */
async function registeredSection(options = {}) {
  const registration = await loadBundle()
  const mod = registration.factory(makeRequire(options))
  let component
  mod.apply({
    slots: {
      inject(_name, callback) { callback() },
      register(_options, registered) { component = registered },
    },
  })
  return component
}

test('首屏渲染出标题、分组小标题与读取中占位', async () => {
  const component = await registeredSection()
  const rendered = renderTexts(component)
  assert.ok(rendered.includes('账号'), '缺少分区标题「账号」')
  assert.ok(rendered.some((text) => text.includes('尚未配置账号')), '缺少分组小标题')
  // 首屏 loading 为真，列表位显示读取中；拉取完成后才换成「暂无账号…」。
  assert.ok(rendered.some((text) => text.includes('正在读取')), '缺少读取中占位')
  assert.ok(rendered.some((text) => text.includes('.credentials.yaml')), '缺少凭据存储位置说明')
  // 分区正常时不该出现兜底文案。
  assert.ok(!rendered.some((text) => text.includes('渲染异常')), '正常渲染不该出现兜底文案')
})

test('子分区渲染抛错时，边界兜住并显示原因（0.3.0 的空白回归门）', async () => {
  const component = await registeredSection({ breakHooks: true })
  let rendered
  assert.doesNotThrow(() => { rendered = renderTexts(component) }, '渲染异常必须被边界接住，不能冒到宿主')
  assert.ok(
    rendered.some((text) => text.includes('渲染异常')),
    '异常时必须显示兜底标题，而不是静默空白',
  )
  assert.ok(
    rendered.some((text) => text.includes('模拟的首屏渲染异常')),
    '兜底必须写出异常原因，便于定位',
  )
  assert.ok(!rendered.includes('正在读取'), '异常时不应继续渲染正常内容')
})

test('mock 不再能附和代码：清单外的组件名在 factory 求值时就抛错', async () => {
  const registration = await loadBundle()
  // 直接解构一个真实组件库里没有的名字，严格代理必须立刻拒绝。
  const strict = makePrimitives()
  assert.throws(() => strict.IconPlusOutline16, /没有导出 IconPlusOutline16/)
  // 而代码实际使用的名字必须能取到。
  assert.ok(strict.IconPlusOutlineMedium)
  assert.ok(registration.id === 'dsh-accounts')
})
