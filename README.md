# vuejs/core [![npm](https://img.shields.io/npm/v/vue/next.svg)](https://www.npmjs.com/package/vue/v/next) [![build status](https://github.com/vuejs/core/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vuejs/core/actions/workflows/ci.yml)

This is the repository for Vue 3.2 source code read.

## package list

```bash
tree ./packages -L 1
./packages
├── compiler-core  # 编译器核心代码：抽象语法树和渲染桥接实现
├── compiler-dom  # 浏览器平台下的编译器
├── compiler-sfc  # Vue单文件组件(.vue)的编译器
├── compiler-ssr  # 服务端渲染编译器
├── global.d.ts
├── reactivity  # 数据响应式系统
├── reactivity-transform  # 新的reactive语法实验特性
├── runtime-core  # runtime核心代码 
├── runtime-dom  # 浏览器的runtime
├── runtime-test  # 为测试编写的轻量级运行时，渲染的dom树是js对象，所以可以运行在所有的js环境里，可以测试渲染是否正确，还可以用于序列化dom、触发dom事件、以及记录某次更新中的dom操作
├── server-renderer  # 服务器渲染
├── sfc-playground  # 在浏览器中编写和预览Vue单文件组件，可查看compile结果
├── shared  # package之间共享的工具库
├── size-check  # 私有包，不会发布npm，tree-shaking后检查包的大小
├── template-explorer  # 浏览器里运行的实时编译组件，会输出render函数，readme里提供在线访问的地址
├── vue  # 构建完整版的vue，依赖compiler和runtime
└── vue-compat
```

