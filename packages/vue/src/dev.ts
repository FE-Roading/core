import { initCustomFormatter } from '@vue/runtime-dom'

export function initDev() {
  // 如果是浏览器环境
  if (__BROWSER__) {
    if (!__ESM_BUNDLER__) {
      console.info(
        `You are running a development build of Vue.\n` +
          `Make sure to use the production build (*.prod.js) when deploying for production.`
      )
    }

    // 自定义Chrome浏览器的开发者控制台输出样式
    initCustomFormatter()
  }
}
