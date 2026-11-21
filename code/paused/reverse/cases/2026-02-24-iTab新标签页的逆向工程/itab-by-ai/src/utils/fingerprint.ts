/**
 * 设备指纹生成工具
 * 基于 getClientId-D9RtL220.js 逆向分析
 *
 * 功能:
 * - 生成唯一设备标识
 * - 用于 API 请求签名
 */

/**
 * 生成设备指纹
 *
 * 使用多种浏览器特征生成唯一标识
 */
export async function generateFingerprint(): Promise<string> {
  const components: string[] = []

  // 1. User Agent
  components.push(navigator.userAgent)

  // 2. 屏幕信息
  components.push(`${screen.width}x${screen.height}x${screen.colorDepth}`)

  // 3. 时区
  components.push(Intl.DateTimeFormat().resolvedOptions().timeZone)

  // 4. 语言
  components.push(navigator.language)

  // 5. 平台
  components.push(navigator.platform)

  // 6. 硬件并发数
  components.push(navigator.hardwareConcurrency?.toString() || '0')

  // 7. 设备内存
  components.push((navigator as any).deviceMemory?.toString() || '0')

  // 8. 触摸支持
  components.push(navigator.maxTouchPoints?.toString() || '0')

  // 9. Canvas 指纹
  components.push(getCanvasFingerprint())

  // 10. WebGL 指纹
  components.push(getWebGLFingerprint())

  // 生成哈希
  const data = components.join('|')
  return hashString(data)
}

/**
 * 获取 Canvas 指纹
 */
function getCanvasFingerprint(): string {
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''

    // 绘制文本
    ctx.textBaseline = 'top'
    ctx.font = '14px Arial'
    ctx.fillStyle = '#f60'
    ctx.fillRect(125, 1, 62, 20)
    ctx.fillStyle = '#069'
    ctx.fillText('Hello, world!', 2, 15)
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'
    ctx.fillText('Hello, world!', 4, 17)

    // 获取数据 URL
    return canvas.toDataURL().slice(0, 100)
  } catch {
    return ''
  }
}

/**
 * 获取 WebGL 指纹
 */
function getWebGLFingerprint(): string {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (!gl) return ''

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) return ''

    const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
    const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)

    return `${vendor}|${renderer}`
  } catch {
    return ''
  }
}

/**
 * 简单哈希函数 (FNV-1a)
 */
function hashString(str: string): string {
  let hash = 0x811c9dc5

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  // 转换为十六进制
  return (hash >>> 0).toString(16)
}

/**
 * 生成随机 ID
 */
export function generateId(prefix = ''): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 9)
  return `${prefix}${timestamp}${random}`
}

/**
 * 生成 UUID v4
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}
