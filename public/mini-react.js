/**
 * Mini React - 约 400 行代码实现 React 核心
 *
 * 架构与真实 React 保持一致：
 *   1. createElement   —— 创建虚拟 DOM（React Element）
 *   2. Fiber           —— 工作单元数据结构
 *   3. WorkLoop        —— 可中断的工作循环（调度器）
 *   4. Reconciler      —— Diff 算法（协调阶段）
 *   5. Commit          —— 提交阶段，真正操作 DOM
 *   6. Hooks           —— useState / useReducer / useEffect / useRef / useMemo / useCallback / useContext
 *   7. Context         —— createContext / Provider / Consumer / useContext
 *   8. memo            —— 跳过 props 未变化的函数组件渲染
 *
 * 与真实 React 的简化点（为了可读性）：
 *   - 调度器用 requestIdleCallback 代替 Scheduler 包
 *   - Lane 优先级模型简化为单队列
 *   - Context 用单一变量存储（真实 React 通过 Fiber 树传播）
 *   - 不支持 Suspense / Concurrent Mode 完整特性
 *
 * 整个实现包裹在 IIFE 中，所有内部函数不会污染全局作用域，
 * 只通过 window.MiniReact / window.MiniReactDOM 对外暴露 API。
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
        // 把所有子节点统一成对象形式（原始值包装为文本节点）
        children: children
          .flat(Infinity)
          .filter(child => child !== null && child !== undefined && typeof child !== 'boolean')
          .map(child =>
            typeof child === 'object'
              ? child
              : createTextElement(child)
          ),
      },
    }
  }

  /** 将字符串 / 数字包装成文本节点 Element */
  function createTextElement(text) {
    return {
      type: 'TEXT_ELEMENT',
      props: { nodeValue: String(text), children: [] },
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 2  FIBER 数据结构
  // ─────────────────────────────────────────────────────────────
  /**
   * Fiber 是 React 内部的工作单元，每个 Element 对应一个 Fiber 节点。
   *
   * 关键字段：
   *   type       —— 节点类型（'div' / Function / 'TEXT_ELEMENT' / '__fragment__'）
   *   props      —— 属性（含 children）
   *   dom        —— 对应的真实 DOM 节点（函数组件 / fragment 为 null）
   *   return     —— 父 Fiber（链表向上指针）
   *   child      —— 第一个子 Fiber
   *   sibling    —— 下一个兄弟 Fiber
   *   alternate  —— 上一次渲染的对应 Fiber（双缓冲）
   *   effectTag  —— 本次要做什么：PLACEMENT / UPDATE / DELETION
   *   hooks      —— 函数组件的 hooks 列表（按调用顺序存储）
   *
   * 遍历顺序：child → sibling → return（深度优先，可中断）
   */

  // ─────────────────────────────────────────────────────────────
  // § 3  全局调度状态
  // ─────────────────────────────────────────────────────────────

  let nextUnitOfWork  = null   // 下一个要处理的 Fiber
  let currentRoot     = null   // 上次提交到 DOM 的根 Fiber（current 树）
  let wipRoot         = null   // 正在构建的根 Fiber（work-in-progress 树）
  let deletions       = []     // 需要删除的 Fiber 列表
  let pendingRerender = false  // setState 在首次 commit 前被调用时的标记
  let isCommitting    = false  // commit 阶段内触发的更新延后到本次提交之后

  // Hooks 执行时的上下文（对应真实 React 的 ReactCurrentDispatcher）
  let wipFiber  = null  // 当前正在执行的函数组件 Fiber
  let hookIndex = 0     // 当前 hook 在 hooks 数组中的下标

  const MEMO_TYPE = typeof Symbol === 'function' ? Symbol('mini.memo') : '__mini_memo__'
  const requestIdle = window.requestIdleCallback ||
    (callback => setTimeout(() => callback({ timeRemaining: () => 50 }), 1))

  // ─────────────────────────────────────────────────────────────
  // § 4  WORK LOOP（工作循环）
  // ─────────────────────────────────────────────────────────────

  /**
   * workLoop 是 React 调度循环的核心。
   *
   * 真实 React 使用 MessageChannel + Scheduler 实现"时间切片"，
   * 这里用 requestIdleCallback 简化：浏览器空闲时执行，
   * 剩余时间不足 1ms 就暂停，让浏览器去处理更高优先级的任务。
   *
   * 所有 Fiber 处理完后（nextUnitOfWork 为 null），进入同步 commit 阶段。
   */
  function workLoop(deadline) {
    let shouldYield = false

    while (nextUnitOfWork && !shouldYield) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
      shouldYield = deadline.timeRemaining() < 1
    }

    // render 阶段结束 → commit 阶段（不可中断）
    if (!nextUnitOfWork && wipRoot) {
      commitRoot()
    }

    requestIdle(workLoop)
  }

  requestIdle(workLoop)

  // ─────────────────────────────────────────────────────────────
  // § 5  PERFORM UNIT OF WORK（处理单个 Fiber）
  // ─────────────────────────────────────────────────────────────

  /**
   * 处理一个 Fiber，返回下一个要处理的 Fiber。
   *
   * 遍历策略（深度优先）：
   *   1. 优先返回子节点（child）
   *   2. 没有子节点就返回兄弟节点（sibling）
   *   3. 都没有就向上找父节点的兄弟节点（uncle）
   */
  function performUnitOfWork(fiber) {
    if (isFunctionComponent(fiber)) {
      updateFunctionComponent(fiber)
    } else {
      updateHostComponent(fiber)
    }

    if (fiber.child) return fiber.child

    let next = fiber
    while (next) {
      if (next.sibling) return next.sibling
      next = next.return
    }
    return null
  }

  /** 处理函数组件：调用函数获得子元素，然后协调子树 */
  function updateFunctionComponent(fiber) {
    wipFiber  = fiber
    hookIndex = 0
    wipFiber.hooks = []

    const isMemo = isMemoType(fiber.type)
    const component = isMemo ? fiber.type.type : fiber.type
    const hasQueuedState = fiber.alternate?.hooks?.some(hook => hook.queue?.length > 0)
    const canReuseMemo = isMemo &&
      fiber.alternate &&
      !hasQueuedState &&
      fiber.type.compare(fiber.alternate.props, fiber.props)

    // 调用函数组件，拿到它返回的 Element。memo 命中时跳过函数调用，复用上次结果。
    const child = canReuseMemo
      ? fiber.alternate.memoizedElement
      : component(fiber.props)

    if (canReuseMemo) {
      wipFiber.hooks = fiber.alternate.hooks || []
    }
    fiber.memoizedElement = child

    const children = [child]
    reconcileChildren(fiber, children)
  }

  /**
   * 处理原生 DOM 节点（或 fragment 占位节点）：
   *   - fragment（__fragment__）：无 DOM，直接协调子树
   *   - 普通元素：创建真实 DOM，然后协调子树
   */
  function updateHostComponent(fiber) {
    if (fiber.type === '__fragment__') {
      // fragment 本身不产生 DOM，直接协调子树
      reconcileChildren(fiber, fiber.props.children)
      return
    }
    if (!fiber.dom) {
      fiber.dom = createDom(fiber)
    }
    reconcileChildren(fiber, fiber.props.children)
  }

  // ─────────────────────────────────────────────────────────────
  // § 6  RECONCILER（协调 / Diff）
  // ─────────────────────────────────────────────────────────────

  /**
   * reconcileChildren 是 React Diff 算法的核心。
   *
   * 逻辑：把旧 Fiber 列表（oldFiber 链）与新 Element 列表逐一对比：
   *   - 类型相同 → UPDATE（复用 DOM 节点，只更新 props）
   *   - 类型不同且有新元素 → PLACEMENT（创建新节点）
   *   - 类型不同且有旧节点 → DELETION（删除旧节点）
   *
   * 支持 key：有 key 时按 key 复用，避免列表删除 / 插入时状态错位。
   */
  function reconcileChildren(wipFiber_, elements) {
    const oldFibers = []
    const keyedOldFibers = new Map()
    const usedOldFibers = new Set()
    let oldFiber = wipFiber_.alternate && wipFiber_.alternate.child
    let prevSibling = null

    while (oldFiber) {
      oldFibers.push(oldFiber)
      const key = getFiberKey(oldFiber)
      if (key !== null) keyedOldFibers.set(key, oldFiber)
      oldFiber = oldFiber.sibling
    }

    elements.forEach((element, index) => {
      if (!element) return

      const key = getElementKey(element)
      const oldMatch = key !== null
        ? keyedOldFibers.get(key)
        : oldFibers.find(fiber => !usedOldFibers.has(fiber) && getFiberKey(fiber) === null)
      const sameType = oldMatch && element.type === oldMatch.type
      let newFiber

      if (sameType) {
        // UPDATE：沿用旧 DOM，更新 props
        newFiber = {
          type:      oldMatch.type,
          props:     element.props,
          dom:       oldMatch.dom,      // 复用真实 DOM
          return:    wipFiber_,
          alternate: oldMatch,          // 双缓冲指针
          effectTag: 'UPDATE',
        }
        usedOldFibers.add(oldMatch)
      }

      if (element && !sameType) {
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

      if (oldMatch && !sameType) {
        oldMatch.effectTag = 'DELETION'
        deletions.push(oldMatch)
        usedOldFibers.add(oldMatch)
      }

      if (index === 0) {
        wipFiber_.child = newFiber
      } else if (prevSibling) {
        prevSibling.sibling = newFiber
      }

      prevSibling = newFiber

    })

    oldFibers.forEach(fiber => {
      if (usedOldFibers.has(fiber)) return
      fiber.effectTag = 'DELETION'
      deletions.push(fiber)
    })
  }

  // ─────────────────────────────────────────────────────────────
  // § 7  COMMIT（提交阶段）
  // ─────────────────────────────────────────────────────────────

  /**
   * commitRoot 是提交阶段的入口，整个过程同步、不可中断。
   *
   * 顺序：
   *   1. 处理所有 DELETION（先删，防止旧节点遮挡新节点）
   *   2. 从根节点开始递归提交 PLACEMENT / UPDATE
   *   3. 更新 currentRoot，清空 wipRoot
   */
  function commitRoot() {
    const finishedRoot = wipRoot
    isCommitting = true
    deletions.forEach(fiber => commitWork(fiber))
    commitWork(finishedRoot.child)
    currentRoot = finishedRoot
    wipRoot = null
    isCommitting = false

    // setState was called during the initial render (before currentRoot existed).
    // Now that currentRoot is set we can schedule the deferred re-render.
    if (pendingRerender) {
      pendingRerender = false
      scheduleRerender()
    }
  }

  /**
   * commitWork 递归处理每个 Fiber 的 DOM 操作 + 副作用。
   *
   * 注意：函数组件和 fragment 没有 DOM（dom 为 null），
   * 需要向上找最近的有 DOM 的祖先作为父节点。
   */
  function commitWork(fiber) {
    if (!fiber) return

    // 向上找最近的有真实 DOM 的祖先（跳过函数组件和 fragment）
    let parentFiber = fiber.return
    while (!parentFiber.dom) {
      parentFiber = parentFiber.return
    }
    const parentDom = parentFiber.dom

    if (fiber.effectTag === 'PLACEMENT' && fiber.dom) {
      parentDom.appendChild(fiber.dom)
    } else if (fiber.effectTag === 'UPDATE' && fiber.dom) {
      updateDom(fiber.dom, fiber.alternate.props, fiber.props)
    } else if (fiber.effectTag === 'DELETION') {
      commitDeletion(fiber, parentDom)
      return  // 删除后不需要再处理子树
    }

    // 运行 useEffect 副作用
    commitEffects(fiber)

    commitWork(fiber.child)
    commitWork(fiber.sibling)
  }

  /** 递归找到第一个有 DOM 的后代并从父节点移除 */
  function commitDeletion(fiber, parentDom) {
    runUnmountEffects(fiber)
    removeDomNodes(fiber, parentDom)
  }

  /** 组件卸载时：递归运行所有 useEffect 清理函数并清空 ref */
  function runUnmountEffects(fiber) {
    if (!fiber) return
    if (fiber.hooks) {
      fiber.hooks.forEach(hook => {
        if (hook._isEffect && hook.cleanup) hook.cleanup()
      })
    }
    if (fiber.dom && fiber.props?.ref) setRef(fiber.props.ref, null)
    let child = fiber.child
    while (child) {
      runUnmountEffects(child)
      child = child.sibling
    }
  }

  /** 删除函数组件 / fragment 时，可能需要移除多个真实 DOM 后代 */
  function removeDomNodes(fiber, parentDom) {
    if (!fiber) return
    if (fiber.dom) {
      if (fiber.dom.parentNode === parentDom) parentDom.removeChild(fiber.dom)
      return
    }
    let child = fiber.child
    while (child) {
      removeDomNodes(child, parentDom)
      child = child.sibling
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 8  DOM 工具函数
  // ─────────────────────────────────────────────────────────────

  const isEvent = key => key.startsWith('on')
  const isProp  = key => key !== 'children' && key !== 'key' && key !== 'ref' && !isEvent(key)
  const isNew   = (prev, next) => key => prev[key] !== next[key]
  const isGone  = (_prev, next) => key => !(key in next)
  const eventAliases = { doubleclick: 'dblclick' }
  const getEventName = name => {
    const eventName = name.slice(2).toLowerCase()
    return eventAliases[eventName] || eventName
  }

  /**
   * updateDom 比较新旧 props，最小化地更新真实 DOM。
   * 处理：普通属性、className、style 对象、事件监听器。
   */
  function updateDom(dom, prevProps, nextProps) {
    if (prevProps.ref !== nextProps.ref) setRef(prevProps.ref, null)

    // 移除不再存在 / 已变化的事件监听
    Object.keys(prevProps).filter(isEvent)
      .filter(k => !(k in nextProps) || isNew(prevProps, nextProps)(k))
      .forEach(name => {
        dom.removeEventListener(getEventName(name), prevProps[name])
      })

    // 清除消失的属性
    Object.keys(prevProps).filter(isProp)
      .filter(isGone(prevProps, nextProps))
      .forEach(name => {
        if (name === 'style') {
          updateStyle(dom, prevProps.style, null)
        } else {
          dom[name] = ''
        }
      })

    // 设置新 / 变化的属性
    Object.keys(nextProps).filter(isProp)
      .filter(isNew(prevProps, nextProps))
      .forEach(name => {
        if (name === 'style') {
          updateStyle(dom, prevProps.style, nextProps.style)
        } else if (name === 'className') {
          dom.className = nextProps[name]
        } else {
          dom[name] = nextProps[name]
        }
      })

    // 添加新的事件监听
    Object.keys(nextProps).filter(isEvent)
      .filter(isNew(prevProps, nextProps))
      .forEach(name => {
        dom.addEventListener(getEventName(name), nextProps[name])
      })

    if (prevProps.ref !== nextProps.ref) setRef(nextProps.ref, dom)
  }

  function updateStyle(dom, prevStyle, nextStyle) {
    if (typeof prevStyle === 'string' && typeof nextStyle !== 'string') {
      dom.style.cssText = ''
    }

    if (prevStyle && typeof prevStyle === 'object') {
      Object.keys(prevStyle).forEach(name => {
        if (!nextStyle || typeof nextStyle !== 'object' || !(name in nextStyle)) {
          dom.style[name] = ''
        }
      })
    }

    if (typeof nextStyle === 'string') {
      dom.style.cssText = nextStyle
    } else if (nextStyle && typeof nextStyle === 'object') {
      Object.assign(dom.style, nextStyle)
    }
  }

  function setRef(ref, value) {
    if (!ref) return
    if (typeof ref === 'function') {
      ref(value)
    } else {
      ref.current = value
    }
  }

  /** 根据 Fiber 创建对应的真实 DOM 节点 */
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
  // Hooks 只能在函数组件内部调用（由 wipFiber / hookIndex 保证顺序）。
  // 每次渲染时，hooks 按调用顺序依次从 wipFiber.hooks[] 中存取。
  // ─────────────────────────────────────────────────────────────

  /**
   * useReducer
   *
   * useState 是 useReducer 的特例，所有状态逻辑在这里统一实现。
   *
   * 工作原理：
   *   - 首次渲染：用 initialState 创建 hook，存入 wipFiber.hooks
   *   - 后续渲染：从 alternate（上次 Fiber）读取旧 hook，
   *     将 queue 中积累的 action 依次 reduce，得到最新 state
   *   - dispatch 调用后：action 推入 queue，触发重新渲染
   */
  function useReducer(reducer, initialState, init) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const queue = oldHook ? oldHook.queue : []

    const hook = {
      state: oldHook ? oldHook.state : init ? init(initialState) : initialState,
      queue,
    }

    // 把上一轮积累的 actions 全部 reduce 到最新状态
    const actions = queue.splice(0)
    actions.forEach(action => {
      hook.state = reducer(hook.state, action)
    })

    const dispatch = action => {
      hook.queue.push(action)
      scheduleRerender()
    }

    wipFiber.hooks.push(hook)
    hookIndex++
    return [hook.state, dispatch]
  }

  /**
   * useState —— useReducer 的语法糖
   *
   * action 可以是新值，也可以是 (prevState) => newState 函数。
   */
  function useState(initialState) {
    return useReducer(
      (state, action) => typeof action === 'function' ? action(state) : action,
      initialState,
      resolveInitialState
    )
  }

  /**
   * useEffect
   *
   * - deps 为 undefined → 每次渲染都执行
   * - deps 为 []       → 只在 mount 时执行（componentDidMount）
   * - deps 为 [a, b]   → a 或 b 变化时执行
   * - callback 可返回清理函数（下次 effect 前 / 卸载时自动调用）
   */
  function useEffect(callback, deps) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]

    const depsChanged = haveDepsChanged(oldHook?.deps, deps)

    const hook = {
      _isEffect: true,
      deps,
      cleanup:  oldHook?.cleanup ?? null,
      // 只有 deps 变化时才记录 callback；不变则为 null，commitEffects 跳过
      callback: depsChanged ? callback : null,
    }

    wipFiber.hooks.push(hook)
    hookIndex++
  }

  /** commit 阶段：运行当次有效的 effect，并保存清理函数 */
  function commitEffects(fiber) {
    if (!fiber.hooks) return
    fiber.hooks.forEach(hook => {
      if (!hook._isEffect || !hook.callback) return
      if (hook.cleanup) hook.cleanup()
      hook.cleanup = hook.callback() ?? null
    })
  }

  /**
   * useMemo
   *
   * 只有当 deps 发生变化时才重新计算 factory()，否则返回缓存值。
   * 常用于避免昂贵计算在每次渲染时重复执行。
   */
  function useMemo(factory, deps) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]

    const depsChanged = haveDepsChanged(oldHook?.deps, deps)

    const hook = {
      value: depsChanged ? factory() : oldHook.value,
      deps,
    }

    wipFiber.hooks.push(hook)
    hookIndex++
    return hook.value
  }

  /**
   * useRef
   *
   * 返回一个 { current: initialValue } 对象。
   * 对象引用在整个组件生命周期内不变（通过 useMemo(fn, []) 实现）。
   * 修改 ref.current 不会触发重新渲染。
   */
  function useRef(initialValue) {
    return useMemo(() => ({ current: initialValue }), [])
  }

  /**
   * useCallback —— useMemo 的语法糖
   *
   * useCallback(fn, deps) 等价于 useMemo(() => fn, deps)
   * 缓存函数引用，避免子组件因引用变化而不必要地重渲染。
   */
  function useCallback(callback, deps) {
    return useMemo(() => callback, deps)
  }

  // ─────────────────────────────────────────────────────────────
  // § 10  CONTEXT（上下文）
  // ─────────────────────────────────────────────────────────────

  /**
   * createContext
   *
   * 返回一个 Context 对象：
   *   - _currentValue：当前值（Provider 写入，useContext 读取）
   *   - Provider：包裹子树，设置 _currentValue
   *   - Consumer：render props 形式消费（兼容旧写法）
   *
   * 简化说明：真实 React 把 context 值存在 Fiber 树上，
   * 支持多层 Provider 嵌套和精确的订阅更新。
   * 这里用单一变量存储，足以演示核心机制。
   */
  function createContext(defaultValue) {
    const context = {
      _currentValue: defaultValue,

      Provider({ value, children }) {
        context._currentValue = value
        // Provider 本身不产生 DOM，用 fragment 透传子节点
        return Array.isArray(children)
          ? createElement('__fragment__', null, ...children)
          : children
      },

      Consumer({ children }) {
        // children 是函数（render props 模式）
        return children(context._currentValue)
      },
    }
    return context
  }

  /** useContext：读取 context 当前值 */
  function useContext(context) {
    // 占一个 hook 槽位，保持 hookIndex 连续（真实 React 会追踪订阅）
    const hook = { _isContext: true }
    wipFiber.hooks.push(hook)
    hookIndex++
    return context._currentValue
  }

  // ─────────────────────────────────────────────────────────────
  // § 11  渲染入口
  // ─────────────────────────────────────────────────────────────

  /**
   * render —— 将 React 元素挂载到真实 DOM 容器
   *
   * 流程：
   *   1. 创建 wipRoot（work-in-progress 根 Fiber）
   *   2. 赋值给 nextUnitOfWork，唤醒 workLoop
   *   3. workLoop 逐个处理 Fiber（render 阶段，可中断）
   *   4. 全部处理完后执行 commitRoot（commit 阶段，同步）
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

  // ─────────────────────────────────────────────────────────────
  // § 12  内部工具
  // ─────────────────────────────────────────────────────────────

  /** setState / dispatch 调用后，调度一次重新渲染 */
  function scheduleRerender() {
    if (!currentRoot || isCommitting) {
      // Called during the initial render before the first commit.
      // Mark the flag; commitRoot will call us again once currentRoot is ready.
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

  function isMemoType(type) {
    return type && typeof type === 'object' && type.$$typeof === MEMO_TYPE
  }

  function isFunctionComponent(fiber) {
    return typeof fiber.type === 'function' || isMemoType(fiber.type)
  }

  function memo(component, compare) {
    return {
      $$typeof: MEMO_TYPE,
      type: component,
      compare: compare || shallowEqualProps,
    }
  }

  function shallowEqualProps(prevProps, nextProps) {
    const prevKeys = Object.keys(prevProps).filter(key => key !== 'children' || !isEmptyChildren(prevProps[key]))
    const nextKeys = Object.keys(nextProps).filter(key => key !== 'children' || !isEmptyChildren(nextProps[key]))
    if (prevKeys.length !== nextKeys.length) return false
    return prevKeys.every(key => Object.prototype.hasOwnProperty.call(nextProps, key) &&
      Object.is(prevProps[key], nextProps[key]))
  }

  function isEmptyChildren(value) {
    return Array.isArray(value) && value.length === 0
  }

  function haveDepsChanged(prevDeps, nextDeps) {
    if (!prevDeps || !nextDeps) return true
    if (prevDeps.length !== nextDeps.length) return true
    return nextDeps.some((dep, i) => !Object.is(dep, prevDeps[i]))
  }

  function resolveInitialState(initialState) {
    return typeof initialState === 'function' ? initialState() : initialState
  }

  function getElementKey(element) {
    return element?.props?.key ?? null
  }

  function getFiberKey(fiber) {
    return fiber?.props?.key ?? null
  }

  // ─────────────────────────────────────────────────────────────
  // § 13  公开 API（与真实 React / ReactDOM API 形状一致）
  // ─────────────────────────────────────────────────────────────

  window.MiniReact = {
    createElement,
    useState,
    useReducer,
    useEffect,
    useRef,
    useMemo,
    useCallback,
    useContext,
    createContext,
    memo,
  }

  window.MiniReactDOM = {
    render,
  }

}())
