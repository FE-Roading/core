import { TransformOptions } from './options'
import {
  RootNode,
  NodeTypes,
  ParentNode,
  TemplateChildNode,
  ElementNode,
  DirectiveNode,
  Property,
  ExpressionNode,
  createSimpleExpression,
  JSChildNode,
  SimpleExpressionNode,
  ElementTypes,
  CacheExpression,
  createCacheExpression,
  TemplateLiteral,
  createVNodeCall,
  ConstantTypes,
  ArrayExpression
} from './ast'
import {
  isString,
  isArray,
  NOOP,
  PatchFlags,
  PatchFlagNames,
  EMPTY_OBJ,
  capitalize,
  camelize
} from '@vue/shared'
import { defaultOnError, defaultOnWarn } from './errors'
import {
  TO_DISPLAY_STRING,
  FRAGMENT,
  helperNameMap,
  CREATE_COMMENT
} from './runtimeHelpers'
import { isVSlot, makeBlock } from './utils'
import { hoistStatic, isSingleElementRoot } from './transforms/hoistStatic'
import { CompilerCompatOptions } from './compat/compatConfig'

// There are two types of transforms:
//
// - NodeTransform:
//   Transforms that operate directly on a ChildNode. NodeTransforms may mutate,
//   replace or remove the node being processed.
export type NodeTransform = (
  node: RootNode | TemplateChildNode,
  context: TransformContext
) => void | (() => void) | (() => void)[]

// - DirectiveTransform:
//   Transforms that handles a single directive attribute on an element.
//   It translates the raw directive into actual props for the VNode.
export type DirectiveTransform = (
  dir: DirectiveNode,
  node: ElementNode,
  context: TransformContext,
  // a platform specific compiler can import the base transform and augment
  // it by passing in this optional argument.
  augmentor?: (ret: DirectiveTransformResult) => DirectiveTransformResult
) => DirectiveTransformResult

export interface DirectiveTransformResult {
  props: Property[]
  needRuntime?: boolean | symbol
  ssrTagParts?: TemplateLiteral['elements']
}

// A structural directive transform is a technically a NodeTransform;
// Only v-if and v-for fall into this category.
export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext
) => void | (() => void)

export interface ImportItem {
  exp: string | ExpressionNode
  path: string
}

export interface TransformContext
  extends Required<
      Omit<TransformOptions, 'filename' | keyof CompilerCompatOptions>
    >,
    CompilerCompatOptions {
  selfName: string | null
  root: RootNode
  helpers: Map<symbol, number>
  components: Set<string>
  directives: Set<string>
  hoists: (JSChildNode | null)[]
  imports: ImportItem[]
  temps: number
  cached: number
  identifiers: { [name: string]: number | undefined }
  scopes: {
    vFor: number
    vSlot: number
    vPre: number
    vOnce: number
  }
  parent: ParentNode | null
  childIndex: number
  currentNode: RootNode | TemplateChildNode | null
  inVOnce: boolean
  helper<T extends symbol>(name: T): T
  removeHelper<T extends symbol>(name: T): void
  helperString(name: symbol): string
  replaceNode(node: TemplateChildNode): void
  removeNode(node?: TemplateChildNode): void
  onNodeRemoved(): void
  addIdentifiers(exp: ExpressionNode | string): void
  removeIdentifiers(exp: ExpressionNode | string): void
  hoist(exp: string | JSChildNode | ArrayExpression): SimpleExpressionNode
  cache<T extends JSChildNode>(exp: T, isVNode?: boolean): CacheExpression | T
  constantCache: Map<TemplateChildNode, ConstantTypes>

  // 2.x Compat only
  filters?: Set<string>
}

export function createTransformContext(
  root: RootNode,
  {
    filename = '',
    prefixIdentifiers = false,
    hoistStatic = false,
    cacheHandlers = false,
    nodeTransforms = [],
    directiveTransforms = {},
    transformHoist = null,
    isBuiltInComponent = NOOP,
    isCustomElement = NOOP,
    expressionPlugins = [],
    scopeId = null,
    slotted = true,
    ssr = false,
    inSSR = false,
    ssrCssVars = ``,
    bindingMetadata = EMPTY_OBJ,
    inline = false,
    isTS = false,
    onError = defaultOnError,
    onWarn = defaultOnWarn,
    compatConfig
  }: TransformOptions
): TransformContext {
  const nameMatch = filename.replace(/\?.*$/, '').match(/([^/\\]+)\.\w+$/)
  const context: TransformContext = {
    // options
    selfName: nameMatch && capitalize(camelize(nameMatch[1])),
    prefixIdentifiers,
    hoistStatic,
    cacheHandlers,
    nodeTransforms,
    directiveTransforms,
    transformHoist,
    isBuiltInComponent,
    isCustomElement,
    expressionPlugins,
    scopeId,
    slotted,
    ssr,
    inSSR,
    ssrCssVars,
    bindingMetadata,
    inline,
    isTS,
    onError,
    onWarn,
    compatConfig,

    // state
    root,
    helpers: new Map(),
    components: new Set(),
    directives: new Set(),
    hoists: [],
    imports: [],
    constantCache: new Map(),
    temps: 0,
    cached: 0,
    identifiers: Object.create(null),
    scopes: {
      vFor: 0,
      vSlot: 0,
      vPre: 0,
      vOnce: 0
    },
    parent: null,
    currentNode: root,
    childIndex: 0,
    inVOnce: false,

    // methods
    helper(name) {
      const count = context.helpers.get(name) || 0
      context.helpers.set(name, count + 1)
      return name
    },
    removeHelper(name) {
      const count = context.helpers.get(name)
      if (count) {
        const currentCount = count - 1
        if (!currentCount) {
          context.helpers.delete(name)
        } else {
          context.helpers.set(name, currentCount)
        }
      }
    },
    helperString(name) {
      return `_${helperNameMap[context.helper(name)]}`
    },
    replaceNode(node) {
      /* istanbul ignore if */
      if (__DEV__) {
        if (!context.currentNode) {
          throw new Error(`Node being replaced is already removed.`)
        }
        if (!context.parent) {
          throw new Error(`Cannot replace root node.`)
        }
      }
      context.parent!.children[context.childIndex] = context.currentNode = node
    },
    removeNode(node) {
      if (__DEV__ && !context.parent) {
        throw new Error(`Cannot remove root node.`)
      }
      const list = context.parent!.children
      const removalIndex = node
        ? list.indexOf(node)
        : context.currentNode
        ? context.childIndex
        : -1
      /* istanbul ignore if */
      if (__DEV__ && removalIndex < 0) {
        throw new Error(`node being removed is not a child of current parent`)
      }
      if (!node || node === context.currentNode) {
        // current node removed  移除当前节点
        context.currentNode = null
        context.onNodeRemoved()
      } else {
        // sibling node removed  移除兄弟节点
        if (context.childIndex > removalIndex) {
          context.childIndex--
          context.onNodeRemoved()
        }
      }
      context.parent!.children.splice(removalIndex, 1)
    },
    onNodeRemoved: () => {},
    addIdentifiers(exp) {
      // identifier tracking only happens in non-browser builds.
      if (!__BROWSER__) {
        if (isString(exp)) {
          addId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(addId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          addId(exp.content)
        }
      }
    },
    removeIdentifiers(exp) {
      if (!__BROWSER__) {
        if (isString(exp)) {
          removeId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(removeId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          removeId(exp.content)
        }
      }
    },
    hoist(exp) {
      if (isString(exp)) exp = createSimpleExpression(exp)
      context.hoists.push(exp)
      const identifier = createSimpleExpression(
        `_hoisted_${context.hoists.length}`,
        false,
        exp.loc,
        ConstantTypes.CAN_HOIST
      )
      identifier.hoisted = exp
      return identifier
    },
    cache(exp, isVNode = false) {
      return createCacheExpression(context.cached++, exp, isVNode)
    }
  }

  if (__COMPAT__) {
    context.filters = new Set()
  }

  function addId(id: string) {
    const { identifiers } = context
    if (identifiers[id] === undefined) {
      identifiers[id] = 0
    }
    identifiers[id]!++
  }

  function removeId(id: string) {
    context.identifiers[id]!--
  }

  return context
}

export function transform(root: RootNode, options: TransformOptions) {
  // 创建 transform 上下文：返回context对象
  // 这个上下文对象 context 维护了 transform 过程的一些配置，比如前面提到的节点和指令的转换函数等；
  // 还维护了 transform 过程的一些状态数据，比如当前处理的 AST 节点，当前 AST 节点在子节点中的索引，
  // 以及当前 AST 节点的父节点等。此外，context 还包含了在转换过程中可能会调用的一些辅助函数，和一些修改 context 对象的方法。
  const context = createTransformContext(root, options)
  // 遍历 AST 节点
  traverseNode(root, context)
  // 静态提升
  if (options.hoistStatic) {
    hoistStatic(root, context)
  }
  if (!options.ssr) {
    createRootCodegen(root, context)
  }
  // finalize meta information 创建根代码生成节点
  root.helpers = [...context.helpers.keys()]
  root.components = [...context.components]
  root.directives = [...context.directives]
  root.imports = context.imports
  root.hoists = context.hoists
  root.temps = context.temps
  root.cached = context.cached

  if (__COMPAT__) {
    root.filters = [...context.filters!]
  }
}

function createRootCodegen(root: RootNode, context: TransformContext) {
  const { helper } = context
  const { children } = root
  if (children.length === 1) {
    const child = children[0]
    // if the single child is an element, turn it into a block.
    if (isSingleElementRoot(root, child) && child.codegenNode) {
      // single element root is never hoisted so codegenNode will never be
      // SimpleExpressionNode
      const codegenNode = child.codegenNode
      if (codegenNode.type === NodeTypes.VNODE_CALL) {
        makeBlock(codegenNode, context)
      }
      root.codegenNode = codegenNode
    } else {
      // - single <slot/>, IfNode, ForNode: already blocks.
      // - single text node: always patched.
      // root codegen falls through via genNode()
      root.codegenNode = child
    }
  } else if (children.length > 1) {
    // root has multiple nodes - return a fragment block.
    let patchFlag = PatchFlags.STABLE_FRAGMENT
    let patchFlagText = PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
    // check if the fragment actually contains a single valid child with
    // the rest being comments
    if (
      __DEV__ &&
      children.filter(c => c.type !== NodeTypes.COMMENT).length === 1
    ) {
      patchFlag |= PatchFlags.DEV_ROOT_FRAGMENT
      patchFlagText += `, ${PatchFlagNames[PatchFlags.DEV_ROOT_FRAGMENT]}`
    }
    root.codegenNode = createVNodeCall(
      context,
      helper(FRAGMENT),
      undefined,
      root.children,
      patchFlag + (__DEV__ ? ` /* ${patchFlagText} */` : ``),
      undefined,
      undefined,
      true,
      undefined,
      false /* isComponent */
    )
  } else {
    // no children = noop. codegen will return null.
  }
}

export function traverseChildren(
  parent: ParentNode,
  context: TransformContext
) {
  let i = 0
  const nodeRemoved = () => {
    i--
  }
  for (; i < parent.children.length; i++) {
    const child = parent.children[i]
    if (isString(child)) continue
    context.parent = parent
    context.childIndex = i
    context.onNodeRemoved = nodeRemoved
    traverseNode(child, context)
  }
}

/**
 * 基本思路就是递归遍历 AST 节点，针对每个节点执行一系列的转换函数，有些转换函数还会设计一个退出函数，
 * 当你执行转换函数后，它会返回一个新函数，然后在你处理完子节点后再执行这些退出函数，
 * 这是因为有些逻辑的处理需要依赖子节点的处理结果才能继续执行。
 * 
 * Vue.js 内部大概内置了八种转换函数，分别处理指令、表达式、元素节点、文本节点等不同的特性。
 * @param node 
 * @param context 
 * @returns 
 */
export function traverseNode(
  node: RootNode | TemplateChildNode,
  context: TransformContext
) {
  context.currentNode = node
  // apply transform plugins
  const { nodeTransforms } = context
  const exitFns = []
  for (let i = 0; i < nodeTransforms.length; i++) {
    // 有些转换函数会设计一个退出函数，在处理完子节点后执行
    const onExit = nodeTransforms[i](node, context)
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit)
      } else {
        exitFns.push(onExit)
      }
    }
    if (!context.currentNode) {
      // node was removed
      return
    } else {
      // node may have been replaced  因为在转换的过程中节点可能被替换，恢复到之前的节点
      node = context.currentNode
    }
  }

  switch (node.type) {
    case NodeTypes.COMMENT:
      if (!context.ssr) {
        // inject import for the Comment symbol, which is needed for creating
        // comment nodes with `createVNode`
        context.helper(CREATE_COMMENT)
      }
      break
    case NodeTypes.INTERPOLATION:
      // no need to traverse, but we need to inject toString helper
      if (!context.ssr) {
        context.helper(TO_DISPLAY_STRING)
      }
      break

    // for container types, further traverse downwards
    case NodeTypes.IF:
      // 递归遍历每个分支节点
      for (let i = 0; i < node.branches.length; i++) {
        traverseNode(node.branches[i], context)
      }
      break
    case NodeTypes.IF_BRANCH:
    case NodeTypes.FOR:
    case NodeTypes.ELEMENT:
    case NodeTypes.ROOT:
      // 递归遍历每个分支节点
      traverseChildren(node, context)
      break
  }

  // exit transforms 执行转换函数返回的退出函数
  context.currentNode = node
  let i = exitFns.length
  while (i--) {
    exitFns[i]()
  }
}

export function createStructuralDirectiveTransform(
  name: string | RegExp,
  fn: StructuralDirectiveTransform
): NodeTransform {
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n)

  return (node, context) => {
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node
      // structural directive transforms are not concerned with slots
      // as they are handled separately in vSlot.ts
      if (node.tagType === ElementTypes.TEMPLATE && props.some(isVSlot)) {
        return
      }
      const exitFns = []
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          // structural directives are removed to avoid infinite recursion
          // also we remove them *before* applying so that it can further
          // traverse itself in case it moves the node around
          props.splice(i, 1)
          i--
          const onExit = fn(node, prop, context)
          if (onExit) exitFns.push(onExit)
        }
      }
      return exitFns
    }
  }
}
