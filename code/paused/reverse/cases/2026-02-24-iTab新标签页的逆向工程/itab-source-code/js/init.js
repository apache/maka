/*
 * @Author: www.itab.link
 * @Date: 2022-01-07 22:32:28
 * @LastEditors: itab.link
 * @LastEditTime: 2023-04-28 11:22:17
 * @Description: file content
 */

// TODO

// const baseConfig = JSON.parse(localStorage.getItem("baseConfig") || '{}')
// const wallpaper = baseConfig.wallpaper || {}
// if (wallpaper.type == 0 || wallpaper.type == 1 || wallpaper.type == 2) {
//     let src = wallpaper.src
//     if (wallpaper.type == 2) { src = wallpaper.thumb }
//     const bodyBg = document.createElement('div')
//     bodyBg.setAttribute('class', 'body-bg')
//     bodyBg.setAttribute('style', `background-image:url(${src});filter: blur(${wallpaper.blur}px);`)
//     document.body.appendChild(bodyBg);
//     setTimeout(() => {
//         document.body.removeChild(bodyBg)
//     }, 1000)
// }
// edge浏览器扩展模式下 启用此logo
let isEdge = !window.location.protocol.includes('http') && window.navigator.userAgent.includes('Edg')
if (isEdge) {
    const applyIcon = document.head.querySelector('link[rel=icon]')
    applyIcon.href = 'logo/edge.ico'
}

