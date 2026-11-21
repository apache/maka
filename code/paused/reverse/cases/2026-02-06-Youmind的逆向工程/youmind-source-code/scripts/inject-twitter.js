;(function () {
  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener('readystatechange', function () {
      if (this.readyState === 4 /* DONE */) {
        if (this.responseType === 'arraybuffer') {
          return
        }
        try {
          if (this.responseText.includes('video_info')) {
            const response = JSON.parse(this.responseText)
            // console.log('look look', response)
          }
        } catch (error) {
          // 好
        }
      }
    })
    return originalOpen.apply(this, [method, url, ...rest])
  }
})()
