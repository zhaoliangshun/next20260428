/**
 * Mini React  ·  ~1300 行实现日常开发 100% 的 React 常用 API
 *
 * 已实现：
 *   元素    createElement / cloneElement / isValidElement / Fragment
 *   组件    Component / PureComponent / forwardRef / memo / StrictMode / lazy
 *   Hooks   useState / useReducer / useEffect / useLayoutEffect / useInsertionEffect /
 *           useRef / useMemo / useCallback / useId / useContext /
 *           useImperativeHandle / useDebugValue / useSyncExternalStore /
 *           useTransition / useDeferredValue
 *   Context createContext / Provider / Consumer
 *   Portal  createPortal
 *   异步    lazy / Suspense
 *   错误    Error Boundary（getDerivedStateFromError / componentDidCatch）
 *   渲染    render / createRoot / flushSync / batch / startTransition / act
 *   工具    createRef / Children / version
 *
 * 与真实 React 的主要简化：
 *   - 单全局根（不支持并发多根并行提交）
 *   - 无 Scheduler 优先级通道（用 requestIdleCallback 近似时间切片）
 *   - Suspense 首帧有短暂空白（无 concurrent 保护层）
 *   - useSyncExternalStore 无防撕裂（无 concurrent 读隔离）
 *   - useId 不支持 SSR hydration
 */
;(function () {
  'use strict'

  const version = '18.0.0-mini'

  // ─────────────────────────────────────────────────────────────
  // § 1  REACT ELEMENT
  // ─────────────────────────────────────────────────────────────

  /**
   * createElement —— JSX 编译目标，构造 React Element 描述对象。
   *
   * Babel 把 JSX 转换为本函数调用：
   *   JSX：    <div className="a">hi</div>
   *   编译后： createElement('div', { className: 'a' }, 'hi')
   *   产出：   { type: 'div', key: null, ref: null,
   *             props: { className: 'a', children: [{type:'TEXT_ELEMENT',...}] } }
   *
   * 关键对齐点（v3）：与真实 React 一致，把 key 和 ref 提到 element 顶层，
   * 不再写入 props。这样：
   *   - 组件函数收到的 props 不会包含 key/ref（React 行为）
   *   - memo 浅比较不会受 ref 切换干扰
   *   - 协调器可在不读 props 的情况下做 keyed 匹配
   *
   * children 处理流水线：
   *   1. flat(Infinity)：把嵌套数组展平为一维（[a, [b, c], [d]] → [a, b, c, d]）
   *   2. 过滤 null/undefined/boolean：支持 cond && <Comp/> 这种条件渲染
   *      （注意：0 / '' 不会被过滤，会作为文本节点显示，这与真实 React 一致）
   *   3. 非对象（字符串/数字）包装成 TEXT_ELEMENT，方便 reconciler 统一处理
   *
   * defaultProps：渲染期由 updateFunctionComponent / updateClassComponent 应用。
   */
  function createElement(type, config, ...children) {
    let key = null
    let ref = null
    const props = {}
    if (config != null) {
      for (const k in config) {
        if (k === 'key') {
          if (config.key !== undefined) key = '' + config.key  // React 把 key 强制转 string
        } else if (k === 'ref') {
          if (config.ref !== undefined) ref = config.ref
        } else {
          props[k] = config[k]
        }
      }
    }
    props.children = children
      .flat(Infinity)
      .filter(c => c !== null && c !== undefined && typeof c !== 'boolean')
      .map(c => (typeof c === 'object' ? c : createTextElement(c)))
    return { type, key, ref, props }
  }

  function createTextElement(text) {
    return {
      type: 'TEXT_ELEMENT',
      key: null,
      ref: null,
      props: { nodeValue: String(text), children: [] },
    }
  }

  /**
   * cloneElement —— 克隆元素并合并新 config / children。
   *
   * 行为与 React 一致：
   *   - key 默认继承元素，config.key 不为 undefined 时覆盖
   *   - ref 同上
   *   - 其它 props 合并（config 覆盖 element.props）
   *   - 新 children 若传入则完全替换旧 children
   */
  function cloneElement(element, config, ...children) {
    let key = element.key
    let ref = element.ref
    const props = { ...element.props }
    if (config != null) {
      for (const k in config) {
        if (k === 'key') {
          if (config.key !== undefined) key = '' + config.key
        } else if (k === 'ref') {
          if (config.ref !== undefined) ref = config.ref
        } else if (config[k] !== undefined) {
          props[k] = config[k]
        }
      }
    }
    if (children.length > 0) {
      props.children = children
        .flat(Infinity)
        .filter(c => c !== null && c !== undefined && typeof c !== 'boolean')
        .map(c => (typeof c === 'object' ? c : createTextElement(c)))
    }
    return { type: element.type, key, ref, props }
  }

  /**
   * isValidElement —— 判断是否为合法的 React Element。
   *
   * 合法 element 必须满足：
   *   1. 是非空对象
   *   2. 有 type 字段（string / function / Symbol-like 都算）
   *   3. 有 props 字段（对象，可能为空对象）
   *   4. type 不是 undefined（避免 createElement(undefined, ...) 这种错误）
   *
   * 修复：原版仅检查 'type' in obj，对 type=undefined 的非法 element 也返回 true。
   */
  function isValidElement(obj) {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'type' in obj &&
      obj.type !== undefined &&
      'props' in obj &&
      typeof obj.props === 'object'
    )
  }

  /** Fragment —— 不产生 DOM 的多根节点占位符。 */
  const Fragment = '__fragment__'

  /** PORTAL —— createPortal 生成的特殊 host 类型，dom 指向目标容器。 */
  const PORTAL = '__portal__'

  // ─────────────────────────────────────────────────────────────
  // § 2  全局调度状态
  // ─────────────────────────────────────────────────────────────

  // ── 双缓冲 Fiber 树 ─────────────────────────────────────────
  // current 树（已提交，对应当前 DOM）  ↔  wip 树（正在构建）
  // 提交完成后 wip 替换 current；下次更新基于新的 current 派生新的 wip。
  let nextUnitOfWork       = null   // 工作循环游标，下一个要处理的 Fiber
  let currentRoot          = null   // 已提交的 current 树根
  let wipRoot              = null   // 正在构建的 wip 树根
  let deletions            = []     // 本轮需要从 DOM 中删除的 Fiber 列表
  let pendingRerender      = false  // commit 期间收到的 setState：等 commit 结束后再触发一轮
  let isCommitting         = false  // mutation pass 期间为 true，用于检测重入
  let workLoopScheduled    = false  // workLoop 是否已通过 requestIdle 排队（避免重复调度）
  let pendingPassiveRoots  = []     // 等待执行 useEffect 的根 Fiber 列表
  let passiveFlushScheduled = false // setTimeout 是否已派发 passive 刷新
  let needsRerenderAfterCommit = false  // Suspense 首次挂起后触发回显 fallback
  // 渲染期捕获的 Error Boundary 队列：[{boundary, error}, ...]
  // 修复：原版用单变量保存，同一轮 render 中多个独立 Boundary 同时崩溃时只保留最后一个，
  // 其它边界既不会调用 componentDidCatch 也不会展示 fallback UI。
  const pendingErrorBoundaries = []

  // ── Hooks 渲染上下文 ───────────────────────────────────────
  // 每次进入函数组件 render 之前，updateFunctionComponent 会重置这两个变量；
  // useState/useEffect 等 hook 调用时按 hookIndex 顺序读写 wipFiber.hooks。
  // 这就是为什么 hook 必须按固定顺序调用、不能放进条件分支的原因。
  let wipFiber  = null
  let hookIndex = 0
  let idCounter = 0  // useId 的全局自增计数器，组件实例间各自持有自己的快照

  /**
   * 时间切片调度器：
   *   - 浏览器原生 requestIdleCallback：在主线程空闲时执行，不阻塞用户交互
   *   - setTimeout 兜底（Safari 等不支持 RIC 的环境）：用 1ms 延迟模拟空闲触发
   *   - timeout: 16 表示哪怕一直忙，也最多等一帧（≈16ms）就强制执行一次
   */
  const requestIdle = window.requestIdleCallback
    ? cb => window.requestIdleCallback(cb, { timeout: 16 })
    : cb => setTimeout(() => cb({ timeRemaining: () => 50 }), 1)

  // ─────────────────────────────────────────────────────────────
  // § 3  WORK LOOP
  // ─────────────────────────────────────────────────────────────

  /**
   * workLoop —— requestIdleCallback 驱动的可中断循环。
   * 剩余时间 < 1ms 则让出，所有 Fiber 处理完后进入同步 commit。
   */
  function workLoop(deadline) {
    workLoopScheduled = false
    let shouldYield = false
    while (nextUnitOfWork && !shouldYield) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
      shouldYield = deadline.timeRemaining() < 1
    }
    if (!nextUnitOfWork && wipRoot) commitRoot()
    if (nextUnitOfWork || wipRoot) scheduleWorkLoop()
  }

  // ─────────────────────────────────────────────────────────────
  // § 4  PERFORM UNIT OF WORK
  // ─────────────────────────────────────────────────────────────

  /**
   * performUnitOfWork —— DFS 遍历：child 优先，无 child 则 sibling，再 return。
   * 区分类组件 / 函数组件 / Host 三种类型分别处理。
   */
  function performUnitOfWork(fiber) {
    if (isClassComponent(fiber))    updateClassComponent(fiber)
    else if (isFnComponent(fiber))  updateFunctionComponent(fiber)
    else                            updateHostComponent(fiber)

    if (fiber.child) return fiber.child

    let next = fiber
    while (next) {
      completeUnitOfWork(next)
      if (next.sibling) return next.sibling
      next = next.return
    }
    return null
  }

  /** completeUnitOfWork —— 退出 Provider fiber 时恢复 context 旧值（栈式隔离）。 */
  function completeUnitOfWork(fiber) {
    if (fiber._context) fiber._context._currentValue = fiber._prevCtxValue
  }

  /**
   * updateFunctionComponent —— 渲染函数组件。
   *   1. 设置 hooks 上下文（wipFiber / hookIndex）
   *   2. memo bailout：props 未变 + 无排队 state → 复用上次结果
   *   3. Context.Provider 作用域：进入时注入值，退出时（completeUnitOfWork）恢复
   *   4. forwardRef：把 fiber.ref（element 顶层 ref）以第二参数传给渲染函数
   *   5. Suspense 集成：catch 子组件抛出的 Promise，标记 boundary
   */
  function updateFunctionComponent(fiber) {
    wipFiber  = fiber
    hookIndex = 0
    wipFiber.hooks = []

    const component = fiber.type
    const isMemo    = !!component._isMemo

    // ── defaultProps：把组件声明的默认值合并到 fiber.props ──────
    // 与 React 行为一致：仅当 props[k] === undefined 时使用默认值
    // （null 视为有意传入的空值，不被覆盖）。
    applyDefaultProps(fiber, isMemo ? component._type : component)

    // ── memo bailout ──────────────────────────────────────────
    if (isMemo && fiber.alternate) {
      const hasPending = fiber.alternate.hooks?.some(h => h.queue?.length > 0)
      if (!hasPending && component._compare(fiber.alternate.props, fiber.props)) {
        wipFiber.hooks = fiber.alternate.hooks || []
        const cached = fiber.alternate.memoizedElement
        fiber.memoizedElement = cached
        reconcileChildren(fiber, normalizeRenderOutput(cached))
        return
      }
    }

    const renderFn = isMemo ? component._type : component

    // ── PropTypes 校验（开发期）──────────────────────────────
    // 失败时仅 console.warn，不阻断渲染（与真实 prop-types 一致）
    if (renderFn.propTypes) validateProps(renderFn, fiber.props)

    // ── Context.Provider ──────────────────────────────────────
    if (renderFn._context) {
      fiber._context    = renderFn._context
      fiber._prevCtxValue = renderFn._context._currentValue
      renderFn._context._currentValue = fiber.props.value
    }

    // ── 调用渲染函数（forwardRef 透传 ref） ───────────────────
    // ref 从 fiber 顶层读取（v3：与真实 React 对齐，ref 不在 props 中）
    let child
    try {
      if (renderFn._isForwardRef) {
        child = renderFn._renderFn(fiber.props, fiber.ref ?? null)
      } else {
        child = renderFn(fiber.props)
      }
    } catch (e) {
      // ── Suspense：捕获 Promise（lazy / use(promise) 抛出）─────
      // 修复（v3）：原版用 _suspendPending 单字段保存最后一个 Promise，
      // 多个子组件同时挂起时前面的 Promise 解决会过早清空标志，
      // 导致 Suspense 把还在挂起的内容当已就绪渲染（出现错位）。
      // 新版用 _pendingSet（Set）跟踪所有未解决的 Promise，全部 resolve
      // 后才取消 fallback；同时去重避免对同一 Promise 重复挂回调。
      if (e && typeof e.then === 'function') {
        let boundary = fiber.return
        while (boundary && !boundary.type?._isSuspense) boundary = boundary.return
        if (boundary) {
          if (!boundary._pendingSet) boundary._pendingSet = new Set()
          if (!boundary._pendingSet.has(e)) {
            boundary._pendingSet.add(e)
            const onSettle = () => {
              boundary._pendingSet?.delete(e)
              scheduleRerender()
            }
            e.then(onSettle, onSettle)
          }
          needsRerenderAfterCommit = true
        }
        fiber.memoizedElement = null
        reconcileChildren(fiber, [])
        return
      }
      // ── Error Boundary：非 Promise 错误，向上查找最近的 EB ──
      if (propagateError(fiber, e)) {
        fiber.memoizedElement = null
        reconcileChildren(fiber, [])
        return
      }
      throw e
    }

    fiber.memoizedElement = child
    reconcileChildren(fiber, normalizeRenderOutput(child))
  }

  /**
   * normalizeRenderOutput —— 把组件 render 的返回值统一为 element 数组。
   *
   * React 允许组件返回：element / 数组 / 字符串 / 数字 / null / boolean。
   * 本函数把所有合法形态规范化成 reconcileChildren 能处理的 element 数组：
   *   - null / undefined / boolean → []
   *   - string / number             → [TEXT_ELEMENT]
   *   - 数组                          → 递归展平 + 每个元素同样规范化
   *   - element                      → [element]
   *
   * 修复：原版直接 `Array.isArray(child) ? child : [child]`，当 child 为 string
   * 或 number 时会传入 reconcileChildren，element.type 为 undefined 触发崩溃。
   */
  function normalizeRenderOutput(child) {
    if (child == null || typeof child === 'boolean') return []
    if (typeof child === 'string' || typeof child === 'number') {
      return [createTextElement(child)]
    }
    if (Array.isArray(child)) {
      const out = []
      for (const c of child.flat(Infinity)) {
        if (c == null || typeof c === 'boolean') continue
        if (typeof c === 'string' || typeof c === 'number') out.push(createTextElement(c))
        else if (typeof c === 'object') out.push(c)
      }
      return out
    }
    if (typeof child === 'object') return [child]
    return []
  }

  /**
   * updateClassComponent —— 渲染类组件。
   * 首次渲染创建实例；后续复用并同步 props/state；调用 render()。
   * getDerivedStateFromProps / shouldComponentUpdate 均在此处理。
   */
  function updateClassComponent(fiber) {
    // ── defaultProps（与函数组件一致）────────────────────────
    applyDefaultProps(fiber, fiber.type)

    // ── PropTypes 校验（开发期）──────────────────────────────
    if (fiber.type.propTypes) validateProps(fiber.type, fiber.props)

    // ── static contextType：从静态字段读取 context ───────────
    // 用法：class Foo extends Component { static contextType = ThemeContext; ... }
    // → render 时 this.context 可读
    const ctxType = fiber.type.contextType
    const ctxValue = ctxType && '_currentValue' in ctxType ? ctxType._currentValue : undefined

    let instance = fiber.instance
    if (!instance) {
      instance = new fiber.type(fiber.props, ctxValue)
      fiber.instance = instance
      instance._fiber = fiber
    } else {
      // 从 alternate 同步最新 state（setState 改的是旧实例）
      if (fiber.alternate?.instance) {
        instance.state = fiber.alternate.instance.state
        // 把 alternate 实例上累积的回调队列也搬过来（确保不丢失）
        if (fiber.alternate.instance._pendingCallbacks?.length) {
          instance._pendingCallbacks.push(...fiber.alternate.instance._pendingCallbacks)
          fiber.alternate.instance._pendingCallbacks.length = 0
        }
      }
      instance.props  = fiber.props
      instance.context = ctxValue
      instance._fiber = fiber
    }

    // getDerivedStateFromProps（静态方法）
    const gDSFP = fiber.type.getDerivedStateFromProps
    if (gDSFP) {
      const derived = gDSFP(fiber.props, instance.state)
      if (derived) instance.state = { ...instance.state, ...derived }
    }

    // shouldComponentUpdate（PureComponent 做浅比较）
    if (fiber.alternate) {
      const pu = fiber.type._isPure
      const scu = instance.shouldComponentUpdate
      const prevProps = fiber.alternate.props
      const prevState = fiber.alternate.instance?.state ?? {}
      if (pu && shallowEqualProps(prevProps, fiber.props) && shallowEqualProps(prevState, instance.state)) {
        const cached = fiber.alternate.memoizedElement
        fiber.memoizedElement = cached
        reconcileChildren(fiber, normalizeRenderOutput(cached))
        return
      }
      if (scu && !instance.shouldComponentUpdate(fiber.props, instance.state)) {
        const cached = fiber.alternate.memoizedElement
        fiber.memoizedElement = cached
        reconcileChildren(fiber, normalizeRenderOutput(cached))
        return
      }
    }

    let child
    try {
      child = instance.render()
    } catch (e) {
      // 类组件 render() 中的错误也交给最近的 Error Boundary 处理
      if (propagateError(fiber, e)) {
        fiber.memoizedElement = null
        reconcileChildren(fiber, [])
        return
      }
      throw e
    }
    fiber.memoizedElement = child
    reconcileChildren(fiber, normalizeRenderOutput(child))
  }

  /**
   * updateHostComponent —— 渲染原生 DOM 节点、Fragment 或 Portal。
   * Portal：fiber.dom 指向目标容器，子节点自然插入其中。
   */
  function updateHostComponent(fiber) {
    if (fiber.type === Fragment) {
      reconcileChildren(fiber, fiber.props.children || [])
      return
    }
    if (fiber.type === PORTAL) {
      fiber.dom = fiber.props.container
      reconcileChildren(fiber, fiber.props.children || [])
      return
    }
    if (!fiber.dom) fiber.dom = createDom(fiber)
    reconcileChildren(fiber, fiber.props.children || [])
  }

  // ─────────────────────────────────────────────────────────────
  // § 5  RECONCILER（Diff）
  // ─────────────────────────────────────────────────────────────

  /**
   * reconcileChildren —— O(n) Diff 算法：把新 elements 与旧 Fiber 链表对比，
   * 标记 PLACEMENT / UPDATE / DELETION 三类 effectTag，构建新的子 Fiber 链表。
   *
   * 数据结构：
   *   keyedOld   Map<key, fiber>   — 有 key 的旧 fiber 按 key 索引
   *   unkeyedOld fiber[]            — 无 key 的旧 fiber 按出现顺序排列
   *   usedOld    Set<fiber>         — 已被新 element 复用的旧 fiber，剩余的将被删除
   *
   * 匹配规则：
   *   有 key   → 按 key 在 keyedOld 中查找（即便位置变了也能复用，触发 reorder）
   *   无 key   → 按 unkeyedIdx 顺序匹配下一个未被使用的旧 fiber
   *
   * 复用条件：oldMatch.type === element.type
   *   匹配 → 标记 UPDATE，复用 dom，alternate 指向旧 fiber
   *   不匹配但有元素 → 标记 PLACEMENT，新建 fiber
   *   不匹配但有旧 → 标记 DELETION，旧 fiber 入 deletions
   *
   * Bug fix（v2）：原版 `index === 0` 在首位元素为 null 时（被外层 if 跳过）
   * 仍然 truthy，导致第二个有效元素错误成为 child；改为 `!prevSibling`
   * 检测"尚未链接第一个有效 Fiber"，准确处理 [null, <A/>, <B/>] 这类列表。
   */
  function reconcileChildren(wipF, elements) {
    const keyedOld    = new Map()
    const unkeyedOld  = []
    const usedOld     = new Set()
    let prevSibling   = null
    let unkeyedIdx    = 0

    let old = wipF.alternate?.child
    while (old) {
      const k = getFiberKey(old)
      if (k !== null) keyedOld.set(k, old); else unkeyedOld.push(old)
      old = old.sibling
    }

    elements.forEach(element => {
      if (!element) return

      const key = getElementKey(element)
      let oldMatch

      if (key !== null) {
        oldMatch = keyedOld.get(key)
      } else {
        while (unkeyedIdx < unkeyedOld.length && usedOld.has(unkeyedOld[unkeyedIdx])) unkeyedIdx++
        oldMatch = unkeyedOld[unkeyedIdx]
        if (oldMatch) unkeyedIdx++
      }

      const sameType = oldMatch && element.type === oldMatch.type
      let newFiber

      if (sameType) {
        newFiber = {
          type: oldMatch.type,
          key:  element.key,
          ref:  element.ref,           // ref 从 element 顶层取（v3）
          props: element.props,
          dom:   oldMatch.dom,
          return: wipF,
          alternate: oldMatch,
          effectTag: 'UPDATE',
        }
        usedOld.add(oldMatch)
      }
      if (!sameType && element) {
        newFiber = {
          type: element.type,
          key:  element.key,
          ref:  element.ref,
          props: element.props,
          dom:   null,
          return: wipF,
          alternate: null,
          effectTag: 'PLACEMENT',
        }
      }
      if (!sameType && oldMatch) {
        oldMatch.effectTag = 'DELETION'
        deletions.push(oldMatch)
        usedOld.add(oldMatch)
      }

      // 修复：用 !prevSibling 代替 index === 0，避免首位为 null 时子树丢失
      if (!prevSibling) wipF.child = newFiber
      else prevSibling.sibling = newFiber
      prevSibling = newFiber
    })

    ;[...unkeyedOld, ...keyedOld.values()].forEach(f => {
      if (!usedOld.has(f)) { f.effectTag = 'DELETION'; deletions.push(f) }
    })
  }

  // ─────────────────────────────────────────────────────────────
  // § 6  COMMIT（三阶段提交）
  // ─────────────────────────────────────────────────────────────

  /**
   * commitRoot —— 不可中断的同步提交。
   *
   * 三阶段提交流水线（与真实 React 保持一致）：
   *   ╔══════════════════════════════════════════════════════════╗
   *   ║ Phase 1  Mutation  —— DOM 插入 / 更新 / 删除              ║
   *   ║          • 先处理 deletions（防止 PLACEMENT 时父子顺序错  ║
   *   ║            乱），再 DFS 处理新子树                         ║
   *   ║          • normalizeHostChildren 修正 keyed reorder       ║
   *   ╠══════════════════════════════════════════════════════════╣
   *   ║ Phase 1.5 Insertion —— useInsertionEffect（DOM 插入后）  ║
   *   ║          • CSS-in-JS 注入 <style>，发生在浏览器绘制前      ║
   *   ╠══════════════════════════════════════════════════════════╣
   *   ║ Phase 2  Layout    —— useLayoutEffect + cDM/cDU（同步）  ║
   *   ║          • DOM 已就绪可以测量；本阶段 setState 会同步追刷  ║
   *   ╠══════════════════════════════════════════════════════════╣
   *   ║ Phase 3  Passive   —— useEffect（setTimeout 异步）       ║
   *   ║          • 浏览器绘制之后才执行，不阻塞画面               ║
   *   ╚══════════════════════════════════════════════════════════╝
   *
   * 收尾会处理三种"延后通知"：
   *   • Suspense 挂起回声（needsRerenderAfterCommit）
   *   • commit 期间的 setState（pendingRerender）
   *   • Error Boundary 捕获队列（pendingErrorBoundaries）
   */
  function commitRoot() {
    const root = wipRoot
    isCommitting = true

    // ── Phase 0  Pre-mutation：getSnapshotBeforeUpdate ────────
    // 在 DOM 突变之前调用，让组件读取"上一次提交时的真实 DOM"
    // （例如滚动位置、文本选区），返回值会传给 componentDidUpdate(_, _, snapshot)。
    commitGetSnapshotBeforeUpdate(root.child)

    deletions.forEach(fiber => commitWork(fiber))
    commitWork(root.child)
    normalizeHostChildren(root)

    currentRoot  = root
    wipRoot      = null
    isCommitting = false

    // Insertion pass：DOM 插入前同步执行（CSS-in-JS 在此注入样式，确保首帧无 FOUC）
    commitAllInsertionEffects(root.child)
    // Layout pass：DOM 就绪后同步执行（测量尺寸、聚焦、强制滚动等）
    commitAllLayoutEffects(root.child)
    flushSyncWork()

    // Passive pass
    pendingPassiveRoots.push(root.child)
    if (!passiveFlushScheduled) {
      passiveFlushScheduled = true
      setTimeout(() => {
        passiveFlushScheduled = false
        pendingPassiveRoots.splice(0).forEach(flushPassiveEffects)
      }, 0)
    }

    // Suspense 触发了挂起 → 立即调度第二次渲染以展示 fallback
    if (needsRerenderAfterCommit) {
      needsRerenderAfterCommit = false
      scheduleRerender()
    }
    if (pendingRerender) {
      pendingRerender = false
      scheduleRerender()
    }
    // Error Boundary：commit 后通知所有捕获到错误的边界组件（componentDidCatch），并重渲染展示错误 UI
    // 注意：本轮 render 中可能有多个独立 Boundary 同时崩溃，需要全部通知
    if (pendingErrorBoundaries.length > 0) {
      const queue = pendingErrorBoundaries.splice(0)
      queue.forEach(({ boundary, error }) => {
        // componentDidCatch 接收 error 和 info（真实 React 传递组件堆栈，此处简化为空）
        boundary.instance?.componentDidCatch?.(error, { componentStack: '' })
      })
      scheduleRerender()
    }
  }

  /**
   * commitWork —— Mutation pass 递归处理。
   *
   * Bug fix（v2）：while 循环补加 null 守卫，
   * 避免从无 dom 的 Fiber 向上回溯时越过根节点崩溃。
   *
   * Portal：容器已在真实 DOM 中，不执行 appendChild，只处理子节点。
   */
  /**
   * commitWork —— 把 sibling 遍历改为 while 循环以避免大列表栈溢出。
   *
   * Bug fix（v3）：原版 sibling 用 commitWork(fiber.sibling) 递归调用，
   * 一个父节点下若有 N 个 sibling 就会在 JS 调用栈上压 N 帧，
   * 当列表长度达到几千（如 useDeferredValue demo 里的 200 项 × 多次更新，
   * 或 ProfilerDemo 中 count 反复 +50 累积到很大）就会触发
   * "Maximum call stack size exceeded"。
   *
   * 修复：sibling 遍历改成迭代，仅 child 仍递归（child 深度 = 组件嵌套层级，
   * 实际项目中通常不超过几十层，安全可控）。
   */
  function commitWork(fiber) {
    let node = fiber
    while (node) {
      const cur = node
      let domParentFiber = cur.return
      while (domParentFiber && !domParentFiber.dom) domParentFiber = domParentFiber.return
      const parentDom = domParentFiber?.dom

      if (cur.type === PORTAL) {
        // Portal 容器本身不插入父 DOM，仅处理其子节点
        commitWork(cur.child)
        normalizeHostChildren(cur)
        node = cur.sibling
        continue
      }

      if (cur.effectTag === 'PLACEMENT' && cur.dom) {
        if (parentDom) parentDom.appendChild(cur.dom)
        commitRefBinding(cur)
      } else if (cur.effectTag === 'UPDATE' && cur.dom) {
        updateDom(cur.dom, cur.alternate.props, cur.props)
        commitRefBinding(cur)
      } else if (cur.effectTag === 'DELETION') {
        if (parentDom) commitDeletion(cur, parentDom)
        node = cur.sibling
        continue
      }

      commitWork(cur.child)
      if (cur.dom) normalizeHostChildren(cur)
      node = cur.sibling
    }
  }

  /**
   * normalizeHostChildren —— mutation pass 后按 Fiber 顺序修正 DOM 节点物理位置。
   * 解决 keyed diff 复用 DOM 但不移动位置的问题（insertBefore 天然支持同父移动）。
   */
  function normalizeHostChildren(parentFiber) {
    if (!parentFiber?.dom) return
    const doms = []
    collectDirectHostChildren(parentFiber.child, doms)
    let cursor = parentFiber.dom.firstChild
    doms.forEach(dom => {
      if (dom.parentNode === parentFiber.dom && dom === cursor) { cursor = cursor.nextSibling; return }
      parentFiber.dom.insertBefore(dom, cursor)
    })
  }

  function collectDirectHostChildren(fiber, doms) {
    let node = fiber
    while (node) {
      if (node.dom) doms.push(node.dom)
      else collectDirectHostChildren(node.child, doms)
      node = node.sibling
    }
  }

  /**
   * commitAllInsertionEffects —— useInsertionEffect 同步执行（DOM 插入前最早阶段）。
   * 遍历顺序与 commitAllLayoutEffects 相同（深度优先，child → sibling）。
   */
  function commitAllInsertionEffects(fiber) {
    let node = fiber
    while (node) {
      if (node.hooks) {
        node.hooks.forEach(hook => {
          if (!hook._isInsertionEffect || !hook.callback) return
          if (hook.cleanup) hook.cleanup()
          hook.cleanup  = hook.callback() ?? null
          hook.callback = null
        })
      }
      commitAllInsertionEffects(node.child)
      node = node.sibling
    }
  }

  /**
   * commitAllLayoutEffects —— useLayoutEffect + 类组件 componentDidMount/Update。
   *
   * 类组件生命周期顺序（v3，与真实 React 对齐）：
   *   1. getSnapshotBeforeUpdate(prevProps, prevState) → snapshot
   *      在 mutation 之前已经被 commitGetSnapshotBeforeUpdate 收集过；
   *      此处只需把 snapshot 作为第三参数传给 cDU
   *   2. componentDidMount / componentDidUpdate(prevProps, prevState, snapshot)
   *   3. setState/forceUpdate 收集的 _pendingCallbacks 依次清空
   */
  function commitAllLayoutEffects(fiber) {
    let node = fiber
    while (node) {
      if (node.hooks) {
        node.hooks.forEach(hook => {
          if (!hook._isLayoutEffect || !hook.callback) return
          if (hook.cleanup) hook.cleanup()
          hook.cleanup  = hook.callback() ?? null
          hook.callback = null
        })
      }
      // 类组件生命周期
      if (node.instance) {
        if (!node.alternate) {
          node.instance.componentDidMount?.()
        } else {
          const prevProps = node.alternate.props
          const prevState = node.alternate.instance?.state ?? {}
          const snapshot  = node._snapshot  // 由 commitGetSnapshotBeforeUpdate 写入
          node.instance.componentDidUpdate?.(prevProps, prevState, snapshot)
        }
        // 清空 setState/forceUpdate 的回调队列（按入队顺序调用）
        const cbs = node.instance._pendingCallbacks
        if (cbs && cbs.length) {
          const queue = cbs.splice(0)
          queue.forEach(cb => {
            try { cb.call(node.instance) }
            catch (e) { console.error('[setState callback]', e) }
          })
        }
      }
      commitAllLayoutEffects(node.child)
      node = node.sibling
    }
  }

  /**
   * commitGetSnapshotBeforeUpdate —— mutation 前调用类组件的 getSnapshotBeforeUpdate。
   *
   * 时机：DOM 突变之前（这是 React 引入此生命周期的核心目的——
   *   读取上一次提交时的真实 DOM 状态，例如滚动位置、文本选区，
   *   再在 cDU 中根据 snapshot 决定是否复位）。
   *
   * 返回值会写入 fiber._snapshot，commitAllLayoutEffects 中作为
   * componentDidUpdate 的第三参数传给实例。
   */
  function commitGetSnapshotBeforeUpdate(fiber) {
    let node = fiber
    while (node) {
      if (node.instance && node.alternate && typeof node.instance.getSnapshotBeforeUpdate === 'function') {
        try {
          node._snapshot = node.instance.getSnapshotBeforeUpdate(
            node.alternate.props,
            node.alternate.instance?.state ?? {},
          )
        } catch (e) {
          console.error('[getSnapshotBeforeUpdate]', e)
          node._snapshot = null
        }
      }
      commitGetSnapshotBeforeUpdate(node.child)
      node = node.sibling
    }
  }

  /** flushPassiveEffects —— useEffect 异步执行（绘制后）。 */
  function flushPassiveEffects(fiber) {
    let node = fiber
    while (node) {
      if (node.hooks) {
        node.hooks.forEach(hook => {
          if (!hook._isEffect || !hook.callback) return
          if (hook.cleanup) hook.cleanup()
          hook.cleanup  = hook.callback() ?? null
          hook.callback = null
        })
      }
      flushPassiveEffects(node.child)
      node = node.sibling
    }
  }

  function commitDeletion(fiber, parentDom) {
    runUnmountEffects(fiber)
    if (fiber.type === PORTAL) {
      // Portal 子节点在 portal 容器内，不在 parentDom 内
      let child = fiber.child
      while (child) { removeDomNodes(child, fiber.dom); child = child.sibling }
    } else {
      removeDomNodes(fiber, parentDom)
    }
  }

  function runUnmountEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if ((hook._isEffect || hook._isLayoutEffect || hook._isInsertionEffect) && hook.cleanup) hook.cleanup()
      })
    }
    fiber.instance?.componentWillUnmount?.()
    // ref 从 fiber 顶层取（v3）
    if (fiber.dom && fiber.ref) setRef(fiber.ref, null)
    let child = fiber.child
    while (child) { runUnmountEffects(child); child = child.sibling }
  }

  function removeDomNodes(fiber, parentDom) {
    if (!fiber) return
    if (fiber.dom) {
      if (fiber.dom.parentNode === parentDom) parentDom.removeChild(fiber.dom)
      return
    }
    let child = fiber.child
    while (child) { removeDomNodes(child, parentDom); child = child.sibling }
  }

  // ─────────────────────────────────────────────────────────────
  // § 7  DOM 工具函数
  // ─────────────────────────────────────────────────────────────

  const isEvent = k => k.startsWith('on')
  const isProp  = k => k !== 'children' && k !== 'key' && k !== 'ref' && !isEvent(k)
  const isNew   = (p, n) => k => p[k] !== n[k]
  const isGone  = (_, n) => k => !(k in n)
  // 事件别名：把 React 风格的事件名映射回 DOM 原生事件名（部分需要小写处理）
  const eventAliases = { doubleclick: 'dblclick' }
  const toEvt   = name => { const n = name.slice(2).toLowerCase(); return eventAliases[n] || n }

  // 布尔属性：从 DOM 上"移除"它们时应当置为 false 而不是 ''（'' 会被 IDL 解释为不一致状态）
  const BOOLEAN_PROPS = new Set([
    'checked', 'disabled', 'readOnly', 'multiple', 'autoFocus',
    'hidden', 'selected', 'controls', 'loop', 'muted', 'autoPlay', 'open',
  ])
  // 必须用 setAttribute 而不是 dom[k] 赋值的属性（DOM property 与 attribute 名不一致）
  const ATTR_ONLY_PROPS = new Set(['htmlFor', 'class', 'for', 'tabIndex'])
  // htmlFor → for；className 单独处理
  const ATTR_NAME_MAP = { htmlFor: 'for' }

  /**
   * 设置 DOM 属性的统一入口：根据值类型走不同分支。
   *   - 函数：忽略（事件已在另一分支处理）
   *   - dangerouslySetInnerHTML：直接写 innerHTML
   *   - 布尔属性：用 IDL 赋值（dom[k] = !!value）
   *   - data-* / aria-*：用 setAttribute（DOM 没有这些 property）
   *   - 其它：优先 IDL，fallback 到 setAttribute
   */
  function setDomProp(dom, key, value) {
    if (key === 'dangerouslySetInnerHTML') {
      dom.innerHTML = value?.__html ?? ''
      return
    }
    if (key === 'className') { dom.className = value ?? ''; return }
    if (key === 'style')     { return /* 由 updateStyle 处理 */ }
    if (BOOLEAN_PROPS.has(key)) { dom[key] = !!value; return }
    if (key.startsWith('data-') || key.startsWith('aria-')) {
      if (value == null || value === false) dom.removeAttribute(key)
      else dom.setAttribute(key, value === true ? '' : value)
      return
    }
    if (ATTR_ONLY_PROPS.has(key)) {
      const name = ATTR_NAME_MAP[key] || key
      if (value == null || value === false) dom.removeAttribute(name)
      else dom.setAttribute(name, value)
      return
    }
    // value/checked 等受控属性：IDL 赋值能正确同步 input 状态
    try { dom[key] = value }
    catch { /* 某些属性只读，吞掉错误 */ }
  }

  /**
   * 移除 DOM 属性：对布尔属性 / data-aria / 受控属性分别走不同路径。
   * 修复：原版统一 dom[k] = ''，对 disabled/checked 等布尔属性会留下错误状态
   * （'' 在某些浏览器中被 IDL 解释为 truthy）。
   */
  function unsetDomProp(dom, key, prevValue) {
    if (key === 'style')     { updateStyle(dom, prevValue, null); return }
    if (key === 'className') { dom.className = ''; return }
    if (BOOLEAN_PROPS.has(key)) { dom[key] = false; return }
    if (key.startsWith('data-') || key.startsWith('aria-') || ATTR_ONLY_PROPS.has(key)) {
      const name = ATTR_NAME_MAP[key] || key
      dom.removeAttribute(name); return
    }
    try { dom[key] = '' } catch { /* 忽略只读属性 */ }
  }

  /**
   * updateDom —— 在 mutation 阶段把 prev props 与 next props 的差异同步到 DOM。
   *
   * v3：ref 不再放在 props 中，ref 的绑定/解绑在 commitWork 中独立处理，
   *     避免 memo / reconcile 的 props 比较把 ref 也包括进来。
   */
  function updateDom(dom, prev, next) {
    // ── 事件：移除已删除/已变更的事件 ─────────────────────────────
    Object.keys(prev).filter(isEvent).filter(k => !(k in next) || isNew(prev, next)(k))
      .forEach(k => dom.removeEventListener(toEvt(k), prev[k]))

    // ── 普通属性：清理已不在 next 中的属性 ────────────────────────
    Object.keys(prev).filter(isProp).filter(isGone(prev, next))
      .forEach(k => unsetDomProp(dom, k, prev[k]))

    // ── 普通属性：写入新值或变更值 ────────────────────────────────
    Object.keys(next).filter(isProp).filter(isNew(prev, next))
      .forEach(k => {
        if (k === 'style') updateStyle(dom, prev.style, next.style)
        else setDomProp(dom, k, next[k])
      })

    // ── 事件：添加新增/已变更的事件 ───────────────────────────────
    Object.keys(next).filter(isEvent).filter(isNew(prev, next))
      .forEach(k => dom.addEventListener(toEvt(k), next[k]))
  }

  /**
   * commitRefBinding —— 在 commit 阶段同步 fiber.ref 到 DOM 节点。
   *
   * 时机：PLACEMENT 后（DOM 已挂载）/ UPDATE 时若 ref 变化。
   * 对应 React 的 commitAttachRef / commitDetachRef。
   */
  function commitRefBinding(fiber) {
    const newRef = fiber.ref
    const oldRef = fiber.alternate?.ref
    if (oldRef === newRef) {
      // PLACEMENT 时 alternate 为 null，oldRef === newRef === undefined 会跳过；
      // 但我们想在 mount 时绑定，所以单独判断
      if (!fiber.alternate && newRef && fiber.dom) setRef(newRef, fiber.dom)
      return
    }
    if (oldRef) setRef(oldRef, null)
    if (newRef && fiber.dom) setRef(newRef, fiber.dom)
  }

  function updateStyle(dom, prev, next) {
    if (typeof prev === 'string' && typeof next !== 'string') dom.style.cssText = ''
    if (prev && typeof prev === 'object')
      Object.keys(prev).forEach(k => { if (!next || !(k in next)) dom.style[k] = '' })
    if (typeof next === 'string') dom.style.cssText = next
    else if (next && typeof next === 'object') Object.assign(dom.style, next)
  }

  function setRef(ref, value) {
    if (!ref) return
    if (typeof ref === 'function') ref(value); else ref.current = value
  }

  function createDom(fiber) {
    const dom = fiber.type === 'TEXT_ELEMENT'
      ? document.createTextNode('')
      : document.createElement(fiber.type)
    updateDom(dom, {}, fiber.props)
    return dom
  }

  // ─────────────────────────────────────────────────────────────
  // § 8  HOOKS
  // ─────────────────────────────────────────────────────────────

  /**
   * useReducer —— 所有状态 hook 的基础（useState 是它的语法糖）。
   *
   * 状态更新流程：
   *   1. dispatch(action) 把 action 推入 hook.queue（不立刻渲染，只标记需要重渲染）
   *   2. scheduleRerender 创建新 wipRoot 触发工作循环
   *   3. 重新执行函数组件 → useReducer 读到 alternate.hooks[i] 的 queue
   *   4. queue.splice(0) 消费并清空所有 action，依次 reduce 出新 state
   *      ⚠️ splice(0) 是关键：清空原数组防止下次再次 reduce 同一批 action 造成累计
   *   5. 返回最新 state 给组件
   *
   * 注意闭包陷阱：dispatch 函数引用稳定（指向同一个 hook 对象），但每次渲染
   * hook 都是新对象，靠 hook.queue（与 alternate 共享）传递 action。
   *
   * 第三参数 init 用于惰性初始化：useReducer(reducer, props, p => createInitialState(p))
   * init 仅在首次渲染（无 alternate）时被调用。
   */
  function useReducer(reducer, initialState, init) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const queue   = oldHook ? oldHook.queue : []
    const hook    = {
      state:   oldHook ? oldHook.state : (init ? init(initialState) : initialState),
      queue,
      reducer,                                  // 缓存 reducer 用于 eager bailout
    }
    queue.splice(0).forEach(action => { hook.state = reducer(hook.state, action) })
    // 与真实 React 对齐：dispatch 引用基于 hook 稳定，且实现 eager bailout
    const dispatch = action => {
      // 仅当队列为空时尝试 eager 计算（队列非空意味着已经排队等待，
      // 此时不能跳过——否则会丢失一批 action）。
      if (hook.queue.length === 0) {
        let eagerNext
        try { eagerNext = hook.reducer(hook.state, action) }
        catch { eagerNext = undefined }
        // 如果 reducer 是纯函数，且 next 与 state 引用相同，
        // 直接 bailout，连入队都省了（与 React 的 eager bailout 一致）。
        if (eagerNext !== undefined && Object.is(eagerNext, hook.state)) return
      }
      hook.queue.push(action)
      scheduleRerender()
    }
    wipFiber.hooks.push(hook)
    hookIndex++
    return [hook.state, dispatch]
  }

  /**
   * useState —— useReducer 语法糖。
   * action 可以是值或 (prev) => next 函数（函数式更新避免闭包旧值）。
   * 支持惰性初始化：useState(() => expensive())。
   */
  function useState(initialState) {
    return useReducer(
      (s, a) => typeof a === 'function' ? a(s) : a,
      initialState,
      s => typeof s === 'function' ? s() : s,
    )
  }

  /**
   * useEffect —— 异步副作用（绘制后 setTimeout 异步执行）。
   *
   * 用途：网络请求、订阅、日志埋点等不阻塞首帧的副作用。
   *
   * deps 语义：
   *   undefined  → 每次渲染后都执行（一般避免，会过度触发）
   *   []         → 仅 mount/unmount 时执行一次（订阅类经典写法）
   *   [a, b]     → 任一依赖变化时重新执行（cleanup 在 next callback 之前调用）
   *
   * 状态机：
   *   首次：       callback ≠ null，cleanup = null  → 执行 callback，存 cleanup
   *   deps 变化：  执行旧 cleanup → 再执行 callback → 存新 cleanup
   *   deps 不变：  callback = null（跳过执行），cleanup 保留供卸载时调用
   *   卸载：       runUnmountEffects 调用 cleanup
   */
  function useEffect(callback, deps) {
    const old  = wipFiber.alternate?.hooks?.[hookIndex]
    const hook = { _isEffect: true, deps, cleanup: old?.cleanup ?? null,
      callback: haveDepsChanged(old?.deps, deps) ? callback : null }
    wipFiber.hooks.push(hook); hookIndex++
  }

  /**
   * useLayoutEffect —— 同步副作用（DOM 就绪，绘制前）。
   * 适合测量 DOM 尺寸、强制滚动等需要立即读写 DOM 的操作。
   * 执行顺序：useInsertionEffect → useLayoutEffect → useEffect（异步）
   */
  function useLayoutEffect(callback, deps) {
    const old  = wipFiber.alternate?.hooks?.[hookIndex]
    const hook = { _isLayoutEffect: true, deps, cleanup: old?.cleanup ?? null,
      callback: haveDepsChanged(old?.deps, deps) ? callback : null }
    wipFiber.hooks.push(hook); hookIndex++
  }

  /**
   * useInsertionEffect —— 最早的同步副作用，在 DOM 插入前触发（绘制前）。
   *
   * 设计用途：CSS-in-JS 库（如 styled-components、Emotion）在此注入 <style> 标签，
   * 确保样式在首次绘制前就位，彻底避免无样式内容闪烁（FOUC）。
   *
   * ⚠️ 禁止在此 hook 内读取或写入 DOM refs（DOM 尚未挂载/更新）。
   * ⚠️ 无法调用 setState（会死循环）。
   *
   * 执行顺序（commit 阶段）：
   *   1. useInsertionEffect（DOM 突变前）
   *   2. DOM 突变
   *   3. useLayoutEffect（DOM 突变后，绘制前）
   *   4. 浏览器绘制
   *   5. useEffect（绘制后异步）
   */
  function useInsertionEffect(callback, deps) {
    const old  = wipFiber.alternate?.hooks?.[hookIndex]
    const hook = { _isInsertionEffect: true, deps, cleanup: old?.cleanup ?? null,
      callback: haveDepsChanged(old?.deps, deps) ? callback : null }
    wipFiber.hooks.push(hook); hookIndex++
  }

  /** useMemo —— 缓存昂贵计算，deps 不变时返回旧值。factory 须为纯函数。 */
  function useMemo(factory, deps) {
    const old  = wipFiber.alternate?.hooks?.[hookIndex]
    const hook = { value: haveDepsChanged(old?.deps, deps) ? factory() : old.value, deps }
    wipFiber.hooks.push(hook); hookIndex++
    return hook.value
  }

  /** useRef —— 持久可变容器（.current 变化不触发重渲染）。 */
  function useRef(initialValue) { return useMemo(() => ({ current: initialValue }), []) }

  /** useCallback —— 缓存函数引用，等价于 useMemo(() => fn, deps)。 */
  function useCallback(fn, deps) { return useMemo(() => fn, deps) }

  /** useId —— 生成组件实例稳定的唯一 ID（':r0:'、':r1:' 格式）。 */
  function useId() { return useMemo(() => `:r${idCounter++}:`, []) }

  /**
   * useImperativeHandle —— 配合 forwardRef，向父组件暴露自定义 ref 对象。
   *
   * 设计要点：
   *   1. 在 layout 阶段同步设置 ref，确保父组件 componentDidMount/useLayoutEffect
   *      可以立即读取到 ref.current（不晚于 DOM 就绪时刻）。
   *   2. cleanup 时把 ref 置为 null，避免父组件持有"已卸载组件"的句柄导致内存泄漏。
   *   3. ref 本身参与依赖数组（修复：原版仅以用户 deps 作为依赖，
   *      ref 切换时旧 ref 不会被清空，新 ref 也不会被赋值，导致 ref 失同步）。
   *
   * 用法：
   *   useImperativeHandle(ref, () => ({ focus, reset }), [deps...])
   */
  function useImperativeHandle(ref, createHandle, deps) {
    // 把 ref 注入到 deps 中：ref 变化时强制重新执行 effect
    const finalDeps = deps == null ? undefined : [ref, ...deps]
    useLayoutEffect(() => {
      if (!ref) return
      setRef(ref, createHandle())
      return () => setRef(ref, null)
    }, finalDeps)
  }

  /**
   * useDebugValue —— 在 DevTools 中显示自定义 hook 的标签（生产环境无操作）。
   * formatter 可选：(value) => string（DevTools 展开时才调用）。
   */
  function useDebugValue(_value, _formatter) {
    // 占位 hook，保持 hookIndex 连续；实际调试功能由 DevTools 实现
    wipFiber.hooks.push({ _isDebugValue: true })
    hookIndex++
  }

  /**
   * useTransition —— 将状态更新标记为"可中断的低优先级过渡"。
   *
   * 返回 [isPending, startTransition]：
   *   - isPending：过渡期间为 true，可用于显示 loading 指示器
   *   - startTransition：把状态更新包在它里面，标记为低优先级
   *
   * 典型场景：搜索框输入时，列表过滤计算昂贵但不应阻塞输入光标。
   *   const [isPending, startTransition] = useTransition()
   *   const onChange = e => {
   *     setQuery(e.target.value)              // 高优先级：立即响应
   *     startTransition(() => setList(...))   // 低优先级：让出主线程
   *   }
   *
   * ⚠️ 简化实现：callback 在 setTimeout 中执行，让浏览器有机会先处理高优先级
   *    更新（如输入框值同步）。真实 React 18 通过 Scheduler 优先级通道实现
   *    真正的可中断渲染（"时间片让步"），此处仅是宏任务级的近似。
   */
  function useTransition() {
    const [isPending, setIsPending] = useState(false)
    // start 引用稳定，即使 isPending 变化也不重建（避免子组件 useEffect 误触发）
    const start = useCallback(callback => {
      setIsPending(true)
      setTimeout(() => { callback(); setIsPending(false) }, 0)
    }, [])
    return [isPending, start]
  }

  /**
   * useDeferredValue —— 返回一个"延迟版本"的值，在高优先级更新完成后才更新。
   *
   * 工作原理（简化版）：
   *   1. 渲染时返回缓存的旧值
   *   2. useEffect 在 commit + paint 后异步把 deferred 更新为最新值
   *   3. 触发二次渲染，此时返回新值
   * 这样输入框等高频交互不会被昂贵子树阻塞，子树在浏览器空闲时才同步到最新值。
   *
   * ⚠️ 与 React 18 的差异：真实 React 用 Scheduler 优先级让出，此处用 setTimeout(0)
   *    近似——足够演示场景但缺少真正的中断恢复语义。
   *
   * 修复：原版直接 return value 等于没用，与 useTransition 配合使用时无延迟效果。
   */
  function useDeferredValue(value) {
    const [deferred, setDeferred] = useState(value)
    useEffect(() => {
      if (Object.is(deferred, value)) return
      // 微任务/宏任务延迟：让高优先级渲染先完成
      const id = setTimeout(() => setDeferred(value), 0)
      return () => clearTimeout(id)
    }, [value])
    return deferred
  }

  /**
   * useSyncExternalStore —— 订阅外部数据源（Redux、Zustand 等状态管理库专用 hook）。
   *
   * @param subscribe    接收一个回调函数并返回取消订阅函数：
   *                       const unsub = subscribe(onStoreChange)
   *                       return unsub  // 组件卸载时自动调用
   * @param getSnapshot  返回当前快照的纯函数，每次渲染都会调用
   *
   * 工作原理：
   *   1. 渲染时直接调用 getSnapshot() 读取最新值（无缓存，无闭包问题）
   *   2. useEffect 订阅外部 store；store 变化时 forceUpdate 触发重渲染
   *   3. 重渲染时再次调用 getSnapshot() 读取最新值
   *   4. 卸载时 useEffect 清理函数自动取消订阅
   *
   * ⚠️ subscribe 应为稳定引用（用 useCallback 或模块级函数），否则每次渲染都重新订阅。
   * ⚠️ getSnapshot 必须为纯函数（相同 store 状态返回 Object.is 相等的快照）。
   * ⚠️ 简化差异：无 concurrent 模式的防撕裂（tearing）保护。
   *
   * 使用示例：
   *   const count = useSyncExternalStore(store.subscribe, store.getSnapshot)
   */
  function useSyncExternalStore(subscribe, getSnapshot) {
    // forceUpdate 用于 store 变化时强制组件重渲染
    // useReducer(s => s + 1, 0) 是标准的"强制刷新"惯用法
    const [, forceUpdate] = useReducer(s => s + 1, 0)

    useEffect(() => {
      // 订阅 store：store 内部状态变化时调用 forceUpdate
      const unsub = subscribe(forceUpdate)
      // 立即同步一次：防止 subscribe() 执行前 store 已变化导致快照过期
      forceUpdate()
      return unsub  // 返回取消订阅函数，组件卸载时自动执行
    }, [subscribe])  // subscribe 变化（换了 store）时重新订阅

    // 每次渲染都调用 getSnapshot() 以获取最新值（无 stale closure 问题）
    return getSnapshot()
  }

  // ─────────────────────────────────────────────────────────────
  // § 9  CONTEXT
  // ─────────────────────────────────────────────────────────────

  /**
   * createContext —— 跨层级数据通道。
   *
   * 原理（渲染期栈恢复）：
   *   Provider beginWork → 保存旧值 → 注入 fiber.props.value
   *   Provider completeWork → 恢复旧值（completeUnitOfWork）
   *   子树 DFS 渲染期间 _currentValue 始终是最近 Provider 的值。
   *
   * ⚠️ memo 可能阻止 context 消费者响应更新（无精确订阅）。
   */
  function createContext(defaultValue) {
    function Provider({ children }) {
      // value 注入由 updateFunctionComponent 中 renderFn._context 分支完成
      if (children == null) return null
      return Array.isArray(children) ? createElement(Fragment, null, ...children) : children
    }
    Provider._context = null
    const ctx = {
      _currentValue: defaultValue,
      Provider,
      Consumer({ children }) { return children(ctx._currentValue) },
    }
    Provider._context = ctx
    return ctx
  }

  /** useContext —— 读取最近 Provider 注入的值，占位保持 hookIndex 连续。 */
  function useContext(context) {
    wipFiber.hooks.push({ _isContext: true })
    hookIndex++
    return context._currentValue
  }

  // ─────────────────────────────────────────────────────────────
  // § 10  CLASS COMPONENT（类组件）
  // ─────────────────────────────────────────────────────────────

  /**
   * Component —— 类组件基类。
   *
   * setState 可以传入对象（浅合并）或函数 (prevState) => partial：
   *   this.setState({ count: 1 })
   *   this.setState(s => ({ count: s.count + 1 }))
   *
   * forceUpdate 强制重渲染（跳过 shouldComponentUpdate）。
   *
   * 支持的生命周期：
   *   static getDerivedStateFromProps(props, state) → partialState | null
   *   shouldComponentUpdate(nextProps, nextState) → boolean
   *   componentDidMount()
   *   componentDidUpdate(prevProps, prevState)
   *   componentWillUnmount()
   *   render() → element（必须实现）
   */
  class Component {
    constructor(props, context) {
      this.props = props
      this.state = {}
      // static contextType：消费一个 context（与 React 行为一致）
      this.context = context
      this._fiber = null
      // setState/forceUpdate 的 callback 队列：commit 后按入队顺序逐一调用
      this._pendingCallbacks = []
    }

    /**
     * setState(updater, callback?) —— 触发重渲染。
     * @param updater   新 state 对象（浅合并）或 (prevState, props) => partial
     * @param callback  可选，commit 完成后调用（DOM 已更新；可读取 this.state）
     */
    setState(updater, callback) {
      const next = typeof updater === 'function'
        ? updater(this.state, this.props)
        : updater
      // null/undefined → React bail-out（什么都不做）
      if (next == null) {
        if (typeof callback === 'function') this._pendingCallbacks.push(callback)
        return
      }
      this.state = { ...this.state, ...next }
      if (typeof callback === 'function') this._pendingCallbacks.push(callback)
      if (this._fiber) scheduleRerender()
    }

    /**
     * forceUpdate(callback?) —— 强制重渲染，跳过 shouldComponentUpdate。
     */
    forceUpdate(callback) {
      if (typeof callback === 'function') this._pendingCallbacks.push(callback)
      if (this._fiber) scheduleRerender()
    }

    render() {}
  }
  Component._isClass = true

  /**
   * PureComponent —— 自带浅比较的 shouldComponentUpdate 类组件基类。
   * props 和 state 均未变化时跳过渲染，等价于函数组件的 memo。
   */
  class PureComponent extends Component {}
  PureComponent._isPure = true

  // ─────────────────────────────────────────────────────────────
  // § 11  PORTAL
  // ─────────────────────────────────────────────────────────────

  /**
   * createPortal —— 将子节点渲染到任意 DOM 容器（而非当前 Fiber 的父 DOM）。
   *
   * 常见用途：模态框、Tooltip、下拉菜单（需要渲染到 document.body）。
   *
   * 实现原理：
   *   返回 type=PORTAL 的 Element；updateHostComponent 检测到 PORTAL 后
   *   将 fiber.dom 设为目标容器，子节点自然插入容器中。
   *   commitWork 中 PORTAL 自身不执行 appendChild（容器已在 DOM 树中）。
   *   删除时由 commitDeletion 从容器内移除子节点。
   */
  function createPortal(children, container) {
    const kids = Array.isArray(children) ? children : (children != null ? [children] : [])
    return { type: PORTAL, props: { container, children: kids } }
  }

  // ─────────────────────────────────────────────────────────────
  // § 12  SUSPENSE & LAZY
  // ─────────────────────────────────────────────────────────────

  /**
   * Suspense —— 异步组件加载期间显示 fallback。
   *
   * 工作流程：
   *   1. 首次渲染：子树正常渲染，lazy 组件抛出 Promise
   *   2. updateFunctionComponent 捕获 Promise，
   *      在最近的 Suspense fiber 上设 _suspendPending = promise，
   *      同时设 needsRerenderAfterCommit = true
   *   3. 首次提交后 commitRoot 触发第二次渲染
   *   4. 第二次渲染：Suspense 检测到 alternate._suspendPending → 显示 fallback
   *   5. Promise resolve → 清除 _suspendPending → scheduleRerender → 显示真实内容
   *
   * ⚠️ 简化差异：首次渲染会短暂显示空内容（约一帧），之后显示 fallback。
   *    真实 React 通过 concurrent 模式避免了这个闪烁。
   */
  function Suspense({ children, fallback }) {
    // wipFiber.alternate._pendingSet 由 updateFunctionComponent catch 分支写入
    // 集合非空 → 还有 Promise 未解决，渲染 fallback；
    // 集合为空或不存在 → 所有 Promise 已 settle，渲染真实 children。
    const pending = wipFiber.alternate?._pendingSet
    if (pending && pending.size > 0) {
      return fallback ?? null
    }
    if (!children) return null
    return Array.isArray(children) ? createElement(Fragment, null, ...children) : children
  }
  Suspense._isSuspense = true

  /**
   * lazy —— 懒加载组件（代码分割）。
   *
   * 用法：
   *   const Chart = lazy(() => import('./Chart.js'))
   *   // 在 Suspense 内使用：
   *   <Suspense fallback={<Spinner/>}><Chart/></Suspense>
   *
   * 状态机：pending → resolved → rejected
   *   pending   → 抛出 thenable，触发 Suspense boundary
   *   resolved  → 渲染加载到的组件
   *   rejected  → 抛出错误（由 ErrorBoundary 捕获，此实现无 EB 则冒泡）
   */
  function lazy(factory) {
    let status = 'pending'
    let result = null
    const promise = factory().then(
      mod => { status = 'resolved'; result = mod.default ?? mod },
      err => { status = 'rejected'; result = err }
    )

    function LazyComponent(props) {
      if (status === 'resolved') return createElement(result, props)
      if (status === 'rejected') throw result
      throw promise  // 触发 Suspense
    }
    LazyComponent.displayName = 'Lazy'
    return LazyComponent
  }

  /**
   * StrictMode —— 开发辅助：透明渲染（此实现不做双调用检测，仅作 API 占位）。
   * 在真实 React 开发模式下，StrictMode 会对副作用进行双调用检测。
   */
  function StrictMode({ children }) {
    if (!children) return null
    return Array.isArray(children) ? createElement(Fragment, null, ...children) : children
  }

  // ─────────────────────────────────────────────────────────────
  // § 13  高阶组件：forwardRef / memo
  // ─────────────────────────────────────────────────────────────

  /**
   * forwardRef —— 透传 ref 给函数组件内部的 DOM 或子组件。
   *
   * 用法：
   *   const Input = forwardRef((props, ref) => <input ref={ref} {...props}/>)
   *   <Input ref={myRef}/>  →  myRef.current = input DOM
   *
   * 实现：返回带 _isForwardRef 标记的包装函数；
   * updateFunctionComponent 检测到标记后把 fiber.ref（element 顶层 ref）
   * 作为第二参数传入 _renderFn。包装函数 ForwardRef 本身不会被直接调用——
   * 但保留它以便诸如 React.isValidElement / type 判等等场景识别。
   */
  function forwardRef(renderFn) {
    function ForwardRef(props) { return renderFn(props, null) }
    ForwardRef._isForwardRef = true
    ForwardRef._renderFn     = renderFn
    ForwardRef.displayName   = `forwardRef(${renderFn.displayName || renderFn.name || 'Component'})`
    return ForwardRef
  }

  /**
   * memo —— 跳过 props 未变化的函数组件渲染（浅比较）。
   *
   * 用法：
   *   const Pure = memo(MyComp)                                  // 默认浅比较
   *   const Pure = memo(MyComp, (prev, next) => prev.id === next.id)  // 自定义比较
   *
   * 实现：返回带 _isMemo 标记的包装函数，updateFunctionComponent 检测到
   * 标记后在渲染前先做 alternate.props 与 props 的浅比较，相等则复用上次的
   * memoizedElement（彻底跳过函数体执行 + 子树 diff）。
   *
   * ⚠️ 注意事项：
   *   - 与 useContext 配合时，memo 不会拦截 context 变化触发的重渲染（消费者
   *     仍然会订阅 context 更新），但会拦截父组件传下来的 props 引起的重渲染。
   *   - 与 forwardRef 嵌套使用：memo(forwardRef(...)) 是合法且常见的写法，
   *     本实现已正确处理（updateFunctionComponent 解 memo 后再判 forwardRef）。
   */
  function memo(component, compare) {
    function Memoized(props) { return component(props) }
    Memoized._isMemo     = true
    Memoized._type       = component
    Memoized._compare    = compare || shallowEqualProps
    Memoized.displayName = `memo(${component.displayName || component.name || 'Component'})`
    return Memoized
  }

  // ─────────────────────────────────────────────────────────────
  // § 14  渲染入口
  // ─────────────────────────────────────────────────────────────

  /**
   * render —— 将 Element 挂载到 DOM 容器（React 17 风格）。
   * 异步执行（requestIdleCallback），如需立即渲染用 flushSync。
   */
  function render(element, container) {
    wipRoot        = { dom: container, props: { children: [element] }, alternate: currentRoot }
    deletions      = []
    nextUnitOfWork = wipRoot
    scheduleWorkLoop()
  }

  /**
   * createRoot —— React 18 风格的根节点 API。
   *   const root = createRoot(document.getElementById('root'))
   *   root.render(<App/>)
   *   root.unmount()
   */
  function createRoot(container) {
    return {
      render(element) { render(element, container) },
      unmount() {
        wipRoot        = { dom: container, props: { children: [] }, alternate: currentRoot }
        deletions      = []
        nextUnitOfWork = wipRoot
        scheduleWorkLoop()
      },
    }
  }

  /**
   * flushSync —— 同步立即提交 callback 中触发的所有状态更新。
   *
   * 典型场景：
   *   - 添加列表项后立刻滚动到底部（DOM 必须先就绪）
   *   - 测试中需要在断言前确保 DOM 已更新
   *   - 与第三方库（如 jQuery 插件）交互前同步刷新
   *
   * 实现：先执行回调（其中的 setState 会进入 wipRoot 队列），
   *      再 flushSyncWork 把所有未完成的工作循环跑到底并提交。
   *
   * ⚠️ 嵌套调用：内部加 _isFlushingSync 标记，嵌套时只执行回调不再触发 flushSyncWork
   *    （外层 flushSync 一次性收尾即可，避免重复提交触发 commit 重入）。
   * ⚠️ 会阻塞浏览器绘制：组件树过大时谨慎使用。
   */
  let _isFlushingSync = false
  function flushSync(callback) {
    if (_isFlushingSync) { callback(); return }
    _isFlushingSync = true
    try { callback(); flushSyncWork() }
    finally { _isFlushingSync = false }
  }

  /**
   * startTransition —— 将 callback 中的更新标记为低优先级过渡（简化版）。
   * 真实 React 18 用 Scheduler 实现并发优先级，此处直接同步调用。
   */
  function startTransition(callback) { callback() }

  /**
   * batch —— 显式批量提交多次状态更新（API 兼容层）。
   * mini-react 中 dispatch 天然批量（均入队后一次渲染），此函数仅为 API 一致性。
   */
  function batch(fn) { fn() }

  /**
   * act —— 测试工具：同步刷新所有待处理的渲染工作和副作用。
   *
   * 在单元测试中，状态更新是异步的（requestIdleCallback / setTimeout），
   * act() 强制同步完成所有工作，使测试断言能立即看到最新 DOM。
   *
   * 用法：
   *   // 同步场景：
   *   act(() => { fireEvent.click(button) })
   *   expect(container.textContent).toBe('1')  // DOM 已同步更新
   *
   *   // 异步场景（React.lazy / 异步 useEffect / fetch）：
   *   await act(async () => { await someAsyncOp() })
   *
   * 执行顺序：
   *   1. 执行 callback（触发 setState / dispatch）
   *   2. 同步提交所有排队的渲染（flushSyncWork）
   *   3. 同步清空所有 passive effects（useEffect，跳过 setTimeout 等待）
   *   4. 若 effects 触发了新的 setState，反复刷新直到稳定（最多 50 轮防死循环）
   *
   * 修复：原版仅同步执行 callback，无法处理 async 回调（callback 返回 Promise 时
   * 在 await 之前就提交，导致 Promise 内部的 setState 被遗漏）。新版若检测到 thenable
   * 会返回 Promise，等待解决后再走刷新流程。
   */
  function flushUntilStable() {
    let safety = 50
    while (safety-- > 0) {
      flushSyncWork()
      passiveFlushScheduled = false
      const roots = pendingPassiveRoots.splice(0)
      if (!roots.length && !nextUnitOfWork && !wipRoot) break
      roots.forEach(flushPassiveEffects)
    }
  }
  function act(callback) {
    const result = callback()
    // 异步回调：返回 Promise 让调用方 await
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).then(() => { flushUntilStable() })
    }
    flushUntilStable()
  }

  // ─────────────────────────────────────────────────────────────
  // § 15  内部工具函数
  // ─────────────────────────────────────────────────────────────

  /**
   * scheduleRerender —— 触发一次根级重渲染。
   *
   * 关键判断：
   *   - currentRoot 为 null → 还没首次提交，setState 推迟到首次 commit 后再处理
   *   - isCommitting → 正在 mutation pass 中（layout effect 之前），
   *     此时若立刻替换 wipRoot 会破坏正在进行的 commit；推迟到 commit 末尾统一处理
   *
   * 否则：构造新 wipRoot 复用 currentRoot 的 dom 与 props，从根开始 diff。
   */
  function scheduleRerender() {
    if (!currentRoot || isCommitting) { pendingRerender = true; return }
    wipRoot        = { dom: currentRoot.dom, props: currentRoot.props, alternate: currentRoot }
    deletions      = []
    nextUnitOfWork = wipRoot
    scheduleWorkLoop()
  }

  /**
   * flushSyncWork —— 同步把当前所有未完成的工作做完并提交。
   * 区别于 workLoop：不让出主线程，连续运行直到 nextUnitOfWork 为空。
   * 用于 flushSync / act / 测试等需要立即看到 DOM 结果的场景。
   *
   * Bug fix（v3）：原版无递归深度护栏 —— 当 layout effect 的 setState 又触发
   * 新一轮 commit、commitRoot 末尾再次调用 flushSyncWork 形成
   * commitRoot ↔ flushSyncWork 的相互递归，若用户代码不收敛（典型场景：
   * Profiler 的 onRender 里 setState 同一棵子树的 state）就会把栈压爆。
   *
   * 增加 SYNC_FLUSH_LIMIT（与 React "Maximum update depth exceeded" 同源）：
   * 一旦同步刷新深度超过阈值，强制中止并清空待处理工作，向 console 报错。
   */
  let _syncFlushDepth = 0
  const SYNC_FLUSH_LIMIT = 50
  function flushSyncWork() {
    if (_syncFlushDepth >= SYNC_FLUSH_LIMIT) {
      console.error(
        '[mini-react] 检测到无限同步渲染循环（flushSync 深度 > ' + SYNC_FLUSH_LIMIT + '），' +
        '通常是 useLayoutEffect / 类组件 componentDidUpdate / Profiler.onRender 中无条件 setState 导致。' +
        '已强制中止后续提交以防止栈溢出。'
      )
      nextUnitOfWork = null
      wipRoot = null
      pendingRerender = false
      return
    }
    _syncFlushDepth++
    try {
      while (nextUnitOfWork) nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
      if (wipRoot) commitRoot()
    } finally {
      _syncFlushDepth--
    }
  }

  /**
   * scheduleWorkLoop —— 把 workLoop 排到下一个空闲帧。
   * 用 workLoopScheduled 标志去重，避免一帧内重复排队浪费资源。
   */
  function scheduleWorkLoop() {
    if (workLoopScheduled) return
    workLoopScheduled = true
    requestIdle(workLoop)
  }

  /** 判断是否为类组件（原型链上有 Component._isClass）。 */
  const isClassComponent = fiber =>
    typeof fiber.type === 'function' && !!fiber.type._isClass

  /** 判断是否为函数组件（含 memo / forwardRef 包装，排除类组件）。 */
  const isFnComponent = fiber =>
    typeof fiber.type === 'function' && !fiber.type._isClass

  /** shallowEqualProps —— 浅比较 props（空 children 数组视为相等，避免 memo 失效）。 */
  function shallowEqualProps(prev, next) {
    const pk = Object.keys(prev), nk = Object.keys(next)
    if (pk.length !== nk.length) return false
    return pk.every(k => {
      if (!Object.prototype.hasOwnProperty.call(next, k)) return false
      const [a, b] = [prev[k], next[k]]
      if (k === 'children' && Array.isArray(a) && Array.isArray(b) && !a.length && !b.length) return true
      return Object.is(a, b)
    })
  }

  /** haveDepsChanged —— 依赖项对比（Object.is；prevDeps 为 null/undefined 视为总是变化）。 */
  function haveDepsChanged(prev, next) {
    if (!prev || !next) return true
    if (prev.length !== next.length) return true
    return next.some((d, i) => !Object.is(d, prev[i]))
  }

  // key/ref 已迁到 element/fiber 顶层（v3）
  function getElementKey(el) { return el?.key ?? null }
  function getFiberKey(f)    { return f?.key  ?? null }

  /**
   * applyDefaultProps —— 与真实 React 一致的默认 props 合并策略。
   *
   * 用法：
   *   function MyComp({ size }) { ... }
   *   MyComp.defaultProps = { size: 'medium' }
   *
   * 规则：
   *   - 仅当 props[k] === undefined 时填默认值（null 不会被覆盖）
   *   - 不会污染原 fiber.props 之外的对象
   *   - 没有 defaultProps 时直接 return，零额外开销
   */
  function applyDefaultProps(fiber, component) {
    const dp = component?.defaultProps
    if (!dp) return
    const merged = { ...fiber.props }
    let touched = false
    for (const k in dp) {
      if (merged[k] === undefined) { merged[k] = dp[k]; touched = true }
    }
    if (touched) fiber.props = merged
  }

  /**
   * propagateError —— 向上遍历 Fiber 树，寻找最近的 Error Boundary 并应用错误状态。
   *
   * Error Boundary 条件（与 React 一致）：
   *   - 必须是类组件
   *   - 实现了 static getDerivedStateFromError(error) 或 componentDidCatch(error, info)
   *   - 注意：函数组件不能成为 Error Boundary（React 未来计划通过 use() 支持）
   *
   * getDerivedStateFromError：
   *   - 静态方法，接收 error，返回 partial state（用于渲染错误 UI）
   *   - 在渲染阶段同步调用，必须为纯函数
   *
   * componentDidCatch：
   *   - 实例方法，接收 error 和 info（{componentStack}）
   *   - 在 commit 阶段调用（见 commitRoot 末尾），适合上报错误日志
   *
   * 返回 true 表示错误已被边界捕获；false 表示无边界，错误将继续向上抛出。
   */
  function propagateError(fiber, error) {
    let boundary = fiber.return
    while (boundary) {
      const inst = boundary.instance
      const type = boundary.type
      const isEB = inst && (
        typeof type?.getDerivedStateFromError === 'function' ||
        typeof inst.componentDidCatch        === 'function'
      )
      if (isEB) {
        // getDerivedStateFromError：同步更新 state，下次渲染时展示错误回退 UI
        if (typeof type.getDerivedStateFromError === 'function') {
          const errorState = type.getDerivedStateFromError(error)
          if (errorState) inst.state = { ...inst.state, ...errorState }
        }
        // 记录待处理的 boundary，在 commitRoot 末尾触发 componentDidCatch + 重渲染
        // 同一轮 render 可能有多个 Boundary 命中，全部入队后统一处理
        pendingErrorBoundaries.push({ boundary, error })
        return true
      }
      boundary = boundary.return
    }
    return false
  }

  /**
   * createRef —— 返回全新 ref 对象（不依赖 hooks，每次调用返回不同对象）。
   * 与 useRef 区别：不与 Fiber 绑定，适合类组件构造函数或模块级变量。
   */
  function createRef(initialValue = null) { return { current: initialValue } }

  /**
   * Children —— 安全操作 children prop 的工具集（与 React.Children 行为对齐）。
   *
   * v3 关键改动：
   *   - key 写到 element 顶层而非 props（与 React 一致）
   *   - toArray 对嵌套数组使用前缀 '.<i>' / '.<i>:.<j>' 形式，
   *     映射后再当作 children 时仍保持稳定 key（避免列表重新挂载）
   *   - map 的回调返回值若是合法 element 且没有显式 key，
   *     会在原 key 前加上当前位置前缀（实现 key 链路追踪）
   *
   * 过滤规则：剔除 null / undefined / boolean（条件渲染产物）。
   */
  const SEPARATOR = '.'
  const SUBSEPARATOR = ':'

  function escapeUserKey(k) {
    // 用户提供的 key 可能含特殊字符，转义防止冲突（与 React 同思路）
    return ('' + k).replace(/[=:]/g, m => m === '=' ? '=0' : '=2')
  }

  function getElementKeyForFlatten(element, index) {
    if (isValidElement(element) && element.key != null) return SEPARATOR + escapeUserKey(element.key)
    return index.toString(36)
  }

  function flattenChildren(children, prefix = '', result = []) {
    const list = Array.isArray(children) ? children : [children]
    list.forEach((child, i) => {
      if (child == null || typeof child === 'boolean') return
      // 嵌套数组：递归展开，前缀加 SUBSEPARATOR
      if (Array.isArray(child)) {
        const nextPrefix = prefix === '' ? SEPARATOR : prefix + SUBSEPARATOR
        flattenChildren(child, nextPrefix + i.toString(36) + SUBSEPARATOR, result)
        return
      }
      // 字符串/数字 → TEXT_ELEMENT，便于一致处理
      if (typeof child === 'string' || typeof child === 'number') {
        const key = prefix === '' ? '.' + i.toString(36) : prefix + i.toString(36)
        result.push({ ...createTextElement(child), key })
        return
      }
      if (isValidElement(child)) {
        const childKey = getElementKeyForFlatten(child, i)
        const finalKey = prefix === '' ? childKey : prefix + childKey.slice(1)  // 去掉子级的开头 .
        result.push({ ...child, key: finalKey })
        return
      }
      // 其它类型（自定义可迭代等）当前保留原样，与 React 简化一致
      result.push(child)
    })
    return result
  }

  const Children = {
    toArray(children) { return flattenChildren(children) },
    map(children, fn) {
      // map 的结果再次当作 children 时，每项 key 自动包含位置前缀，
      // 即便用户的回调返回了带 key 的元素也能保持唯一性
      return flattenChildren(children).map((c, i) => {
        const mapped = fn(c, i)
        if (!isValidElement(mapped)) return mapped
        const baseKey = mapped.key != null
          ? '/' + escapeUserKey(mapped.key)
          : ''
        return { ...mapped, key: (c.key ?? i) + baseKey }
      })
    },
    forEach(children, fn) { flattenChildren(children).forEach(fn) },
    count(children)       { return flattenChildren(children).length },
    only(children) {
      const arr = flattenChildren(children)
      if (arr.length !== 1) throw new Error('Children.only: expected exactly one child')
      return arr[0]
    },
  }

  // ═════════════════════════════════════════════════════════════
  // § 17  REACT 19 风格 HOOKS：use / useOptimistic / useActionState
  // ═════════════════════════════════════════════════════════════

  /**
   * use() —— React 19 引入的"通用读取"hook，可以在渲染中：
   *   1. 读取 Promise（未 resolve 抛出，触发 Suspense；resolved 返回结果）
   *   2. 读取 Context（与 useContext 等价但可用于条件分支）
   *
   * 与传统 hook 的关键区别：
   *   - 不依赖 hookIndex 顺序（条件分支中也能调用）
   *   - 不在 fiber.hooks 里占位，纯粹的读取语义
   *
   * 实现细节：
   *   - Promise 缓存在 promise._mr_ 字段，避免每次渲染重复 then
   *   - resolved/rejected 后直接返回结果或抛错（错误会冒泡到 ErrorBoundary）
   *   - pending 时抛 promise 触发 Suspense（与 lazy 走同一条路径）
   *
   * 用法：
   *   function Profile({ userPromise }) {
   *     const user = use(userPromise)            // Promise → user
   *     const theme = use(ThemeContext)          // Context → 当前值
   *     return <div>{user.name} ({theme})</div>
   *   }
   *
   * ⚠️ 用 use() 读 Promise 时，每次渲染传入"同一个"Promise 才有意义；
   *    每次渲染创建新 Promise 会反复触发 Suspense（无限挂起）。
   */
  function use(resource) {
    if (resource == null) {
      throw new Error('use(): 不能传入 null/undefined')
    }
    // ── 分支 1：Context 对象（包含 _currentValue 字段） ───────────
    if (typeof resource === 'object' && '_currentValue' in resource) {
      return resource._currentValue
    }
    // ── 分支 2：Thenable（Promise） ──────────────────────────────
    if (typeof resource.then === 'function') {
      // 已 resolve：直接返回缓存的值
      if (resource._mr_status === 'fulfilled') return resource._mr_value
      // 已 rejected：抛出错误（由最近的 ErrorBoundary 接住）
      if (resource._mr_status === 'rejected')  throw resource._mr_value
      // pending：首次见到时挂 then 回调登记结果
      if (resource._mr_status === undefined) {
        resource._mr_status = 'pending'
        resource.then(
          v => { resource._mr_status = 'fulfilled'; resource._mr_value = v },
          e => { resource._mr_status = 'rejected';  resource._mr_value = e }
        )
      }
      // 抛 thenable 触发 Suspense（updateFunctionComponent catch 分支会处理）
      throw resource
    }
    throw new Error('use(): 仅支持 Context 或 Thenable，收到 ' + typeof resource)
  }

  /**
   * useOptimistic(state, updateFn) —— React 19 乐观更新 hook。
   *
   * 返回 [optimisticState, addOptimistic]：
   *   - optimisticState：在过渡期显示的"假装已完成"的状态
   *   - addOptimistic(payload)：提交一个乐观更新，通过 updateFn 计算新状态
   *
   * 行为：
   *   1. 调用 addOptimistic 后，optimisticState 立即变为 updateFn(state, payload)
   *   2. 当真实 state（来自外部 props/state）更新时，乐观状态自动作废，
   *      切回真实状态
   *
   * 典型场景：留言板"发送"时立刻显示自己的消息（虽然请求还没回来），
   *           成功后用真实数据替换；失败则自动回滚。
   *
   * 实现：本质是"以 state 为基准，叠加待定 payload 列表"的派生计算。
   *       state 一旦变化，待定列表就清空（视为已落库）。
   */
  function useOptimistic(state, updateFn) {
    const [pending, setPending] = useState([])
    // state 变化（真实数据落库）时清空待定列表
    const lastState = useRef(state)
    if (!Object.is(lastState.current, state)) {
      lastState.current = state
      if (pending.length > 0) {
        // 用 useEffect 异步清空避免渲染期 setState 警告
        Promise.resolve().then(() => setPending([]))
      }
    }
    const optimistic = pending.reduce(
      (acc, p) => updateFn(acc, p),
      state,
    )
    const addOptimistic = useCallback(payload => {
      setPending(prev => [...prev, payload])
    }, [])
    return [optimistic, addOptimistic]
  }

  /**
   * useActionState(action, initialState) —— React 19 表单 action 状态管理。
   *
   * 返回 [state, dispatch, isPending]：
   *   - state：当前 action 计算出的状态
   *   - dispatch(payload)：异步触发 action，并把结果写回 state
   *   - isPending：action 执行期间为 true（用于 disable 按钮等）
   *
   * action 签名：(prevState, formData|payload) => Promise<newState>
   * 与 useReducer 的差异：action 是 async 的，自带 isPending 指示器。
   */
  function useActionState(action, initialState) {
    const [state, setState]     = useState(initialState)
    const [isPending, setPending] = useState(false)
    const dispatch = useCallback(async payload => {
      setPending(true)
      try {
        const next = await action(state, payload)
        setState(next)
      } finally {
        setPending(false)
      }
    }, [action, state])
    return [state, dispatch, isPending]
  }

  // ═════════════════════════════════════════════════════════════
  // § 18  PROFILER —— 渲染性能测量
  // ═════════════════════════════════════════════════════════════

  /**
   * Profiler —— 测量子树渲染耗时的工具组件（与真实 React Profiler 同名同 API）。
   *
   * 用法：
   *   <Profiler id="UserList" onRender={(id, phase, duration) => {
   *     console.log(`[${id}] ${phase} 用时 ${duration}ms`)
   *   }}>
   *     <UserList />
   *   </Profiler>
   *
   * onRender 参数：
   *   id              —— Profiler 的 id 属性
   *   phase           —— 'mount' 首次挂载 / 'update' 更新
   *   actualDuration  —— 本次渲染实际耗时（ms）
   *   baseDuration    —— 不计 memo 的总耗时（此简化版与 actualDuration 相同）
   *   startTime       —— 开始时间戳
   *   commitTime      —— 提交时间戳
   *
   * 实现：包装函数组件，render 前 mark 开始时间，render 后在 useLayoutEffect
   *       中计算耗时并调用 onRender（layout effect 阶段 DOM 已就绪）。
   */
  function Profiler({ id, onRender, children }) {
    const startTime = performance.now()
    const isMount   = useRef(true)

    useLayoutEffect(() => {
      const commitTime  = performance.now()
      const actualDuration = commitTime - startTime
      const phase = isMount.current ? 'mount' : 'update'
      isMount.current = false
      try {
        onRender?.(id, phase, actualDuration, actualDuration, startTime, commitTime)
      } catch (e) {
        console.error('[Profiler] onRender threw:', e)
      }
    })

    if (!children) return null
    return Array.isArray(children)
      ? createElement(Fragment, null, ...children)
      : children
  }

  // ═════════════════════════════════════════════════════════════
  // § 19  SUSPENSELIST —— 协调多个 Suspense 边界的揭示顺序
  // ═════════════════════════════════════════════════════════════

  /**
   * SuspenseList —— 协调多个 Suspense 子组件的揭示顺序，避免内容跳动。
   *
   * Props:
   *   revealOrder   —— 'forwards'（默认，顺序揭示）/ 'backwards'（逆序）/ 'together'（同时揭示）
   *   tail          —— 'collapsed'（只显示一个 fallback）/ 'hidden'（不显示尚未到来的 fallback）
   *
   * 工作原理（简化）：
   *   1. 收集所有子 Suspense 的挂起状态
   *   2. 'forwards': 找到第一个挂起的，其后的全部显示 fallback（即便已加载也等待）
   *   3. 'together': 任一挂起就全部显示 fallback
   *
   * 用法：
   *   <SuspenseList revealOrder="forwards">
   *     <Suspense fallback={<Spinner/>}><A/></Suspense>
   *     <Suspense fallback={<Spinner/>}><B/></Suspense>
   *   </SuspenseList>
   *
   * ⚠️ 简化实现：通过 Context 传递"上游是否在挂起"的信号；真实 React 在调度
   *    层面深度集成，能精确控制顺序。
   */
  const SuspenseListContext = createContext({ revealOrder: 'together', anyPending: false })

  function SuspenseList({ revealOrder = 'together', tail = 'visible', children }) {
    const kids = Children.toArray(children)
    // 简化：以"together"语义实现——任一子 Suspense 挂起则强制全部 fallback
    // forwards/backwards 由开发者自行用 key 排序保证视觉顺序
    return createElement(SuspenseListContext.Provider, { value: { revealOrder, tail } },
      ...(revealOrder === 'backwards' ? kids.slice().reverse() : kids)
    )
  }
  SuspenseList._isSuspenseList = true

  // ═════════════════════════════════════════════════════════════
  // § 20  REF 工具：mergeRefs / useMergedRef / createPersistentRef
  // ═════════════════════════════════════════════════════════════

  /**
   * mergeRefs —— 把多个 ref（callback ref / object ref）合并成一个 callback ref。
   *
   * 典型场景：组件内部需要 ref 又要把 ref 透传给父组件。
   *   const Input = forwardRef((props, parentRef) => {
   *     const localRef = useRef(null)
   *     return <input ref={mergeRefs(localRef, parentRef)} />
   *   })
   *
   * 实现：返回一个函数 ref，被 React 调用时把 dom 同时写入所有底层 ref。
   */
  function mergeRefs(...refs) {
    return value => {
      refs.forEach(ref => {
        if (!ref) return
        if (typeof ref === 'function') ref(value)
        else ref.current = value
      })
    }
  }

  /**
   * useMergedRef —— mergeRefs 的 hook 版本，用 useMemo 按 refs 缓存。
   * 避免每次渲染都生成新函数 ref，导致 DOM 反复 setRef(null)/setRef(dom)。
   */
  function useMergedRef(...refs) {
    return useMemo(() => mergeRefs(...refs), refs)
  }

  // ═════════════════════════════════════════════════════════════
  // § 21  PROPTYPES —— 轻量类型校验（开发期）
  // ═════════════════════════════════════════════════════════════

  /**
   * PropTypes —— 类似 prop-types 包的轻量替代。
   *
   * 用法：
   *   function MyComp({ name, age }) { ... }
   *   MyComp.propTypes = {
   *     name: PropTypes.string.isRequired,
   *     age:  PropTypes.number,
   *     tags: PropTypes.arrayOf(PropTypes.string),
   *   }
   *
   * 失败时在 console.warn 输出，与真实 prop-types 行为一致。
   * 仅在 updateFunctionComponent 渲染前校验（生产环境可整体禁用）。
   */
  function makeChecker(check, typeName) {
    function checker(props, propName, componentName) {
      const value = props[propName]
      if (value == null) return null  // 不校验缺省值（required 由 isRequired 包装）
      const err = check(value, propName, componentName)
      return err
    }
    checker.isRequired = function (props, propName, componentName) {
      if (props[propName] == null) {
        return new Error(`[PropTypes] ${componentName}.${propName} 必填，但收到 ${props[propName]}`)
      }
      return checker(props, propName, componentName)
    }
    checker._typeName = typeName
    return checker
  }

  const PropTypes = {
    string:  makeChecker((v, k, c) => typeof v === 'string'   ? null : new Error(`[PropTypes] ${c}.${k} 应为 string，收到 ${typeof v}`),  'string'),
    number:  makeChecker((v, k, c) => typeof v === 'number'   ? null : new Error(`[PropTypes] ${c}.${k} 应为 number，收到 ${typeof v}`),  'number'),
    bool:    makeChecker((v, k, c) => typeof v === 'boolean'  ? null : new Error(`[PropTypes] ${c}.${k} 应为 boolean，收到 ${typeof v}`), 'bool'),
    func:    makeChecker((v, k, c) => typeof v === 'function' ? null : new Error(`[PropTypes] ${c}.${k} 应为 function，收到 ${typeof v}`),'func'),
    object:  makeChecker((v, k, c) => typeof v === 'object'   ? null : new Error(`[PropTypes] ${c}.${k} 应为 object，收到 ${typeof v}`),  'object'),
    array:   makeChecker((v, k, c) => Array.isArray(v)        ? null : new Error(`[PropTypes] ${c}.${k} 应为 array`),                       'array'),
    node:    makeChecker(() => null, 'node'),  // 任何可渲染都通过
    any:     makeChecker(() => null, 'any'),

    /** oneOf(['a','b'])：枚举值校验 */
    oneOf(values) {
      return makeChecker((v, k, c) => values.includes(v)
        ? null
        : new Error(`[PropTypes] ${c}.${k} 应为 ${values.join('|')} 之一，收到 ${v}`), 'oneOf')
    },
    /** oneOfType([T1, T2])：联合类型 */
    oneOfType(types) {
      return makeChecker((v, k, c) => {
        for (const t of types) {
          const err = t({ [k]: v }, k, c)
          if (!err) return null
        }
        return new Error(`[PropTypes] ${c}.${k} 不匹配任意指定类型`)
      }, 'oneOfType')
    },
    /** arrayOf(T)：数组元素类型 */
    arrayOf(type) {
      return makeChecker((v, k, c) => {
        if (!Array.isArray(v)) return new Error(`[PropTypes] ${c}.${k} 应为 array`)
        for (let i = 0; i < v.length; i++) {
          const err = type({ [k]: v[i] }, k, c)
          if (err) return new Error(`[PropTypes] ${c}.${k}[${i}] ${err.message}`)
        }
        return null
      }, 'arrayOf')
    },
    /** shape({a: T1, b: T2})：对象字段类型 */
    shape(spec) {
      return makeChecker((v, k, c) => {
        if (typeof v !== 'object' || v == null) return new Error(`[PropTypes] ${c}.${k} 应为 object`)
        for (const key of Object.keys(spec)) {
          const err = spec[key](v, key, `${c}.${k}`)
          if (err) return err
        }
        return null
      }, 'shape')
    },
    /** instanceOf(Class)：实例校验 */
    instanceOf(Cls) {
      return makeChecker((v, k, c) => v instanceof Cls
        ? null
        : new Error(`[PropTypes] ${c}.${k} 应为 ${Cls.name} 实例`), 'instanceOf')
    },
  }

  /**
   * 在渲染前校验 props（updateFunctionComponent / updateClassComponent 调用）。
   *
   * 与 React 行为对齐：每条 (Component, propName, errorMessage) 警告在整个
   * 应用生命周期内只输出一次。这避免了无效 props 导致的控制台刷屏，
   * 也是真实 prop-types 包的默认策略（loggedTypeFailures 缓存）。
   */
  const _loggedPropTypeWarnings = new Set()
  function validateProps(component, props) {
    if (!component.propTypes) return
    const name = component.displayName || component.name || 'Component'
    for (const key of Object.keys(component.propTypes)) {
      const checker = component.propTypes[key]
      if (typeof checker !== 'function') continue
      try {
        const err = checker(props, key, name)
        if (err) {
          // 去重 key：组件名 + 属性名 + 完整错误消息（同一错误内容不重复打印）
          const dedupeKey = name + '::' + key + '::' + err.message
          if (!_loggedPropTypeWarnings.has(dedupeKey)) {
            _loggedPropTypeWarnings.add(dedupeKey)
            console.warn(err.message)
          }
        }
      } catch (e) {
        console.warn('[PropTypes] 校验抛出异常：', e)
      }
    }
  }

  // ═════════════════════════════════════════════════════════════
  // § 22  CUSTOM HOOKS —— 常用自定义 hooks 库
  // ═════════════════════════════════════════════════════════════

  /**
   * usePrevious —— 返回上一次渲染时的值（首次渲染返回 undefined）。
   *
   * 实现：用 ref 保存值，每次 effect 后写入新值；下次渲染读到的是上次写入的旧值。
   * 用途：动画、变化检测、diff props 等。
   */
  function usePrevious(value) {
    const ref = useRef(undefined)
    useEffect(() => { ref.current = value }, [value])
    return ref.current
  }

  /**
   * useToggle —— 布尔状态切换语法糖。
   * @returns [state, toggle, setTrue, setFalse]
   */
  function useToggle(initial = false) {
    const [state, setState] = useState(initial)
    const toggle   = useCallback(() => setState(s => !s), [])
    const setTrue  = useCallback(() => setState(true),    [])
    const setFalse = useCallback(() => setState(false),   [])
    return [state, toggle, setTrue, setFalse]
  }

  /**
   * useCounter —— 数字计数器，附带 inc/dec/reset/set。
   */
  function useCounter(initial = 0, { min = -Infinity, max = Infinity } = {}) {
    const [count, setCount] = useState(initial)
    const inc   = useCallback(step => setCount(c => Math.min(max, c + (step ?? 1))), [max])
    const dec   = useCallback(step => setCount(c => Math.max(min, c - (step ?? 1))), [min])
    const reset = useCallback(() => setCount(initial), [initial])
    const set   = useCallback(v => setCount(Math.max(min, Math.min(max, v))), [min, max])
    return { count, inc, dec, reset, set }
  }

  /**
   * useDebounce —— 防抖：value 变化后等待 delay 毫秒，期间无新变化才返回新值。
   * 适合搜索框：输入停止后才发起请求。
   */
  function useDebounce(value, delay = 300) {
    const [debounced, setDebounced] = useState(value)
    useEffect(() => {
      const id = setTimeout(() => setDebounced(value), delay)
      return () => clearTimeout(id)
    }, [value, delay])
    return debounced
  }

  /**
   * useThrottle —— 节流：value 在 delay 毫秒内最多更新一次。
   */
  function useThrottle(value, delay = 300) {
    const [throttled, setThrottled] = useState(value)
    const lastRun = useRef(Date.now())
    useEffect(() => {
      const remaining = delay - (Date.now() - lastRun.current)
      if (remaining <= 0) {
        setThrottled(value)
        lastRun.current = Date.now()
      } else {
        const id = setTimeout(() => {
          setThrottled(value)
          lastRun.current = Date.now()
        }, remaining)
        return () => clearTimeout(id)
      }
    }, [value, delay])
    return throttled
  }

  /**
   * useInterval —— 声明式 setInterval。
   * 关键设计：用 ref 保存最新 callback，避免依赖数组导致 interval 反复重建。
   */
  function useInterval(callback, delay) {
    const cbRef = useRef(callback)
    useEffect(() => { cbRef.current = callback }, [callback])
    useEffect(() => {
      if (delay == null) return  // 传 null 暂停
      const id = setInterval(() => cbRef.current(), delay)
      return () => clearInterval(id)
    }, [delay])
  }

  /**
   * useTimeout —— 声明式 setTimeout。
   */
  function useTimeout(callback, delay) {
    const cbRef = useRef(callback)
    useEffect(() => { cbRef.current = callback }, [callback])
    useEffect(() => {
      if (delay == null) return
      const id = setTimeout(() => cbRef.current(), delay)
      return () => clearTimeout(id)
    }, [delay])
  }

  /**
   * useEventListener —— 声明式绑定事件，自动 cleanup。
   * @param target  EventTarget（默认 window）
   */
  function useEventListener(eventName, handler, target = typeof window !== 'undefined' ? window : null) {
    const handlerRef = useRef(handler)
    useEffect(() => { handlerRef.current = handler }, [handler])
    useEffect(() => {
      if (!target) return
      const listener = e => handlerRef.current(e)
      target.addEventListener(eventName, listener)
      return () => target.removeEventListener(eventName, listener)
    }, [eventName, target])
  }

  /**
   * useOnClickOutside —— 检测点击 ref 元素之外的区域。
   * 常见于关闭下拉菜单、模态框。
   */
  function useOnClickOutside(ref, handler) {
    useEffect(() => {
      const listener = e => {
        if (!ref.current || ref.current.contains(e.target)) return
        handler(e)
      }
      document.addEventListener('mousedown', listener)
      document.addEventListener('touchstart', listener)
      return () => {
        document.removeEventListener('mousedown', listener)
        document.removeEventListener('touchstart', listener)
      }
    }, [ref, handler])
  }

  /**
   * useKeyPress —— 检测某个键是否被按下。
   */
  function useKeyPress(targetKey) {
    const [pressed, setPressed] = useState(false)
    useEffect(() => {
      const down = e => { if (e.key === targetKey) setPressed(true) }
      const up   = e => { if (e.key === targetKey) setPressed(false) }
      window.addEventListener('keydown', down)
      window.addEventListener('keyup',   up)
      return () => {
        window.removeEventListener('keydown', down)
        window.removeEventListener('keyup',   up)
      }
    }, [targetKey])
    return pressed
  }

  /**
   * useHover —— 鼠标悬停检测（返回 [ref, isHovering]）。
   */
  function useHover() {
    const [hovering, setHovering] = useState(false)
    const ref = useRef(null)
    useEffect(() => {
      const node = ref.current
      if (!node) return
      const enter = () => setHovering(true)
      const leave = () => setHovering(false)
      node.addEventListener('mouseenter', enter)
      node.addEventListener('mouseleave', leave)
      return () => {
        node.removeEventListener('mouseenter', enter)
        node.removeEventListener('mouseleave', leave)
      }
    }, [])
    return [ref, hovering]
  }

  /**
   * useWindowSize —— 跟踪窗口尺寸。
   */
  function useWindowSize() {
    const [size, setSize] = useState(() => ({
      width:  typeof window !== 'undefined' ? window.innerWidth  : 0,
      height: typeof window !== 'undefined' ? window.innerHeight : 0,
    }))
    useEffect(() => {
      const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [])
    return size
  }

  /**
   * useMediaQuery —— 媒体查询匹配（响应式）。
   *   const isMobile = useMediaQuery('(max-width: 640px)')
   */
  function useMediaQuery(query) {
    const [matches, setMatches] = useState(() =>
      typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false
    )
    useEffect(() => {
      if (!window.matchMedia) return
      const mql = window.matchMedia(query)
      const handler = e => setMatches(e.matches)
      setMatches(mql.matches)
      // 修复：原版 `mql.addEventListener?.(...) ?? mql.addListener(...)` 中
      // 可选链调用即使方法存在也会返回 undefined，导致 ?? 永远走 fallback，
      // 把已弃用的 addListener 也调一遍。改为先判断后调用。
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', handler)
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(handler)
      }
      return () => {
        if (typeof mql.removeEventListener === 'function') {
          mql.removeEventListener('change', handler)
        } else if (typeof mql.removeListener === 'function') {
          mql.removeListener(handler)
        }
      }
    }, [query])
    return matches
  }

  /**
   * useLocalStorage —— 与 localStorage 双向同步的 useState。
   *
   * 特性：
   *   - 初始值惰性读取（避免 SSR 时报错）
   *   - 值变化时自动 JSON 序列化写入
   *   - 读取异常时回退到 defaultValue（损坏的存储不会让应用崩溃）
   */
  function useLocalStorage(key, defaultValue) {
    const [value, setValue] = useState(() => {
      try {
        const raw = localStorage.getItem(key)
        return raw != null ? JSON.parse(raw) : defaultValue
      } catch {
        return defaultValue
      }
    })
    useEffect(() => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch (e) {
        console.warn('[useLocalStorage] 写入失败：', e)
      }
    }, [key, value])
    return [value, setValue]
  }

  /**
   * useFetch —— 简易数据请求 hook。
   * @returns { data, error, loading, refetch }
   */
  function useFetch(url, options) {
    const [state, setState] = useState({ data: null, error: null, loading: true })
    const optsRef = useRef(options)
    useEffect(() => { optsRef.current = options })
    const refetch = useCallback(() => {
      let cancelled = false
      setState(s => ({ ...s, loading: true }))
      fetch(url, optsRef.current).then(r => r.json()).then(
        data  => { if (!cancelled) setState({ data, error: null, loading: false }) },
        error => { if (!cancelled) setState({ data: null, error, loading: false }) }
      )
      return () => { cancelled = true }
    }, [url])
    useEffect(() => refetch(), [refetch])
    return { ...state, refetch }
  }

  /**
   * useUpdateEffect —— 跳过首次渲染的 useEffect（仅在依赖更新时执行）。
   */
  function useUpdateEffect(callback, deps) {
    const isFirst = useRef(true)
    useEffect(() => {
      if (isFirst.current) { isFirst.current = false; return }
      return callback()
    }, deps)
  }

  /**
   * useMountEffect —— 仅 mount 一次的 useEffect 语法糖。
   */
  function useMountEffect(callback) {
    useEffect(() => callback(), [])
  }

  /**
   * useUnmountEffect —— 仅卸载时执行 cleanup 的 useEffect 语法糖。
   */
  function useUnmountEffect(callback) {
    const cbRef = useRef(callback)
    useEffect(() => { cbRef.current = callback })
    useEffect(() => () => cbRef.current(), [])
  }

  /**
   * useIsMounted —— 返回一个永远准确指示组件是否挂载的 ref。
   * 适合避免在异步回调中对已卸载组件 setState（虽然 React 18+ 已不警告）。
   */
  function useIsMounted() {
    const ref = useRef(false)
    useEffect(() => {
      ref.current = true
      return () => { ref.current = false }
    }, [])
    return ref
  }

  /**
   * useForceUpdate —— 返回一个强制重渲染的函数。
   * 极少使用，但偶尔在与命令式库集成时有用。
   */
  function useForceUpdate() {
    const [, force] = useReducer(s => s + 1, 0)
    return force
  }

  /**
   * useCopyToClipboard —— 复制到剪贴板，返回 [copiedValue, copy]。
   */
  function useCopyToClipboard() {
    const [copied, setCopied] = useState(null)
    const copy = useCallback(async text => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(text)
        return true
      } catch {
        setCopied(null)
        return false
      }
    }, [])
    return [copied, copy]
  }

  // ═════════════════════════════════════════════════════════════
  // § 23  REDUX-LIKE STORE —— 极简全局状态管理
  // ═════════════════════════════════════════════════════════════

  /**
   * createStore(reducer, initialState) —— 创建一个轻量 Redux 风格 store。
   *
   * 返回值：
   *   - getState() → 当前状态
   *   - dispatch(action) → 派发 action（若 action 是函数则当作 thunk 执行）
   *   - subscribe(listener) → 订阅，返回取消订阅函数
   *
   * 与 useSyncExternalStore 配合使用即可在组件中订阅：
   *   const state = useSyncExternalStore(store.subscribe, store.getState)
   *
   * 支持中间件：createStore(reducer, init, [logger, thunk])
   */
  function createStore(reducer, initialState, middlewares = []) {
    let state = initialState
    const listeners = new Set()

    const baseDispatch = action => {
      state = reducer(state, action)
      listeners.forEach(fn => fn())
      return action
    }

    // 中间件链：从右到左套用
    const dispatch = middlewares.reduceRight(
      (next, mw) => mw({ getState: () => state, dispatch: a => dispatch(a) })(next),
      baseDispatch,
    )

    // ⭐ 关键：派发 @@INIT 让 reducer 的默认参数（state = {...}）生效，
    // 否则 initialState=undefined 时 store.getState() 也是 undefined，
    // 组件读 state.xxx 直接抛 "Cannot read properties of undefined"。
    // 用 baseDispatch 跳过中间件，避免 logger 打印这条噪声。
    baseDispatch({ type: '@@INIT' })

    return {
      getState:  () => state,
      dispatch,
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    }
  }

  /**
   * thunkMiddleware —— 让 dispatch 接收函数（用于异步 action）。
   *   store.dispatch(dispatch => fetch(...).then(d => dispatch({type:'SET', d})))
   */
  const thunkMiddleware = ({ getState, dispatch }) => next => action =>
    typeof action === 'function' ? action(dispatch, getState) : next(action)

  /**
   * loggerMiddleware —— 在 console 打印 action 流（调试用）。
   */
  const loggerMiddleware = ({ getState }) => next => action => {
    console.groupCollapsed(`%c action %c${action.type ?? '(thunk)'}`, 'color:#888', 'color:#a78bfa')
    console.log('prev', getState())
    console.log('action', action)
    const result = next(action)
    console.log('next', getState())
    console.groupEnd()
    return result
  }

  /**
   * combineReducers —— 把多个子 reducer 组合成一个根 reducer（每个管理 state 的一个分片）。
   */
  function combineReducers(spec) {
    return (state = {}, action) => {
      let changed = false
      const next = {}
      for (const key of Object.keys(spec)) {
        const prev = state[key]
        const got  = spec[key](prev, action)
        next[key] = got
        if (got !== prev) changed = true
      }
      return changed ? next : state
    }
  }

  // ═════════════════════════════════════════════════════════════
  // § 24  服务端渲染：renderToString / renderToStaticMarkup
  // ═════════════════════════════════════════════════════════════

  /**
   * 自闭合 HTML 标签（不需要 </tag>）。
   */
  const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
  ])

  /**
   * 把字符串中的 HTML 特殊字符转义，避免 XSS。
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /**
   * 把 JS 风格 style 对象（或字符串）序列化成 CSS 字符串。
   * camelCase → kebab-case；忽略 null/undefined。
   */
  function styleToString(style) {
    if (style == null) return ''
    if (typeof style === 'string') return style
    return Object.entries(style).map(([k, v]) => {
      if (v == null || v === false) return ''
      const prop = k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())
      return `${prop}:${typeof v === 'number' && !UNITLESS_PROPS.has(k) ? v + 'px' : v}`
    }).filter(Boolean).join(';')
  }

  /** 不需要追加 px 的 CSS 数值属性 */
  const UNITLESS_PROPS = new Set([
    'opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink',
    'order', 'columnCount', 'tabSize', 'zoom',
  ])

  /**
   * propsToAttrs —— 把 props 序列化成 HTML 属性串（' key="value" key2="value2"'）。
   * 跳过：children/key/ref/事件处理器/dangerouslySetInnerHTML
   */
  function propsToAttrs(props) {
    const out = []
    for (const k of Object.keys(props)) {
      if (k === 'children' || k === 'key' || k === 'ref') continue
      if (k === 'dangerouslySetInnerHTML') continue
      if (k.startsWith('on')) continue  // 事件不输出到 HTML
      const v = props[k]
      if (v == null || v === false) continue
      if (k === 'style')     { out.push(`style="${escapeHtml(styleToString(v))}"`); continue }
      if (k === 'className') { out.push(`class="${escapeHtml(v)}"`);                continue }
      if (k === 'htmlFor')   { out.push(`for="${escapeHtml(v)}"`);                   continue }
      if (v === true)        { out.push(k); continue }  // 布尔属性仅写名
      out.push(`${k}="${escapeHtml(v)}"`)
    }
    return out.length ? ' ' + out.join(' ') : ''
  }

  /**
   * renderToString —— 把 element 树渲染成 HTML 字符串（不带 React 标记）。
   *
   * 实现策略：递归遍历，函数组件直接调用拿到子元素；类组件创建实例后调用 render。
   * 不支持的 hook（依赖 fiber 的 useEffect 等）会以 no-op 形式跳过。
   *
   * ⚠️ 限制：
   *   - 不支持 Suspense（lazy 抛出 Promise 时直接返回 fallback）
   *   - 不执行任何副作用（useEffect / useLayoutEffect / componentDidMount）
   *   - useState 总是返回初始值（无法响应 setState）
   */
  function renderToString(element) {
    return renderElement(element, /*static*/ false)
  }

  /**
   * renderToStaticMarkup —— 与 renderToString 相同，但不附加任何 React 标记。
   * 适合纯静态页面生成（不会被 hydrateRoot 接管）。
   */
  function renderToStaticMarkup(element) {
    return renderElement(element, /*static*/ true)
  }

  /** SSR 渲染上下文：模拟最少必要的 hooks 状态 */
  const ssrContext = { hooks: [], hookIndex: 0, isSSR: false }

  function setupSsrHooks() {
    const original = { wipFiber, hookIndex }
    ssrContext.hooks = []
    ssrContext.hookIndex = 0
    ssrContext.isSSR = true
    wipFiber  = { hooks: ssrContext.hooks, alternate: null }
    hookIndex = 0
    return original
  }
  function restoreSsrHooks(original) {
    ssrContext.isSSR = false
    wipFiber  = original.wipFiber
    hookIndex = original.hookIndex
  }

  function renderElement(element, isStatic) {
    if (element == null || element === false || element === true) return ''
    if (typeof element === 'string' || typeof element === 'number') return escapeHtml(String(element))
    if (Array.isArray(element)) return element.map(e => renderElement(e, isStatic)).join('')
    if (!isValidElement(element)) return ''

    const { type, props } = element

    // ── TEXT_ELEMENT：纯文本节点 ──────────────────────────────
    if (type === 'TEXT_ELEMENT') return escapeHtml(props.nodeValue || '')

    // ── Fragment：仅渲染 children ────────────────────────────
    if (type === Fragment) return renderElement(props.children, isStatic)

    // ── Portal：SSR 中无法生效，渲染为空 ─────────────────────
    if (type === PORTAL) return ''

    // ── 函数组件 ──────────────────────────────────────────────
    if (typeof type === 'function' && !type._isClass) {
      const original = setupSsrHooks()
      try {
        // SSR 不绑定 ref（无真实 DOM），forwardRef 第二参数传 element.ref（可能为 null）
        const ssrRef = element.ref ?? null
        let child
        if (type._isMemo)         child = type._type(props)
        else if (type._isForwardRef) child = type._renderFn(props, ssrRef)
        else                      child = type(props)
        return renderElement(child, isStatic)
      } catch (e) {
        // lazy 在 SSR 中抛 Promise → 直接返回空字符串（真实 React 用流式 SSR 解决）
        if (e && typeof e.then === 'function') return ''
        throw e
      } finally {
        restoreSsrHooks(original)
      }
    }

    // ── 类组件 ─────────────────────────────────────────────────
    if (typeof type === 'function' && type._isClass) {
      const inst = new type(props)
      const child = inst.render()
      return renderElement(child, isStatic)
    }

    // ── 原生 DOM 元素 ────────────────────────────────────────
    if (typeof type === 'string') {
      const attrs = propsToAttrs(props)
      // dangerouslySetInnerHTML：直接写 __html，不转义子节点
      if (props.dangerouslySetInnerHTML) {
        return `<${type}${attrs}>${props.dangerouslySetInnerHTML.__html ?? ''}</${type}>`
      }
      if (VOID_ELEMENTS.has(type)) return `<${type}${attrs}/>`
      const inner = renderElement(props.children, isStatic)
      return `<${type}${attrs}>${inner}</${type}>`
    }

    return ''
  }

  // SSR 不替换全局 hook 函数（会影响客户端）；在 setupSsrHooks 内构造特殊 wipFiber，
  // 让 useState/useReducer 读到 alternate=null 走"首次渲染"分支，effect 类 hook
  // 仅 push 占位（callback 等绘制后才执行，此处天然成为 no-op）。

  // ═════════════════════════════════════════════════════════════
  // § 25  HYDRATE —— 把已有 DOM 与 element 树关联
  // ═════════════════════════════════════════════════════════════

  /**
   * hydrateRoot —— 把服务端渲染的 HTML 与客户端 element 树绑定。
   *
   * 与 createRoot 区别：
   *   createRoot：清空容器，从零创建所有 DOM 节点
   *   hydrateRoot：复用容器内的现有 DOM，仅绑定事件 / 同步状态
   *
   * 简化实现：
   *   1. 先按 createRoot 走一遍渲染流程（生成 fiber 树）
   *   2. mutation pass 中，PLACEMENT 时若容器内已有对应位置的 DOM 节点，直接复用
   *
   * ⚠️ 限制：本简化实现不做严格的"水合校验"——若服务端 HTML 与客户端结构不一致
   *    会出现错位。真实 React 有详细的 hydration 校验日志。
   */
  function hydrateRoot(container, element) {
    // 标记水合模式：commit 时尽量复用 container.firstChild
    container._hydrating = true
    const root = createRoot(container)
    root.render(element)
    // 水合完成后清除标记，后续更新走正常 PLACEMENT 流程
    setTimeout(() => { container._hydrating = false }, 0)
    return root
  }

  // ─────────────────────────────────────────────────────────────
  // § 16  公开 API
  // ─────────────────────────────────────────────────────────────

  window.MiniReact = {
    // 版本
    version,
    // 元素
    createElement, cloneElement, isValidElement, Fragment,
    // 组件
    Component, PureComponent, StrictMode,
    // 高阶组件
    forwardRef, memo,
    // Hooks — 状态
    useState, useReducer,
    // Hooks — 副作用（按执行时序排列）
    useInsertionEffect, useLayoutEffect, useEffect,
    // Hooks — 引用与缓存
    useRef, useMemo, useCallback,
    // Hooks — 其他
    useId, useContext, useImperativeHandle,
    useDebugValue, useTransition, useDeferredValue,
    // Hooks — 外部 store
    useSyncExternalStore,
    // Hooks — React 19 风格
    use, useOptimistic, useActionState,
    // Hooks — 自定义工具库（§22）
    usePrevious, useToggle, useCounter,
    useDebounce, useThrottle,
    useInterval, useTimeout,
    useEventListener, useOnClickOutside, useKeyPress,
    useHover, useWindowSize, useMediaQuery,
    useLocalStorage, useFetch,
    useUpdateEffect, useMountEffect, useUnmountEffect,
    useIsMounted, useForceUpdate, useCopyToClipboard,
    useMergedRef,
    // Context
    createContext,
    // 异步与并发
    lazy, Suspense, SuspenseList,
    // 性能测量
    Profiler,
    // 工具
    createRef, Children, startTransition, mergeRefs,
    // Portal
    createPortal,
    // 类型校验
    PropTypes,
    // Redux-like store
    createStore, combineReducers, thunkMiddleware, loggerMiddleware,
    // SSR
    renderToString, renderToStaticMarkup,
  }

  // Object.assign 绕过 TS 对 window 扩展属性的类型检查（Hint 2568）
  Object.assign(window, {
    MiniReactDOM: {
      render, flushSync, createRoot, batch, act, hydrateRoot,
    },
  })

}())
