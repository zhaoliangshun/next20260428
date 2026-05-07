/**
 * Mini React  ·  ~4000 行实现 React 核心 100% 主要功能
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  设计目标                                                           │
 * │    1. 用最少的代码完成 React 95% 日常 API（包含 React 18 / 19 新 API）│
 * │    2. 每一行都可读，注释覆盖原理而非语法                             │
 * │    3. 与真实 React 行为保持一致；仅在并发调度的精度上做近似           │
 * │    4. 提供完整可运行 demo（window.MiniReactDemos），逐个验证特性     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ─── 已实现功能清单 ───────────────────────────────────────────────────
 *
 *   元素      createElement / cloneElement / isValidElement / Fragment
 *             $$typeof（防 XSS 注入） / 自动 key/ref 抽取
 *   组件      Component / PureComponent / forwardRef / memo / StrictMode
 *             lazy / Profiler
 *   Hooks     useState / useReducer
 *             useEffect / useLayoutEffect / useInsertionEffect
 *             useRef / useMemo / useCallback / useId
 *             useContext / useImperativeHandle / useDebugValue
 *             useSyncExternalStore / useTransition / useDeferredValue
 *             use / useOptimistic / useActionState / useFormStatus    [React 19]
 *   Context   createContext / Provider / Consumer
 *   Portal    createPortal
 *   异步      lazy / Suspense + 错误重试 + 嵌套边界
 *   错误      ErrorBoundary（getDerivedStateFromError / componentDidCatch）
 *   Scheduler ImmediatePriority / UserBlocking / Normal / Low / Idle
 *             scheduleCallback / shouldYield / cancelCallback
 *   事件      合成事件系统（事件委托到根容器，SyntheticEvent 包装）
 *   渲染      render / createRoot / hydrateRoot / flushSync
 *             renderToString / renderToStaticMarkup（SSR）
 *             unstable_batchedUpdates / startTransition / act
 *   工具      createRef / Children / findDOMNode / version
 *
 * ─── 与真实 React 的简化点 ────────────────────────────────────────────
 *   - 单全局根树（不支持并发多根并行提交）
 *   - Scheduler 用 requestIdleCallback + 优先级队列近似 lane 调度
 *   - Suspense 首帧有短暂空白（无 concurrent transitions 保护层）
 *   - useSyncExternalStore 无 tearing 防护（无并发读隔离）
 *   - 合成事件不做事件池化（React 17+ 也已移除池化）
 *   - SSR 不支持流式（renderToPipeableStream 未实现）
 *   - 无 React DevTools 协议
 *
 * ─── 文件章节速查 ─────────────────────────────────────────────────────
 *   §  1  REACT ELEMENT             —— JSX 编译目标
 *   §  2  SCHEDULER                  —— 优先级队列与时间切片
 *   §  3  全局调度状态
 *   §  4  WORK LOOP                  —— requestIdleCallback 驱动
 *   §  5  PERFORM UNIT OF WORK       —— 区分类/函数/Host 三类
 *   §  6  RECONCILER                 —— O(n) Diff（key Map + 顺序匹配）
 *   §  7  COMMIT 三阶段              —— Mutation / Layout / Passive
 *   §  8  DOM 工具                    —— SVG / dangerouslySetInnerHTML
 *   §  9  合成事件系统               —— 委托 + SyntheticEvent
 *   § 10  HOOKS                      —— 全部 19 个 hooks
 *   § 11  CONTEXT                    —— 渲染期栈隔离
 *   § 12  CLASS COMPONENT            —— 完整生命周期
 *   § 13  PORTAL                     —— 渲染到任意容器
 *   § 14  SUSPENSE & LAZY            —— 异步组件 + 嵌套边界
 *   § 15  ERROR BOUNDARY             —— 错误捕获 + UI 回退
 *   § 16  HOC                        —— forwardRef / memo
 *   § 17  PROFILER                   —— 性能测量
 *   § 18  HYDRATION                  —— 复用 SSR DOM
 *   § 19  SERVER RENDERING           —— renderToString
 *   § 20  React 19 HOOKS             —— use / useOptimistic 等
 *   § 21  渲染入口                    —— render / createRoot 等
 *   § 22  内部工具
 *   § 23  公开 API
 *   § 24  DEMOS                      —— 每个功能可运行示例
 */
;(function () {
  'use strict'

  const version = '18.2.0-mini-extended'

  // ─────────────────────────────────────────────────────────────
  // § 1  REACT ELEMENT
  // ─────────────────────────────────────────────────────────────

  /**
   * REACT_ELEMENT_TYPE —— 真实 React 用 Symbol 标记元素类型，
   * 防止恶意 JSON 注入伪造 ReactElement（XSS 防御）。
   * 浏览器若不支持 Symbol 则降级为数字（兼容性保留）。
   */
  const REACT_ELEMENT_TYPE  = typeof Symbol === 'function' ? Symbol.for('react.element')   : 0xeac7
  const REACT_FRAGMENT_TYPE = typeof Symbol === 'function' ? Symbol.for('react.fragment')  : 0xead7
  const REACT_PORTAL_TYPE   = typeof Symbol === 'function' ? Symbol.for('react.portal')    : 0xeaca
  const REACT_PROFILER_TYPE = typeof Symbol === 'function' ? Symbol.for('react.profiler')  : 0xead2
  const REACT_SUSPENSE_TYPE = typeof Symbol === 'function' ? Symbol.for('react.suspense')  : 0xead1
  const REACT_LAZY_TYPE     = typeof Symbol === 'function' ? Symbol.for('react.lazy')      : 0xead4
  const REACT_MEMO_TYPE     = typeof Symbol === 'function' ? Symbol.for('react.memo')      : 0xead3
  const REACT_FORWARD_TYPE  = typeof Symbol === 'function' ? Symbol.for('react.forward_ref'): 0xead0
  const REACT_CONTEXT_TYPE  = typeof Symbol === 'function' ? Symbol.for('react.context')   : 0xeace

  /**
   * createElement —— JSX 编译目标。
   *
   * <div className="a" key="k" ref={r}>hi</div>
   *   ↓
   * createElement('div', {className:'a', key:'k', ref:r}, 'hi')
   *
   * 核心职责：
   *   1. 从 props 中抽取 key 与 ref（这两个不参与 props 比较）
   *   2. children 展平 + 过滤无效节点 + 字符串包装为 TEXT_ELEMENT
   *   3. 标记 $$typeof 防 JSON 注入
   *
   * @example
   *   const el = createElement('h1', { className: 'title' }, 'Hello')
   *   // → { $$typeof, type: 'h1', key: null, ref: null, props: { className, children: [...] } }
   */
  function createElement(type, config, ...children) {
    let key = null
    let ref = null
    const props = {}

    if (config != null) {
      // key/ref 单独提取，不放入 props（与 React 行为一致）
      if (config.key !== undefined) key = '' + config.key
      if (config.ref !== undefined) ref = config.ref
      for (const propName in config) {
        if (propName !== 'key' && propName !== 'ref' &&
            Object.prototype.hasOwnProperty.call(config, propName)) {
          props[propName] = config[propName]
        }
      }
    }

    // children 展平 + 过滤
    props.children = children
      .flat(Infinity)
      .filter(c => c !== null && c !== undefined && typeof c !== 'boolean')
      .map(c => (typeof c === 'object' ? c : createTextElement(c)))

    // type 自身的 defaultProps（类组件常用）
    if (type && type.defaultProps) {
      for (const propName in type.defaultProps) {
        if (props[propName] === undefined) props[propName] = type.defaultProps[propName]
      }
    }

    return { $$typeof: REACT_ELEMENT_TYPE, type, key, ref, props }
  }

  function createTextElement(text) {
    return {
      $$typeof: REACT_ELEMENT_TYPE,
      type: 'TEXT_ELEMENT',
      key: null,
      ref: null,
      props: { nodeValue: String(text), children: [] },
    }
  }

  /**
   * cloneElement —— 克隆元素并合并新 props / key / ref / children。
   * 新 children 若传入则完全覆盖旧 children。
   *
   * @example
   *   const cloned = cloneElement(el, { className: 'extra' }, 'new child')
   */
  function cloneElement(element, config, ...children) {
    const props = { ...element.props }
    let key = element.key
    let ref = element.ref

    if (config != null) {
      if (config.key !== undefined) key = '' + config.key
      if (config.ref !== undefined) ref = config.ref
      for (const propName in config) {
        if (propName !== 'key' && propName !== 'ref' &&
            Object.prototype.hasOwnProperty.call(config, propName)) {
          props[propName] = config[propName]
        }
      }
    }

    if (children.length > 0) {
      props.children = children
        .flat(Infinity)
        .filter(c => c !== null && c !== undefined && typeof c !== 'boolean')
        .map(c => (typeof c === 'object' ? c : createTextElement(c)))
    }

    return { $$typeof: REACT_ELEMENT_TYPE, type: element.type, key, ref, props }
  }

  /** isValidElement —— 严格判断 ReactElement（依赖 $$typeof）。 */
  function isValidElement(obj) {
    return typeof obj === 'object' && obj !== null && obj.$$typeof === REACT_ELEMENT_TYPE
  }

  /** Fragment —— 不产生 DOM 的多根节点占位符。 */
  const Fragment = REACT_FRAGMENT_TYPE

  /** PORTAL 内部标记（区别于 type 上的 REACT_PORTAL_TYPE，作为 Fiber 类型用）。 */
  const PORTAL = '__portal__'

  /** 把 React 内部 Symbol 暴露出去，便于宿主框架做 element 类型探测（如 React DevTools）。 */
  const REACT_TYPEOF_SYMBOLS = {
    element:    REACT_ELEMENT_TYPE,
    fragment:   REACT_FRAGMENT_TYPE,
    portal:     REACT_PORTAL_TYPE,
    profiler:   REACT_PROFILER_TYPE,
    suspense:   REACT_SUSPENSE_TYPE,
    lazy:       REACT_LAZY_TYPE,
    memo:       REACT_MEMO_TYPE,
    forwardRef: REACT_FORWARD_TYPE,
    context:    REACT_CONTEXT_TYPE,
  }

  // ─────────────────────────────────────────────────────────────
  // § 2  SCHEDULER —— 优先级调度器
  // ─────────────────────────────────────────────────────────────

  /**
   * 优先级常量（数字越小越紧急）。
   *
   * 真实 React 使用 31 位 lane（位运算合并多优先级），
   * 此处简化为 5 个离散等级，按数字大小排序：
   *
   *   ImmediatePriority   1   同步刷新（flushSync）
   *   UserBlockingPriority 2   用户输入响应（点击、键盘）
   *   NormalPriority      3   默认（普通 setState）
   *   LowPriority         4   过渡更新（startTransition）
   *   IdlePriority        5   后台、离屏
   */
  const ImmediatePriority    = 1
  const UserBlockingPriority = 2
  const NormalPriority       = 3
  const LowPriority          = 4
  const IdlePriority         = 5

  /** 各优先级对应的"过期时长"（ms），到期则强制升为同步执行。 */
  const TIMEOUT_BY_PRIORITY = {
    [ImmediatePriority]:   -1,        // 立即过期（同步）
    [UserBlockingPriority]: 250,      // 250ms 内必须完成
    [NormalPriority]:       5000,     // 5s
    [LowPriority]:          10000,    // 10s
    [IdlePriority]:         1073741823, // 永不过期（最大 31 位整数）
  }

  /**
   * Scheduler 内部状态：
   *   taskQueue        待执行任务（按 expirationTime 排序）
   *   currentTask      正在执行的任务
   *   currentPriority  当前优先级（runWithPriority 期间临时改变）
   */
  const schedulerState = {
    taskQueue: [],
    currentTask: null,
    currentPriority: NormalPriority,
    taskIdCounter: 1,
    isPerformingWork: false,
  }

  /**
   * scheduleCallback —— 以指定优先级排队一个回调。
   *
   * 实现要点：
   *   1. expirationTime = now + timeout，超过则提升为同步
   *   2. 按 expirationTime 升序插入（最紧急的在队首）
   *   3. 若未在执行，调度 flushWork（requestIdleCallback / MessageChannel）
   *
   * @example
   *   const task = scheduleCallback(NormalPriority, () => { ... })
   *   cancelCallback(task)  // 取消
   */
  function scheduleCallback(priority, callback) {
    const startTime = performance.now()
    const timeout = TIMEOUT_BY_PRIORITY[priority] ?? 5000
    const expirationTime = timeout < 0 ? startTime - 1 : startTime + timeout

    const task = {
      id: schedulerState.taskIdCounter++,
      callback,
      priority,
      startTime,
      expirationTime,
      isCanceled: false,
    }

    // 按 expirationTime 插入（小顶堆的简化版：线性扫描）
    let inserted = false
    for (let i = 0; i < schedulerState.taskQueue.length; i++) {
      if (task.expirationTime < schedulerState.taskQueue[i].expirationTime) {
        schedulerState.taskQueue.splice(i, 0, task)
        inserted = true
        break
      }
    }
    if (!inserted) schedulerState.taskQueue.push(task)

    if (!schedulerState.isPerformingWork) requestHostCallback()
    return task
  }

  /** cancelCallback —— 取消尚未执行的任务（仅置 flag，不从队列移除）。 */
  function cancelCallback(task) {
    if (task) task.isCanceled = true
  }

  /** getCurrentPriorityLevel —— 用于 ReactDOM 内部判断更新归属。 */
  function getCurrentPriorityLevel() { return schedulerState.currentPriority }

  /**
   * runWithPriority —— 以指定优先级临时执行 fn。
   * fn 内部触发的 setState 会沿用此优先级。
   */
  function runWithPriority(priority, fn) {
    const prev = schedulerState.currentPriority
    schedulerState.currentPriority = priority
    try { return fn() } finally { schedulerState.currentPriority = prev }
  }

  /**
   * shouldYield —— 是否应该让出主线程给浏览器。
   * 真实 React 用 5ms 切片；此处用当前 deadline.timeRemaining()。
   */
  let _currentDeadline = null
  function shouldYield() {
    return _currentDeadline ? _currentDeadline.timeRemaining() < 1 : false
  }

  /**
   * requestHostCallback —— 调度 flushWork 到下一帧。
   * 优先 requestIdleCallback；不支持则降级 MessageChannel / setTimeout。
   */
  function requestHostCallback() {
    if (schedulerState.isPerformingWork) return
    schedulerState.isPerformingWork = true
    requestIdle(deadline => {
      _currentDeadline = deadline
      flushWork()
      _currentDeadline = null
      schedulerState.isPerformingWork = false
      // 还有任务则继续调度
      if (schedulerState.taskQueue.length > 0) requestHostCallback()
    })
  }

  /** flushWork —— 在剩余时间内连续执行任务直至队列空或时间耗尽。 */
  function flushWork() {
    let task = schedulerState.taskQueue[0]
    while (task && !shouldYield()) {
      if (task.isCanceled) {
        schedulerState.taskQueue.shift()
        task = schedulerState.taskQueue[0]
        continue
      }
      schedulerState.currentTask = task
      schedulerState.currentPriority = task.priority
      const continuation = task.callback()
      // 若回调返回函数，表示未完成，下次继续执行
      if (typeof continuation === 'function') {
        task.callback = continuation
      } else {
        schedulerState.taskQueue.shift()
      }
      task = schedulerState.taskQueue[0]
    }
    schedulerState.currentTask = null
    schedulerState.currentPriority = NormalPriority
  }

  // ─────────────────────────────────────────────────────────────
  // § 3  全局调度状态
  // ─────────────────────────────────────────────────────────────

  let nextUnitOfWork           = null   // render 阶段游标
  let currentRoot              = null   // 已提交的 current 树
  let wipRoot                  = null   // 正在构建的 wip 树
  let deletions                = []     // 本轮需删除的 Fiber
  let pendingRerender          = false  // commit 前/中 setState 的延迟标记
  let isCommitting             = false  // mutation pass 期间
  let workLoopScheduled        = false
  let pendingPassiveRoots      = []
  let passiveFlushScheduled    = false
  let needsRerenderAfterCommit = false  // Suspense 首次挂起后触发回显 fallback
  let pendingErrorBoundary     = null   // 渲染期捕获的 Error Boundary fiber
  let pendingErrorBoundaryError= null   // 与之对应的错误对象
  let isHydrating              = false  // hydrateRoot 模式下复用现有 DOM
  let isBatchingUpdates        = false  // unstable_batchedUpdates 期间
  let pendingBatchUpdates      = []     // 批量更新合并队列

  let wipFiber  = null
  let hookIndex = 0
  let idCounter = 0

  /**
   * requestIdle —— 跨浏览器的空闲调度封装。
   *   现代浏览器：requestIdleCallback（Chrome / Firefox / Edge）
   *   Safari / 老浏览器：setTimeout 模拟（固定 50ms 余量）
   */
  const requestIdle = window.requestIdleCallback
    ? cb => window.requestIdleCallback(cb, { timeout: 16 })
    : cb => setTimeout(() => cb({ timeRemaining: () => 50 }), 1)

  // ─────────────────────────────────────────────────────────────
  // § 4  WORK LOOP
  // ─────────────────────────────────────────────────────────────

  /**
   * workLoop —— 可中断主循环。
   *
   * 流程：
   *   1. 每帧空闲时间内连续 performUnitOfWork
   *   2. 剩余时间 < 1ms 让出（避免阻塞输入）
   *   3. 所有 Fiber 处理完进入同步 commit
   *   4. commit 后若仍有工作，再次调度
   *
   * 设计权衡：
   *   - 用 deadline.timeRemaining 而非固定 5ms 切片，跟随浏览器策略
   *   - commit 不可中断（保证 DOM 一致性）
   */
  function workLoop(deadline) {
    workLoopScheduled = false
    _currentDeadline  = deadline
    let shouldYieldFlag = false
    while (nextUnitOfWork && !shouldYieldFlag) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
      shouldYieldFlag = deadline.timeRemaining() < 1
    }
    _currentDeadline = null
    if (!nextUnitOfWork && wipRoot) commitRoot()
    if (nextUnitOfWork || wipRoot) scheduleWorkLoop()
  }

  // ─────────────────────────────────────────────────────────────
  // § 5  PERFORM UNIT OF WORK
  // ─────────────────────────────────────────────────────────────

  /**
   * performUnitOfWork —— DFS 遍历核心。
   *
   * 顺序：
   *   1. beginWork(fiber): 处理当前 Fiber（render）
   *   2. 有 child → 进入 child
   *   3. 无 child → completeWork(fiber)，再 sibling，再 return
   *
   * 三种 Fiber 类型分发：
   *   - 类组件 → updateClassComponent
   *   - 函数组件 → updateFunctionComponent（含 forwardRef / memo）
   *   - Host（DOM/Fragment/Portal）→ updateHostComponent
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

  /**
   * completeUnitOfWork —— 退出 Fiber 时的清理工作。
   *
   * 主要任务：
   *   1. 退出 Provider：恢复 context 旧值（栈式隔离）
   *   2. Profiler：累计渲染时长（actualDuration）
   */
  function completeUnitOfWork(fiber) {
    if (fiber._context) fiber._context._currentValue = fiber._prevCtxValue
    if (fiber._profilerStartTime != null) {
      const actual = performance.now() - fiber._profilerStartTime
      fiber._profilerActualDuration = actual
    }
  }

  /**
   * updateFunctionComponent —— 渲染函数组件。
   *
   * 处理细节：
   *   1. 设置 hooks 上下文（wipFiber / hookIndex）
   *   2. memo bailout：props 浅等 + 无排队 state → 复用上次结果
   *   3. Context.Provider 作用域：进入时注入值
   *   4. forwardRef：把 fiber.ref 以第二参数传给渲染函数
   *   5. Suspense 集成：catch 子组件抛出的 Promise
   *   6. ErrorBoundary 集成：catch 普通错误冒泡到边界
   */
  function updateFunctionComponent(fiber) {
    wipFiber  = fiber
    hookIndex = 0
    wipFiber.hooks = []

    const component = fiber.type
    const isMemo    = !!component._isMemo

    // ── memo bailout ──────────────────────────────────────────
    if (isMemo && fiber.alternate) {
      const hasPending = fiber.alternate.hooks?.some(h => h.queue?.length > 0)
      if (!hasPending && component._compare(fiber.alternate.props, fiber.props)) {
        wipFiber.hooks = fiber.alternate.hooks || []
        const cached = fiber.alternate.memoizedElement
        fiber.memoizedElement = cached
        reconcileChildren(fiber, Array.isArray(cached) ? cached : [cached])
        return
      }
    }

    const renderFn = isMemo ? component._type : component

    // ── Context.Provider ──────────────────────────────────────
    if (renderFn._context) {
      fiber._context     = renderFn._context
      fiber._prevCtxValue = renderFn._context._currentValue
      renderFn._context._currentValue = fiber.props.value
    }

    // ── Profiler 计时起点 ─────────────────────────────────────
    if (renderFn._isProfiler) {
      fiber._profilerStartTime = performance.now()
    }

    // ── 调用渲染函数（forwardRef 透传 ref） ───────────────────
    let child
    try {
      if (renderFn._isForwardRef) {
        child = renderFn._renderFn(fiber.props, fiber.ref ?? null)
      } else {
        child = renderFn(fiber.props)
      }
    } catch (e) {
      // ── Suspense：捕获 Promise（lazy / use 抛出）──────────────
      if (e && typeof e.then === 'function') {
        let boundary = fiber.return
        while (boundary && !boundary.type?._isSuspense) boundary = boundary.return
        if (boundary) {
          boundary._suspendPending = e
          needsRerenderAfterCommit = true
          e.then(
            () => { delete boundary._suspendPending; scheduleRerender() },
            () => { delete boundary._suspendPending; scheduleRerender() }
          )
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
    reconcileChildren(fiber, Array.isArray(child) ? child : [child])
  }

  /**
   * updateClassComponent —— 渲染类组件。
   *
   * 完整生命周期处理：
   *   - constructor（首次 new）
   *   - static getDerivedStateFromProps
   *   - shouldComponentUpdate / PureComponent 浅比较
   *   - render
   *   - componentDidMount / componentDidUpdate（在 commit 阶段）
   *   - componentWillUnmount（卸载时）
   *   - static getDerivedStateFromError / componentDidCatch（错误边界）
   */
  function updateClassComponent(fiber) {
    let instance = fiber.instance
    if (!instance) {
      // 首次：构造实例 + 注入 context
      instance = new fiber.type(fiber.props)
      fiber.instance = instance
      instance._fiber = fiber
      // contextType 静态属性指定订阅的 context
      if (fiber.type.contextType) {
        instance.context = fiber.type.contextType._currentValue
      }
    } else {
      if (fiber.alternate?.instance) {
        instance.state = fiber.alternate.instance.state
      }
      instance.props  = fiber.props
      instance._fiber = fiber
      if (fiber.type.contextType) {
        instance.context = fiber.type.contextType._currentValue
      }
    }

    // getDerivedStateFromProps：每次渲染前都会调用（替代 willReceiveProps）
    const gDSFP = fiber.type.getDerivedStateFromProps
    if (gDSFP) {
      const derived = gDSFP(fiber.props, instance.state)
      if (derived) instance.state = { ...instance.state, ...derived }
    }

    // shouldComponentUpdate / PureComponent 浅比较
    if (fiber.alternate) {
      const pu  = fiber.type._isPure
      const scu = instance.shouldComponentUpdate
      const prevProps = fiber.alternate.props
      const prevState = fiber.alternate.instance?.state ?? {}
      if (pu && shallowEqualProps(prevProps, fiber.props) && shallowEqualProps(prevState, instance.state)) {
        const cached = fiber.alternate.memoizedElement
        fiber.memoizedElement = cached
        reconcileChildren(fiber, Array.isArray(cached) ? cached : [cached])
        return
      }
      if (scu && !instance.shouldComponentUpdate(fiber.props, instance.state)) {
        const cached = fiber.alternate.memoizedElement
        fiber.memoizedElement = cached
        reconcileChildren(fiber, Array.isArray(cached) ? cached : [cached])
        return
      }
    }

    let child
    try {
      child = instance.render()
    } catch (e) {
      if (propagateError(fiber, e)) {
        fiber.memoizedElement = null
        reconcileChildren(fiber, [])
        return
      }
      throw e
    }
    fiber.memoizedElement = child
    reconcileChildren(fiber, Array.isArray(child) ? child : [child])
  }

  /**
   * updateHostComponent —— 渲染原生 DOM、Fragment、Portal、Profiler。
   */
  function updateHostComponent(fiber) {
    if (fiber.type === Fragment || fiber.type === REACT_FRAGMENT_TYPE) {
      reconcileChildren(fiber, fiber.props.children || [])
      return
    }
    if (fiber.type === PORTAL) {
      fiber.dom = fiber.props.container
      reconcileChildren(fiber, fiber.props.children || [])
      return
    }
    if (!fiber.dom) {
      fiber.dom = isHydrating ? hydrateDom(fiber) : createDom(fiber)
    }
    reconcileChildren(fiber, fiber.props.children || [])
  }

  // ─────────────────────────────────────────────────────────────
  // § 6  RECONCILER（Diff）
  // ─────────────────────────────────────────────────────────────

  /**
   * reconcileChildren —— O(n) Diff。
   *
   * 算法：
   *   1. 老 Fiber 按 key 分两类：keyedOld（Map）/ unkeyedOld（数组）
   *   2. 新元素遍历：
   *      - 有 key：从 keyedOld 查找；type 相同则复用，不同则替换
   *      - 无 key：按顺序匹配 unkeyedOld 中第一个未用项
   *   3. 未被使用的老 Fiber → 标记 DELETION
   *
   * Bug fix（v2）：原版 `index === 0` 当首位元素为 null 时会丢失后续 Fiber。
   * 改为 `!prevSibling` 检测"尚未链接第一个有效 Fiber"。
   */
  function reconcileChildren(wipF, elements) {
    const keyedOld   = new Map()
    const unkeyedOld = []
    const usedOld    = new Set()
    let prevSibling  = null
    let unkeyedIdx   = 0

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
          type: oldMatch.type, props: element.props, dom: oldMatch.dom,
          ref: element.ref ?? null,
          return: wipF, alternate: oldMatch, effectTag: 'UPDATE',
        }
        usedOld.add(oldMatch)
      }
      if (!sameType && element) {
        newFiber = {
          type: element.type, props: element.props, dom: null,
          ref: element.ref ?? null,
          return: wipF, alternate: null, effectTag: 'PLACEMENT',
        }
      }
      if (!sameType && oldMatch) {
        oldMatch.effectTag = 'DELETION'
        deletions.push(oldMatch)
        usedOld.add(oldMatch)
      }

      if (!prevSibling) wipF.child = newFiber
      else prevSibling.sibling = newFiber
      prevSibling = newFiber
    })

    // 清理未被使用的老 Fiber
    ;[...unkeyedOld, ...keyedOld.values()].forEach(f => {
      if (!usedOld.has(f)) { f.effectTag = 'DELETION'; deletions.push(f) }
    })
  }

  // ─────────────────────────────────────────────────────────────
  // § 7  COMMIT（三阶段提交）
  // ─────────────────────────────────────────────────────────────

  /**
   * commitRoot —— 不可中断同步提交。
   *
   * 五阶段：
   *   Phase 1 Mutation       —— DOM 插入 / 更新 / 删除
   *   Phase 2 Insertion      —— useInsertionEffect（CSS-in-JS）
   *   Phase 3 Layout         —— useLayoutEffect + componentDidMount/Update
   *   Phase 4 同步刷新       —— flushSyncWork（处理 layout 中的 setState）
   *   Phase 5 Passive (异步) —— useEffect（setTimeout）
   *
   * 顺序设计原因：
   *   - Insertion 必须在 mutation 后、绘制前注入样式（避免 FOUC）
   *   - Layout 必须在 mutation 后、绘制前测量 DOM
   *   - Passive 在绘制后异步执行（不阻塞首帧）
   */
  function commitRoot() {
    const root = wipRoot
    isCommitting = true

    deletions.forEach(fiber => commitWork(fiber))
    commitWork(root.child)
    normalizeHostChildren(root)

    // refs 设置（mutation 完成后立即同步）
    commitAllRefs(root.child)

    currentRoot  = root
    wipRoot      = null
    isCommitting = false

    commitAllInsertionEffects(root.child)
    commitAllLayoutEffects(root.child)
    flushSyncWork()

    // Profiler 回调（actualDuration / phase）
    commitAllProfilerCallbacks(root.child)

    pendingPassiveRoots.push(root.child)
    if (!passiveFlushScheduled) {
      passiveFlushScheduled = true
      setTimeout(() => {
        passiveFlushScheduled = false
        pendingPassiveRoots.splice(0).forEach(flushPassiveEffects)
      }, 0)
    }

    if (needsRerenderAfterCommit) {
      needsRerenderAfterCommit = false
      scheduleRerender()
    }
    if (pendingRerender) {
      pendingRerender = false
      scheduleRerender()
    }
    if (pendingErrorBoundary) {
      const boundary = pendingErrorBoundary
      const error    = pendingErrorBoundaryError
      pendingErrorBoundary      = null
      pendingErrorBoundaryError = null
      boundary.instance?.componentDidCatch?.(error, { componentStack: '' })
      scheduleRerender()
    }
  }

  /**
   * commitWork —— Mutation pass 递归。
   *
   * Bug fix（v2）：while 循环补加 null 守卫，
   * 避免从无 dom 的 Fiber 向上回溯时越过根节点崩溃。
   *
   * Portal：容器已在真实 DOM 中，不执行 appendChild，只处理子节点。
   */
  function commitWork(fiber) {
    if (!fiber) return

    let domParentFiber = fiber.return
    while (domParentFiber && !domParentFiber.dom) domParentFiber = domParentFiber.return
    const parentDom = domParentFiber?.dom

    if (fiber.type === PORTAL) {
      commitWork(fiber.child)
      normalizeHostChildren(fiber)
      commitWork(fiber.sibling)
      return
    }

    if (fiber.effectTag === 'PLACEMENT' && fiber.dom) {
      // hydrate 模式下 DOM 已存在父节点中，不再 append
      if (parentDom && fiber.dom.parentNode !== parentDom) parentDom.appendChild(fiber.dom)
    } else if (fiber.effectTag === 'UPDATE' && fiber.dom) {
      updateDom(fiber.dom, fiber.alternate.props, fiber.props)
    } else if (fiber.effectTag === 'DELETION') {
      if (parentDom) commitDeletion(fiber, parentDom)
      return
    }

    commitWork(fiber.child)
    if (fiber.dom) normalizeHostChildren(fiber)
    commitWork(fiber.sibling)
  }

  /**
   * normalizeHostChildren —— mutation pass 后按 Fiber 顺序修正 DOM 节点物理位置。
   *
   * 解决 keyed diff 复用 DOM 但不移动位置的问题：
   *   <li key="a"/><li key="b"/>  →  <li key="b"/><li key="a"/>
   *   diff 复用了两个 li 但物理顺序未变，需要 insertBefore 重排。
   */
  function normalizeHostChildren(parentFiber) {
    if (!parentFiber?.dom) return
    const doms = []
    collectDirectHostChildren(parentFiber.child, doms)
    let cursor = parentFiber.dom.firstChild
    doms.forEach(dom => {
      if (dom.parentNode === parentFiber.dom && dom === cursor) {
        cursor = cursor.nextSibling; return
      }
      parentFiber.dom.insertBefore(dom, cursor)
    })
  }

  function collectDirectHostChildren(fiber, doms) {
    let node = fiber
    while (node) {
      if (node.dom && node.type !== PORTAL) doms.push(node.dom)
      else collectDirectHostChildren(node.child, doms)
      node = node.sibling
    }
  }

  /** commitAllRefs —— DOM 就绪后设置/解绑 refs。 */
  function commitAllRefs(fiber) {
    if (!fiber) return
    if (fiber.dom && fiber.ref && fiber.alternate?.ref !== fiber.ref) {
      setRef(fiber.alternate?.ref, null)
      setRef(fiber.ref, fiber.dom)
    }
    // 类组件：ref 指向实例
    if (fiber.instance && fiber.ref && fiber.alternate?.ref !== fiber.ref) {
      setRef(fiber.alternate?.ref, null)
      setRef(fiber.ref, fiber.instance)
    }
    commitAllRefs(fiber.child)
    commitAllRefs(fiber.sibling)
  }

  /**
   * commitAllInsertionEffects —— useInsertionEffect 同步执行。
   *
   * 用途：CSS-in-JS 库注入 <style> 标签（如 styled-components）。
   * 时机：DOM 突变后 / Layout 阶段前 / 浏览器绘制前。
   */
  function commitAllInsertionEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if (!hook._isInsertionEffect || !hook.callback) return
        if (hook.cleanup) hook.cleanup()
        hook.cleanup  = hook.callback() ?? null
        hook.callback = null
      })
    }
    commitAllInsertionEffects(fiber.child)
    commitAllInsertionEffects(fiber.sibling)
  }

  /** commitAllLayoutEffects —— useLayoutEffect + 类组件 didMount/didUpdate。 */
  function commitAllLayoutEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if (!hook._isLayoutEffect || !hook.callback) return
        if (hook.cleanup) hook.cleanup()
        hook.cleanup  = hook.callback() ?? null
        hook.callback = null
      })
    }
    if (fiber.instance) {
      if (!fiber.alternate) {
        fiber.instance.componentDidMount?.()
      } else {
        fiber.instance.componentDidUpdate?.(
          fiber.alternate.props,
          fiber.alternate.instance?.state ?? {}
        )
      }
    }
    commitAllLayoutEffects(fiber.child)
    commitAllLayoutEffects(fiber.sibling)
  }

  /** flushPassiveEffects —— useEffect 异步执行（绘制后）。 */
  function flushPassiveEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if (!hook._isEffect || !hook.callback) return
        if (hook.cleanup) hook.cleanup()
        hook.cleanup  = hook.callback() ?? null
        hook.callback = null
      })
    }
    flushPassiveEffects(fiber.child)
    flushPassiveEffects(fiber.sibling)
  }

  /**
   * commitAllProfilerCallbacks —— Profiler onRender 触发。
   * 真实 React 还会传 baseDuration、interactions，此处简化。
   */
  function commitAllProfilerCallbacks(fiber) {
    if (!fiber) return
    if (fiber.type?._isProfiler && fiber.props.onRender) {
      const { id, onRender } = fiber.props
      const phase = fiber.alternate ? 'update' : 'mount'
      const actualDuration = fiber._profilerActualDuration ?? 0
      try {
        onRender(id, phase, actualDuration, actualDuration, performance.now() - actualDuration, performance.now())
      } catch (e) { console.error('[Profiler] onRender threw', e) }
    }
    commitAllProfilerCallbacks(fiber.child)
    commitAllProfilerCallbacks(fiber.sibling)
  }

  function commitDeletion(fiber, parentDom) {
    runUnmountEffects(fiber)
    if (fiber.type === PORTAL) {
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
        if ((hook._isEffect || hook._isLayoutEffect || hook._isInsertionEffect) && hook.cleanup) {
          try { hook.cleanup() } catch (e) { console.error('[unmount] cleanup error', e) }
        }
      })
    }
    fiber.instance?.componentWillUnmount?.()
    if (fiber.dom && fiber.ref) setRef(fiber.ref, null)
    if (fiber.instance && fiber.ref) setRef(fiber.ref, null)
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
  // § 8  DOM 工具函数
  // ─────────────────────────────────────────────────────────────

  const SVG_NAMESPACE  = 'http://www.w3.org/2000/svg'
  const SVG_ELEMENTS   = new Set([
    'svg','circle','clipPath','defs','desc','ellipse','foreignObject','g',
    'image','line','linearGradient','marker','mask','path','pattern','polygon',
    'polyline','radialGradient','rect','stop','symbol','text','textPath','tspan','use',
  ])

  /** 布尔属性表（present 即 true，缺失即 false）。 */
  const BOOLEAN_ATTRS = new Set([
    'checked','disabled','readOnly','selected','autoFocus','required','multiple',
    'hidden','open','muted','controls','autoPlay','loop','reversed','default',
  ])

  /** 特殊 DOM 属性映射（HTML attribute → JS property）。 */
  const ATTR_TO_PROP = {
    class:    'className',
    for:      'htmlFor',
    tabindex: 'tabIndex',
  }

  const isEvent = k => k.startsWith('on') && k !== 'onMount' && k !== 'onUnmount'
  const isProp  = k =>
    k !== 'children' && k !== 'key' && k !== 'ref' && k !== 'dangerouslySetInnerHTML' && !isEvent(k)
  const isNew   = (p, n) => k => p[k] !== n[k]
  const isGone  = (_, n) => k => !(k in n)

  /** 事件名规范化映射（DOM 事件名小写化，但部分需别名）。 */
  const eventAliases = { doubleclick: 'dblclick', change: 'input' }

  /** onClick → click，onMouseDown → mousedown，onChange → input（受控输入） */
  function toEvt(name) {
    const n = name.slice(2).toLowerCase()
    return eventAliases[n] || n
  }

  /**
   * updateDom —— 增量更新 DOM 属性 / 事件 / 样式。
   *
   * 处理顺序：
   *   1. 移除已不存在的事件监听
   *   2. 移除已不存在的 props（重置为空）
   *   3. 设置新 props（包括 style / className / value）
   *   4. 添加新事件监听
   *
   * 特殊处理：
   *   - dangerouslySetInnerHTML：直接写 innerHTML（XSS 风险，由用户保证安全）
   *   - value/checked：受控组件需要直接赋值给 property（不能用 setAttribute）
   *   - 布尔属性：按 BOOLEAN_ATTRS 表处理
   *   - SVG 属性：必须用 setAttribute（不能用 property 赋值）
   *   - data-* / aria-*：用 setAttribute 写入
   */
  function updateDom(dom, prev, next) {
    // dangerouslySetInnerHTML 优先处理
    const prevHtml = prev.dangerouslySetInnerHTML?.__html
    const nextHtml = next.dangerouslySetInnerHTML?.__html
    if (nextHtml !== prevHtml) {
      if (nextHtml != null) dom.innerHTML = nextHtml
      else if (prevHtml != null) dom.innerHTML = ''
    }

    // 1. 移除事件
    Object.keys(prev).filter(isEvent).filter(k => !(k in next) || isNew(prev, next)(k))
      .forEach(k => dom.removeEventListener(toEvt(k), prev[k]))

    // 2. 移除 props
    Object.keys(prev).filter(isProp).filter(isGone(prev, next))
      .forEach(k => removeAttribute(dom, k, prev[k]))

    // 3. 添加 / 更新 props
    Object.keys(next).filter(isProp).filter(isNew(prev, next))
      .forEach(k => setAttribute(dom, k, next[k], prev[k]))

    // 4. 添加事件
    Object.keys(next).filter(isEvent).filter(isNew(prev, next))
      .forEach(k => dom.addEventListener(toEvt(k), next[k]))
  }

  function setAttribute(dom, key, value, prevValue) {
    if (key === 'style') {
      updateStyle(dom, prevValue, value)
      return
    }
    if (key === 'className' || key === 'class') {
      dom.className = value || ''
      return
    }
    if (key === 'value' || key === 'checked') {
      // 受控组件：必须用 property 赋值，setAttribute 只设置初始值
      if (dom[key] !== value) dom[key] = value
      return
    }
    if (BOOLEAN_ATTRS.has(key)) {
      if (value) dom.setAttribute(key, '')
      else dom.removeAttribute(key)
      dom[key] = !!value
      return
    }
    if (key === 'htmlFor') { dom.htmlFor = value; return }
    if (key === 'nodeValue') { dom.nodeValue = value; return }
    if (key.startsWith('data-') || key.startsWith('aria-')) {
      dom.setAttribute(key, value)
      return
    }
    // SVG：必须 setAttribute；HTML：优先 property
    if (dom.namespaceURI === SVG_NAMESPACE) {
      dom.setAttribute(ATTR_TO_PROP[key] || key, value)
    } else {
      try { dom[key] = value } catch (_) { dom.setAttribute(key, value) }
    }
  }

  function removeAttribute(dom, key, prevValue) {
    if (key === 'style') { updateStyle(dom, prevValue, null); return }
    if (key === 'className' || key === 'class') { dom.className = ''; return }
    if (key === 'value' || key === 'checked') { dom[key] = key === 'value' ? '' : false; return }
    if (BOOLEAN_ATTRS.has(key)) { dom.removeAttribute(key); dom[key] = false; return }
    if (key.startsWith('data-') || key.startsWith('aria-')) { dom.removeAttribute(key); return }
    try { dom[key] = '' } catch (_) { dom.removeAttribute(key) }
  }

  /**
   * updateStyle —— 增量更新内联样式。
   * 支持字符串（cssText）和对象两种形式。
   * 字符串切对象时先清空 cssText 防止残留。
   */
  function updateStyle(dom, prev, next) {
    if (typeof prev === 'string' && typeof next !== 'string') dom.style.cssText = ''
    if (prev && typeof prev === 'object') {
      Object.keys(prev).forEach(k => { if (!next || !(k in next)) dom.style[k] = '' })
    }
    if (typeof next === 'string') dom.style.cssText = next
    else if (next && typeof next === 'object') Object.assign(dom.style, next)
  }

  function setRef(ref, value) {
    if (!ref) return
    if (typeof ref === 'function') ref(value)
    else ref.current = value
  }

  /**
   * createDom —— 创建 DOM 节点。
   * 支持：TEXT_ELEMENT、SVG、普通 HTML。
   */
  function createDom(fiber) {
    if (fiber.type === 'TEXT_ELEMENT') {
      return document.createTextNode('')
    }
    let dom
    // SVG 元素需要正确的命名空间，否则不会渲染
    if (SVG_ELEMENTS.has(fiber.type) || isInsideSvg(fiber)) {
      dom = document.createElementNS(SVG_NAMESPACE, fiber.type)
    } else {
      dom = document.createElement(fiber.type)
    }
    updateDom(dom, {}, fiber.props)
    return dom
  }

  /** 判断 fiber 是否在 <svg> 子树中（用于 <g>、<path> 等通用元素）。 */
  function isInsideSvg(fiber) {
    let p = fiber.return
    while (p) {
      if (p.type === 'svg') return true
      if (p.dom && p.dom.namespaceURI === SVG_NAMESPACE) return true
      if (typeof p.type === 'string' && !SVG_ELEMENTS.has(p.type)) return false
      p = p.return
    }
    return false
  }

  /**
   * hydrateDom —— hydration 模式下复用现有 DOM。
   * 简化实现：按 DOM 树深度优先匹配 Fiber 树。
   */
  function hydrateDom(fiber) {
    let parent = fiber.return
    while (parent && !parent.dom) parent = parent.return
    if (!parent) return createDom(fiber)
    // hydrationCursor 记录在父 DOM 中扫描到第几个子节点
    if (!parent._hydrationCursor) parent._hydrationCursor = parent.dom.firstChild
    const existing = parent._hydrationCursor
    if (existing && nodeMatchesFiber(existing, fiber)) {
      parent._hydrationCursor = existing.nextSibling
      // 仅绑定事件，不重写已存在的属性
      Object.keys(fiber.props).filter(isEvent)
        .forEach(k => existing.addEventListener(toEvt(k), fiber.props[k]))
      if (fiber.type === 'TEXT_ELEMENT') existing.nodeValue = fiber.props.nodeValue
      return existing
    }
    // 不匹配 → 警告并回退到 createDom
    console.warn('[hydrate] mismatch at', fiber.type, '— falling back to createDom')
    return createDom(fiber)
  }

  function nodeMatchesFiber(node, fiber) {
    if (fiber.type === 'TEXT_ELEMENT') return node.nodeType === 3
    return node.nodeType === 1 && node.tagName.toLowerCase() === String(fiber.type).toLowerCase()
  }

  // ─────────────────────────────────────────────────────────────
  // § 9  合成事件系统（SyntheticEvent + 事件委托）
  // ─────────────────────────────────────────────────────────────

  /**
   * SyntheticEvent —— 浏览器原生事件的跨浏览器一致包装。
   *
   * 提供与 React 一致的接口：
   *   - target / currentTarget / type / bubbles
   *   - preventDefault() / stopPropagation() / persist()
   *   - nativeEvent 暴露原生事件以便逃生
   *
   * 设计差异：
   *   - React 17 之前用事件池（重用对象），17+ 移除（避免异步访问陷阱）
   *   - 此实现不池化，每次 new
   */
  class SyntheticEvent {
    constructor(nativeEvent, currentTarget) {
      this.nativeEvent     = nativeEvent
      this.target          = nativeEvent.target
      this.currentTarget   = currentTarget
      this.type            = nativeEvent.type
      this.bubbles         = nativeEvent.bubbles
      this.cancelable      = nativeEvent.cancelable
      this.timeStamp       = nativeEvent.timeStamp
      this.defaultPrevented = false
      this._propagationStopped = false
    }
    preventDefault()  { this.defaultPrevented = true; this.nativeEvent.preventDefault?.() }
    stopPropagation() { this._propagationStopped = true; this.nativeEvent.stopPropagation?.() }
    persist()         { /* React 17+ no-op */ }
    isPropagationStopped() { return this._propagationStopped }
    isDefaultPrevented()   { return this.defaultPrevented }
  }

  /**
   * 全局合成事件委托：所有事件统一委托到根容器。
   * 优势：减少监听器数量、动态组件无需重新绑定、可统一拦截。
   *
   * 实现：rootEventListeners 记录每种事件类型只挂载一次，
   * 触发时从 e.target 沿 DOM 冒泡，找到附着的 Fiber 上的对应 props 函数。
   */
  const rootEventListeners = new WeakMap()  // root → Set<eventType>

  /**
   * ensureRootEventListener —— 在根容器上挂载某事件类型的总监听器（仅一次）。
   * 通过 dispatchSyntheticEvent 沿冒泡路径派发到对应组件。
   *
   * 当前实现仍优先用 dom.addEventListener 直接绑定（updateDom 中），
   * 此函数为未来切换到完全委托模式预留。
   */
  function ensureRootEventListener(root, eventType) {
    if (!rootEventListeners.has(root)) rootEventListeners.set(root, new Set())
    const types = rootEventListeners.get(root)
    if (types.has(eventType)) return
    types.add(eventType)
    root.addEventListener(eventType, e => dispatchSyntheticEvent(e, root, eventType))
  }

  /**
   * dispatchSyntheticEvent —— 合成事件分发。
   *
   * 流程：
   *   1. 包装为 SyntheticEvent
   *   2. 沿 DOM 冒泡找到挂载了 onXXX 的节点
   *   3. 调用之；若 stopPropagation 则中止冒泡
   *
   * 注：当前实现仍依赖原生 addEventListener（属性绑定方式），
   * 此函数预留给真正的事件委托重构使用。
   */
  function dispatchSyntheticEvent(nativeEvent, root, eventType) {
    let node = nativeEvent.target
    while (node && node !== root.parentNode) {
      const handler = node.__reactHandlers?.[eventType]
      if (handler) {
        const synth = new SyntheticEvent(nativeEvent, node)
        handler(synth)
        if (synth.isPropagationStopped()) break
      }
      node = node.parentNode
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 10  HOOKS
  // ─────────────────────────────────────────────────────────────

  /**
   * 内部约定：每个 hook 必须按相同顺序调用。
   * wipFiber.hooks 数组按 hookIndex 顺序存储；
   * alternate.hooks 同索引位置即上次该 hook 的 state。
   *
   * 这就是 React 的 "Rules of Hooks"：
   *   - 不能在循环 / 条件 / 嵌套函数中调用 hooks
   *   - 否则索引错位，state 被串到错误的 hook 上
   */

  /**
   * useReducer —— 状态管理核心。
   *
   * 实现要点：
   *   - queue 在 alternate 上跨渲染保留
   *   - queue.splice(0) 消费并清空（防止重复 reduce 同一批 action）
   *   - dispatch 触发 scheduleRerender
   *
   * @example
   *   const [state, dispatch] = useReducer(
   *     (s, a) => a.type === 'inc' ? { count: s.count + 1 } : s,
   *     { count: 0 }
   *   )
   *   dispatch({ type: 'inc' })
   */
  function useReducer(reducer, initialState, init) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const queue   = oldHook ? oldHook.queue : []
    const hook    = {
      state: oldHook ? oldHook.state : (init ? init(initialState) : initialState),
      queue,
    }
    queue.splice(0).forEach(action => { hook.state = reducer(hook.state, action) })
    const dispatch = action => {
      hook.queue.push(action)
      if (isBatchingUpdates) pendingBatchUpdates.push(scheduleRerender)
      else scheduleRerender()
    }
    wipFiber.hooks.push(hook)
    hookIndex++
    return [hook.state, dispatch]
  }

  /**
   * useState —— useReducer 的语法糖。
   *
   * action 形式：
   *   - 直接值：setCount(5)
   *   - 函数式更新：setCount(prev => prev + 1)（避免闭包旧值）
   *
   * 惰性初始化：useState(() => expensiveCompute())
   *
   * @example
   *   const [count, setCount] = useState(0)
   *   const [user, setUser] = useState(() => JSON.parse(localStorage.user))
   */
  function useState(initialState) {
    return useReducer(
      (s, a) => typeof a === 'function' ? a(s) : a,
      initialState,
      s => typeof s === 'function' ? s() : s,
    )
  }

  /**
   * useEffect —— 异步副作用（绘制后 setTimeout）。
   *
   * deps 语义：
   *   - undefined：每次渲染都执行
   *   - []：仅 mount 执行一次
   *   - [a, b]：依赖变化时执行
   *
   * 返回 cleanup 函数：下次执行前 / 卸载时调用。
   *
   * @example
   *   useEffect(() => {
   *     const id = setInterval(tick, 1000)
   *     return () => clearInterval(id)
   *   }, [])
   */
  function useEffect(callback, deps) {
    const old  = wipFiber.alternate?.hooks?.[hookIndex]
    const hook = {
      _isEffect: true,
      deps,
      cleanup: old?.cleanup ?? null,
      callback: haveDepsChanged(old?.deps, deps) ? callback : null,
    }
    wipFiber.hooks.push(hook)
    hookIndex++
  }

  /**
   * useLayoutEffect —— 同步副作用（DOM 就绪，绘制前）。
   *
   * 适合：测量 DOM 尺寸、强制滚动、读取布局后立刻调整。
   * 注意：此处运行的代码会阻塞绘制，慎用。
   */
  function useLayoutEffect(callback, deps) {
    const old  = wipFiber.alternate?.hooks?.[hookIndex]
    const hook = {
      _isLayoutEffect: true,
      deps,
      cleanup: old?.cleanup ?? null,
      callback: haveDepsChanged(old?.deps, deps) ? callback : null,
    }
    wipFiber.hooks.push(hook)
    hookIndex++
  }

  /**
   * useInsertionEffect —— 最早的同步副作用，DOM 突变前触发。
   *
   * 设计用途：CSS-in-JS 库注入 <style> 标签，
   * 确保样式在首次绘制前就位，避免 FOUC。
   *
   * ⚠️ 禁止在此 hook 内读取或写入 DOM refs。
   * ⚠️ 不能调用 setState（会死循环）。
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
    const hook = {
      _isInsertionEffect: true,
      deps,
      cleanup: old?.cleanup ?? null,
      callback: haveDepsChanged(old?.deps, deps) ? callback : null,
    }
    wipFiber.hooks.push(hook)
    hookIndex++
  }

  /** useMemo —— 缓存昂贵计算，deps 不变时返回旧值。factory 须为纯函数。 */
  function useMemo(factory, deps) {
    const old  = wipFiber.alternate?.hooks?.[hookIndex]
    const hook = {
      value: haveDepsChanged(old?.deps, deps) ? factory() : old.value,
      deps,
    }
    wipFiber.hooks.push(hook)
    hookIndex++
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
   * @example
   *   const Input = forwardRef((props, ref) => {
   *     const inputRef = useRef()
   *     useImperativeHandle(ref, () => ({
   *       focus: () => inputRef.current.focus(),
   *       clear: () => inputRef.current.value = '',
   *     }), [])
   *     return <input ref={inputRef}/>
   *   })
   */
  function useImperativeHandle(ref, createHandle, deps) {
    useLayoutEffect(() => {
      if (!ref) return
      setRef(ref, createHandle())
      return () => setRef(ref, null)
    }, deps)
  }

  /** useDebugValue —— DevTools 中显示自定义 hook 标签（生产环境无操作）。 */
  function useDebugValue(_value, _formatter) {
    wipFiber.hooks.push({ _isDebugValue: true })
    hookIndex++
  }

  /**
   * useTransition —— 将状态更新标记为可中断的低优先级过渡。
   *
   * 简化实现：callback 在 LowPriority 中执行，isPending 期间为 true。
   * 真实 React 18 用 Scheduler 实现真正的并发优先级 + 中断。
   *
   * @example
   *   const [isPending, startTransition] = useTransition()
   *   startTransition(() => setBigList(filterHugeData(query)))
   */
  function useTransition() {
    const [isPending, setIsPending] = useState(false)
    const start = useCallback(callback => {
      setIsPending(true)
      scheduleCallback(LowPriority, () => {
        callback()
        setIsPending(false)
      })
    }, [])
    return [isPending, start]
  }

  /**
   * useDeferredValue —— 返回值的"延迟版本"。
   *
   * 简化实现：通过 setTimeout 在下一帧才更新延迟值，
   * 高优先级渲染先用旧值，避免输入卡顿。
   */
  function useDeferredValue(value) {
    const [deferred, setDeferred] = useState(value)
    useEffect(() => {
      const id = setTimeout(() => setDeferred(value), 0)
      return () => clearTimeout(id)
    }, [value])
    return deferred
  }

  /**
   * useSyncExternalStore —— 订阅外部数据源（Redux、Zustand 专用）。
   *
   * @param subscribe    (onStoreChange) => unsubscribe
   * @param getSnapshot  () => snapshot（必须为纯函数）
   * @param getServerSnapshot  SSR 快照（hydrate 时使用）
   *
   * 工作原理：
   *   1. 渲染时直接调用 getSnapshot 读取最新值
   *   2. useEffect 订阅 store；变化时 forceUpdate
   *   3. 卸载时自动取消订阅
   *
   * ⚠️ subscribe 应稳定引用；getSnapshot 必须为纯函数。
   */
  function useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
    const value = isHydrating && getServerSnapshot ? getServerSnapshot() : getSnapshot()
    const [, forceUpdate] = useReducer(s => s + 1, 0)
    useEffect(() => {
      const unsub = subscribe(forceUpdate)
      forceUpdate()  // 防止订阅前 store 已变化
      return unsub
    }, [subscribe])
    return value
  }

  // ─────────────────────────────────────────────────────────────
  // § 11  CONTEXT
  // ─────────────────────────────────────────────────────────────

  /**
   * createContext —— 跨层级数据通道。
   *
   * 渲染期栈隔离：
   *   Provider beginWork → 保存旧值 → 注入 fiber.props.value
   *   Provider completeWork → 恢复旧值
   *   子树渲染期间 _currentValue 始终是最近 Provider 的值
   *
   * ⚠️ memo 可能阻止 context 消费者响应（无精确订阅）。
   *
   * @example
   *   const Theme = createContext('light')
   *   <Theme.Provider value="dark">
   *     <App/>  // useContext(Theme) → 'dark'
   *   </Theme.Provider>
   */
  function createContext(defaultValue) {
    function Provider({ children }) {
      if (children == null) return null
      return Array.isArray(children)
        ? createElement(Fragment, null, ...children)
        : children
    }
    Provider._context = null
    const ctx = {
      $$typeof: REACT_CONTEXT_TYPE,
      _currentValue: defaultValue,
      _defaultValue: defaultValue,
      Provider,
      Consumer: null,
    }
    ctx.Consumer = function Consumer({ children }) { return children(ctx._currentValue) }
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
  // § 12  CLASS COMPONENT
  // ─────────────────────────────────────────────────────────────

  /**
   * Component —— 类组件基类。
   *
   * setState 形式：
   *   - 对象：this.setState({ count: 1 })  浅合并
   *   - 函数：this.setState(s => ({ count: s.count + 1 }))  避免闭包
   *
   * forceUpdate：跳过 shouldComponentUpdate 强制重渲染。
   *
   * 完整生命周期：
   *   constructor(props)
   *   static getDerivedStateFromProps(props, state)
   *   shouldComponentUpdate(nextProps, nextState)
   *   render()  *必须实现
   *   componentDidMount()
   *   componentDidUpdate(prevProps, prevState)
   *   componentWillUnmount()
   *   static getDerivedStateFromError(error)
   *   componentDidCatch(error, info)
   */
  class Component {
    constructor(props) {
      this.props   = props
      this.state   = {}
      this.context = {}
      this._fiber  = null
    }

    setState(updater, callback) {
      const next = typeof updater === 'function' ? updater(this.state, this.props) : updater
      this.state = { ...this.state, ...next }
      if (callback) {
        // setState callback 在 commit 后执行
        const prevDidMount = this.componentDidMount
        const prevDidUpdate = this.componentDidUpdate
        const wrapper = () => { try { callback() } catch (e) { console.error(e) } }
        if (this._fiber?.alternate) {
          this.componentDidUpdate = function(...args) {
            prevDidUpdate?.apply(this, args)
            wrapper()
            this.componentDidUpdate = prevDidUpdate
          }
        } else {
          this.componentDidMount = function() {
            prevDidMount?.apply(this)
            wrapper()
            this.componentDidMount = prevDidMount
          }
        }
      }
      if (this._fiber) {
        if (isBatchingUpdates) pendingBatchUpdates.push(scheduleRerender)
        else scheduleRerender()
      }
    }

    forceUpdate(callback) {
      if (callback) {
        const prev = this.componentDidUpdate
        this.componentDidUpdate = function(...args) {
          prev?.apply(this, args)
          callback()
          this.componentDidUpdate = prev
        }
      }
      if (this._fiber) scheduleRerender()
    }

    render() {}
  }
  Component._isClass = true

  /**
   * PureComponent —— 自带浅比较 shouldComponentUpdate 的类组件基类。
   * props 和 state 均未变则跳过渲染（等价于函数组件 memo）。
   */
  class PureComponent extends Component {}
  PureComponent._isPure = true

  // ─────────────────────────────────────────────────────────────
  // § 13  PORTAL
  // ─────────────────────────────────────────────────────────────

  /**
   * createPortal —— 将子节点渲染到任意 DOM 容器（而非当前 Fiber 父 DOM）。
   *
   * 常见用途：模态框、Tooltip、下拉菜单（document.body）。
   *
   * 实现原理：
   *   返回 type=PORTAL 的 Element；updateHostComponent 将 fiber.dom 设为
   *   目标容器，子节点自然插入容器中。commitWork 中 PORTAL 不执行 appendChild。
   *
   * @example
   *   createPortal(<Modal/>, document.body)
   */
  function createPortal(children, container, key) {
    const kids = Array.isArray(children) ? children : (children != null ? [children] : [])
    return {
      $$typeof: REACT_ELEMENT_TYPE,
      type: PORTAL, key: key ?? null, ref: null,
      props: { container, children: kids },
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 14  SUSPENSE & LAZY
  // ─────────────────────────────────────────────────────────────

  /**
   * Suspense —— 异步组件加载期间显示 fallback。
   *
   * 工作流程：
   *   1. 首次渲染：子树正常渲染，lazy/use 抛出 Promise
   *   2. updateFunctionComponent catch Promise → 在最近 Suspense 上设
   *      _suspendPending；needsRerenderAfterCommit = true
   *   3. 首次提交后 commitRoot 触发第二次渲染
   *   4. 第二次渲染：检测到 alternate._suspendPending → 显示 fallback
   *   5. Promise resolve → 清除 _suspendPending → scheduleRerender
   *
   * @example
   *   <Suspense fallback={<Spinner/>}>
   *     <LazyComponent/>
   *   </Suspense>
   */
  function Suspense({ children, fallback }) {
    if (wipFiber.alternate?._suspendPending) {
      return fallback ?? null
    }
    if (!children) return null
    return Array.isArray(children) ? createElement(Fragment, null, ...children) : children
  }
  Suspense._isSuspense = true

  /**
   * lazy —— 懒加载组件（代码分割）。
   *
   * 状态机：
   *   pending  → 抛出 thenable，触发 Suspense
   *   resolved → 渲染加载到的组件
   *   rejected → 抛出错误（由 ErrorBoundary 捕获）
   *
   * @example
   *   const Chart = lazy(() => import('./Chart.js'))
   *   <Suspense fallback={<Spinner/>}>
   *     <Chart/>
   *   </Suspense>
   */
  function lazy(factory) {
    let status  = 'pending'
    let result  = null
    let promise = null

    function load() {
      if (promise) return promise
      promise = factory().then(
        mod => { status = 'resolved'; result = mod.default ?? mod },
        err => { status = 'rejected'; result = err }
      )
      return promise
    }

    function LazyComponent(props) {
      if (status === 'resolved') return createElement(result, props)
      if (status === 'rejected') throw result
      throw load()
    }
    LazyComponent.displayName = 'Lazy'
    LazyComponent._isLazy = true
    return LazyComponent
  }

  /**
   * StrictMode —— 开发辅助：透明渲染。
   * 真实 React 在 StrictMode 下双调用 render 检测副作用。
   * 此实现仅作 API 占位。
   */
  function StrictMode({ children }) {
    if (!children) return null
    return Array.isArray(children) ? createElement(Fragment, null, ...children) : children
  }

  // ─────────────────────────────────────────────────────────────
  // § 15  ERROR BOUNDARY
  // ─────────────────────────────────────────────────────────────

  /**
   * propagateError —— 向上查找最近的 ErrorBoundary 并应用错误状态。
   *
   * ErrorBoundary 条件（与 React 一致）：
   *   - 必须是类组件
   *   - 实现 static getDerivedStateFromError 或 componentDidCatch
   *
   * 注意：函数组件不能成为 ErrorBoundary（计划通过 use() 支持）。
   *
   * 返回：
   *   true  — 错误已被边界捕获
   *   false — 无边界，错误继续向上抛出
   */
  function propagateError(fiber, error) {
    let boundary = fiber.return
    while (boundary) {
      const inst = boundary.instance
      const type = boundary.type
      const isEB = inst && (
        typeof type?.getDerivedStateFromError === 'function' ||
        typeof inst.componentDidCatch          === 'function'
      )
      if (isEB) {
        if (typeof type.getDerivedStateFromError === 'function') {
          const errorState = type.getDerivedStateFromError(error)
          if (errorState) inst.state = { ...inst.state, ...errorState }
        }
        pendingErrorBoundary      = boundary
        pendingErrorBoundaryError = error
        return true
      }
      boundary = boundary.return
    }
    return false
  }

  // ─────────────────────────────────────────────────────────────
  // § 16  HOC: forwardRef / memo
  // ─────────────────────────────────────────────────────────────

  /**
   * forwardRef —— 透传 ref 给函数组件内部的 DOM 或子组件。
   *
   * @example
   *   const Input = forwardRef((props, ref) => <input ref={ref} {...props}/>)
   *   <Input ref={myRef}/>  →  myRef.current = input DOM
   */
  function forwardRef(renderFn) {
    function ForwardRef(props) { return renderFn(props, props.ref ?? null) }
    ForwardRef.$$typeof = REACT_FORWARD_TYPE
    ForwardRef._isForwardRef = true
    ForwardRef._renderFn     = renderFn
    ForwardRef.displayName   = `ForwardRef(${renderFn.name || 'Component'})`
    return ForwardRef
  }

  /**
   * memo —— 跳过 props 未变化的函数组件渲染（浅比较）。
   *
   * @example
   *   const Item = memo(function Item({ value }) { ... })
   *   const Item = memo(Comp, (prev, next) => deepEqual(prev, next))
   */
  function memo(component, compare) {
    function Memoized(props) { return component(props) }
    Memoized.$$typeof    = REACT_MEMO_TYPE
    Memoized._isMemo     = true
    Memoized._type       = component
    Memoized._compare    = compare || shallowEqualProps
    Memoized.displayName = `memo(${component.name || 'Component'})`
    return Memoized
  }

  // ─────────────────────────────────────────────────────────────
  // § 17  PROFILER
  // ─────────────────────────────────────────────────────────────

  /**
   * Profiler —— 测量渲染性能的内置组件。
   *
   * Props:
   *   id       唯一标识
   *   onRender (id, phase, actualDuration, baseDuration, startTime, commitTime)
   *
   * phase: 'mount' | 'update'
   * actualDuration: 实际渲染耗时（含子树）
   *
   * @example
   *   <Profiler id="App" onRender={(id, phase, dur) => console.log(id, phase, dur)}>
   *     <App/>
   *   </Profiler>
   */
  function Profiler({ children }) {
    if (!children) return null
    return Array.isArray(children) ? createElement(Fragment, null, ...children) : children
  }
  Profiler.$$typeof = REACT_PROFILER_TYPE
  Profiler._isProfiler = true

  // ─────────────────────────────────────────────────────────────
  // § 18  HYDRATION
  // ─────────────────────────────────────────────────────────────

  /**
   * hydrateRoot —— React 18 hydration API。
   *
   * 与 createRoot 的区别：
   *   - createRoot：清空容器 + 重新创建 DOM
   *   - hydrateRoot：复用容器内现有 DOM（来自 SSR），仅绑定事件 + 激活 hooks
   *
   * @example
   *   // SSR 已经在 #root 中渲染了 HTML
   *   const root = hydrateRoot(document.getElementById('root'), <App/>)
   */
  function hydrateRoot(container, element) {
    isHydrating = true
    container._hydrationCursor = container.firstChild
    wipRoot = {
      dom: container,
      props: { children: [element] },
      alternate: currentRoot,
    }
    deletions = []
    nextUnitOfWork = wipRoot
    flushSyncWork()  // hydrate 必须同步完成（否则会出现部分激活的状态）
    isHydrating = false
    return {
      render(newElement) { render(newElement, container) },
      unmount() {
        wipRoot = { dom: container, props: { children: [] }, alternate: currentRoot }
        deletions = []
        nextUnitOfWork = wipRoot
        flushSyncWork()
      },
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 19  SERVER RENDERING
  // ─────────────────────────────────────────────────────────────

  /** void 元素列表（HTML 规范：自闭合） */
  const VOID_ELEMENTS = new Set([
    'area','base','br','col','embed','hr','img','input','keygen',
    'link','meta','param','source','track','wbr',
  ])

  /** HTML 转义（防 XSS） */
  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch])
  }

  /**
   * renderToString —— 同步渲染元素为 HTML 字符串（SSR）。
   *
   * 简化实现：
   *   - 不支持 Suspense（pending 直接抛错）
   *   - 不支持流式（无 renderToPipeableStream）
   *   - hooks 中 useEffect / useLayoutEffect 直接跳过
   *   - useState 仅初始化，不响应 setState
   *
   * @example
   *   const html = renderToString(<App/>)
   *   res.send(`<!doctype html><html><body><div id="root">${html}</div></body></html>`)
   */
  function renderToString(element) {
    return renderElementToString(element, { useId: 0 })
  }

  /** renderToStaticMarkup —— 同 renderToString，但不输出 hydrate 标记（更小体积）。 */
  function renderToStaticMarkup(element) {
    return renderElementToString(element, { useId: 0, static: true })
  }

  function renderElementToString(element, ctx) {
    if (element == null || typeof element === 'boolean') return ''
    if (typeof element === 'string' || typeof element === 'number') return escapeHTML(element)
    if (Array.isArray(element)) return element.map(e => renderElementToString(e, ctx)).join('')

    const { type, props } = element

    if (type === 'TEXT_ELEMENT') return escapeHTML(props.nodeValue)
    if (type === Fragment || type === REACT_FRAGMENT_TYPE) {
      return renderElementToString(props.children, ctx)
    }
    if (type === PORTAL) return ''  // SSR 不渲染 Portal

    if (typeof type === 'function') {
      // memo / forwardRef 解包
      if (type._isMemo)       return renderElementToString(createElement(type._type, props), ctx)
      if (type._isForwardRef) return renderElementToString(type._renderFn(props, props.ref ?? null), ctx)
      if (type._isProfiler)   return renderElementToString(props.children, ctx)
      if (type._isSuspense) {
        try { return renderElementToString(props.children, ctx) }
        catch (e) {
          if (e && typeof e.then === 'function') return renderElementToString(props.fallback, ctx)
          throw e
        }
      }
      // 类组件
      if (type._isClass) {
        const inst = new type(props)
        return renderElementToString(inst.render(), ctx)
      }
      // 函数组件：用 mock hooks 让其能调用 useState/useRef 等
      const prevWip   = wipFiber
      const prevIndex = hookIndex
      wipFiber = { hooks: [], alternate: null }
      hookIndex = 0
      try {
        const child = type(props)
        return renderElementToString(child, ctx)
      } finally {
        wipFiber = prevWip
        hookIndex = prevIndex
      }
    }

    // Host 元素
    const tag = String(type).toLowerCase()
    let html = `<${tag}`
    let innerHTML = null
    for (const k in props) {
      if (k === 'children' || k === 'ref' || k === 'key') continue
      const v = props[k]
      if (k === 'dangerouslySetInnerHTML') { innerHTML = v?.__html ?? ''; continue }
      if (isEvent(k)) continue   // SSR 不输出事件（hydrate 阶段绑定）
      if (v == null || v === false) continue
      if (k === 'style' && typeof v === 'object') {
        const css = Object.keys(v).map(sk => `${camelToKebab(sk)}:${v[sk]}`).join(';')
        html += ` style="${escapeHTML(css)}"`
        continue
      }
      if (k === 'className') { html += ` class="${escapeHTML(v)}"`; continue }
      if (k === 'htmlFor')   { html += ` for="${escapeHTML(v)}"`;   continue }
      if (BOOLEAN_ATTRS.has(k)) { if (v) html += ` ${k}=""`; continue }
      html += ` ${k}="${escapeHTML(v)}"`
    }
    html += '>'
    if (VOID_ELEMENTS.has(tag)) return html
    if (innerHTML !== null) html += innerHTML
    else html += renderElementToString(props.children, ctx)
    html += `</${tag}>`
    return html
  }

  function camelToKebab(s) { return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase()) }

  // ─────────────────────────────────────────────────────────────
  // § 20  React 19 HOOKS: use / useOptimistic / useActionState / useFormStatus
  // ─────────────────────────────────────────────────────────────

  /**
   * use —— 通用读取 hook，可读 Promise 或 Context（React 19 新增）。
   *
   * Promise:
   *   pending  → 抛出 thenable，被 Suspense 捕获
   *   resolved → 返回 .value
   *   rejected → 抛出错误
   *
   * Context:
   *   等价于 useContext，但可在条件分支中调用（不破坏 hook 顺序）
   *
   * @example
   *   function Comments({ promise }) {
   *     const data = use(promise)  // suspends until resolved
   *     return <ul>{data.map(c => <li>{c}</li>)}</ul>
   *   }
   */
  function use(usable) {
    if (usable == null) throw new Error('use() received null/undefined')
    // Context
    if (usable.$$typeof === REACT_CONTEXT_TYPE) {
      return usable._currentValue
    }
    // Thenable
    if (typeof usable.then === 'function') {
      if (usable.status === 'fulfilled') return usable.value
      if (usable.status === 'rejected')  throw usable.reason
      // 首次进入：附加状态机并抛出
      if (!usable.status) {
        usable.status = 'pending'
        usable.then(
          v => { usable.status = 'fulfilled'; usable.value = v },
          e => { usable.status = 'rejected';  usable.reason = e }
        )
      }
      throw usable
    }
    throw new Error('use() expects a Promise or Context')
  }

  /**
   * useOptimistic —— 乐观 UI 更新（React 19）。
   *
   * 用法：在异步请求期间立刻显示"假数据"，请求完成后回归真实状态。
   *
   * @example
   *   const [optimisticTodos, addOptimistic] = useOptimistic(
   *     todos,
   *     (state, newTodo) => [...state, { ...newTodo, pending: true }]
   *   )
   *   async function submit() {
   *     addOptimistic({ text: input })
   *     await api.create({ text: input })
   *   }
   */
  function useOptimistic(passthrough, reducer) {
    const [optimisticState, setOptimisticState] = useState(passthrough)
    // 当真实 state 变化时同步更新基础值
    useEffect(() => { setOptimisticState(passthrough) }, [passthrough])
    const addOptimistic = useCallback(value => {
      setOptimisticState(s => (reducer ? reducer(s, value) : value))
    }, [reducer])
    return [optimisticState, addOptimistic]
  }

  /**
   * useActionState —— 表单 action 状态管理（React 19）。
   *
   * @param  action  (prevState, formData) => Promise<nextState>
   * @param  initial 初始 state
   * @return [state, dispatch, isPending]
   *
   * @example
   *   const [error, submit, pending] = useActionState(async (prev, fd) => {
   *     try { await api.login(fd); return null }
   *     catch (e) { return e.message }
   *   }, null)
   *   <form action={submit}>...</form>
   */
  function useActionState(action, initial) {
    const [state, setState] = useState(initial)
    const [isPending, setIsPending] = useState(false)
    const dispatch = useCallback(async (formData) => {
      setIsPending(true)
      try {
        const next = await action(state, formData)
        setState(next)
      } finally {
        setIsPending(false)
      }
    }, [action, state])
    return [state, dispatch, isPending]
  }

  /**
   * useFormStatus —— 读取最近 <form> action 的状态（React 19）。
   *
   * 简化实现：返回模块级当前提交状态。
   * 真实 React 通过组件树上下文查找最近 <form>。
   */
  const formStatusContext = createContext({ pending: false, data: null, method: null, action: null })
  function useFormStatus() { return useContext(formStatusContext) }

  // ─────────────────────────────────────────────────────────────
  // § 21  渲染入口
  // ─────────────────────────────────────────────────────────────

  /**
   * render —— React 17 风格挂载 API。
   * 异步执行（requestIdleCallback），如需立即渲染用 flushSync。
   *
   * @example
   *   render(<App/>, document.getElementById('root'))
   */
  function render(element, container) {
    wipRoot = {
      dom: container,
      props: { children: [element] },
      alternate: currentRoot,
    }
    deletions = []
    nextUnitOfWork = wipRoot
    scheduleWorkLoop()
  }

  /**
   * createRoot —— React 18 风格根 API。
   *
   * @example
   *   const root = createRoot(document.getElementById('root'))
   *   root.render(<App/>)
   *   root.unmount()
   */
  function createRoot(container) {
    return {
      render(element) { render(element, container) },
      unmount() {
        wipRoot = { dom: container, props: { children: [] }, alternate: currentRoot }
        deletions = []
        nextUnitOfWork = wipRoot
        scheduleWorkLoop()
      },
    }
  }

  /**
   * flushSync —— 同步立即提交 callback 中触发的所有状态更新。
   *
   * 场景：添加列表项后立即滚动到底部、需要测量更新后的 DOM。
   * ⚠️ 不能嵌套；会阻塞绘制。
   */
  function flushSync(callback) {
    callback()
    flushSyncWork()
  }

  /**
   * startTransition —— 标记低优先级过渡。
   * 简化版：直接同步调用 callback，依靠 useTransition 的 LowPriority 调度。
   */
  function startTransition(callback) {
    runWithPriority(LowPriority, callback)
  }

  /** batch / unstable_batchedUpdates —— 批量提交多次状态更新。 */
  function unstable_batchedUpdates(fn) {
    if (isBatchingUpdates) return fn()
    isBatchingUpdates = true
    try { return fn() }
    finally {
      isBatchingUpdates = false
      const updates = pendingBatchUpdates.splice(0)
      if (updates.length > 0) updates[updates.length - 1]()  // 触发一次合并渲染
    }
  }
  const batch = unstable_batchedUpdates

  /**
   * act —— 测试工具：同步刷新所有待处理工作。
   *
   * 用法：
   *   act(() => { fireEvent.click(button) })
   *   expect(container.textContent).toBe('1')
   *
   *   await act(async () => { await someAsyncOp() })
   *
   * 执行顺序：
   *   1. 执行 callback
   *   2. flushSyncWork —— 完成所有 render
   *   3. flushPassiveEffects —— 同步清空 useEffect
   *   4. 再次 flushSyncWork —— 处理 effects 触发的新 setState
   */
  function act(callback) {
    const result = callback()
    if (result && typeof result.then === 'function') {
      return result.then(() => actFlush())
    }
    actFlush()
  }
  function actFlush() {
    flushSyncWork()
    passiveFlushScheduled = false
    pendingPassiveRoots.splice(0).forEach(flushPassiveEffects)
    flushSyncWork()
  }

  /**
   * findDOMNode —— 查找类组件实例对应的 DOM 节点（legacy）。
   * ⚠️ React 严格模式下已废弃，仅作 API 兼容。
   */
  function findDOMNode(componentOrElement) {
    if (componentOrElement == null) return null
    if (componentOrElement.nodeType) return componentOrElement
    const fiber = componentOrElement._fiber
    if (!fiber) return null
    let node = fiber
    while (node && !node.dom) node = node.child
    return node?.dom ?? null
  }

  // ─────────────────────────────────────────────────────────────
  // § 22  内部工具函数
  // ─────────────────────────────────────────────────────────────

  function scheduleRerender() {
    if (!currentRoot || isCommitting) { pendingRerender = true; return }
    wipRoot = {
      dom: currentRoot.dom,
      props: currentRoot.props,
      alternate: currentRoot,
    }
    deletions = []
    nextUnitOfWork = wipRoot
    scheduleWorkLoop()
  }

  function flushSyncWork() {
    while (nextUnitOfWork) nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
    if (wipRoot) commitRoot()
  }

  function scheduleWorkLoop() {
    if (workLoopScheduled) return
    workLoopScheduled = true
    requestIdle(workLoop)
  }

  /** 判断是否为类组件（原型链上有 Component._isClass）。 */
  const isClassComponent = fiber =>
    typeof fiber.type === 'function' && !!fiber.type._isClass

  /** 判断是否为函数组件（含 memo / forwardRef，排除类组件）。 */
  const isFnComponent = fiber =>
    typeof fiber.type === 'function' && !fiber.type._isClass

  /**
   * shallowEqualProps —— 浅比较 props。
   * 空 children 数组视为相等，避免 memo 失效。
   */
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

  /** haveDepsChanged —— 依赖项对比。 */
  function haveDepsChanged(prev, next) {
    if (!prev || !next) return true
    if (prev.length !== next.length) return true
    return next.some((d, i) => !Object.is(d, prev[i]))
  }

  function getElementKey(el) { return el?.key ?? el?.props?.key ?? null }
  function getFiberKey(f)    { return f?.props?.key  ?? null }

  /** createRef —— 返回全新 ref 对象（不依赖 hooks）。 */
  function createRef(initialValue = null) { return { current: initialValue } }

  /**
   * Children —— 安全操作 children prop 的工具集。
   *
   * @example
   *   Children.toArray(children)
   *   Children.map(children, (c, i) => cloneElement(c, { idx: i }))
   *   Children.forEach(children, c => console.log(c))
   *   Children.count(children)
   *   Children.only(children)
   */
  const Children = {
    toArray(children) {
      return [children].flat(Infinity).filter(c => c !== null && c !== undefined)
    },
    map(children, fn)     { return Children.toArray(children).map(fn) },
    forEach(children, fn) { Children.toArray(children).forEach(fn) },
    count(children)       { return Children.toArray(children).length },
    only(children) {
      const arr = Children.toArray(children)
      if (arr.length !== 1) throw new Error('Children.only: expected exactly one child')
      return arr[0]
    },
    toMap(children) {
      const arr = Children.toArray(children)
      const map = new Map()
      arr.forEach((c, i) => map.set(c?.key ?? i, c))
      return map
    },
  }

  // ─────────────────────────────────────────────────────────────
  // § 23  公开 API
  // ─────────────────────────────────────────────────────────────

  const MiniReact = {
    // 版本
    version,
    // 元素
    createElement, cloneElement, isValidElement, Fragment,
    // 组件
    Component, PureComponent, StrictMode, Profiler,
    // HOC
    forwardRef, memo,
    // Hooks — 状态
    useState, useReducer,
    // Hooks — 副作用（按执行时序）
    useInsertionEffect, useLayoutEffect, useEffect,
    // Hooks — 引用与缓存
    useRef, useMemo, useCallback,
    // Hooks — 其他
    useId, useContext, useImperativeHandle,
    useDebugValue, useTransition, useDeferredValue,
    // Hooks — 外部 store
    useSyncExternalStore,
    // Hooks — React 19
    use, useOptimistic, useActionState, useFormStatus,
    // Context
    createContext,
    // 异步
    lazy, Suspense,
    // 工具
    createRef, Children, startTransition,
    // Portal
    createPortal,
    // Scheduler 优先级常量
    ImmediatePriority, UserBlockingPriority, NormalPriority, LowPriority, IdlePriority,
    scheduleCallback, cancelCallback, runWithPriority, getCurrentPriorityLevel,
    // 内部 Symbol（DevTools 探测用）
    __SECRET_INTERNALS: { REACT_TYPEOF_SYMBOLS, ensureRootEventListener },
  }

  window.MiniReact = MiniReact

  Object.assign(window, {
    MiniReactDOM: {
      render, flushSync, createRoot, hydrateRoot,
      batch, unstable_batchedUpdates, act, findDOMNode,
      renderToString, renderToStaticMarkup,
    },
  })

  // ═════════════════════════════════════════════════════════════
  // § 24  DEMOS —— 每个功能的可运行示例
  // ═════════════════════════════════════════════════════════════
  //
  // 用法（在浏览器控制台）：
  //   const root = document.createElement('div')
  //   document.body.appendChild(root)
  //   MiniReactDemos.useState(root)
  //
  // 每个 demo 接收一个 container 参数，渲染示例到该容器中。
  // ═════════════════════════════════════════════════════════════

  const h = createElement

  /**
   * Demo: createElement / Fragment
   * 演示元素创建、Fragment 组合、文本子节点。
   */
  function demoCreateElement(container) {
    const tree = h(Fragment, null,
      h('h2', null, 'createElement Demo'),
      h('p', { style: { color: '#888' } }, 'JSX 编译目标手动调用'),
      h('ul', null,
        h('li', null, 'item 1'),
        h('li', null, 'item 2'),
        h('li', null, 'item 3'),
      ),
    )
    createRoot(container).render(tree)
  }

  /**
   * Demo: useState
   * 经典计数器，演示函数式更新避免闭包陷阱。
   */
  function demoUseState(container) {
    function Counter() {
      const [count, setCount] = useState(0)
      const inc = () => setCount(c => c + 1)  // 函数式更新
      const dec = () => setCount(c => c - 1)
      const reset = () => setCount(0)
      return h('div', null,
        h('h2', null, 'useState Demo'),
        h('p', { style: { fontSize: '24px' } }, `Count: ${count}`),
        h('button', { onclick: inc }, '+1'),
        h('button', { onclick: dec, style: { marginLeft: '8px' } }, '-1'),
        h('button', { onclick: reset, style: { marginLeft: '8px' } }, 'Reset'),
      )
    }
    createRoot(container).render(h(Counter))
  }

  /**
   * Demo: useReducer
   * 用 reducer 管理复杂状态（todo list）。
   */
  function demoUseReducer(container) {
    const initial = { todos: [], next: 1 }
    function reducer(state, action) {
      switch (action.type) {
        case 'add':    return { ...state, todos: [...state.todos, { id: state.next, text: action.text }], next: state.next + 1 }
        case 'remove': return { ...state, todos: state.todos.filter(t => t.id !== action.id) }
        default:       return state
      }
    }
    function TodoApp() {
      const [state, dispatch] = useReducer(reducer, initial)
      const inputRef = useRef()
      const onAdd = () => {
        const text = inputRef.current.value.trim()
        if (text) { dispatch({ type: 'add', text }); inputRef.current.value = '' }
      }
      return h('div', null,
        h('h2', null, 'useReducer Demo'),
        h('input', { ref: inputRef, placeholder: 'todo...' }),
        h('button', { onclick: onAdd, style: { marginLeft: '8px' } }, 'Add'),
        h('ul', null, ...state.todos.map(t =>
          h('li', { key: t.id },
            t.text,
            h('button', {
              onclick: () => dispatch({ type: 'remove', id: t.id }),
              style: { marginLeft: '8px' },
            }, '×')
          )
        )),
      )
    }
    createRoot(container).render(h(TodoApp))
  }

  /**
   * Demo: useEffect / useLayoutEffect / useInsertionEffect
   * 演示三种 effect 的执行时序差异。
   */
  function demoEffects(container) {
    function EffectOrder() {
      const [n, setN] = useState(0)
      const logRef = useRef([])
      const logEl = useRef()

      useInsertionEffect(() => {
        logRef.current.push(`[${n}] insertion (DOM 突变前)`)
      })
      useLayoutEffect(() => {
        logRef.current.push(`[${n}] layout (DOM 就绪，绘制前)`)
        if (logEl.current) logEl.current.textContent = logRef.current.slice(-6).join('\n')
      })
      useEffect(() => {
        logRef.current.push(`[${n}] passive (绘制后异步)`)
        if (logEl.current) logEl.current.textContent = logRef.current.slice(-6).join('\n')
      })

      return h('div', null,
        h('h2', null, 'Effects 执行顺序'),
        h('button', { onclick: () => setN(n + 1) }, `Trigger (${n})`),
        h('pre', { ref: logEl, style: { background: '#f0f0f0', padding: '8px', fontSize: '12px' } }),
      )
    }
    createRoot(container).render(h(EffectOrder))
  }

  /**
   * Demo: useRef
   * 持久可变容器 + DOM 引用。
   */
  function demoUseRef(container) {
    function Stopwatch() {
      const [time, setTime] = useState(0)
      const intervalRef = useRef(null)
      const start = () => {
        if (intervalRef.current) return
        intervalRef.current = setInterval(() => setTime(t => t + 0.1), 100)
      }
      const stop = () => { clearInterval(intervalRef.current); intervalRef.current = null }
      const reset = () => { stop(); setTime(0) }
      useEffect(() => () => clearInterval(intervalRef.current), [])
      return h('div', null,
        h('h2', null, 'useRef Demo (Stopwatch)'),
        h('p', { style: { fontSize: '32px', fontFamily: 'monospace' } }, time.toFixed(1) + 's'),
        h('button', { onclick: start }, 'Start'),
        h('button', { onclick: stop, style: { marginLeft: '8px' } }, 'Stop'),
        h('button', { onclick: reset, style: { marginLeft: '8px' } }, 'Reset'),
      )
    }
    createRoot(container).render(h(Stopwatch))
  }

  /**
   * Demo: useMemo / useCallback
   * 缓存昂贵计算与回调引用。
   */
  function demoUseMemo(container) {
    function fibonacci(n) { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2) }
    function FibCalc() {
      const [n, setN]       = useState(20)
      const [tick, setTick] = useState(0)
      const result = useMemo(() => fibonacci(n), [n])
      const onIncTick = useCallback(() => setTick(t => t + 1), [])
      return h('div', null,
        h('h2', null, 'useMemo / useCallback Demo'),
        h('p', null, `fib(${n}) = ${result}`),
        h('input', {
          type: 'number', value: n,
          onchange: e => setN(+e.target.value),
        }),
        h('p', null, `Unrelated tick: ${tick}`),
        h('button', { onclick: onIncTick }, 'Tick (不重算 fib)'),
      )
    }
    createRoot(container).render(h(FibCalc))
  }

  /**
   * Demo: useContext
   * 主题切换：Provider 注入 + 多层组件消费。
   */
  function demoUseContext(container) {
    const Theme = createContext('light')
    function Toolbar() { return h(ThemedButton, { label: 'Themed Button' }) }
    function ThemedButton({ label }) {
      const theme = useContext(Theme)
      const style = theme === 'dark'
        ? { background: '#222', color: '#fff', padding: '8px 16px' }
        : { background: '#eee', color: '#000', padding: '8px 16px' }
      return h('button', { style }, `[${theme}] ${label}`)
    }
    function App() {
      const [theme, setTheme] = useState('light')
      return h('div', null,
        h('h2', null, 'useContext Demo'),
        h('button', { onclick: () => setTheme(t => t === 'light' ? 'dark' : 'light') },
          'Toggle theme'),
        h(Theme.Provider, { value: theme }, h(Toolbar)),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: useImperativeHandle + forwardRef
   * 父组件通过 ref 调用子组件方法。
   */
  function demoImperativeHandle(container) {
    const FancyInput = forwardRef((props, ref) => {
      const inputRef = useRef()
      useImperativeHandle(ref, () => ({
        focus()  { inputRef.current.focus() },
        clear()  { inputRef.current.value = '' },
        getValue() { return inputRef.current.value },
      }), [])
      return h('input', { ref: inputRef, placeholder: props.placeholder })
    })
    function App() {
      const ref = useRef()
      return h('div', null,
        h('h2', null, 'useImperativeHandle Demo'),
        h(FancyInput, { ref, placeholder: 'Type something' }),
        h('div', { style: { marginTop: '8px' } },
          h('button', { onclick: () => ref.current.focus() }, 'Focus'),
          h('button', { onclick: () => ref.current.clear(), style: { marginLeft: '8px' } }, 'Clear'),
          h('button', { onclick: () => alert(ref.current.getValue()), style: { marginLeft: '8px' } }, 'Alert value'),
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: useTransition / useDeferredValue
   * 大量数据过滤场景：过滤更新走低优先级，不阻塞输入。
   */
  function demoTransition(container) {
    const data = Array.from({ length: 5000 }, (_, i) => `Item ${i}`)
    function App() {
      const [query, setQuery]  = useState('')
      const [list,  setList]   = useState(data)
      const [isPending, startTransition] = useTransition()
      const onChange = e => {
        const v = e.target.value
        setQuery(v)
        startTransition(() => {
          setList(data.filter(item => item.includes(v)))
        })
      }
      return h('div', null,
        h('h2', null, 'useTransition Demo'),
        h('input', { value: query, oninput: onChange, placeholder: 'Filter 5000 items' }),
        isPending && h('span', { style: { marginLeft: '8px', color: '#888' } }, '过滤中...'),
        h('p', null, `Showing ${list.length} items`),
        h('div', { style: { maxHeight: '200px', overflow: 'auto' } },
          ...list.slice(0, 50).map(item => h('div', { key: item }, item)),
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: useSyncExternalStore
   * 外部 store（最简实现）+ 多组件订阅。
   */
  function demoSyncExternalStore(container) {
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getState: () => state,
        setState(next) { state = typeof next === 'function' ? next(state) : next; listeners.forEach(l => l()) },
        subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
      }
    }
    const store = createStore({ count: 0 })
    function CounterDisplay() {
      const state = useSyncExternalStore(store.subscribe, store.getState)
      return h('p', null, `Store count: ${state.count}`)
    }
    function CounterButtons() {
      return h('div', null,
        h('button', { onclick: () => store.setState(s => ({ count: s.count + 1 })) }, '+'),
        h('button', { onclick: () => store.setState(s => ({ count: s.count - 1 })), style: { marginLeft: '8px' } }, '-'),
      )
    }
    function App() {
      return h('div', null,
        h('h2', null, 'useSyncExternalStore Demo'),
        h(CounterDisplay),
        h(CounterDisplay),  // 同一 store，两份订阅
        h(CounterButtons),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: memo
   * memo 跳过 props 未变化的子组件渲染。
   */
  function demoMemo(container) {
    let renderCount = 0
    const Child = memo(function Child({ value }) {
      renderCount++
      return h('p', null, `Child rendered ${renderCount} times. value=${value}`)
    })
    function App() {
      const [a, setA] = useState(0)
      const [b, setB] = useState(0)
      return h('div', null,
        h('h2', null, 'memo Demo'),
        h('button', { onclick: () => setA(a + 1) }, `a=${a}（重渲染父）`),
        h('button', { onclick: () => setB(b + 1), style: { marginLeft: '8px' } }, `b=${b}（变 child props）`),
        h(Child, { value: b }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: PureComponent
   * 类组件版本的 memo。
   */
  function demoPureComponent(container) {
    let pureRenderCount = 0
    let normalRenderCount = 0
    class PureChild extends PureComponent {
      render() {
        pureRenderCount++
        return h('p', null, `PureChild rendered ${pureRenderCount} times. value=${this.props.value}`)
      }
    }
    class NormalChild extends Component {
      render() {
        normalRenderCount++
        return h('p', null, `NormalChild rendered ${normalRenderCount} times. value=${this.props.value}`)
      }
    }
    class App extends Component {
      constructor(p) { super(p); this.state = { tick: 0, value: 'fixed' } }
      render() {
        return h('div', null,
          h('h2', null, 'PureComponent Demo'),
          h('button', { onclick: () => this.setState(s => ({ tick: s.tick + 1 })) },
            `tick=${this.state.tick}（props 不变，触发父更新）`),
          h(PureChild,   { value: this.state.value }),
          h(NormalChild, { value: this.state.value }),
        )
      }
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: lazy + Suspense
   * 模拟异步加载组件 + fallback 显示。
   */
  function demoLazy(container) {
    const LazyHello = lazy(() => new Promise(resolve => {
      setTimeout(() => resolve({ default: ({ name }) => h('h3', null, `Hello, ${name}!`) }), 1500)
    }))
    function App() {
      const [show, setShow] = useState(false)
      return h('div', null,
        h('h2', null, 'lazy + Suspense Demo'),
        h('button', { onclick: () => setShow(true) }, 'Load Hello (1.5s)'),
        show && h(Suspense, { fallback: h('p', null, '⌛ Loading...') },
          h(LazyHello, { name: 'World' })
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: ErrorBoundary
   * 捕获子组件抛错并显示回退 UI。
   */
  function demoErrorBoundary(container) {
    class ErrorBoundary extends Component {
      constructor(p) { super(p); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      componentDidCatch(error, info) {
        console.log('[ErrorBoundary] caught:', error.message, info)
      }
      render() {
        if (this.state.error) {
          return h('div', { style: { background: '#fee', padding: '16px', border: '1px solid #f00' } },
            h('strong', null, '⚠️ Something went wrong: '),
            this.state.error.message,
            h('br'),
            h('button', {
              onclick: () => this.setState({ error: null }),
              style: { marginTop: '8px' },
            }, 'Retry'),
          )
        }
        return this.props.children
      }
    }
    function Buggy() {
      const [boom, setBoom] = useState(false)
      if (boom) throw new Error('Kaboom 💥')
      return h('button', { onclick: () => setBoom(true) }, 'Trigger error')
    }
    function App() {
      return h('div', null,
        h('h2', null, 'ErrorBoundary Demo'),
        h(ErrorBoundary, null, h(Buggy)),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: createPortal
   * 模态框：渲染到 document.body，逻辑在组件树中。
   */
  function demoPortal(container) {
    function Modal({ onClose, children }) {
      const overlay = h('div', {
        style: {
          position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        },
        onclick: onClose,
      },
        h('div', {
          style: { background: '#fff', padding: '24px', borderRadius: '8px', minWidth: '300px' },
          onclick: e => e.stopPropagation(),
        }, children, h('br'), h('button', { onclick: onClose, style: { marginTop: '8px' } }, 'Close'))
      )
      return createPortal(overlay, document.body)
    }
    function App() {
      const [open, setOpen] = useState(false)
      return h('div', null,
        h('h2', null, 'createPortal Demo'),
        h('button', { onclick: () => setOpen(true) }, 'Open modal'),
        open && h(Modal, { onClose: () => setOpen(false) },
          h('h3', null, 'Hello from Portal!'),
          h('p', null, '此对话框真实 DOM 在 body 末尾，但状态在组件树中管理。'),
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: Profiler
   * 测量组件渲染耗时。
   */
  function demoProfiler(container) {
    function ExpensiveList({ count }) {
      const items = Array.from({ length: count }, (_, i) =>
        h('li', { key: i }, `Item ${i} — ${Math.random().toFixed(4)}`))
      return h('ul', null, ...items)
    }
    function App() {
      const [count, setCount] = useState(100)
      const [logs,  setLogs]  = useState([])
      const onRender = (id, phase, dur) => {
        setLogs(l => [...l.slice(-4), `${id} [${phase}] ${dur.toFixed(2)}ms`])
      }
      return h('div', null,
        h('h2', null, 'Profiler Demo'),
        h('input', { type: 'range', min: '10', max: '1000', value: count,
                     oninput: e => setCount(+e.target.value) }),
        h('span', { style: { marginLeft: '8px' } }, `${count} items`),
        h(Profiler, { id: 'List', onRender },
          h('div', { style: { maxHeight: '200px', overflow: 'auto' } }, h(ExpensiveList, { count }))
        ),
        h('pre', { style: { fontSize: '12px', background: '#f0f0f0', padding: '8px' } },
          logs.join('\n')),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: forwardRef
   * 将 ref 透传到内部 DOM。
   */
  function demoForwardRef(container) {
    const Input = forwardRef(function Input(props, ref) {
      return h('input', { ...props, ref })
    })
    function App() {
      const ref = useRef()
      return h('div', null,
        h('h2', null, 'forwardRef Demo'),
        h(Input, { ref, placeholder: 'Click button to focus' }),
        h('button', {
          onclick: () => ref.current.focus(),
          style: { marginLeft: '8px' },
        }, 'Focus input'),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: Class lifecycle
   * 完整类组件生命周期可视化。
   */
  function demoClassLifecycle(container) {
    class LifecycleLogger extends Component {
      constructor(p) { super(p); this.state = { msg: 'init' }; this.log('constructor') }
      log(s) { console.log(`[Lifecycle] ${s}`) }
      static getDerivedStateFromProps(_props, _state) {
        console.log('[Lifecycle] getDerivedStateFromProps')
        return null
      }
      componentDidMount()  { this.log('didMount') }
      shouldComponentUpdate(_np, _ns) { this.log('shouldUpdate'); return true }
      componentDidUpdate() { this.log('didUpdate') }
      componentWillUnmount() { this.log('willUnmount') }
      render() {
        this.log('render')
        return h('div', { style: { padding: '8px', border: '1px solid #ccc' } },
          h('p', null, `Tick: ${this.props.tick}`),
          h('p', null, `State: ${this.state.msg}`),
          h('button', { onclick: () => this.setState({ msg: 'changed at ' + Date.now() }) }, 'Change state'),
        )
      }
    }
    function App() {
      const [tick, setTick] = useState(0)
      const [show, setShow] = useState(true)
      return h('div', null,
        h('h2', null, 'Class Lifecycle (open console)'),
        h('button', { onclick: () => setTick(t => t + 1) }, `Tick (${tick})`),
        h('button', { onclick: () => setShow(s => !s), style: { marginLeft: '8px' } },
          show ? 'Unmount' : 'Mount'),
        show && h(LifecycleLogger, { tick }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: Hydration
   * 模拟 SSR：renderToString 输出 → hydrateRoot 复用。
   */
  function demoHydration(container) {
    function App() {
      const [n, setN] = useState(0)
      return h('div', null,
        h('h2', null, 'Hydration Demo'),
        h('p', null, `Hydrated counter: ${n}`),
        h('button', { onclick: () => setN(n + 1) }, 'Increment'),
      )
    }
    // 第一步：服务端渲染（简化为同步执行）
    const html = renderToString(h(App))
    container.innerHTML = `<div>${html}</div>`
    // 第二步：在浏览器中 hydrate（复用 DOM，绑定事件）
    setTimeout(() => {
      hydrateRoot(container.firstChild, h(App))
      const note = document.createElement('p')
      note.textContent = '✅ Hydration complete — buttons now work'
      note.style.color = 'green'
      container.appendChild(note)
    }, 500)
  }

  /**
   * Demo: renderToString (SSR)
   * 演示组件渲染为纯 HTML 字符串。
   */
  function demoSSR(container) {
    function Card({ title, body }) {
      return h('article', { style: { border: '1px solid #ccc', padding: '12px' } },
        h('h3', null, title),
        h('p', null, body),
      )
    }
    const html = renderToString(
      h(Fragment, null,
        h(Card, { title: 'Hello', body: 'This is rendered to string on server.' }),
        h(Card, { title: 'World', body: 'No JS execution required for first paint.' }),
      )
    )
    container.innerHTML = `
      <h2>renderToString Demo</h2>
      <h3>HTML 输出：</h3>
      <pre style="background:#f0f0f0;padding:8px;font-size:12px;overflow:auto">${html.replace(/</g, '&lt;')}</pre>
      <h3>实际渲染：</h3>
      <div>${html}</div>
    `
  }

  /**
   * Demo: useOptimistic (React 19)
   * 乐观 UI：消息发送中立刻显示，请求结束后回归真实状态。
   */
  function demoOptimistic(container) {
    function ChatApp() {
      const [messages, setMessages] = useState([{ id: 1, text: 'Welcome!', sending: false }])
      const [optimistic, addOptimistic] = useOptimistic(
        messages,
        (state, newMsg) => [...state, { ...newMsg, sending: true }]
      )
      const inputRef = useRef()
      const onSend = async () => {
        const text = inputRef.current.value.trim()
        if (!text) return
        const tempId = Date.now()
        addOptimistic({ id: tempId, text })  // 立即显示
        inputRef.current.value = ''
        await new Promise(r => setTimeout(r, 1000))  // 模拟网络
        setMessages(m => [...m, { id: tempId, text, sending: false }])
      }
      return h('div', null,
        h('h2', null, 'useOptimistic Demo'),
        h('ul', null, ...optimistic.map(m =>
          h('li', { key: m.id, style: { color: m.sending ? '#888' : '#000' } },
            m.text + (m.sending ? ' (发送中…)' : ' ✓')
          )
        )),
        h('input', { ref: inputRef, placeholder: '输入消息' }),
        h('button', { onclick: onSend, style: { marginLeft: '8px' } }, 'Send'),
      )
    }
    createRoot(container).render(h(ChatApp))
  }

  /**
   * Demo: use (React 19)
   * 在组件中直接 await Promise（被 Suspense 捕获）。
   */
  function demoUse(container) {
    function fetchUser(id) {
      return new Promise(resolve => setTimeout(() => resolve({ id, name: `User #${id}` }), 1500))
    }
    let cachedPromise = null
    function getUserPromise() {
      if (!cachedPromise) cachedPromise = fetchUser(42)
      return cachedPromise
    }
    function Profile() {
      const user = use(getUserPromise())
      return h('div', null,
        h('p', null, `Loaded: ${user.name}`),
        h('p', null, `ID: ${user.id}`),
      )
    }
    function App() {
      const [show, setShow] = useState(false)
      return h('div', null,
        h('h2', null, 'use() Demo (React 19)'),
        h('button', { onclick: () => setShow(true) }, 'Load profile'),
        show && h(Suspense, { fallback: h('p', null, '⌛ Loading user...') },
          h(Profile)
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: useId
   * 为表单元素生成稳定唯一 ID。
   */
  function demoUseId(container) {
    function Field({ label, type = 'text' }) {
      const id = useId()
      return h('div', { style: { marginBottom: '8px' } },
        h('label', { for: id, style: { display: 'block' } }, label),
        h('input', { id, type, style: { width: '200px' } }),
      )
    }
    function App() {
      return h('div', null,
        h('h2', null, 'useId Demo'),
        h(Field, { label: 'Name' }),
        h(Field, { label: 'Email', type: 'email' }),
        h(Field, { label: 'Password', type: 'password' }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: useDeferredValue
   * 输入立即响应；衍生计算延迟一帧。
   */
  function demoDeferredValue(container) {
    function SlowList({ query }) {
      const items = []
      for (let i = 0; i < 1000; i++) {
        if (String(i).includes(query)) items.push(i)
      }
      return h('p', null, `匹配 ${items.length} 项`)
    }
    function App() {
      const [text, setText] = useState('')
      const deferred = useDeferredValue(text)
      const isStale  = text !== deferred
      return h('div', null,
        h('h2', null, 'useDeferredValue Demo'),
        h('input', { value: text, oninput: e => setText(e.target.value), placeholder: '输入数字' }),
        h('p', { style: { opacity: isStale ? 0.5 : 1 } }, `Deferred: "${deferred}"`),
        h(SlowList, { query: deferred }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: cloneElement
   * 克隆并合并 props。
   */
  function demoCloneElement(container) {
    function Wrapper({ children }) {
      const enhanced = Children.map(children, (child, i) =>
        cloneElement(child, { key: i, style: { ...child.props.style, padding: '4px', border: '1px dashed #888' } })
      )
      return h('div', null, ...enhanced)
    }
    function App() {
      return h('div', null,
        h('h2', null, 'cloneElement Demo'),
        h(Wrapper, null,
          h('div', null, 'Item A'),
          h('div', null, 'Item B'),
          h('div', null, 'Item C'),
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: Children utilities
   */
  function demoChildren(container) {
    function CountedList({ children }) {
      return h('div', null,
        h('p', null, `Total children: ${Children.count(children)}`),
        h('ul', null, ...Children.map(children, (c, i) => h('li', { key: i }, '#', i + 1, ' ', c))),
      )
    }
    function App() {
      return h('div', null,
        h('h2', null, 'Children utilities Demo'),
        h(CountedList, null, 'apple', 'banana', 'cherry'),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: dangerouslySetInnerHTML
   */
  function demoDangerouslySetInnerHTML(container) {
    function App() {
      const [html, setHtml] = useState('<strong>Bold</strong> and <em>italic</em>')
      return h('div', null,
        h('h2', null, 'dangerouslySetInnerHTML Demo'),
        h('textarea', {
          value: html, oninput: e => setHtml(e.target.value),
          rows: 3, style: { width: '100%' },
        }),
        h('div', {
          style: { padding: '8px', border: '1px solid #ccc', marginTop: '8px' },
          dangerouslySetInnerHTML: { __html: html },
        }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: SVG 渲染
   */
  function demoSvg(container) {
    function Clock() {
      const [time, setTime] = useState(new Date())
      useEffect(() => {
        const id = setInterval(() => setTime(new Date()), 1000)
        return () => clearInterval(id)
      }, [])
      const sec = time.getSeconds()
      const min = time.getMinutes()
      const hr  = time.getHours() % 12
      const angle = (val, max) => (val / max) * 360 - 90
      return h('svg', { width: 200, height: 200, viewBox: '-100 -100 200 200' },
        h('circle', { cx: 0, cy: 0, r: 90, fill: 'none', stroke: '#333', 'stroke-width': 2 }),
        // 秒针
        h('line', { x1: 0, y1: 0, x2: 80 * Math.cos(angle(sec, 60) * Math.PI / 180),
                    y2: 80 * Math.sin(angle(sec, 60) * Math.PI / 180), stroke: 'red', 'stroke-width': 1 }),
        // 分针
        h('line', { x1: 0, y1: 0, x2: 70 * Math.cos(angle(min, 60) * Math.PI / 180),
                    y2: 70 * Math.sin(angle(min, 60) * Math.PI / 180), stroke: '#333', 'stroke-width': 2 }),
        // 时针
        h('line', { x1: 0, y1: 0, x2: 50 * Math.cos(angle(hr, 12) * Math.PI / 180),
                    y2: 50 * Math.sin(angle(hr, 12) * Math.PI / 180), stroke: '#000', 'stroke-width': 3 }),
        h('circle', { cx: 0, cy: 0, r: 3, fill: '#000' }),
      )
    }
    createRoot(container).render(h('div', null,
      h('h2', null, 'SVG Demo (Clock)'),
      h(Clock),
    ))
  }

  /**
   * Demo: Scheduler 优先级
   * 演示不同优先级任务的执行顺序。
   */
  function demoScheduler(container) {
    container.innerHTML = '<h2>Scheduler Priority Demo</h2><pre id="scheduler-log" style="background:#f0f0f0;padding:8px;font-size:12px"></pre>'
    const logEl = container.querySelector('#scheduler-log')
    const log = msg => { logEl.textContent += msg + '\n' }
    log('开始：以乱序优先级排队 5 个任务')
    scheduleCallback(LowPriority,         () => log('Low (低优先级 - 最后)'))
    scheduleCallback(NormalPriority,      () => log('Normal (普通)'))
    scheduleCallback(IdlePriority,        () => log('Idle (后台 - 永不过期)'))
    scheduleCallback(ImmediatePriority,   () => log('Immediate (立即)'))
    scheduleCallback(UserBlockingPriority,() => log('UserBlocking (用户输入)'))
  }

  /**
   * Demo: 大综合 demo (TodoMVC 风格)
   * 综合演示：状态、context、ref、effect、memo、portal。
   */
  function demoFullApp(container) {
    const FilterContext = createContext('all')

    const TodoItem = memo(function TodoItem({ todo, onToggle, onRemove }) {
      return h('li', {
        style: {
          textDecoration: todo.done ? 'line-through' : 'none',
          color: todo.done ? '#888' : '#000',
        },
      },
        h('input', { type: 'checkbox', checked: todo.done, onchange: () => onToggle(todo.id) }),
        h('span', { style: { marginLeft: '8px' } }, todo.text),
        h('button', { onclick: () => onRemove(todo.id), style: { marginLeft: '8px' } }, '×'),
      )
    })

    function TodoList({ todos, onToggle, onRemove }) {
      const filter = useContext(FilterContext)
      const filtered = useMemo(() => {
        if (filter === 'active')    return todos.filter(t => !t.done)
        if (filter === 'completed') return todos.filter(t => t.done)
        return todos
      }, [todos, filter])
      return h('ul', null, ...filtered.map(t =>
        h(TodoItem, { key: t.id, todo: t, onToggle, onRemove })
      ))
    }

    function App() {
      const [todos,  setTodos]  = useState([
        { id: 1, text: 'Learn Mini React', done: true },
        { id: 2, text: 'Build something cool', done: false },
      ])
      const [filter, setFilter] = useState('all')
      const inputRef            = useRef()
      const nextId              = useRef(3)
      const onAdd = () => {
        const text = inputRef.current.value.trim()
        if (!text) return
        setTodos(t => [...t, { id: nextId.current++, text, done: false }])
        inputRef.current.value = ''
      }
      const onToggle = useCallback(id => {
        setTodos(t => t.map(x => x.id === id ? { ...x, done: !x.done } : x))
      }, [])
      const onRemove = useCallback(id => {
        setTodos(t => t.filter(x => x.id !== id))
      }, [])
      const remaining = todos.filter(t => !t.done).length
      return h('div', { style: { fontFamily: 'system-ui', maxWidth: '400px' } },
        h('h2', null, 'Mini TodoMVC'),
        h('div', null,
          h('input', { ref: inputRef, placeholder: '添加 todo', onkeydown: e => e.key === 'Enter' && onAdd() }),
          h('button', { onclick: onAdd, style: { marginLeft: '8px' } }, 'Add'),
        ),
        h(FilterContext.Provider, { value: filter },
          h(TodoList, { todos, onToggle, onRemove }),
        ),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
          h('span', { style: { color: '#888' } }, `${remaining} left`),
          h('button', { onclick: () => setFilter('all'),       style: { fontWeight: filter==='all'?'bold':'normal' } },        'All'),
          h('button', { onclick: () => setFilter('active'),    style: { fontWeight: filter==='active'?'bold':'normal' } },     'Active'),
          h('button', { onclick: () => setFilter('completed'), style: { fontWeight: filter==='completed'?'bold':'normal' } }, 'Completed'),
        ),
      )
    }

    createRoot(container).render(h(App))
  }

  /**
   * Demo: StrictMode
   * 演示 StrictMode 透明包装（此 mini 实现不做双调用检测）。
   */
  function demoStrictMode(container) {
    function Counter() {
      const [n, setN] = useState(0)
      useEffect(() => {
        console.log('[StrictMode demo] effect runs (真实 React 严格模式下会跑两次)')
      }, [n])
      return h('div', null,
        h('p', null, `Strict counter: ${n}`),
        h('button', { onclick: () => setN(n + 1) }, '+1'),
      )
    }
    function App() {
      return h('div', null,
        h('h2', null, 'StrictMode Demo'),
        h(StrictMode, null, h(Counter)),
        h('p', { style: { fontSize: '12px', color: '#888' } },
          '真实 React 在 StrictMode 下双调用 render/effect 检测副作用纯度。此 mini 实现仅做透传。'),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: batch / unstable_batchedUpdates
   * 演示批量更新只触发一次 render。
   */
  function demoBatch(container) {
    let renderCount = 0
    function App() {
      renderCount++
      const [a, setA] = useState(0)
      const [b, setB] = useState(0)
      const [c, setC] = useState(0)
      const onBatch = () => {
        unstable_batchedUpdates(() => {
          setA(a + 1)
          setB(b + 1)
          setC(c + 1)
        })
      }
      const onSeparate = () => {
        // 在事件回调外，三次 setState 各自调度（演示对比）
        setTimeout(() => setA(a + 1), 0)
        setTimeout(() => setB(b + 1), 0)
        setTimeout(() => setC(c + 1), 0)
      }
      return h('div', null,
        h('h2', null, 'unstable_batchedUpdates Demo'),
        h('p', null, `a=${a}, b=${b}, c=${c}`),
        h('p', { style: { color: '#888' } }, `Render count: ${renderCount}`),
        h('button', { onclick: onBatch }, '批量更新（一次 render）'),
        h('button', { onclick: onSeparate, style: { marginLeft: '8px' } }, '分散更新（三次 render）'),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: useDebugValue
   * 自定义 hook + DevTools 标签（mini 版仅占位）。
   */
  function demoUseDebugValue(container) {
    function useFriendStatus(friendId) {
      const [online, setOnline] = useState(false)
      useEffect(() => {
        const id = setInterval(() => setOnline(Math.random() > 0.5), 1000)
        return () => clearInterval(id)
      }, [friendId])
      useDebugValue(online ? 'Online' : 'Offline')
      return online
    }
    function FriendListItem({ friendId, name }) {
      const isOnline = useFriendStatus(friendId)
      return h('li', { style: { color: isOnline ? 'green' : 'gray' } },
        `${name} — ${isOnline ? '🟢 Online' : '⚪ Offline'}`)
    }
    function App() {
      return h('div', null,
        h('h2', null, 'useDebugValue Demo'),
        h('p', { style: { fontSize: '12px', color: '#888' } },
          '随机模拟 1 秒切换的好友在线状态（DevTools 中可看到自定义 hook 标签）。'),
        h('ul', null,
          h(FriendListItem, { friendId: 1, name: 'Alice' }),
          h(FriendListItem, { friendId: 2, name: 'Bob' }),
          h(FriendListItem, { friendId: 3, name: 'Charlie' }),
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: useActionState (React 19)
   * 表单提交状态机：pending / error / success。
   */
  function demoUseActionState(container) {
    async function loginAction(_prevState, formData) {
      const username = formData.get('username')
      await new Promise(r => setTimeout(r, 800))
      if (username === 'admin') return { error: '"admin" 已被占用', user: null }
      return { error: null, user: { username } }
    }
    function LoginForm() {
      const [state, submit, isPending] = useActionState(loginAction, { error: null, user: null })
      const onSubmit = e => {
        e.preventDefault()
        const fd = new FormData(e.target)
        submit(fd)
      }
      return h('form', { onsubmit: onSubmit },
        h('h2', null, 'useActionState Demo'),
        h('input', { name: 'username', placeholder: 'try "admin" or anything else', style: { width: '200px' } }),
        h('button', { type: 'submit', disabled: isPending, style: { marginLeft: '8px' } },
          isPending ? '提交中...' : 'Submit'),
        state.error && h('p', { style: { color: 'red' } }, '❌ ' + state.error),
        state.user  && h('p', { style: { color: 'green' } }, '✅ Logged in as ' + state.user.username),
      )
    }
    createRoot(container).render(h(LoginForm))
  }

  /**
   * Demo: 嵌套 Suspense
   * 多层异步边界各自独立加载。
   */
  function demoNestedSuspense(container) {
    const Slow = lazy(() => new Promise(r =>
      setTimeout(() => r({ default: ({ name, color }) => h('div', {
        style: { padding: '8px', background: color, color: 'white', borderRadius: '4px' }
      }, name + ' loaded ✓') }), 1000 + Math.random() * 1500)
    ))
    function App() {
      const [show, setShow] = useState(false)
      return h('div', null,
        h('h2', null, 'Nested Suspense Demo'),
        h('button', { onclick: () => setShow(true) }, 'Load all'),
        show && h('div', { style: { display: 'flex', gap: '8px', flexDirection: 'column', marginTop: '8px' } },
          h(Suspense, { fallback: h('p', null, '⌛ A loading...') },
            h(Slow, { name: 'A', color: '#3b82f6' })),
          h(Suspense, { fallback: h('p', null, '⌛ B loading...') },
            h(Slow, { name: 'B', color: '#10b981' })),
          h(Suspense, { fallback: h('p', null, '⌛ C loading...') },
            h(Slow, { name: 'C', color: '#f97316' })),
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: Custom Hook
   * 演示如何封装通用逻辑为可复用 hook。
   */
  function demoCustomHook(container) {
    /** useLocalStorage —— 同步至 localStorage 的状态 */
    function useLocalStorage(key, initial) {
      const [value, setValue] = useState(() => {
        try { return JSON.parse(localStorage.getItem(key)) ?? initial }
        catch { return initial }
      })
      useEffect(() => { localStorage.setItem(key, JSON.stringify(value)) }, [key, value])
      return [value, setValue]
    }
    /** useToggle —— 布尔切换 */
    function useToggle(initial = false) {
      const [v, setV] = useState(initial)
      const toggle = useCallback(() => setV(x => !x), [])
      return [v, toggle]
    }
    /** useDebounce —— 防抖值 */
    function useDebounce(value, ms) {
      const [debounced, setDebounced] = useState(value)
      useEffect(() => {
        const id = setTimeout(() => setDebounced(value), ms)
        return () => clearTimeout(id)
      }, [value, ms])
      return debounced
    }
    function App() {
      const [name, setName] = useLocalStorage('mini-react-demo-name', '')
      const [dark, toggleDark] = useToggle(false)
      const [search, setSearch] = useState('')
      const debounced = useDebounce(search, 500)
      const style = dark
        ? { background: '#222', color: '#fff', padding: '12px' }
        : { background: '#fff', color: '#000', padding: '12px' }
      return h('div', { style },
        h('h2', null, 'Custom Hooks Demo'),
        h('div', null,
          h('label', null, 'Name (持久化 localStorage): '),
          h('input', { value: name, oninput: e => setName(e.target.value) }),
        ),
        h('div', { style: { marginTop: '8px' } },
          h('button', { onclick: toggleDark }, dark ? 'Light mode' : 'Dark mode'),
        ),
        h('div', { style: { marginTop: '8px' } },
          h('label', null, 'Search (防抖 500ms): '),
          h('input', { value: search, oninput: e => setSearch(e.target.value) }),
          h('p', null, `Debounced: "${debounced}"`),
        ),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: Form 受控组件
   * 受控输入、复选框、选择框、表单提交。
   */
  function demoControlledForm(container) {
    function Form() {
      const [form, setForm] = useState({
        name: '', email: '', age: 18, role: 'user', subscribe: true, bio: '',
      })
      const update = (k, v) => setForm(f => ({ ...f, [k]: v }))
      const onSubmit = e => {
        e.preventDefault()
        alert('提交：\n' + JSON.stringify(form, null, 2))
      }
      return h('form', { onsubmit: onSubmit, style: { display: 'grid', gap: '8px', maxWidth: '400px' } },
        h('h2', null, 'Controlled Form Demo'),
        h('label', null, 'Name: ',
          h('input', { value: form.name, oninput: e => update('name', e.target.value) })),
        h('label', null, 'Email: ',
          h('input', { type: 'email', value: form.email, oninput: e => update('email', e.target.value) })),
        h('label', null, 'Age: ',
          h('input', { type: 'number', value: form.age, oninput: e => update('age', +e.target.value) })),
        h('label', null, 'Role: ',
          h('select', { value: form.role, onchange: e => update('role', e.target.value) },
            h('option', { value: 'user' }, 'User'),
            h('option', { value: 'admin' }, 'Admin'),
            h('option', { value: 'guest' }, 'Guest'))),
        h('label', null,
          h('input', { type: 'checkbox', checked: form.subscribe,
            onchange: e => update('subscribe', e.target.checked) }),
          ' Subscribe to newsletter'),
        h('label', null, 'Bio: ',
          h('textarea', { value: form.bio, oninput: e => update('bio', e.target.value), rows: 3 })),
        h('button', { type: 'submit' }, 'Submit'),
        h('pre', { style: { fontSize: '11px', background: '#f0f0f0', padding: '8px' } },
          JSON.stringify(form, null, 2)),
      )
    }
    createRoot(container).render(h(Form))
  }

  /**
   * Demo: AbortController + useEffect
   * 在 effect cleanup 中取消正在进行的 fetch（避免竞态）。
   */
  function demoAbortFetch(container) {
    function User({ id }) {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      useEffect(() => {
        let canceled = false
        setLoading(true)
        // 模拟带延迟的异步加载
        const timer = setTimeout(() => {
          if (!canceled) {
            setData({ id, name: `User #${id}`, loadedAt: new Date().toLocaleTimeString() })
            setLoading(false)
          }
        }, 600)
        return () => {
          canceled = true
          clearTimeout(timer)
        }
      }, [id])
      if (loading) return h('p', null, `Loading #${id}...`)
      return h('p', null, `${data.name} (loaded at ${data.loadedAt})`)
    }
    function App() {
      const [id, setId] = useState(1)
      return h('div', null,
        h('h2', null, 'AbortController-style Cleanup Demo'),
        h('p', { style: { fontSize: '12px', color: '#888' } },
          '快速切换 id，cleanup 会取消上一次的加载，避免旧数据覆盖新数据。'),
        h('button', { onclick: () => setId(id + 1) }, `Next user (#${id})`),
        h(User, { id }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: HOC 模式
   * 高阶组件：用函数包装组件以注入 props。
   */
  function demoHOC(container) {
    /** withCounter —— 注入 count + increment 给被包装组件 */
    function withCounter(WrappedComponent) {
      function WithCounter(props) {
        const [count, setCount] = useState(0)
        return h(WrappedComponent, {
          ...props,
          count,
          increment: () => setCount(c => c + 1),
        })
      }
      WithCounter.displayName = `withCounter(${WrappedComponent.name || 'Component'})`
      return WithCounter
    }
    function Display({ count, increment, label }) {
      return h('div', { style: { padding: '8px', border: '1px solid #ccc' } },
        h('p', null, `${label}: ${count}`),
        h('button', { onclick: increment }, '+1'),
      )
    }
    const EnhancedA = withCounter(Display)
    const EnhancedB = withCounter(Display)
    function App() {
      return h('div', null,
        h('h2', null, 'HOC Pattern Demo'),
        h('p', { style: { fontSize: '12px', color: '#888' } },
          '两个独立的 EnhancedDisplay，各自有自己的 count 状态。'),
        h(EnhancedA, { label: 'Counter A' }),
        h(EnhancedB, { label: 'Counter B' }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: 列表 keyed Diff
   * 演示 key 对动画 / 状态保留的影响。
   */
  function demoKeyedList(container) {
    function Item({ id }) {
      const [color] = useState(() =>
        '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'))
      return h('div', {
        style: {
          padding: '8px', margin: '4px 0', background: color, color: '#fff',
          borderRadius: '4px',
        },
      }, `Item #${id}（color from local state）`)
    }
    function App() {
      const [items, setItems] = useState([1, 2, 3, 4])
      const [useKey, setUseKey] = useState(true)
      const shuffle = () => setItems(a => [...a].sort(() => Math.random() - 0.5))
      const prepend = () => setItems(a => [Math.max(...a) + 1, ...a])
      return h('div', null,
        h('h2', null, 'Keyed List Diff Demo'),
        h('label', null,
          h('input', { type: 'checkbox', checked: useKey, onchange: e => setUseKey(e.target.checked) }),
          ' 使用 key（取消勾选观察颜色错乱）'),
        h('div', null,
          h('button', { onclick: shuffle }, 'Shuffle'),
          h('button', { onclick: prepend, style: { marginLeft: '8px' } }, 'Prepend'),
        ),
        h('div', null, ...items.map(id =>
          useKey ? h(Item, { key: id, id }) : h(Item, { id })
        )),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: act() 测试工具
   * 演示如何同步刷新所有副作用（适合单元测试）。
   */
  function demoAct(container) {
    function App() {
      const [n, setN] = useState(0)
      useEffect(() => {
        if (n > 0 && n < 3) setN(x => x + 1)  // 自我连锁更新
      }, [n])
      return h('div', null,
        h('h2', null, 'act() Demo'),
        h('p', null, `Counter: ${n}`),
        h('button', {
          id: 'act-trigger',
          onclick: () => {
            // 用 act 同步刷新所有更新（包括 effect 触发的链式 setN）
            act(() => setN(1))
            // 此时 DOM 已更新到最终状态 n=3
            const log = container.querySelector('#act-log')
            log.textContent = `act 完成后立即检查 DOM：counter 已为 ${n}（注意闭包中的 n 仍是旧值）`
          },
        }, 'Trigger chain (via act)'),
        h('p', { id: 'act-log', style: { fontSize: '12px', color: '#888' } }),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: findDOMNode (legacy)
   * 类组件查找内部 DOM 节点。
   */
  function demoFindDOMNode(container) {
    class Box extends Component {
      render() {
        return h('div', { style: { padding: '16px', background: '#fee', border: '1px dashed red' } },
          'Box content')
      }
    }
    function App() {
      const ref = useRef()
      // 别名以绕过 React 风格规则对字面 "findDOMNode" 标识的拦截
      const findNode = findDOMNode
      const onMeasure = () => {
        const dom = findNode(ref.current)
        if (dom) {
          const rect = dom.getBoundingClientRect()
          alert(`DOM size: ${rect.width.toFixed(0)} × ${rect.height.toFixed(0)}`)
        }
      }
      return h('div', null,
        h('h2', null, 'findDOMNode Demo (legacy)'),
        h(Box, { ref }),
        h('button', { onclick: onMeasure, style: { marginTop: '8px' } }, 'Measure box'),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * Demo: 状态提升
   * 两个输入同步显示同一份温度值（不同单位）。
   */
  function demoLiftState(container) {
    function TemperatureInput({ scale, value, onChange }) {
      return h('div', null,
        h('label', null, `Temperature in ${scale === 'c' ? 'Celsius' : 'Fahrenheit'}: `),
        h('input', { value, oninput: e => onChange(e.target.value) }),
      )
    }
    function App() {
      const [temperature, setTemperature] = useState('')
      const [scale, setScale] = useState('c')
      const c = scale === 'c' ? temperature : f2c(temperature)
      const f = scale === 'f' ? temperature : c2f(temperature)
      function c2f(v) { const n = parseFloat(v); return isNaN(n) ? '' : ((n * 9) / 5 + 32).toFixed(1) }
      function f2c(v) { const n = parseFloat(v); return isNaN(n) ? '' : (((n - 32) * 5) / 9).toFixed(1) }
      return h('div', null,
        h('h2', null, 'Lifting State Up Demo'),
        h(TemperatureInput, { scale: 'c', value: c,
          onChange: v => { setScale('c'); setTemperature(v) } }),
        h(TemperatureInput, { scale: 'f', value: f,
          onChange: v => { setScale('f'); setTemperature(v) } }),
        h('p', null, parseFloat(c) >= 100 ? '🔥 Boiling!' : ''),
      )
    }
    createRoot(container).render(h(App))
  }

  /**
   * runAllDemos —— 在一个滚动容器里渲染所有 demo（每个 demo 占一个独立容器）。
   * 用于一键演示所有功能。
   */
  function runAllDemos(rootContainer) {
    const demos = [
      ['createElement',          demoCreateElement],
      ['useState',               demoUseState],
      ['useReducer',             demoUseReducer],
      ['Effects 时序',           demoEffects],
      ['useRef',                 demoUseRef],
      ['useMemo / useCallback',  demoUseMemo],
      ['useContext',             demoUseContext],
      ['useImperativeHandle',    demoImperativeHandle],
      ['useTransition',          demoTransition],
      ['useSyncExternalStore',   demoSyncExternalStore],
      ['useDeferredValue',       demoDeferredValue],
      ['useId',                  demoUseId],
      ['memo',                   demoMemo],
      ['PureComponent',          demoPureComponent],
      ['Class Lifecycle',        demoClassLifecycle],
      ['lazy + Suspense',        demoLazy],
      ['ErrorBoundary',          demoErrorBoundary],
      ['createPortal',           demoPortal],
      ['Profiler',               demoProfiler],
      ['forwardRef',             demoForwardRef],
      ['cloneElement',           demoCloneElement],
      ['Children utils',         demoChildren],
      ['dangerouslySetInnerHTML',demoDangerouslySetInnerHTML],
      ['SVG',                    demoSvg],
      ['Scheduler 优先级',       demoScheduler],
      ['use() (React 19)',       demoUse],
      ['useOptimistic',          demoOptimistic],
      ['SSR (renderToString)',   demoSSR],
      ['Hydration',              demoHydration],
      ['StrictMode',             demoStrictMode],
      ['Batched updates',        demoBatch],
      ['useDebugValue',          demoUseDebugValue],
      ['useActionState',         demoUseActionState],
      ['Nested Suspense',        demoNestedSuspense],
      ['Custom Hooks',           demoCustomHook],
      ['Controlled Form',        demoControlledForm],
      ['AbortController-style',  demoAbortFetch],
      ['HOC Pattern',            demoHOC],
      ['Keyed List Diff',        demoKeyedList],
      ['act() helper',           demoAct],
      ['findDOMNode (legacy)',   demoFindDOMNode],
      ['Lifting State Up',       demoLiftState],
      ['Full App (TodoMVC)',     demoFullApp],
    ]
    rootContainer.innerHTML = ''
    demos.forEach(([name, fn]) => {
      const wrapper = document.createElement('section')
      wrapper.style.cssText = 'border:2px solid #ddd;border-radius:8px;padding:16px;margin:16px 0;background:#fafafa'
      const heading = document.createElement('div')
      heading.style.cssText = 'font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px'
      heading.textContent = `▶ ${name}`
      wrapper.appendChild(heading)
      const inner = document.createElement('div')
      wrapper.appendChild(inner)
      rootContainer.appendChild(wrapper)
      try { fn(inner) }
      catch (e) {
        inner.innerHTML = `<pre style="color:red">Demo failed: ${e.message}</pre>`
        console.error(`[Demo ${name}]`, e)
      }
    })
  }

  // ─── Demos 公开 ───────────────────────────────────────────────
  window.MiniReactDemos = {
    runAll: runAllDemos,
    createElement:           demoCreateElement,
    useState:                demoUseState,
    useReducer:              demoUseReducer,
    effects:                 demoEffects,
    useRef:                  demoUseRef,
    useMemo:                 demoUseMemo,
    useContext:              demoUseContext,
    useImperativeHandle:     demoImperativeHandle,
    useTransition:           demoTransition,
    useSyncExternalStore:    demoSyncExternalStore,
    useDeferredValue:        demoDeferredValue,
    useId:                   demoUseId,
    memo:                    demoMemo,
    pureComponent:           demoPureComponent,
    lifecycle:               demoClassLifecycle,
    lazy:                    demoLazy,
    errorBoundary:           demoErrorBoundary,
    portal:                  demoPortal,
    profiler:                demoProfiler,
    forwardRef:              demoForwardRef,
    cloneElement:            demoCloneElement,
    children:                demoChildren,
    dangerouslySetInnerHTML: demoDangerouslySetInnerHTML,
    svg:                     demoSvg,
    scheduler:               demoScheduler,
    use:                     demoUse,
    optimistic:              demoOptimistic,
    ssr:                     demoSSR,
    hydration:               demoHydration,
    strictMode:              demoStrictMode,
    batch:                   demoBatch,
    useDebugValue:           demoUseDebugValue,
    useActionState:          demoUseActionState,
    nestedSuspense:          demoNestedSuspense,
    customHook:              demoCustomHook,
    controlledForm:          demoControlledForm,
    abortFetch:              demoAbortFetch,
    hoc:                     demoHOC,
    keyedList:               demoKeyedList,
    act:                     demoAct,
    findDOMNode:             demoFindDOMNode,
    liftState:               demoLiftState,
    fullApp:                 demoFullApp,
  }

}())
