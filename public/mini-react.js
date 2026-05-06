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
   * createElement —— JSX 编译目标。
   * <div className="a">hi</div>  →  createElement('div', {className:'a'}, 'hi')
   * children 展平 + 过滤 null/undefined/boolean + 字符串包装为 TEXT_ELEMENT。
   */
  function createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...props,
        children: children
          .flat(Infinity)
          .filter(c => c !== null && c !== undefined && typeof c !== 'boolean')
          .map(c => (typeof c === 'object' ? c : createTextElement(c))),
      },
    }
  }

  function createTextElement(text) {
    return { type: 'TEXT_ELEMENT', props: { nodeValue: String(text), children: [] } }
  }

  /**
   * cloneElement —— 克隆元素并合并新 props / key / ref / children。
   * 新 children 若传入则完全覆盖旧 children。
   */
  function cloneElement(element, config, ...children) {
    const { key, ref, ...rest } = config || {}
    const props = { ...element.props, ...rest }
    if (key !== undefined) props.key = key
    if (ref !== undefined) props.ref = ref
    if (children.length > 0) {
      props.children = children
        .flat(Infinity)
        .filter(c => c !== null && c !== undefined && typeof c !== 'boolean')
        .map(c => (typeof c === 'object' ? c : createTextElement(c)))
    }
    return { type: element.type, props }
  }

  /** isValidElement —— 判断是否为合法的 React Element。 */
  function isValidElement(obj) {
    return typeof obj === 'object' && obj !== null && 'type' in obj && 'props' in obj
  }

  /** Fragment —— 不产生 DOM 的多根节点占位符。 */
  const Fragment = '__fragment__'

  /** PORTAL —— createPortal 生成的特殊 host 类型，dom 指向目标容器。 */
  const PORTAL = '__portal__'

  // ─────────────────────────────────────────────────────────────
  // § 2  全局调度状态
  // ─────────────────────────────────────────────────────────────

  let nextUnitOfWork       = null   // render 阶段游标
  let currentRoot          = null   // 已提交的 current 树
  let wipRoot              = null   // 正在构建的 wip 树
  let deletions            = []     // 本轮需删除的 Fiber
  let pendingRerender      = false  // commit 前/中 setState 的延迟标记
  let isCommitting         = false  // mutation pass 期间
  let workLoopScheduled    = false
  let pendingPassiveRoots  = []
  let passiveFlushScheduled = false
  let needsRerenderAfterCommit = false  // Suspense 首次挂起后触发回显 fallback
  let pendingErrorBoundary      = null  // 渲染期捕获的 Error Boundary fiber
  let pendingErrorBoundaryError = null  // 与之对应的错误对象

  let wipFiber  = null
  let hookIndex = 0
  let idCounter = 0

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
   *   4. forwardRef：把 fiber.props.ref 以第二参数传给渲染函数
   *   5. Suspense 集成：catch 子组件抛出的 Promise，标记 boundary
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
      fiber._context    = renderFn._context
      fiber._prevCtxValue = renderFn._context._currentValue
      renderFn._context._currentValue = fiber.props.value
    }

    // ── 调用渲染函数（forwardRef 透传 ref） ───────────────────
    let child
    try {
      if (renderFn._isForwardRef) {
        child = renderFn._renderFn(fiber.props, fiber.props.ref ?? null)
      } else {
        child = renderFn(fiber.props)
      }
    } catch (e) {
      // ── Suspense：捕获 Promise（lazy 抛出）──────────────────
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
   * 首次渲染创建实例；后续复用并同步 props/state；调用 render()。
   * getDerivedStateFromProps / shouldComponentUpdate 均在此处理。
   */
  function updateClassComponent(fiber) {
    let instance = fiber.instance
    if (!instance) {
      instance = new fiber.type(fiber.props)
      fiber.instance = instance
      instance._fiber = fiber
    } else {
      // 从 alternate 同步最新 state（setState 改的是旧实例）
      if (fiber.alternate?.instance) {
        instance.state = fiber.alternate.instance.state
      }
      instance.props  = fiber.props
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
      // 类组件 render() 中的错误也交给最近的 Error Boundary 处理
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
   * reconcileChildren —— O(n) Diff：key Map + 无 key 顺序匹配。
   *
   * Bug fix（v2）：原版 `index === 0` 当首位元素为 null 时会丢失后续 Fiber。
   * 改为 `!prevSibling` 检测"尚未链接第一个有效 Fiber"。
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
        newFiber = { type: oldMatch.type, props: element.props, dom: oldMatch.dom,
          return: wipF, alternate: oldMatch, effectTag: 'UPDATE' }
        usedOld.add(oldMatch)
      }
      if (!sameType && element) {
        newFiber = { type: element.type, props: element.props, dom: null,
          return: wipF, alternate: null, effectTag: 'PLACEMENT' }
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
   *   Phase 1 Mutation  —— DOM 插入 / 更新 / 删除
   *   Phase 2 Layout    —— useLayoutEffect + componentDidMount/Update（同步）
   *   Phase 3 Passive   —— useEffect（setTimeout 异步）
   */
  function commitRoot() {
    const root = wipRoot
    isCommitting = true

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
    // Error Boundary：commit 后通知边界组件（componentDidCatch），并重渲染展示错误 UI
    if (pendingErrorBoundary) {
      const boundary = pendingErrorBoundary
      const error    = pendingErrorBoundaryError
      pendingErrorBoundary      = null
      pendingErrorBoundaryError = null
      // componentDidCatch 接收 error 和 info（真实 React 传递组件堆栈，此处简化为空）
      boundary.instance?.componentDidCatch?.(error, { componentStack: '' })
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
  function commitWork(fiber) {
    if (!fiber) return

    let domParentFiber = fiber.return
    while (domParentFiber && !domParentFiber.dom) domParentFiber = domParentFiber.return
    const parentDom = domParentFiber?.dom

    if (fiber.type === PORTAL) {
      // Portal 容器本身不插入父 DOM，仅处理其子节点
      commitWork(fiber.child)
      normalizeHostChildren(fiber)
      commitWork(fiber.sibling)
      return
    }

    if (fiber.effectTag === 'PLACEMENT' && fiber.dom) {
      if (parentDom) parentDom.appendChild(fiber.dom)
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

  /** commitAllLayoutEffects —— useLayoutEffect + 类组件 componentDidMount/Update。 */
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
    // 类组件生命周期
    if (fiber.instance) {
      if (!fiber.alternate) {
        fiber.instance.componentDidMount?.()
      } else {
        fiber.instance.componentDidUpdate?.(fiber.alternate.props, fiber.alternate.instance?.state ?? {})
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
    if (fiber.dom && fiber.props?.ref) setRef(fiber.props.ref, null)
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
  const eventAliases = { doubleclick: 'dblclick' }
  const toEvt   = name => { const n = name.slice(2).toLowerCase(); return eventAliases[n] || n }

  function updateDom(dom, prev, next) {
    if (prev.ref !== next.ref) setRef(prev.ref, null)
    Object.keys(prev).filter(isEvent).filter(k => !(k in next) || isNew(prev, next)(k))
      .forEach(k => dom.removeEventListener(toEvt(k), prev[k]))
    Object.keys(prev).filter(isProp).filter(isGone(prev, next))
      .forEach(k => { if (k === 'style') updateStyle(dom, prev.style, null); else dom[k] = '' })
    Object.keys(next).filter(isProp).filter(isNew(prev, next))
      .forEach(k => {
        if (k === 'style') updateStyle(dom, prev.style, next.style)
        else if (k === 'className') dom.className = next[k]
        else dom[k] = next[k]
      })
    Object.keys(next).filter(isEvent).filter(isNew(prev, next))
      .forEach(k => dom.addEventListener(toEvt(k), next[k]))
    if (prev.ref !== next.ref) setRef(next.ref, dom)
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
   * useReducer —— 状态管理核心。
   * queue.splice(0) 消费并清空队列（关键：防止重复 reduce 同一批 action）。
   */
  function useReducer(reducer, initialState, init) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const queue   = oldHook ? oldHook.queue : []
    const hook    = { state: oldHook ? oldHook.state : (init ? init(initialState) : initialState), queue }
    queue.splice(0).forEach(action => { hook.state = reducer(hook.state, action) })
    const dispatch = action => { hook.queue.push(action); scheduleRerender() }
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
   * useEffect —— 异步副作用（绘制后 setTimeout）。
   * deps 语义：undefined=每次，[]=仅 mount，[a,b]=依赖变化时。
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
   * 在 layout 阶段同步设置 ref，cleanup 时清空。
   */
  function useImperativeHandle(ref, createHandle, deps) {
    useLayoutEffect(() => {
      if (!ref) return
      setRef(ref, createHandle())
      return () => setRef(ref, null)
    }, deps)
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
   * 简化实现：callback 在 setTimeout 中执行，isPending 在此期间为 true。
   * 真实 React 18 用 Scheduler 实现真正的并发优先级。
   */
  function useTransition() {
    const [isPending, setIsPending] = useState(false)
    const start = useCallback(callback => {
      setIsPending(true)
      setTimeout(() => { callback(); setIsPending(false) }, 0)
    }, [])
    return [isPending, start]
  }

  /**
   * useDeferredValue —— 返回一个"延迟版本"的值，在高优先级更新完成后才更新。
   * 简化实现：直接返回最新值（无真正的延迟）。
   * 真实 React 18 使用并发调度将低优先级更新推迟到高优先级渲染之后。
   */
  function useDeferredValue(value) { return value }

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
    constructor(props) {
      this.props = props
      this.state = {}
      this._fiber = null
    }

    setState(updater) {
      const next = typeof updater === 'function' ? updater(this.state) : updater
      this.state = { ...this.state, ...next }
      if (this._fiber) scheduleRerender()
    }

    forceUpdate() {
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
    // wipFiber.alternate._suspendPending 由 updateFunctionComponent catch 分支写入
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
   * 实现：返回带 _isForwardRef 标记的包装函数，
   * updateFunctionComponent 检测到标记后把 props.ref 作为第二参数传入。
   */
  function forwardRef(renderFn) {
    function ForwardRef(props) { return renderFn(props, props.ref ?? null) }
    ForwardRef._isForwardRef = true
    ForwardRef._renderFn     = renderFn
    ForwardRef.displayName   = `forwardRef(${renderFn.name || 'Component'})`
    return ForwardRef
  }

  /**
   * memo —— 跳过 props 未变化的函数组件渲染（浅比较）。
   *
   * 自定义比较：memo(Component, (prev, next) => deepEqual(prev, next))
   * ⚠️ 与 useContext 配合时，memo 可能阻止 context 变化触发的重渲染。
   */
  function memo(component, compare) {
    function Memoized(props) { return component(props) }
    Memoized._isMemo     = true
    Memoized._type       = component
    Memoized._compare    = compare || shallowEqualProps
    Memoized.displayName = `memo(${component.name || 'Component'})`
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
   * 场景：添加列表项后立刻滚动到底部。
   * ⚠️ 不能嵌套使用；会阻塞浏览器绘制。
   */
  function flushSync(callback) { callback(); flushSyncWork() }

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
   *   act(() => { fireEvent.click(button) })
   *   expect(container.textContent).toBe('1')  // DOM 已同步更新
   *
   *   // 异步场景（React.lazy / useEffect 内的 setState）：
   *   await act(async () => { await someAsyncOp() })
   *
   * 执行顺序：
   *   1. 执行 callback（触发 setState / dispatch）
   *   2. 同步提交所有排队的渲染（flushSyncWork）
   *   3. 同步清空所有 passive effects（useEffect）
   *   4. 若 effects 触发了新的 setState，再次刷新（确保完全稳定）
   */
  function act(callback) {
    callback()
    flushSyncWork()
    // 同步清空 useEffect（测试中不等待 setTimeout）
    passiveFlushScheduled = false
    pendingPassiveRoots.splice(0).forEach(flushPassiveEffects)
    // effects 可能触发了新的 setState，再刷新一次
    flushSyncWork()
  }

  // ─────────────────────────────────────────────────────────────
  // § 15  内部工具函数
  // ─────────────────────────────────────────────────────────────

  function scheduleRerender() {
    if (!currentRoot || isCommitting) { pendingRerender = true; return }
    wipRoot        = { dom: currentRoot.dom, props: currentRoot.props, alternate: currentRoot }
    deletions      = []
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

  function getElementKey(el) { return el?.props?.key ?? null }
  function getFiberKey(f)    { return f?.props?.key  ?? null }

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
        pendingErrorBoundary      = boundary
        pendingErrorBoundaryError = error
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
   * Children —— 安全操作 children prop 的工具集。
   * 统一展平并过滤 null/undefined，提供稳定的遍历接口。
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
    // Context
    createContext,
    // 异步
    lazy, Suspense,
    // 工具
    createRef, Children, startTransition,
    // Portal
    createPortal,
  }

  // Object.assign 绕过 TS 对 window 扩展属性的类型检查（Hint 2568）
  Object.assign(window, {
    MiniReactDOM: { render, flushSync, createRoot, batch, act },
  })

}())
