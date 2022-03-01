import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

class ComputedRefImpl<T> {
  public dep?: Dep = undefined  // 依赖集合

  private _value!: T  // 原始值
  private _dirty = true  // 表示是否需要重新计算
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true  // computed的类型检测实际为ref类型
  public readonly [ReactiveFlags.IS_READONLY]: boolean  // 是否只读

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean, // 只定义getter则默认为readonly
    isSSR: boolean
  ) {
    
    this.effect = new ReactiveEffect(getter, () => {
      // 当依赖更新后，将_dirty置为true——在下次获取值时需要重新求值。如果本身根本未被使用则进行高操作
      if (!this._dirty) {
        this._dirty = true
        triggerRefValue(this)  // 触发依赖更新
      }
    })
    this.effect.active = !isSSR  // 服务器渲染时，active字段为false
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    // 触发get的依赖收集：ref的函数
    trackRefValue(self)
    // 首次调用时，计算具体的值
    if (self._dirty) {
      self._dirty = false
      self._value = self.effect.run()!  // 运行getter函数来返回结果，并触发依赖收集将computed.effect添加到被引用数据的dep中
    }
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

/**
 * 
 * @param getter 支持两种格式：getter函数，{get(){},set(){}}对象
 * @param debugOptions 
 */
export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  // 如果只传入一个函数，则认为只定义了get，如果设置值时会触发警告
  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter, isSSR)

  if (__DEV__ && debugOptions && !isSSR) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
