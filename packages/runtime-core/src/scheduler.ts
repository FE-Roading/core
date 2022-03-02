import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'

export interface SchedulerJob extends Function {
  id?: number
  active?: boolean
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

// 用来控制异步任务的刷新逻辑
let isFlushing = false  // 是否处于刷新中 (这里的刷新, 可以这么理解 存在很多job队列, 只有在上一个job队列内所有job执行完了, 才会去执行下一个job队列)
let isFlushPending = false  // 是否处于刷新准备中

// 是一个根据job.id排序的有序队列，job.id==null的任务会被放置到队列末尾。
const queue: SchedulerJob[] = [] // 主异步任务队列 
let flushIndex = 0  // 主异步任务队列执行 起始坐标

const pendingPreFlushCbs: SchedulerJob[] = []  // 前置任务的准备队列
let activePreFlushCbs: SchedulerJob[] | null = null  // 当开始执行到前置任务队列时, activePreFlushCbs 会把 pendingPreFlushCbs 去重复制一份, 再清空 pendingPreFlushCbs 
let preFlushIndex = 0  // 前置任务队列的起始坐标

const pendingPostFlushCbs: SchedulerJob[] = []  // 后置任务的准备队列
let activePostFlushCbs: SchedulerJob[] | null = null  // 同 activePreFlushCbs
let postFlushIndex = 0  // 后置任务队列的起始坐标

// 创建微任务
const resolvedPromise: Promise<any> = Promise.resolve()  // 完成状态的Promise
let currentFlushPromise: Promise<void> | null = null  // 当前刷新中的promise，在刷新过程中可以将任务放置到刷新后执行(nextTick)

let currentPreFlushParentJob: SchedulerJob | null = null  // 当前前置任务的父job

const RECURSION_LIMIT = 100  // 允许的最大递归调用层级
type CountMap = Map<SchedulerJob, number>  // 记录执行job对应的递归调用次数，用于判断死循环(当job调用次数>RECURSION_LIMIT，则认定进入了死循环。)

// nextTick 实现
export function nextTick<T = void>(
  this: T,
  fn?: (this: T) => void
): Promise<void> {
  // 如果是在任务队列刷新过程中出发的nextTick，则将该任务会在刷新完成后执行；反之，则开启一个微任务
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
// 如果job存在id , 通过二分查找 找到适合的位置
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJobId = getId(queue[middle])
    middleJobId < id ? (start = middle + 1) : (end = middle)
  }

  return start
}

// 将job添加进主任务队列：跟前/后置任务队列添加的区别是，这个要保证任务的顺序
export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  if (
    (!queue.length ||
      !queue.includes(
        job,
        isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
      )) &&
    job !== currentPreFlushParentJob
  ) {  // 长度不为0 或者 当前任务队列中不包含 要插入的job (ps 如果这个job允许递归是可以插入的)
    if (job.id == null) { // job.id不存在则直接放入队列末尾
      queue.push(job)
    } else {
      // 根据job.id查找对应位置并放入队列，确保有序
      queue.splice(findInsertionIndex(job.id), 0, job)
    }

    // 开启任务队列执行准备
    queueFlush()
  }
}

// 开启任务队列执行准备，将清空任务队列的放置到下一个微任务中
function queueFlush() {
  if (!isFlushing && !isFlushPending) {  // 只有在都为false时 才会执行flushJobs
    isFlushPending = true  // 表示即将进行刷新。已将刷新任务队列放置到微任务队列中
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

// 向前/后置任务队列中添加job，
function queueCb(
  cb: SchedulerJobs,
  activeQueue: SchedulerJob[] | null,
  pendingQueue: SchedulerJob[],
  index: number
) {
  if (!isArray(cb)) {
    // 当前 activeQueue 不为null, 或者当前的activeQueue不包括该job, 或者 该job允许递归
    if (
      !activeQueue ||
      !activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)
    ) {
      pendingQueue.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingQueue.push(...cb)
  }

  // 开启任务队列执行准备
  queueFlush()
}

// 添加前置任务
export function queuePreFlushCb(cb: SchedulerJob) {
  queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex)
}
// 添加后置任务
export function queuePostFlushCb(cb: SchedulerJobs) {
  queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex)
}

// 执行前置任务队列
export function flushPreFlushCbs(
  seen?: CountMap,
  parentJob: SchedulerJob | null = null
) {
  // 长度不为0
  if (pendingPreFlushCbs.length) {
    currentPreFlushParentJob = parentJob
    activePreFlushCbs = [...new Set(pendingPreFlushCbs)] // 去重, 备份到activePreFlushCbs
    pendingPreFlushCbs.length = 0 // 清空pending

    if (__DEV__) {
      seen = seen || new Map()
    }
    // 循环执行 队列中的job
    for (
      preFlushIndex = 0;
      preFlushIndex < activePreFlushCbs.length;
      preFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePreFlushCbs[preFlushIndex])
      ) {
        continue
      }
      activePreFlushCbs[preFlushIndex]()
    }
    activePreFlushCbs = null
    preFlushIndex = 0
    currentPreFlushParentJob = null
    // recursively flush until it drains
    // 如果前置任务队列中的job 又有前置任务, 也就是会执行 queuePreFlushCb 然后添加进了pendingPreFlushCbs里面, 
    // 因为前置任务比主任务都要先执行, 所以这里再调用 flushPreFlushCbs 将所有的前置任务执行完
    flushPreFlushCbs(seen, parentJob)
  }
}

// 执行后置任务队列
export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {  // 存在待执行任务
    const deduped = [...new Set(pendingPostFlushCbs)] // 待执行任务队列去重并复制
    pendingPostFlushCbs.length = 0  // 清空待执行任务队列

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 存在 activePostFlushCbs 这种情况比如 mount 里面还有个 mount，放入待执行任务队列后退出
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 升序
    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    // 循环执行后置任务
    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }

    // 还原清空
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

function flushJobs(seen?: CountMap) {
  isFlushPending = false  // 结束准备状态
  isFlushing = true  // 进入执行刷新状态
  if (__DEV__) {
    seen = seen || new Map()
  }
  
  flushPreFlushCbs(seen)  // 执行前置任务队列

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  // 按任务ID升序排列，主要是两点原因：
  // 1、组件更新顺序是先父后子，因此父组件的renderEffect id更小；
  // 2、子组件在父组件更新过程中被卸载后可以被跳过
  queue.sort((a, b) => getId(a) - getId(b))

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  // 在开发环境时，才检测是否存在死循环任务
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    // 循环执行 主队列
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {  // 如果该job执行次数超过100次，则认为该job进入死循环，自动中断该任务而进入下一个任务
          continue
        }
        // console.log(`running:`, job.id)
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    // 重置主任务索引和队列
    flushIndex = 0
    queue.length = 0

    flushPostFlushCbs(seen)  // 执行后置任务

    // 执行完后
    isFlushing = false  // 重置正在刷新的标志位
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    // 如果在 执行主任务队列任务或者后置任务队列中 存在前置/主/后置任务时，重新再次执行一次直至都清空
    if (
      queue.length ||
      pendingPreFlushCbs.length ||
      pendingPostFlushCbs.length
    ) {
      flushJobs(seen)
    }
  }
}

// 通过Map存储更新job执行的次数，主要是为防止任务的死循环执行问题
function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
