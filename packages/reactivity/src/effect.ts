import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively. 记录当前effect所在的递归层级记录
let effectTrackDepth = 0 // 递归层级计数器
export let trackOpBit = 1 // 递归层级的bit记录，可用于位运算提高效率
/**
 * 允许effect执行栈的最大层级
 * The bitwise track markers support at most 30 levels of recursion. 
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 全局 effect 栈
const effectStack: ReactiveEffect[] = []
// 当前激活的 effect
let activeEffect: ReactiveEffect | undefined

// 用于拦截Object.keys(target)这类操作时，添加一个该key进行依赖收集
export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export class ReactiveEffect<T = any> {
  active = true  // 是否激活标志位
  deps: Dep[] = []  // 当前effect的所有dep集合

  // can be attached after creation
  computed?: boolean  // 是否为计算属性
  allowRecurse?: boolean  // 是否允许递归
  onStop?: () => void  // 停止监听时触发
  // dev only
  onTrack?: (event: DebuggerEvent) => void  // 追踪时触发
  // dev only
  onTrigger?: (event: DebuggerEvent) => void  // 触发回调时触发

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,  // 自定义的调度执行函数
    scope?: EffectScope | null
  ) {
    // 在(scope || activeEffectScope)?.active==true时，scope.effects.push(this)
    recordEffectScope(this, scope)
  }

  run() {
    // 如果是未激活状态，直接返回运行结果
    if (!this.active) {
      return this.fn()
    }

    if (!effectStack.includes(this)) {  // 如果全局effect栈未包含当前effect
      try {
        // 将activeEffect置为当前的effect，并放入effect栈
        effectStack.push((activeEffect = this))
        // 开启全局 shouldTrack，允许依赖收集。原值入栈
        enableTracking()
        // 递归层级记录————1 右移（++effectTrackDepth）位：1*2^(++effectTrackDepth)
        trackOpBit = 1 << ++effectTrackDepth

        if (effectTrackDepth <= maxMarkerBits) {
          // 如果未超过允许的最大执行栈层级：将this.deps中的每个dep.w |= trackOpBit
          initDepMarkers(this)
        } else {
          // 超过：清除将this.deps中的每个dep包含的this，并将this.deps=[]
          cleanupEffect(this)
        }
        return this.fn() // 执行结果(在finally执行完成后返回)
      } finally { // effect相关信息还原为之前的状态
        if (effectTrackDepth <= maxMarkerBits) {
          finalizeDepMarkers(this) // 清除effect.deps中(wasTracked && !newTracked)的dep，清理dep.w/n位
        }
        // 递归层级的标志位还原
        trackOpBit = 1 << --effectTrackDepth

        // 恢复 shouldTrack 开启之前的状态
        resetTracking()
        // effect出栈
        effectStack.pop()
        // 指向effect栈最后一个 effect
        const n = effectStack.length
        activeEffect = n > 0 ? effectStack[n - 1] : undefined
      }
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}
// 清空当前effect的deps中的当前effect
function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean                 // 是否延迟触发 effect
  scheduler?: EffectScheduler    // 调度函数
  scope?: EffectScope
  allowRecurse?: boolean         // 是否允许递归
  onStop?: () => void            // 停止监听时触发
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  // 如果已经是 `effect` 先重置为原始对象
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const _effect = new ReactiveEffect(fn)
  // 合并配置
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  // 如果不指定lazy选项，会立即执行一次
  if (!options || !options.lazy) {
    _effect.run()
  }

  // 返回一个effect执行函数(已绑定this指向)，并绑定effect实例属性
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}
// 是否应该收集依赖
let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果不是依赖收集阶段，则直接返回
  if (!isTracking()) {
    return
  }
  // 每个 target 对应一个 depsMap
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  // 每个 key 对应一个 dep 集合
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = createDep()))
  }

  const eventInfo = __DEV__
    ? { effect: activeEffect, target, type, key }
    : undefined

  trackEffects(dep, eventInfo)
}

export function isTracking() {
  return shouldTrack && activeEffect !== undefined
}

export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false  // 是否允许收集依赖
  if (effectTrackDepth <= maxMarkerBits) { // 如果全局effect递归层级深度未超过最大值
    if (!newTracked(dep)) {  // 如果该dep是新创建的，dep.n=trackOpBit
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }

  // 是否允许收集依赖的全局开关
  if (shouldTrack) {
    // 收集当前激活的 effect 作为依赖
    dep.add(activeEffect!)
    // 当前激活的 effect 收集 dep 集合作为依赖
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 通过 targetMap 拿到 target 对应的依赖集合
  const depsMap = targetMap.get(target)
  // 没有依赖，直接返回
  if (!depsMap) {
    // never been tracked
    return
  }

  // 根据操作类型收集所有的deps
  let deps: (Dep | undefined)[] = []
  // 清除操作时，需要触发target的所有依赖
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 如果是通过设置Array.length来改变数组长度，则将大于长度和length的dep放入deps
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE操作之一，添加对应的 effects
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET 迭代相关依赖触发
    switch (type) {
      case TriggerOpTypes.ADD: // add时，对象会触发ITERATE_KEY依赖，map还会多触发MAP_KEY_ITERATE_KEY依赖；数组会触发length依赖
        if (!isArray(target)) { 
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE: // delete时，数组单独触发依赖，map会触发ITERATE_KEY依赖，map还会多触发MAP_KEY_ITERATE_KEY依赖
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET: // set时，针对map出发迭代依赖
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
  // 如果只有一个依赖，则直接遍历执行effect
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    
    // 所有的effect扁平化去重后，执行依赖
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

// 遍历执行 effects
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization：主要针对set时，提取所有的元素到数组用于迭代
  for (const effect of (isArray(dep) ? dep : [...dep])) {
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }

      if (effect.scheduler) {
        // 如果effect定义了调度器，则执行调度器
        effect.scheduler()
      } else {
        // 直接运行
        effect.run()
      }
    }
  }
}
