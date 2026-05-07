/**
 * Mini React - 约 500 行代码实现 React 核心
 *
 * 架构与真实 React 保持一致：
 *   1. createElement   —— 创建虚拟 DOM（React Element）
 *   2. Fiber           —— 工作单元数据结构（链表树 + 双缓冲）
 *   3. WorkLoop        —— 可中断的工作循环（requestIdleCallback）
 *   4. Reconciler      —— Diff 算法（O(n) key 匹配 + O(1) 无 key 顺序匹配）
 *   5. Commit          —— 三阶段提交：mutation → layout → passive
 *   6. Hooks           —— useState / useReducer / useEffect / useLayoutEffect
 *                         useRef / useMemo / useCallback / useContext / useId
 *   7. Context         —— createContext / Provider / Consumer / useContext
 *   8. memo            —— 跳过 props 未变化的函数组件渲染
 *   9. 工具            —— Fragment / createRef / Children / flushSync
 */
;(function () {
  'use strict'

  // ─────────────────────────────────────────────────────────────
  // § 1  REACT ELEMENT（虚拟 DOM）
  // ─────────────────────────────────────────────────────────────

  /**
   * createElement 是 JSX 的编译目标。
   *   <div className="box">hello</div>
   * 会被 Babel 编译成：
   *   createElement('div', { className: 'box' }, 'hello')
   *
   * 返回一个普通对象 —— React Element：
   *   { type, props: { ...attrs, children } }
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
   * Fragment：让函数组件可以返回多个根节点，自身不产生任何 DOM。
   *   h(Fragment, null, h('span', null, 'a'), h('span', null, 'b'))
   */
  const Fragment = '__fragment__'

  // ─────────────────────────────────────────────────────────────
  // § 2  FIBER 数据结构
  // ─────────────────────────────────────────────────────────────
  /**
   * Fiber 是 React 内部的工作单元，每个 Element 对应一个 Fiber。
   *
   * 树结构（链表，可中断遍历）：
   *   fiber.child    —— 第一个子节点
   *   fiber.sibling  —— 下一个兄弟节点
   *   fiber.return   —— 父节点
   *
   * 双缓冲：
   *   fiber.alternate —— 上一次渲染的对应 Fiber
   *                      current 树（已提交）↔ wip 树（正在构建）
   *
   * 副作用标记：
   *   fiber.effectTag —— 'PLACEMENT' | 'UPDATE' | 'DELETION'
   *
   * 函数组件专属：
   *   fiber.hooks          —— hooks 数组（按调用顺序）
   *   fiber.memoizedElement —— 组件函数上次返回的 Element（memo 复用）
   */

  // ─────────────────────────────────────────────────────────────
  // § 3  全局调度状态
  // ─────────────────────────────────────────────────────────────

  let nextUnitOfWork  = null   // 下一个待处理的 Fiber
  let currentRoot     = null   // 已提交到 DOM 的根 Fiber（current 树）
  let wipRoot         = null   // 正在构建的根 Fiber（work-in-progress 树）
  let deletions       = []     // 本轮需要删除的 Fiber 列表
  let pendingRerender = false  // commit 前调用 setState 时的延迟标记
  let isCommitting    = false  // commit 阶段内触发的更新需延后

  let wipFiber  = null  // 当前正在渲染的函数组件 Fiber（hooks 上下文）
  let hookIndex = 0     // 当前 hook 的下标（保证 hooks 按调用顺序一一对应）

  let idCounter = 0     // useId 单调计数器

  const requestIdle = window.requestIdleCallback ||
    (cb => setTimeout(() => cb({ timeRemaining: () => 50 }), 1))

  // ─────────────────────────────────────────────────────────────
  // § 4  WORK LOOP（工作循环）
  // ─────────────────────────────────────────────────────────────

  /**
   * 浏览器空闲时逐个处理 Fiber（render 阶段，可中断）。
   * 所有 Fiber 处理完后，进入不可中断的 commit 阶段。
   *
   * 真实 React 用 MessageChannel + Scheduler 做时间切片，
   * 这里用 requestIdleCallback 简化：剩余时间 < 1ms 则暂停。
   */
  function workLoop(deadline) {
    let shouldYield = false

    while (nextUnitOfWork && !shouldYield) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
      shouldYield = deadline.timeRemaining() < 1
    }

    if (!nextUnitOfWork && wipRoot) commitRoot()

    requestIdle(workLoop)
  }

  requestIdle(workLoop)

  // ─────────────────────────────────────────────────────────────
  // § 5  PERFORM UNIT OF WORK（处理单个 Fiber）
  // ─────────────────────────────────────────────────────────────

  /**
   * 深度优先遍历顺序：child → sibling → uncle（父节点的 sibling）
   */
  function performUnitOfWork(fiber) {
    if (isFunctionComponent(fiber)) updateFunctionComponent(fiber)
    else updateHostComponent(fiber)

    if (fiber.child) return fiber.child

    let next = fiber
    while (next) {
      if (next.sibling) return next.sibling
      next = next.return
    }
    return null
  }

  /**
   * 处理函数组件：
   *   1. 设置 hooks 执行上下文（wipFiber / hookIndex）
   *   2. memo 命中时跳过函数调用，复用上次结果
   *   3. 调用组件函数，拿到子 Element，协调子树
   */
  function updateFunctionComponent(fiber) {
    wipFiber  = fiber
    hookIndex = 0
    wipFiber.hooks = []

    const component = fiber.type
    const isMemo    = !!component._isMemo

    // memo bailout：props 未变化且无排队 state 更新 → 复用上次渲染结果
    if (isMemo && fiber.alternate) {
      const hasPendingState = fiber.alternate.hooks?.some(h => h.queue?.length > 0)
      if (!hasPendingState && component._compare(fiber.alternate.props, fiber.props)) {
        wipFiber.hooks = fiber.alternate.hooks || []
        const cached = fiber.alternate.memoizedElement
        fiber.memoizedElement = cached
        reconcileChildren(fiber, Array.isArray(cached) ? cached : [cached])
        return
      }
    }

    const renderFn = isMemo ? component._type : component
    const child    = renderFn(fiber.props)
    fiber.memoizedElement = child
    reconcileChildren(fiber, Array.isArray(child) ? child : [child])
  }

  /**
   * 处理原生 DOM 节点：
   *   - Fragment（'__fragment__'）：不产生 DOM，直接协调子树
   *   - 普通元素：按需创建真实 DOM，然后协调子树
   */
  function updateHostComponent(fiber) {
    if (fiber.type === Fragment) {
      reconcileChildren(fiber, fiber.props.children || [])
      return
    }
    if (!fiber.dom) fiber.dom = createDom(fiber)
    reconcileChildren(fiber, fiber.props.children || [])
  }

  // ─────────────────────────────────────────────────────────────
  // § 6  RECONCILER（协调 / Diff）
  // ─────────────────────────────────────────────────────────────

  /**
   * 对比旧 Fiber 链与新 Element 列表，标记 effectTag。
   *
   * 匹配策略（修复了旧版 O(n²) 问题）：
   *   有 key  → Map 查找，O(1)
   *   无 key  → 按位置顺序匹配，O(1)（unkeyedIdx 单向推进）
   *
   * 结果：
   *   类型相同 → UPDATE（复用 DOM 节点，只更新 props）
   *   类型不同且有新元素 → PLACEMENT（创建新节点）
   *   类型不同且有旧节点 → DELETION（删除旧节点）
   */
  function reconcileChildren(wipFiber_, elements) {
    const keyedOldFibers   = new Map()  // key → oldFiber
    const unkeyedOldFibers = []         // 无 key 旧 Fiber，按出现顺序
    const usedOldFibers    = new Set()
    let prevSibling = null
    let unkeyedIdx  = 0

    // 把旧 Fiber 链分为"有 key"和"无 key"两类
    let oldFiber = wipFiber_.alternate?.child
    while (oldFiber) {
      const key = getFiberKey(oldFiber)
      if (key !== null) keyedOldFibers.set(key, oldFiber)
      else unkeyedOldFibers.push(oldFiber)
      oldFiber = oldFiber.sibling
    }

    elements.forEach((element, index) => {
      if (!element) return

      const key = getElementKey(element)
      let oldMatch

      if (key !== null) {
        oldMatch = keyedOldFibers.get(key)
      } else {
        // 跳过已被使用的无 key 旧 Fiber（保证 O(n) 总复杂度）
        while (unkeyedIdx < unkeyedOldFibers.length &&
               usedOldFibers.has(unkeyedOldFibers[unkeyedIdx])) unkeyedIdx++
        oldMatch = unkeyedOldFibers[unkeyedIdx]
        if (oldMatch) unkeyedIdx++
      }

      const sameType = oldMatch && element.type === oldMatch.type
      let newFiber

      if (sameType) {
        // UPDATE：沿用旧 DOM，只更新 props
        newFiber = {
          type:      oldMatch.type,
          props:     element.props,
          dom:       oldMatch.dom,
          return:    wipFiber_,
          alternate: oldMatch,
          effectTag: 'UPDATE',
        }
        usedOldFibers.add(oldMatch)
      }

      if (!sameType && element) {
        // PLACEMENT：新节点，需要创建 DOM
        newFiber = {
          type:      element.type,
          props:     element.props,
          dom:       null,
          return:    wipFiber_,
          alternate: null,
          effectTag: 'PLACEMENT',
        }
      }

      if (!sameType && oldMatch) {
        oldMatch.effectTag = 'DELETION'
        deletions.push(oldMatch)
        usedOldFibers.add(oldMatch)
      }

      if (index === 0) wipFiber_.child = newFiber
      else prevSibling.sibling = newFiber
      prevSibling = newFiber
    })

    // 剩余未匹配的旧 Fiber 全部标记删除
    ;[...unkeyedOldFibers, ...keyedOldFibers.values()].forEach(f => {
      if (!usedOldFibers.has(f)) {
        f.effectTag = 'DELETION'
        deletions.push(f)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────
  // § 7  COMMIT（提交阶段）
  // ─────────────────────────────────────────────────────────────

  /**
   * commitRoot 是提交阶段的入口，整个过程同步、不可中断。
   *
   * 三阶段提交（与真实 React 一致）：
   *   1. Mutation pass  —— DOM 插入 / 更新 / 删除（commitWork）
   *   2. Layout pass    —— useLayoutEffect 同步执行（DOM 已就绪，浏览器未绘制）
   *   3. Passive pass   —— useEffect 异步执行（setTimeout，浏览器绘制后）
   *
   * useLayoutEffect vs useEffect：
   *   Layout  → 同步，可读取/修改 DOM，会阻塞浏览器绘制
   *   Passive → 异步，不阻塞绘制，适合数据请求、订阅等
   */
  function commitRoot() {
    const finishedRoot = wipRoot
    isCommitting = true

    deletions.forEach(fiber => commitWork(fiber))
    commitWork(finishedRoot.child)

    currentRoot  = finishedRoot
    wipRoot      = null
    isCommitting = false

    // Layout pass：DOM 已更新，浏览器尚未绘制 → 适合测量 DOM 尺寸
    commitAllLayoutEffects(finishedRoot.child)

    // Passive pass：延后到浏览器完成绘制后（不阻塞 UI）
    setTimeout(() => flushPassiveEffects(finishedRoot.child), 0)

    // setState 在首次 commit 前被调用（currentRoot 当时为 null）
    // 现在 currentRoot 已就绪，执行被推迟的重渲染
    if (pendingRerender) {
      pendingRerender = false
      scheduleRerender()
    }
  }

  /**
   * Mutation pass：递归处理每个 Fiber 的 DOM 操作。
   * 函数组件 / fragment 无 DOM（dom 为 null），需向上找最近有 DOM 的祖先。
   */
  function commitWork(fiber) {
    if (!fiber) return

    let domParentFiber = fiber.return
    while (domParentFiber && !domParentFiber.dom) domParentFiber = domParentFiber.return
    if (!domParentFiber) return
    const parentDom = domParentFiber.dom

    if (fiber.effectTag === 'PLACEMENT' && fiber.dom) {
      parentDom.appendChild(fiber.dom)
    } else if (fiber.effectTag === 'UPDATE' && fiber.dom) {
      updateDom(fiber.dom, fiber.alternate.props, fiber.props)
    } else if (fiber.effectTag === 'DELETION') {
      commitDeletion(fiber, parentDom)
      return  // 删除后不再遍历子树
    }

    commitWork(fiber.child)
    commitWork(fiber.sibling)
  }

  /** Layout pass：useLayoutEffect 同步执行 */
  function commitAllLayoutEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if (!hook._isLayoutEffect || !hook.callback) return
        if (hook.cleanup) hook.cleanup()
        hook.cleanup = hook.callback() ?? null
        hook.callback = null  // 清除，避免重复执行
      })
    }
    commitAllLayoutEffects(fiber.child)
    commitAllLayoutEffects(fiber.sibling)
  }

  /** Passive pass：useEffect 异步执行 */
  function flushPassiveEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if (!hook._isEffect || !hook.callback) return
        if (hook.cleanup) hook.cleanup()
        hook.cleanup = hook.callback() ?? null
        hook.callback = null
      })
    }
    flushPassiveEffects(fiber.child)
    flushPassiveEffects(fiber.sibling)
  }

  function commitDeletion(fiber, parentDom) {
    runUnmountEffects(fiber)
    removeDomNodes(fiber, parentDom)
  }

  /** 卸载时：递归运行所有副作用清理函数，并清空 ref */
  function runUnmountEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if ((hook._isEffect || hook._isLayoutEffect) && hook.cleanup) hook.cleanup()
      })
    }
    if (fiber.dom && fiber.props?.ref) setRef(fiber.props.ref, null)
    let child = fiber.child
    while (child) { runUnmountEffects(child); child = child.sibling }
  }

  /** 删除函数组件 / fragment 时，递归移除所有真实 DOM 后代 */
  function removeDomNodes(fiber, parentDom) {
    if (!fiber) return // 基础情况：空节点
    if (fiber.dom) {
      if (fiber.dom.parentNode === parentDom) parentDom.removeChild(fiber.dom) // 从父节点移除DOM
      return
    }
    let child = fiber.child
    while (child) { removeDomNodes(child, parentDom); child = child.sibling } // 递归遍历子树
  }

  // ─────────────────────────────────────────────────────────────
  // § 8  DOM 工具函数
  // ─────────────────────────────────────────────────────────────

  const isEvent = k => k.startsWith('on')
  const isProp  = k => k !== 'children' && k !== 'key' && k !== 'ref' && !isEvent(k)
  const isNew = (prev, next) => k => !Object.is(prev[k], next[k])
  const isGone = (_, next) => k => !(k in next)
  const toEventName = name => {
    const n = name.slice(2)
    return n === 'doubleclick' ? 'dblclick' : n.toLowerCase()
  }

  /**
   * updateDom：比较新旧 props，最小化地更新真实 DOM。
   * 处理：事件监听器、普通属性、className、style 对象/字符串、ref。
   */
  function updateDom(dom, prevProps, nextProps) {
    if (prevProps.ref !== nextProps.ref) setRef(prevProps.ref, null)

    // 移除旧事件监听
    Object.keys(prevProps).filter(isEvent)
      .filter(k => !(k in nextProps) || isNew(prevProps, nextProps)(k))
      .forEach(k => dom.removeEventListener(toEventName(k), prevProps[k]))

    // 清除消失的属性
    Object.keys(prevProps).filter(isProp).filter(isGone(prevProps, nextProps))
      .forEach(k => { if (k === 'style') updateStyle(dom, prevProps.style, null); dom[k] = '' })

    // 设置新 / 变化的属性
    Object.keys(nextProps).filter(isProp).filter(isNew(prevProps, nextProps))
      .forEach(k => {
        if (k === 'style') updateStyle(dom, prevProps.style, nextProps.style)
        else if (k === 'className') dom.className = nextProps[k]
        else dom[k] = nextProps[k]
      })

    // 添加新事件监听
    Object.keys(nextProps).filter(isEvent).filter(isNew(prevProps, nextProps))
      .forEach(k => dom.addEventListener(toEventName(k), nextProps[k]))

    if (prevProps.ref !== nextProps.ref) setRef(nextProps.ref, dom)
  }

  function updateStyle(dom, prev, next) {
    if (typeof prev === 'string' && typeof next !== 'string') dom.style.cssText = ''
    if (prev && typeof prev === 'object') {
      Object.keys(prev).forEach(k => {
        if (!next || typeof next !== 'object' || !(k in next)) dom.style[k] = ''
      })
    }
    if (typeof next === 'string') dom.style.cssText = next
    else if (next && typeof next === 'object') Object.assign(dom.style, next)
  }

  function setRef(ref, value) {
    if (!ref) return
    if (typeof ref === 'function') ref(value)
    else ref.current = value
  }

  function createDom(fiber) {
    const dom = fiber.type === 'TEXT_ELEMENT'
      ? document.createTextNode('')
      : document.createElement(fiber.type)
    updateDom(dom, {}, fiber.props)
    return dom
  }

  // ─────────────────────────────────────────────────────────────
  // § 9  HOOKS
  // ─────────────────────────────────────────────────────────────
  //
  // Hooks 只能在函数组件顶层调用（由 wipFiber / hookIndex 保证顺序）。
  // 每次渲染时，hooks 按调用顺序依次从 wipFiber.hooks[] 中存取。
  // ─────────────────────────────────────────────────────────────

  /**
   * useReducer —— 所有状态管理 hook 的基础。
   *
   * 工作原理：
   *   - 首次渲染：用 initialState 创建 hook，存入 wipFiber.hooks
   *   - 后续渲染：从 alternate 读取旧 hook，
   *     queue.splice(0) 消费并清空所有待处理 action，得到最新 state
   *   - dispatch：action 推入 queue，触发重渲染
   *
   * splice(0) 而非 slice(0) 的关键：消费的同时清空队列，
   * 避免下次渲染重复 reduce 同一批 action（这是一个经典 bug）。
   */
  function useReducer(reducer, initialState, init) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]

    const hook = {
      state: oldHook ? oldHook.state : (init ? init(initialState) : initialState),
      queue:  oldHook ? oldHook.queue : [],
    }

    hook.queue.splice(0).forEach(action => {
      hook.state = reducer(hook.state, action)
    })

    const dispatch = action => { hook.queue.push(action); scheduleRerender() }

    wipFiber.hooks.push(hook)
    hookIndex++
    return [hook.state, dispatch]
  }

  /**
   * useState —— useReducer 的语法糖。
   * action 可以是新值，也可以是 (prevState) => newState 函数。
   */
  function useState(initialState) {
    return useReducer(
      (state, action) => typeof action === 'function' ? action(state) : action,
      initialState,
      resolveInitialState,
    )
  }

  /**
   * useEffect —— 被动副作用（Passive Effect）
   *
   * 在浏览器完成绘制之后异步执行（setTimeout 延后）。
   * 适合：数据请求、订阅、日志等不需要立即读取 DOM 的操作。
   *
   * - deps 为 undefined → 每次渲染都执行
   * - deps 为 []       → 只在 mount 时执行（componentDidMount）
   * - deps 为 [a, b]   → a 或 b 变化时执行
   * - callback 可返回清理函数（下次 effect 前 / 卸载时自动调用）
   */
  function useEffect(callback, deps) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const hook    = {
      _isEffect: true,
      deps,
      cleanup:  oldHook?.cleanup ?? null,
      callback: haveDepsChanged(oldHook?.deps, deps) ? callback : null,
    }
    wipFiber.hooks.push(hook)
    hookIndex++
  }

  /**
   * useLayoutEffect —— 布局副作用（Layout Effect）
   *
   * 在所有 DOM 突变完成后、浏览器绘制之前同步执行。
   * 适合：读取 / 修改 DOM 布局（测量高度、同步滚动等）。
   *
   * 与 useEffect 的区别：
   *   useLayoutEffect → 同步，DOM 就绪后立即执行，会阻塞浏览器绘制
   *   useEffect       → 异步，浏览器绘制后才执行，不阻塞 UI
   */
  function useLayoutEffect(callback, deps) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const hook    = {
      _isLayoutEffect: true,
      deps,
      cleanup:  oldHook?.cleanup ?? null,
      callback: haveDepsChanged(oldHook?.deps, deps) ? callback : null,
    }
    wipFiber.hooks.push(hook)
    hookIndex++
  }

  /**
   * useMemo —— 缓存昂贵计算结果。
   * deps 不变时返回缓存值，deps 变化时重新调用 factory()。
   * 注意：factory 必须是纯函数（无副作用），副作用请放 useEffect。
   */
  function useMemo(factory, deps) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const hook    = {
      value: haveDepsChanged(oldHook?.deps, deps) ? factory() : oldHook.value,
      deps,
    }
    wipFiber.hooks.push(hook)
    hookIndex++
    return hook.value
  }

  /**
   * useRef —— 可变容器，修改 .current 不触发重渲染。
   * 两大用途：
   *   1. 持有 DOM 引用（配合 ref prop，mount 后自动赋值）
   *   2. 跨渲染存储可变值（如 setInterval 返回的 id）
   */
  function useRef(initialValue) {
    return useMemo(() => ({ current: initialValue }), [])
  }

  /** useCallback = useMemo(() => fn, deps)，缓存函数引用，避免子组件不必要重渲 */
  function useCallback(callback, deps) {
    return useMemo(() => callback, deps)
  }

  /**
   * useId —— 生成组件稳定的唯一 ID（':r0:', ':r1:' 格式）。
   * 主要用途：关联 <label htmlFor> 与 <input id>，避免多实例 ID 冲突。
   * useMemo + [] 保证同一组件实例在所有渲染中返回相同 ID。
   */
  function useId() {
    return useMemo(() => `:r${idCounter++}:`, [])
  }

  // ─────────────────────────────────────────────────────────────
  // § 10  CONTEXT（跨层级传值）
  // ─────────────────────────────────────────────────────────────

  /**
   * createContext —— 创建跨层级传值的通道。
   *
   * Provider 写入值（_currentValue），useContext / Consumer 读取值。
   *
   * 简化说明：真实 React 把 context 值存在 Fiber 树上，
   * 支持多层 Provider 嵌套覆盖，并精确订阅最近的 Provider。
   * 这里用单一变量存储，足以覆盖 99% 的使用场景。
   */
  function createContext(defaultValue) {
    const ctx = {
      _currentValue: defaultValue,

      Provider({ value, children }) {
        ctx._currentValue = value
        return Array.isArray(children)
          ? createElement(Fragment, null, ...children)
          : children
      },

      Consumer({ children }) {
        return children(ctx._currentValue)
      },
    }
    return ctx
  }

  /** useContext：读取最近 Provider 的值（无 Provider 时返回 defaultValue） */
  function useContext(context) {
    wipFiber.hooks.push({ _isContext: true })  // 占槽位，保持 hookIndex 连续
    hookIndex++
    return context._currentValue
  }

  // ─────────────────────────────────────────────────────────────
  // § 11  渲染入口
  // ─────────────────────────────────────────────────────────────

  /**
   * render —— 将 React 元素挂载到真实 DOM 容器。
   * 创建 wipRoot，唤醒 workLoop，开始 render 阶段。
   */
  function render(element, container) {
    wipRoot = {
      dom:       container,
      props:     { children: [element] },
      alternate: currentRoot,
    }
    deletions      = []
    nextUnitOfWork = wipRoot
  }

  /**
   * flushSync —— 同步立即提交所有待处理的状态更新。
   *
   * 用途：在需要立即读取更新后 DOM 的场景（如添加列表项后立刻滚动到底部）。
   * 原理：callback() 触发 scheduleRerender → 同步跑完所有 Fiber → 同步 commitRoot。
   *
   * 注意：flushSync 内不能再调用 flushSync（会死循环）。
   */
  function flushSync(callback) {
    callback()
    // 同步消费 callback 触发的所有状态更新
    while (nextUnitOfWork) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
    }
    if (wipRoot) commitRoot()
  }

  // ─────────────────────────────────────────────────────────────
  // § 12  内部工具
  // ─────────────────────────────────────────────────────────────

  /** setState / dispatch 调用后，调度一次重渲染 */
  function scheduleRerender() {
    if (!currentRoot || isCommitting) {
      // 首次 commit 前 / commit 过程中的 setState：延后到 commit 完成后处理
      pendingRerender = true
      return
    }
    wipRoot = {
      dom:       currentRoot.dom,
      props:     currentRoot.props,
      alternate: currentRoot,
    }
    deletions      = []
    nextUnitOfWork = wipRoot
  }

  const isFunctionComponent = fiber => typeof fiber.type === 'function'

  /**
   * memo —— 跳过 props 未变化的函数组件渲染。
   *
   * 实现方式：返回一个普通函数包装器（而非对象），
   * 使 isFunctionComponent 可以正常识别（typeof fn === 'function'）。
   * _isMemo / _type / _compare 挂在函数属性上，updateFunctionComponent 检查它们。
   */
  function memo(component, compare) {
    function Memoized(props) { return component(props) }
    Memoized._isMemo     = true
    Memoized._type       = component
    Memoized._compare    = compare || shallowEqualProps
    Memoized.displayName = `memo(${component.name || 'Component'})`
    return Memoized
  }

  function shallowEqualProps(prevProps, nextProps) {
    const pk = Object.keys(prevProps)
    const nk = Object.keys(nextProps)
    if (pk.length !== nk.length) return false
    return pk.every(k => {
      if (!Object.prototype.hasOwnProperty.call(nextProps, k)) return false
      const a = prevProps[k], b = nextProps[k]
      // 空 children 数组（每次 createElement 都会创建新数组引用）视为相等，
      // 避免父组件未传 children 时 memo 永远无法命中
      if (k === 'children' && Array.isArray(a) && Array.isArray(b) && !a.length && !b.length) return true
      return Object.is(a, b)
    })
  }

  function haveDepsChanged(prevDeps, nextDeps) {
    if (!prevDeps || !nextDeps) return true
    if (prevDeps.length !== nextDeps.length) return true
    return nextDeps.some((d, i) => !Object.is(d, prevDeps[i]))
  }

  function resolveInitialState(s) { return typeof s === 'function' ? s() : s }
  function getElementKey(el) { return el?.props?.key ?? null }
  function getFiberKey(f)    { return f?.props?.key  ?? null }

  /**
   * createRef —— 创建可变 ref 对象（不依赖 hook，可在模块级 / 类中使用）。
   * 与 useRef 区别：不与 Fiber 绑定，每次调用都返回新对象。
   */
  function createRef(initialValue = null) { return { current: initialValue } }

  /**
   * Children 工具集 —— 安全地操作 children prop（支持单节点 / 数组 / 嵌套数组）。
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
  // § 13  公开 API（与真实 React / ReactDOM API 形状一致）
  // ─────────────────────────────────────────────────────────────

  window.MiniReact = {
    createElement,
    Fragment,
    useState,
    useReducer,
    useEffect,
    useLayoutEffect,
    useRef,
    useMemo,
    useCallback,
    useId,
    useContext,
    createContext,
    memo,
    createRef,
    Children,
  }

  window.MiniReactDOM = {
    render,
    flushSync,
  }

}())
