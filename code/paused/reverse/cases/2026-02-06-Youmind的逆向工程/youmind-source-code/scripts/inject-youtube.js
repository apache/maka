;(function () {
  const globalVariable = {
    ytInitialPlayerResponse:
      window.metacontext?.context?.ytInitialPlayerResponse ||
      window.ytInitialPlayerResponse,
    ytInitialData: window.ytInitialData,
  }

  // 创建一个自定义事件并传递变量值
  const event = new CustomEvent('grab_youtube_metacontext_youmind', {
    detail: globalVariable,
  })
  window.dispatchEvent(event) // 触发事件
})()
