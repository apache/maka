;(function () {
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState

  function onStateChange() {
    window.postMessage({ type: 'SPARouteChange', url: location.href }, '*')
  }

  // 拦截 pushState
  history.pushState = function (...args) {
    originalPushState.apply(history, args)
    onStateChange()
  }

  // 拦截 replaceState
  history.replaceState = function (...args) {
    originalReplaceState.apply(history, args)
    onStateChange()
  }

  // 监听popstate事件（用户点击返回/前进按钮时触发）
  window.addEventListener('popstate', onStateChange)
})()
