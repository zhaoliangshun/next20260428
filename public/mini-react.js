/**
 * Mini React - 约 550 行代码实现 React 核心
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  架构与真实 React 保持一致：                                      │
 * │  1. createElement   —— 创建虚拟 DOM（React Element）             │
 * │  2. Fiber           —— 工作单元（child/sibling/return 链表树     │
 * │                         + alternate 双缓冲）                     │
 * │  3. WorkLoop        —— requestIdleCallback 可中断工作循环         │
 * │  4. Reconciler      —— Diff：O(n) key 匹配 + 顺序匹配            │
 * │  5. Commit          —— 三阶段：mutation → layout → passive       │
 * │  6. Hooks           —— useState / useReducer / useEffect /       │
 * │                         useLayoutEffect / useRef / useMemo /     │
 * │                         useCallback / useContext / useId         │
 * │  7. Context         —— createContext / Provider / Consumer       │
 * │  8. memo            —— 浅比较 props，跳过不必要渲染               │
 * │  9. 工具            —— Fragment / createRef / Children / flushSync│
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 与真实 React 的主要简化之处：
 *   - 用 requestIdleCallback 替代 MessageChannel + Scheduler（优先级调度）
 *   - Passive effects 按 fiber 顺序依次 cleanup→run，真实 React 是先全部
 *     cleanup 再全部 run（两遍 DFS）
 *   - useContext 无精确订阅：memo 包裹的组件在 context 变化时可能不重渲染
 *   - 无 Suspense / ErrorBoundary / concurrent features / SSR
 */
;(function () {
  'use strict'

  // ─────────────────────────────────────────────────────────────
  // § 1  REACT ELEMENT（虚拟 DOM）
  // ─────────────────────────────────────────────────────────────

  /**
   * createElement —— JSX 的编译目标，创建描述 UI 的轻量对象（React Element）。
   *
   * JSX：  <div className="box">hello</div>
   * 编译：  createElement('div', { className: 'box' }, 'hello')
   * 结果：  { type: 'div', props: { className: 'box', children: [...] } }
   *
   * children 处理细节：
   *   - flat(Infinity)：展平嵌套数组（Fragment / map 的返回值）
   *   - filter：剔除 null / undefined / boolean（条件渲染的 false 不产生节点）
   *   - map：字符串/数字包装为 TEXT_ELEMENT，统一节点类型，简化后续 Fiber 处理
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

  /**
   * createTextElement —— 将字符串/数字包装成统一的 Element 对象。
   * TEXT_ELEMENT 类型在 createDom 中对应 document.createTextNode()。
   * nodeValue 对应 DOM Text 节点的同名属性。
   */
  function createTextElement(text) {
    return { type: 'TEXT_ELEMENT', props: { nodeValue: String(text), children: [] } }
  }

  /**
   * Fragment —— 多根节点占位符，渲染时不产生任何真实 DOM。
   * 允许组件返回多个并列子节点，而不需要额外的包裹元素。
   *   createElement(Fragment, null, <A/>, <B/>)  →  <A/><B/>（无额外 DOM）
   * updateHostComponent 检测到 Fragment 时直接协调子树、跳过 createDom。
   */
  const Fragment = '__fragment__'

  // ─────────────────────────────────────────────────────────────
  // § 2  FIBER 数据结构（文档说明，无实际代码）
  // ─────────────────────────────────────────────────────────────

  /**
   * Fiber 是 React 内部的工作单元，每个 Element 对应一个 Fiber 节点。
   *
   * ── 树遍历（单链表，DFS 可中断）─────────────────────────────────
   *   fiber.child    —— 第一个子节点
   *   fiber.sibling  —— 下一个兄弟节点
   *   fiber.return   —— 父节点（performUnitOfWork 向上回溯时使用）
   *
   * 遍历顺序示意（child 优先，然后 sibling，最后 uncle）：
   *                A
   *               / \
   *              B   C
   *             / \   \
   *            D   E   F
   *   执行顺序：A → B → D → E → C → F
   *
   * ── 双缓冲（Double Buffering）──────────────────────────────────
   *   fiber.alternate —— 另一棵树中对应的 Fiber
   *   current 树（已提交，用户可见）↔ wip 树（正在构建）
   *   commit 后：currentRoot = wipRoot，wipRoot = null
   *
   * ── 副作用标记 ─────────────────────────────────────────────────
   *   fiber.effectTag —— 'PLACEMENT' | 'UPDATE' | 'DELETION'
   *
   * ── 函数组件专属字段 ────────────────────────────────────────────
   *   fiber.hooks              —— hooks 数组（严格按调用顺序索引）
   *   fiber.memoizedElement    —— 上次 render 返回的 Element（memo 复用）
   *   fiber._context           —— Provider fiber 持有的 context 对象引用
   *   fiber._previousContextValue —— Provider 退出时用于恢复的旧 context 值
   */

  // ─────────────────────────────────────────────────────────────
  // § 3  全局调度状态
  // ─────────────────────────────────────────────────────────────

  let nextUnitOfWork  = null   // render 阶段游标：下一个待处理的 Fiber
  let currentRoot     = null   // 已提交到 DOM 的根 Fiber（current 树）
  let wipRoot         = null   // 正在构建的根 Fiber（work-in-progress 树）
  let deletions       = []     // 本轮 Diff 需要删除的 Fiber 列表（commit 时统一处理）
  let pendingRerender = false  // commit 前 / commit 期间 setState 的延迟标记
  let isCommitting    = false  // mutation pass 期间为 true，阻止 scheduleRerender 建立新 wipRoot
  let workLoopScheduled    = false   // 防止重复注册 requestIdleCallback
  let pendingPassiveRoots  = []      // 等待执行 passive effects 的 fiber 根节点列表
  let passiveFlushScheduled = false  // 防止重复注册 setTimeout

  let wipFiber  = null  // 当前正在渲染的函数组件 Fiber（hooks 执行上下文）
  let hookIndex = 0     // 当前 hook 的顺序下标（保证每次渲染与上次 hook 一一对应）

  let idCounter = 0     // useId 全局单调自增计数器

  /**
   * requestIdle —— 浏览器空闲时间调度器。
   * 优先用 requestIdleCallback（原生空闲回调）；
   * 降级到 setTimeout 1ms + 模拟 50ms 可用时间（Node / 旧浏览器兼容）。
   *
   * 真实 React 用 MessageChannel + Scheduler 包实现优先级调度，
   * 时间片约 5ms / 帧，比 requestIdleCallback 更稳定、优先级更高。
   */
  const requestIdle = window.requestIdleCallback
    ? cb => window.requestIdleCallback(cb, { timeout: 16 })
    : cb => setTimeout(() => cb({ timeRemaining: () => 50 }), 1)

  // ─────────────────────────────────────────────────────────────
  // § 4  WORK LOOP（工作循环）
  // ─────────────────────────────────────────────────────────────

  /**
   * workLoop —— 浏览器空闲时间片内处理 Fiber（render 阶段，可中断）。
   *
   * 执行流程：
   *   ① 逐个处理 nextUnitOfWork，每处理完一个检查剩余时间
   *   ② 时间片耗尽（< 1ms）→ 让出控制权，等待下次 requestIdleCallback
   *   ③ 全部 Fiber 处理完（nextUnitOfWork === null）且有 wipRoot
   *      → 进入不可中断的 commit 阶段（commitRoot）
   *   ④ 仍有未完成工作 → 重新调度 workLoop
   *
   * 可中断性的关键：
   *   Fiber 链表（child/sibling/return）允许工作"暂停在任意节点，
   *   下次从同一节点继续"，无需维护递归调用栈。
   */
  function workLoop(deadline) {
    workLoopScheduled = false
    let shouldYield = false

    while (nextUnitOfWork && !shouldYield) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
      shouldYield = deadline.timeRemaining() < 1
    }

    // render 阶段全部完成 → 同步提交（commit 阶段不可中断）
    if (!nextUnitOfWork && wipRoot) commitRoot()

    // 若仍有未完成工作（被时间片中断），重新排队
    if (nextUnitOfWork || wipRoot) scheduleWorkLoop()
  }

  // ─────────────────────────────────────────────────────────────
  // § 5  PERFORM UNIT OF WORK（处理单个 Fiber）
  // ─────────────────────────────────────────────────────────────

  /**
   * performUnitOfWork —— 处理一个 Fiber，返回下一个要处理的 Fiber。
   *
   * DFS 遍历顺序（对应真实 React 的 beginWork + completeWork）：
   *   1. beginWork：处理当前 Fiber（创建 DOM / 执行 hooks / 协调子树）
   *   2. 有 child → 进入 child（向下）
   *   3. 无 child → completeWork：完成当前节点，进入 sibling（向右）
   *   4. 无 sibling → 向上回溯 return，completeWork 父节点，直到找到 sibling
   *
   * "先 child 后 sibling 再 uncle"的顺序保证：
   *   父组件渲染结果（子 Fiber 链）在子组件渲染之前生成；
   *   subtree 内所有节点完成后，completeWork 才在父节点执行。
   */
  function performUnitOfWork(fiber) {
    if (isFunctionComponent(fiber)) updateFunctionComponent(fiber)
    else updateHostComponent(fiber)

    // 有子节点 → DFS 向下
    if (fiber.child) return fiber.child

    // 无子节点 → 开始完成阶段，向上回溯
    let next = fiber
    while (next) {
      completeUnitOfWork(next)
      if (next.sibling) return next.sibling
      next = next.return
    }
    return null
  }

  /**
   * completeUnitOfWork —— 一个 Fiber 的所有子节点处理完毕后调用（completeWork）。
   *
   * 当前职责：恢复 Context Provider 的旧 context 值（实现 Provider 作用域栈）。
   *
   * Provider beginWork（updateFunctionComponent）时：
   *   保存旧值 → 设置新值（ctx._currentValue = fiber.props.value）
   * Provider completeWork（此处）时：
   *   恢复旧值（ctx._currentValue = _previousContextValue）
   *
   * 这确保了：Provider 的兄弟节点不会读取到该 Provider 注入的 context 值，
   * 多层 Provider 嵌套时各自作用域互不污染。
   */
  function completeUnitOfWork(fiber) {
    if (fiber._context) {
      fiber._context._currentValue = fiber._previousContextValue
    }
  }

  /**
   * updateFunctionComponent —— 渲染函数组件。
   *
   * 步骤：
   *   1. 设置 hooks 上下文（wipFiber / hookIndex），让 useState 等知道当前
   *      在渲染哪个组件、处理第几个 hook
   *   2. memo bailout 检测：props 未变化 + 无待处理 state → 跳过渲染，复用缓存
   *   3. Context.Provider 进入作用域：保存旧值、注入新值
   *   4. 调用组件函数，拿到子 Element，交给 reconcileChildren
   *
   * hooks 顺序规则（"规则一：只在顶层调用"的根本原因）：
   *   每次渲染重置 wipFiber.hooks = []，hookIndex 从 0 开始；
   *   每调用一个 hook，hookIndex++；
   *   通过 wipFiber.alternate?.hooks?.[hookIndex] 读取上次对应位置的旧 hook 状态。
   *   一旦在条件/循环内调用 hook，hookIndex 顺序就会错位，读到错误的旧状态。
   */
  function updateFunctionComponent(fiber) {
    wipFiber  = fiber
    hookIndex = 0
    wipFiber.hooks = []

    const component = fiber.type
    const isMemo    = !!component._isMemo

    // ── memo bailout ──────────────────────────────────────────────
    // 两个条件同时满足才跳过渲染：
    //   a. 无排队中的 state 更新（hook.queue 为空）
    //   b. props 浅比较相等（_compare 默认为 shallowEqualProps）
    //
    // 跳过时：复用 alternate.hooks 数组和 memoizedElement，调用 reconcileChildren
    // 继续构建子 Fiber（即使跳过本组件的函数调用，子树仍需和 current 树对比）。
    //
    // ⚠️ 已知限制：若该组件使用 useContext，memo 可能阻止 context 变化时的重渲染。
    //    真实 React 对 useContext 消费者绕过 memo 做了特殊处理，此实现未实现。
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

    // ── Context.Provider 进入作用域 ───────────────────────────────
    // Provider 函数上挂有 _context 引用（createContext 时设置）；
    // 进入时保存旧值并注入 fiber.props.value，退出时由 completeUnitOfWork 恢复，
    // 支持同级 Provider 隔离和多层 Provider 嵌套覆盖。
    if (renderFn._context) {
      fiber._context = renderFn._context
      fiber._previousContextValue = renderFn._context._currentValue
      renderFn._context._currentValue = fiber.props.value
    }

    const child = renderFn(fiber.props)
    fiber.memoizedElement = child
    reconcileChildren(fiber, Array.isArray(child) ? child : [child])
  }

  /**
   * updateHostComponent —— 渲染原生 DOM 节点或 Fragment。
   *
   * Fragment（'__fragment__'）：
   *   不创建 DOM 节点，直接协调 props.children。
   *   commitWork 遇到 dom === null 时会向上找最近有 DOM 的祖先作为插入点。
   *
   * 普通 DOM 元素（'div'、'span' 等）：
   *   首次渲染（dom === null）→ createDom 创建真实 DOM；
   *   后续更新（dom 已存在）→ 沿用旧 DOM，updateDom 只更新 props 差异。
   *   两种情况下都需要调用 reconcileChildren 继续协调子树。
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
  // § 6  RECONCILER（协调 / Diff 算法）
  // ─────────────────────────────────────────────────────────────

  /**
   * reconcileChildren —— 对比旧 Fiber 链与新 Element 列表，标记 effectTag。
   *
   * ── 匹配策略（O(n) 复杂度）──────────────────────────────────────
   *   有 key  → keyedOldFibers Map 查找，O(1)
   *   无 key  → unkeyedOldFibers 数组 + unkeyedIdx 单向推进，O(n) total
   *   usedOldFibers Set 防止同一旧 Fiber 被匹配两次
   *
   * ── effectTag 含义 ───────────────────────────────────────────────
   *   UPDATE    —— 新旧类型相同，复用 DOM 节点，commitWork 只更新 props
   *   PLACEMENT —— 新节点（无对应旧节点 / 类型变了），commitWork 创建并插入 DOM
   *   DELETION  —— 旧节点无对应新元素，推入 deletions 列表，commit 时移除
   *
   * ── Bug 修复（v2）────────────────────────────────────────────────
   *   原版使用 `index === 0` 判断"第一个新 Fiber"。
   *   当 elements[0] 为 null（条件渲染）时，早返回导致 prevSibling 仍为 null；
   *   后续非 null 元素因 `index !== 0` 且 `prevSibling === null` 而无法被链接，
   *   wipFiber_.child 也永远不会被设置，整个子树丢失。
   *
   *   修复：改为 `!prevSibling` 检测"尚未链接第一个有效 Fiber"，
   *   与 element 在 elements 中的下标无关，正确处理首位为 null 的情况。
   */
  function reconcileChildren(wipFiber_, elements) {
    const keyedOldFibers   = new Map()  // key → oldFiber（有 key 的旧 Fiber）
    const unkeyedOldFibers = []         // 无 key 的旧 Fiber，按出现顺序排列
    const usedOldFibers    = new Set()  // 已匹配的旧 Fiber（防止重复使用）
    let prevSibling = null
    let unkeyedIdx  = 0

    // 把旧 Fiber 链拆分为"有 key"和"无 key"两类
    let oldFiber = wipFiber_.alternate?.child
    while (oldFiber) {
      const key = getFiberKey(oldFiber)
      if (key !== null) keyedOldFibers.set(key, oldFiber)
      else unkeyedOldFibers.push(oldFiber)
      oldFiber = oldFiber.sibling
    }

    elements.forEach(element => {
      // null / undefined / false → 跳过，不产生 Fiber（条件渲染）
      if (!element) return

      const key = getElementKey(element)
      let oldMatch

      if (key !== null) {
        // 有 key：Map O(1) 查找
        oldMatch = keyedOldFibers.get(key)
      } else {
        // 无 key：按顺序消费 unkeyedOldFibers，跳过已被使用的槽位
        while (unkeyedIdx < unkeyedOldFibers.length &&
               usedOldFibers.has(unkeyedOldFibers[unkeyedIdx])) unkeyedIdx++
        oldMatch = unkeyedOldFibers[unkeyedIdx]
        if (oldMatch) unkeyedIdx++
      }

      const sameType = oldMatch && element.type === oldMatch.type
      let newFiber

      if (sameType) {
        // UPDATE：类型相同，复用旧 DOM 节点，只更新 props
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
        // PLACEMENT：新节点或类型改变，需创建 DOM
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
        // DELETION：旧节点没有对应的新元素，标记删除
        oldMatch.effectTag = 'DELETION'
        deletions.push(oldMatch)
        usedOldFibers.add(oldMatch)
      }

      // 链接新 Fiber 到父节点的 child 链
      // 修复：用 !prevSibling 而非 index === 0，
      //       当 elements 首位为 null 时后续节点仍能正确挂载
      if (!prevSibling) wipFiber_.child = newFiber
      else prevSibling.sibling = newFiber
      prevSibling = newFiber
    })

    // 所有新元素匹配完毕，剩余未被匹配的旧 Fiber 全部标记删除
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
   * commitRoot —— 提交阶段入口（同步、不可中断）。
   *
   * 三阶段提交（与真实 React 对齐）：
   *
   *   Phase 1 — Mutation（DOM 突变）
   *     commitWork 递归处理所有 Fiber：插入 / 更新 / 删除真实 DOM 节点
   *     normalizeHostChildren 修正 keyed diff 后的 DOM 节点物理顺序
   *
   *   Phase 2 — Layout（布局副作用，同步）
   *     commitAllLayoutEffects 同步执行所有 useLayoutEffect 回调
   *     此时 DOM 已更新但浏览器尚未绘制，可安全读取 DOM 尺寸/位置
   *     layout effect 触发的 setState → flushSyncWork 立即同步完成渲染
   *
   *   Phase 3 — Passive（被动副作用，异步）
   *     setTimeout 延后到浏览器绘制后，批量执行所有 useEffect 回调
   *     不阻塞 UI 绘制，适合数据请求、订阅、日志等操作
   *
   * isCommitting 标志：
   *   mutation pass 期间置为 true，阻止期间的 setState 立即创建新 wipRoot
   *   （例如 ref 回调触发 setState）；改为设 pendingRerender，commit 末尾重新触发。
   *
   * pendingPassiveRoots 用列表而非版本号的原因：
   *   flushSyncWork() 可能在同一调用栈内再次触发 commitRoot（layout effect → setState），
   *   那次 commit 的 useEffect 均为 null（deps 未变），而本次 commit 的可能是非 null
   *   （首次 mount）。两批 effects 必须分别保留，不能被合并或覆盖。
   */
  function commitRoot() {
    const finishedRoot = wipRoot
    isCommitting = true

    // Phase 1: Mutation —— 删除旧节点，插入/更新新节点，修正顺序
    deletions.forEach(fiber => commitWork(fiber))
    commitWork(finishedRoot.child)
    normalizeHostChildren(finishedRoot)

    // 切换双缓冲树：wip 树升格为 current 树
    currentRoot  = finishedRoot
    wipRoot      = null
    isCommitting = false

    // Phase 2: Layout —— useLayoutEffect 同步执行（DOM 就绪，未绘制）
    commitAllLayoutEffects(finishedRoot.child)

    // layout effect 内触发的 setState 必须同步提交，
    // 避免浏览器先绘制不一致的中间状态（layout effect 的语义保证）
    flushSyncWork()

    // Phase 3: Passive —— useEffect 延后到浏览器绘制后执行
    pendingPassiveRoots.push(finishedRoot.child)
    if (!passiveFlushScheduled) {
      passiveFlushScheduled = true
      setTimeout(() => {
        passiveFlushScheduled = false
        const roots = pendingPassiveRoots.splice(0)
        roots.forEach(root => flushPassiveEffects(root))
      }, 0)
    }

    // 处理首次 commit 前 / mutation 阶段中被延后的 setState
    if (pendingRerender) {
      pendingRerender = false
      scheduleRerender()
    }
  }

  /**
   * commitWork —— Mutation pass：递归处理每个 Fiber 的 DOM 操作。
   *
   * 函数组件 / Fragment 没有 dom（dom === null），
   * 需向上遍历 return 链找到最近有真实 DOM 的祖先作为父容器。
   *
   * Bug 修复（v2）：
   *   原版 while 循环无 null 守卫：
   *     while (!domParentFiber.dom) domParentFiber = domParentFiber.return
   *   若从根部到顶端都无 dom（理论上不应发生，但防御性编程），会抛 NullPointerError。
   *   修复：改为 while (domParentFiber && !domParentFiber.dom)，并用可选链 ?. 保护。
   *
   * PLACEMENT：新节点追加到父容器末尾（normalizeHostChildren 事后修正顺序）
   * UPDATE：复用旧 DOM，updateDom 最小化更新属性/事件/ref
   * DELETION：runUnmountEffects 递归清理 effects + ref，再 removeDomNodes 移除 DOM
   *            删除后不继续遍历子树（子节点由 commitDeletion 内部递归处理）
   */
  function commitWork(fiber) {
    if (!fiber) return

    // 向上找最近有真实 DOM 的祖先（函数组件 / Fragment 的 dom 为 null）
    let domParentFiber = fiber.return
    while (domParentFiber && !domParentFiber.dom) domParentFiber = domParentFiber.return
    const parentDom = domParentFiber?.dom

    if (fiber.effectTag === 'PLACEMENT' && fiber.dom) {
      if (parentDom) parentDom.appendChild(fiber.dom)
    } else if (fiber.effectTag === 'UPDATE' && fiber.dom) {
      updateDom(fiber.dom, fiber.alternate.props, fiber.props)
    } else if (fiber.effectTag === 'DELETION') {
      if (parentDom) commitDeletion(fiber, parentDom)
      return  // 删除后不再遍历子树
    }

    commitWork(fiber.child)
    if (fiber.dom) normalizeHostChildren(fiber)
    commitWork(fiber.sibling)
  }

  /**
   * normalizeHostChildren —— 修正 keyed diff 后 DOM 节点的物理顺序。
   *
   * 背景：
   *   keyed reconciler 在 UPDATE 时复用旧 DOM 节点但不移动它；
   *   commitWork 只更新 props，不调整 DOM 位置。
   *   例如旧顺序 [A,B,C] 变为 [C,A,B]，A/B/C 三个 DOM 节点被复用（UPDATE），
   *   但它们在 DOM 中的位置仍是 [A,B,C]，需要此函数修正为 [C,A,B]。
   *
   * 算法：
   *   1. collectDirectHostChildren 收集"此 Fiber 的直接宿主子 DOM 节点"列表
   *      （跳过函数组件 / Fragment，穿透到它们的真实 DOM 后代）
   *   2. cursor 从父 DOM 的 firstChild 开始顺序扫描
   *   3. 若期望的 DOM 已在 cursor 位置 → 不操作，cursor 前进
   *   4. 否则 insertBefore(dom, cursor) → 将节点移到正确位置
   *
   * insertBefore 天然支持同父节点内的移动（无需先 removeChild）。
   */
  function normalizeHostChildren(parentFiber) {
    if (!parentFiber?.dom) return
    const doms = []
    collectDirectHostChildren(parentFiber.child, doms)
    let cursor = parentFiber.dom.firstChild
    doms.forEach(dom => {
      if (dom.parentNode === parentFiber.dom && dom === cursor) {
        cursor = cursor.nextSibling
        return
      }
      parentFiber.dom.insertBefore(dom, cursor)
    })
  }

  /**
   * collectDirectHostChildren —— 收集 Fiber 子树中"第一层"真实 DOM 节点。
   *
   * 遇到有 dom 的 Fiber（原生 DOM 节点）→ 收集该 dom，停止向下（子节点归它管）。
   * 遇到无 dom 的 Fiber（函数组件 / Fragment）→ 递归进入其 child 继续寻找。
   * 横向通过 sibling 遍历所有兄弟节点。
   */
  function collectDirectHostChildren(fiber, doms) {
    let node = fiber
    while (node) {
      if (node.dom) {
        doms.push(node.dom)
      } else {
        collectDirectHostChildren(node.child, doms)
      }
      node = node.sibling
    }
  }

  /**
   * commitAllLayoutEffects —— Layout pass：同步执行 useLayoutEffect。
   *
   * 遍历顺序：DFS（先 child 后 sibling），即子组件的 layoutEffect 先于父组件执行。
   * 每个 hook：先运行旧的 cleanup，再运行新的 callback；callback 返回值为新 cleanup。
   * hook.callback 执行后置 null，避免同一 effect 被重复执行。
   *
   * ⚠️ 与真实 React 的差异：
   *   真实 React 先对所有 Fiber 运行 cleanup（unmountLayoutEffects），
   *   再对所有 Fiber 运行 setup（mountLayoutEffects）。
   *   此实现按 Fiber 顺序依次 cleanup→run，多组件场景下 cleanup 和 run
   *   的相对顺序可能与真实 React 不一致。
   */
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

  /**
   * flushPassiveEffects —— Passive pass：异步执行 useEffect。
   *
   * 在 setTimeout 中调用（浏览器完成绘制后），不阻塞 UI。
   * 逻辑与 commitAllLayoutEffects 相同，仅通过 _isEffect 区分类型。
   *
   * ⚠️ 与真实 React 的差异：同 commitAllLayoutEffects 说明。
   */
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

  /**
   * runUnmountEffects —— 卸载时递归运行所有副作用清理函数，并清空 ref。
   *
   * useEffect / useLayoutEffect 的 cleanup 在组件卸载时必须执行，
   * 防止订阅 / 定时器 / 监听器泄漏。
   * ref 清空（setRef(ref, null)）对应 React 在卸载时的 ref = null 行为，
   * 让引用方知道该 DOM 节点已不可用。
   */
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

  /**
   * removeDomNodes —— 删除函数组件 / Fragment 时，递归移除所有真实 DOM 后代。
   *
   * 函数组件本身 dom === null，需向下找所有有 dom 的后代并逐一移除。
   * 找到有 dom 的节点后停止向下（子节点跟随父 dom 一起被浏览器移除，无需显式删除）。
   * parentNode 检查防止二次删除（节点可能已被父节点的 removeChild 间接移除）。
   */
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

  const isEvent = k => k.startsWith('on')
  const isProp  = k => k !== 'children' && k !== 'key' && k !== 'ref' && !isEvent(k)
  const isNew   = (prev, next) => k => prev[k] !== next[k]
  const isGone  = (_, next) => k => !(k in next)

  // React 事件名为驼峰（onDoubleClick），DOM 事件名为小写（dblclick）；
  // doubleclick → dblclick 是一个常见的标准差异，需要显式映射。
  const eventAliases = { doubleclick: 'dblclick' }
  const toEventName  = name => { const n = name.slice(2).toLowerCase(); return eventAliases[n] || n }

  /**
   * updateDom —— 最小化地将新旧 props 差异应用到真实 DOM。
   *
   * 处理顺序（顺序本身是正确性保证）：
   *   1. ref 变更时先清空旧 ref（避免旧 ref 暂时指向错误节点）
   *   2. 移除消失的旧事件监听（先移后加，防止重复绑定）
   *   3. 清除消失的旧属性
   *      - style 单独处理（updateStyle 防止残留样式）
   *      - 其他属性置为 ''（DOM property 赋空值是标准做法）
   *   4. 设置新增或变化的属性
   *      - className → dom.className（避开 JS 关键字 class）
   *      - style     → updateStyle（支持对象和字符串两种形式）
   *      - 其他      → dom[k] = v（利用 DOM property 语义，优于 setAttribute）
   *   5. 添加新事件监听
   *   6. ref 变更时赋值新 ref（DOM 已完全更新后再赋，保证引用有效）
   */
  function updateDom(dom, prevProps, nextProps) {
    if (prevProps.ref !== nextProps.ref) setRef(prevProps.ref, null)

    // 移除旧事件监听
    Object.keys(prevProps).filter(isEvent)
      .filter(k => !(k in nextProps) || isNew(prevProps, nextProps)(k))
      .forEach(k => dom.removeEventListener(toEventName(k), prevProps[k]))

    // 清除消失的属性
    Object.keys(prevProps).filter(isProp).filter(isGone(prevProps, nextProps))
      .forEach(k => { if (k === 'style') updateStyle(dom, prevProps.style, null); else dom[k] = '' })

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

  /**
   * updateStyle —— 精细更新 DOM 的 style 属性，支持对象和字符串两种形式。
   *
   * 场景覆盖：
   *   字符串 → 字符串：直接覆盖 cssText（最快路径）
   *   对象   → 对象：先清除 prev 中有但 next 中无的 key（置 ''），再 Object.assign
   *   对象   → null/字符串：先清空 cssText，再按字符串处理
   *   字符串 → 对象：先清空 cssText（防残留），再 Object.assign
   *   任何   → null：只清空（上面清除消失属性时 updateStyle(dom, prev, null) 调用）
   */
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

  /**
   * setRef —— 统一处理函数 ref 和对象 ref。
   *   函数 ref：调用 ref(value)（回调 ref 模式）
   *   对象 ref：赋值 ref.current = value（createRef / useRef 模式）
   * value 为 null 时表示清空（组件卸载或 ref 变更时调用）。
   */
  function setRef(ref, value) {
    if (!ref) return
    if (typeof ref === 'function') ref(value)
    else ref.current = value
  }

  /**
   * createDom —— 根据 Fiber 类型创建对应的真实 DOM 节点。
   *   TEXT_ELEMENT → document.createTextNode('')（内容由 nodeValue 属性赋值）
   *   其他         → document.createElement(type)
   * 创建后立即调用 updateDom({}, props) 应用初始属性、事件监听和 ref。
   */
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
  // 所有 hook 均依赖两个渲染期全局变量：
  //   wipFiber  —— 当前渲染的函数组件 Fiber
  //   hookIndex —— 当前 hook 的顺序下标
  //
  // "hook 只能在函数组件顶层调用"的根本原因：
  //   每次渲染时 hookIndex 从 0 单调递增，通过下标访问 alternate.hooks[hookIndex]
  //   读取上次对应位置的旧状态。若在条件/循环中调用 hook，下标错位后读到错误状态。
  // ─────────────────────────────────────────────────────────────

  /**
   * useReducer —— 所有状态管理 hook 的核心实现。
   *
   * 首次渲染（oldHook 不存在）：
   *   用 initialState（或 init(initialState) 惰性初始化）创建 hook，queue 为空。
   *
   * 后续渲染（oldHook 存在）：
   *   沿用旧 hook.state；queue.splice(0) 消费并清空所有待处理 action，
   *   依次 reduce 得到最新 state。
   *
   * splice(0) vs slice(0)：
   *   slice(0)  —— 只读取，不清空；下次渲染会重复 reduce 同一批 action（经典 bug）
   *   splice(0) —— 读取且清空；每批 action 只被 reduce 一次（正确行为）
   *
   * dispatch 工作原理：
   *   把 action 追加到 hook.queue，调用 scheduleRerender 异步触发重渲染。
   *   不直接修改 state——状态更新是"不可变的意图登记"，渲染时才 reduce 出新值，
   *   与 React 的批量更新模型（batching）一致。
   *
   * 多次快速 dispatch：
   *   每次 dispatch 都向同一个 queue 追加 action；scheduleRerender 是幂等的，
   *   多次调用只重复设置 nextUnitOfWork。下次渲染时所有 action 一次性 reduce，
   *   天然实现批量更新（类似 React 18 的 automatic batching）。
   */
  function useReducer(reducer, initialState, init) {
    const oldHook = wipFiber.alternate?.hooks?.[hookIndex]
    const queue   = oldHook ? oldHook.queue : []

    const hook = {
      state: oldHook ? oldHook.state : (init ? init(initialState) : initialState),
      queue,
    }

    // 消费并清空队列（splice(0) 同时完成两件事）
    queue.splice(0).forEach(action => {
      hook.state = reducer(hook.state, action)
    })

    const dispatch = action => { hook.queue.push(action); scheduleRerender() }

    wipFiber.hooks.push(hook)
    hookIndex++
    return [hook.state, dispatch]
  }

  /**
   * useState —— useReducer 的语法糖，reducer 固定为"赋新值或调用更新函数"。
   *
   * setState(newValue)         → state = newValue
   * setState(prev => prev + 1) → state = prev + 1（函数式更新，避免闭包旧值问题）
   *
   * 惰性初始化：useState(() => expensiveCompute())
   *   → resolveInitialState 检测函数并调用，仅在首次渲染执行一次，
   *   避免每次渲染都计算昂贵的初始值（即使后续渲染不会使用它）。
   */
  function useState(initialState) {
    return useReducer(
      (state, action) => typeof action === 'function' ? action(state) : action,
      initialState,
      resolveInitialState,
    )
  }

  /**
   * useEffect —— 被动副作用（Passive Effect），异步执行。
   *
   * 执行时机：浏览器完成绘制后（setTimeout 延后），不阻塞 UI 渲染。
   * 适合：数据请求、事件订阅、日志、外部库集成等不需要立即读写 DOM 的操作。
   *
   * deps 语义：
   *   不传 deps（undefined） → 每次渲染后都执行
   *   []                    → 仅在 mount 时执行（componentDidMount 等价）
   *   [a, b]                → a 或 b（Object.is）改变时执行
   *
   * 清理函数（cleanup）：
   *   callback 可 return 一个函数，在下次 effect 执行前 / 组件卸载时自动调用。
   *   典型：return () => subscription.unsubscribe()
   *
   * hook 存储字段：
   *   _isEffect  —— 类型标记，区分 useEffect / useLayoutEffect / 其他
   *   deps       —— 依赖项数组（下次渲染时 haveDepsChanged 对比）
   *   cleanup    —— 上次执行留下的清理函数（null 表示无需清理）
   *   callback   —— 本次需要执行的副作用函数（deps 未变则为 null，跳过执行）
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
   * useLayoutEffect —— 布局副作用（Layout Effect），同步执行。
   *
   * 执行时机：DOM 突变完成后、浏览器绘制前，同步阻塞主线程。
   * 适合：读取 / 修改 DOM 布局（测量高度、强制滚动位置、同步动画起始值等）。
   *
   * 与 useEffect 的唯一区别是执行时机：
   *   useLayoutEffect → commitAllLayoutEffects（DOM 就绪，未绘制，同步）
   *   useEffect       → flushPassiveEffects（setTimeout，绘制后，异步）
   *
   * 注意：useLayoutEffect 会阻塞浏览器绘制，过重的计算会造成卡顿；
   * 非必要不使用，数据请求等操作一律放 useEffect。
   * SSR 场景中使用会产生警告（服务端无 DOM），可改用 useEffect 或条件判断。
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
   * useMemo —— 缓存昂贵计算的结果，deps 不变时跳过重新计算。
   *
   * 首次渲染（oldHook 不存在）：
   *   haveDepsChanged(undefined, deps) 返回 true → 总是调用 factory()。
   *
   * 后续渲染：
   *   deps 变化 → 重新调用 factory()，存入 hook.value
   *   deps 不变 → 直接返回 oldHook.value（不调用 factory）
   *
   * 约束：factory 必须是纯函数（无副作用），有副作用请用 useEffect。
   * useMemo 是"性能优化提示"，不保证永远不重新计算（此实现会严格遵守 deps）。
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
   * useRef —— 创建在组件生命周期内持久存在的可变容器。
   *
   * 实现：useMemo(() => ({ current: initialValue }), [])
   *   deps = [] → factory 只在 mount 时执行一次，后续渲染返回同一对象引用。
   *   修改 .current 不触发重渲染（ref 对象本身的引用没有改变）。
   *
   * 两大常见用途：
   *   1. 持有 DOM 引用：<div ref={myRef}> → myRef.current = domElement
   *      （mount 时 updateDom 调用 setRef 赋值，unmount 时清空为 null）
   *   2. 跨渲染存储可变值：如 setInterval ID、上一次的 props、中止信号等
   *
   * useRef vs createRef：
   *   useRef  —— 与 Fiber 绑定，同一组件实例始终返回相同对象（hooks 机制保证）
   *   createRef —— 每次调用返回全新对象，适合类组件或组件外使用
   */
  function useRef(initialValue) {
    return useMemo(() => ({ current: initialValue }), [])
  }

  /**
   * useCallback —— 缓存函数引用，避免子组件因新函数引用而不必要地重渲染。
   *
   * useCallback(fn, deps) 等价于 useMemo(() => fn, deps)。
   * 缓存的是函数引用本身，不缓存调用结果（与 useMemo 的本质区别）。
   *
   * 典型场景：将回调传给被 memo 包裹的子组件时，
   * 若父组件重渲染但 deps 未变，子组件因回调引用不变而跳过重渲染。
   * 若没有 useCallback，父组件每次渲染都创建新函数引用，memo 永远失效。
   */
  function useCallback(callback, deps) {
    return useMemo(() => callback, deps)
  }

  /**
   * useId —— 生成组件实例稳定的唯一 ID（格式：':r0:'、':r1:' 等）。
   *
   * 实现：useMemo + [] 保证同一组件实例在所有渲染中返回相同 ID；
   * idCounter 全局单调自增，保证不同组件实例之间 ID 不冲突。
   *
   * 主要用途：关联 <label htmlFor="id"> 与 <input id="id">，
   * 当同一组件存在多个实例时避免 ID 重复（innerHTML 或列表渲染场景）。
   *
   * 注意：SSR 场景需要服务端/客户端 ID 保持一致（hydration），
   * 此实现纯客户端，不支持 SSR hydration。
   */
  function useId() {
    return useMemo(() => `:r${idCounter++}:`, [])
  }

  // ─────────────────────────────────────────────────────────────
  // § 10  CONTEXT（跨层级传值）
  // ─────────────────────────────────────────────────────────────

  /**
   * createContext —— 创建跨层级数据传递通道。
   *
   * 返回的 ctx 对象：
   *   _currentValue  —— 当前活跃的 context 值（Provider 渲染期动态修改）
   *   Provider       —— 注入新值的包裹组件（传 value prop）
   *   Consumer       —— render props 形式的消费组件（已被 useContext 替代）
   *
   * 实现原理（渲染期栈恢复）：
   *   Provider 函数上挂有 _context 引用（见 Provider._context = ctx）；
   *   updateFunctionComponent 渲染 Provider 时：
   *     进入（beginWork）：保存 _currentValue 旧值 → 注入 fiber.props.value
   *     退出（completeWork）：恢复 _currentValue 旧值
   *   子树 DFS 渲染期间 _currentValue 始终是最近 Provider 的值；
   *   useContext 直接读取 _currentValue，无需订阅/发布机制。
   *
   * 多层 Provider 嵌套：
   *   内层 Provider 进入时保存外层的值，退出时恢复，形成栈式隔离，
   *   兄弟节点之间也正确隔离（DFS 保证 completeWork 在进入兄弟节点前执行）。
   *
   * ⚠️ 已知限制：
   *   1. useContext 无精确订阅：若消费者被 memo 包裹，可能错过 context 更新
   *      （真实 React 对 useContext 消费者绕过 memo 做了特殊处理）
   *   2. 无法跨异步边界传递（此实现为同步 DFS，无此问题）
   */
  function createContext(defaultValue) {
    function Provider({ children }) {
      // Provider 函数本身只负责渲染 children；
      // value 的注入由 updateFunctionComponent 中 renderFn._context 分支完成
      // （读取 fiber.props.value 并写入 ctx._currentValue），无需在此函数体内使用。
      if (children == null) return null
      return Array.isArray(children)
        ? createElement(Fragment, null, ...children)
        : children
    }
    Provider._context = null  // 先占位，下方赋 ctx 引用（避免循环引用顺序问题）

    const ctx = {
      _currentValue: defaultValue,
      Provider,

      /**
       * Consumer —— render props 形式的 context 消费者（较老的 API）。
       * children 必须是函数：(value) => ReactElement
       * 直接读取 ctx._currentValue（渲染期已由 Provider 注入正确值）。
       * 推荐使用 useContext 替代，更简洁直观。
       */
      Consumer({ children }) {
        return children(ctx._currentValue)
      },
    }
    Provider._context = ctx
    return ctx
  }

  /**
   * useContext —— 读取最近 Provider 注入的 context 值。
   *
   * 实现：直接返回 context._currentValue。
   * 渲染期 DFS 保证：此时 _currentValue 已被最近的祖先 Provider 更新为正确值。
   * 若无 Provider 祖先，返回 createContext 时传入的 defaultValue。
   *
   * 占位 hook（{ _isContext: true }）：
   *   确保 hookIndex 在所有 hook 调用中保持连续递增，
   *   避免 useContext 与其他 hook 在 hooks 数组中的下标错位。
   *
   * ⚠️ 不触发订阅式重渲染：
   *   只有当消费者的祖先重渲染（导致 Provider 重渲染并更新 _currentValue），
   *   消费者才跟着重渲染并读取新值。
   *   若消费者被 memo 包裹，即使 context 变化，也可能不会重渲染。
   */
  function useContext(context) {
    wipFiber.hooks.push({ _isContext: true })  // 占位，保持 hookIndex 连续
    hookIndex++
    return context._currentValue
  }

  // ─────────────────────────────────────────────────────────────
  // § 11  渲染入口
  // ─────────────────────────────────────────────────────────────

  /**
   * render —— 将 React 元素树挂载到真实 DOM 容器（首次或后续更新均可）。
   *
   * 工作流程：
   *   1. 创建 wipRoot（以容器 DOM 为 dom，alternate 指向上次 currentRoot）
   *   2. 清空 deletions 列表
   *   3. 设置 nextUnitOfWork = wipRoot（启动 render 阶段游标）
   *   4. 调度 workLoop（浏览器空闲时开始处理）
   *
   * render 本身不同步执行渲染，只是"投递"工作给 workLoop，
   * 实际渲染在浏览器空闲时发生。如需立即渲染，使用 flushSync。
   *
   * 多次调用 render（如 React 18 的 root.render）会创建新的 wipRoot，
   * alternate 指向最新 currentRoot，实现增量更新（而非每次重建整棵树）。
   */
  function render(element, container) {
    wipRoot = {
      dom:       container,
      props:     { children: [element] },
      alternate: currentRoot,
    }
    deletions      = []
    nextUnitOfWork = wipRoot
    scheduleWorkLoop()
  }

  /**
   * flushSync —— 同步立即执行 callback 并提交所有待处理的状态更新。
   *
   * 使用场景：需要在某个操作后立即读取更新后的 DOM。
   *   例：添加列表项后立刻滚动到底部（若用异步 render，滚动时 DOM 尚未更新）。
   *
   * 工作原理：
   *   callback() 内的 setState → scheduleRerender → nextUnitOfWork 入队
   *   flushSyncWork → 同步跑完所有 Fiber → 同步 commitRoot
   *   callback 返回时 DOM 已更新完毕，可安全读取新布局。
   *
   * ⚠️ 注意事项：
   *   - 不能嵌套调用（内层 flushSync 会在外层 commitRoot 完成前触发，导致状态混乱）
   *   - 会阻塞浏览器绘制，非必要不使用
   *   - 内部 setState 立即同步执行，不同于正常 setState 的异步批量模式
   */
  function flushSync(callback) {
    callback()
    flushSyncWork()
  }

  // ─────────────────────────────────────────────────────────────
  // § 12  内部工具函数
  // ─────────────────────────────────────────────────────────────

  /**
   * scheduleRerender —— setState / dispatch 调用后，安排一次完整的重渲染。
   *
   * 两种延后情况（不能立即建立 wipRoot）：
   *   a. currentRoot === null：首次 commit 尚未完成，current 树还不可用
   *   b. isCommitting === true：mutation pass 正在进行，wipRoot 刚被置 null
   *   这两种情况设 pendingRerender = true，commitRoot 末尾重新触发。
   *
   * 正常情况：
   *   克隆 currentRoot 建立新 wipRoot（alternate = currentRoot），
   *   清空 deletions，设置 nextUnitOfWork，调度 workLoop。
   *
   * 多次快速 setState 的批量效果：
   *   每次 dispatch 向 hook.queue 追加 action，然后重建 wipRoot。
   *   多次重建 wipRoot 是幂等的（nextUnitOfWork 被反复设置为同一逻辑起点），
   *   queue 累积所有 action，下次渲染时一次性 reduce，天然实现批量更新。
   */
  function scheduleRerender() {
    if (!currentRoot || isCommitting) {
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
    scheduleWorkLoop()
  }

  /**
   * flushSyncWork —— 同步跑完当前所有待处理 Fiber 并提交。
   * 用于：flushSync API 和 layout effect 后的同步提交（防止中间状态被绘制）。
   */
  function flushSyncWork() {
    while (nextUnitOfWork) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork)
    }
    if (wipRoot) commitRoot()
  }

  /**
   * scheduleWorkLoop —— 注册一次 requestIdleCallback（防止重复注册）。
   * workLoopScheduled 标志确保同一时间最多只有一个待执行的 workLoop 回调。
   */
  function scheduleWorkLoop() {
    if (workLoopScheduled) return
    workLoopScheduled = true
    requestIdle(workLoop)
  }

  /** 判断 Fiber 是否为函数组件（type 为函数，涵盖普通函数组件和 memo 包裹组件） */
  const isFunctionComponent = fiber => typeof fiber.type === 'function'

  /**
   * memo —— 高阶组件，跳过 props 未变化的函数组件渲染（性能优化）。
   *
   * 返回值是函数（Memoized），而非对象，确保 isFunctionComponent 能正确识别。
   * 关键元数据挂在函数属性上：
   *   _isMemo     —— 标记这是 memo 组件，updateFunctionComponent 据此走 bailout 路径
   *   _type       —— 原始组件函数（bailout 失败时调用它渲染）
   *   _compare    —— props 比较函数（默认浅比较 shallowEqualProps）
   *   displayName —— 调试用名称（DevTools 显示）
   *
   * bailout 条件（两者同时满足）：
   *   1. hook.queue 为空（无待处理 state 更新）
   *   2. _compare(oldProps, newProps) 返回 true（props 未变化）
   *
   * 自定义比较函数：memo(Component, (prev, next) => shallowEqual(prev, next))
   *   可实现深比较或忽略特定 prop 的比较逻辑。
   *
   * ⚠️ memo + useContext 的已知限制：
   *   memo 可能阻止 context 变化触发的重渲染（见 useContext 说明）。
   */
  function memo(component, compare) {
    function Memoized(props) { return component(props) }
    Memoized._isMemo     = true
    Memoized._type       = component
    Memoized._compare    = compare || shallowEqualProps
    Memoized.displayName = `memo(${component.name || 'Component'})`
    return Memoized
  }

  /**
   * shallowEqualProps —— 浅比较两个 props 对象（Object.is 逐 key 比较 value）。
   *
   * 特殊处理：children 均为空数组时视为相等。
   * 原因：createElement 每次调用都创建新的 children 数组引用（即使内容为空），
   * 若父组件未传 children（children: []），memo 会因引用不同而永远无法命中 bailout。
   */
  function shallowEqualProps(prevProps, nextProps) {
    const pk = Object.keys(prevProps)
    const nk = Object.keys(nextProps)
    if (pk.length !== nk.length) return false
    return pk.every(k => {
      if (!Object.prototype.hasOwnProperty.call(nextProps, k)) return false
      const a = prevProps[k], b = nextProps[k]
      // 空 children 数组特例：引用不同但语义相同，视为相等
      if (k === 'children' && Array.isArray(a) && Array.isArray(b) && !a.length && !b.length) return true
      return Object.is(a, b)
    })
  }

  /**
   * haveDepsChanged —— 判断 effect/memo 的依赖项是否发生变化。
   *
   * 规则：
   *   prevDeps 或 nextDeps 为 null/undefined → true（总是视为变化，每次执行）
   *   两者长度不同 → true
   *   任意位置元素 Object.is 不等 → true
   *
   * Object.is 与 === 的区别：
   *   Object.is(NaN, NaN) === true（NaN 视为相等，避免 NaN dep 无限触发）
   *   Object.is(+0, -0)  === false（+0 与 -0 视为不等）
   */
  function haveDepsChanged(prevDeps, nextDeps) {
    if (!prevDeps || !nextDeps) return true
    if (prevDeps.length !== nextDeps.length) return true
    return nextDeps.some((d, i) => !Object.is(d, prevDeps[i]))
  }

  /** resolveInitialState —— useState 惰性初始化：传函数则调用，否则直接用值 */
  function resolveInitialState(s) { return typeof s === 'function' ? s() : s }

  /** getElementKey / getFiberKey —— 安全读取 key（返回 null 表示无 key） */
  function getElementKey(el) { return el?.props?.key ?? null }
  function getFiberKey(f)    { return f?.props?.key  ?? null }

  /**
   * createRef —— 创建独立的可变 ref 对象（不依赖 hooks，可在组件外使用）。
   *
   * 与 useRef 区别：
   *   useRef  —— 与 Fiber 绑定，同一组件实例始终返回同一对象
   *   createRef —— 每次调用返回全新对象，适合类组件构造函数或模块级变量
   */
  function createRef(initialValue = null) { return { current: initialValue } }

  /**
   * Children —— 安全操作 children prop 的工具集。
   *
   * children 可能是单个节点、数组、嵌套数组、null/undefined，
   * 这些工具统一展平并过滤无效值，提供稳定的遍历接口。
   *
   * toArray  —— 展平为一维数组，过滤 null/undefined（不过滤 false，保留可能的 Element）
   * map      —— 类似 Array.map，返回新数组
   * forEach  —— 类似 Array.forEach，无返回值
   * count    —— 返回子节点数量
   * only     —— 断言恰好有一个子节点，否则抛出错误（用于封装只接受单子组件的场景）
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
