/**
 * 加密工具
 * 基于 aes-C7jXGMOE.js 逆向分析
 *
 * 功能:
 * - AES 加密/解密
 * - Base64 编码/解码
 */

/**
 * AES 加密配置
 */
const AES_CONFIG = {
  mode: 'CBC',
  padding: 'Pkcs7',
  iv: 'itab-aes-iv-12345' // 固定 IV (实际项目应使用随机 IV)
}

/**
 * 简单 XOR 加密 (用于兼容原项目的加密方式)
 *
 * 注意: 这不是安全的加密方式，仅用于逆向分析还原
 * 实际项目应使用 Web Crypto API
 */
export function xorEncrypt(data: string, key: string): string {
  let result = ''
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(
      data.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    )
  }
  return btoa(result) // Base64 编码
}

/**
 * 简单 XOR 解密
 */
export function xorDecrypt(encryptedData: string, key: string): string {
  const data = atob(encryptedData) // Base64 解码
  let result = ''
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(
      data.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    )
  }
  return result
}

/**
 * 使用 Web Crypto API 进行 AES 加密
 */
export async function aesEncrypt(data: string, key: string): Promise<string> {
  try {
    // 导入密钥
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key.padEnd(32, '0').slice(0, 32)),
      { name: 'AES-CBC' },
      false,
      ['encrypt']
    )

    // 加密数据
    const iv = new TextEncoder().encode(AES_CONFIG.iv.padEnd(16, '0').slice(0, 16))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      new TextEncoder().encode(data)
    )

    // 返回 Base64
    const ivAndEncrypted = new Uint8Array(iv.length + encrypted.byteLength)
    ivAndEncrypted.set(iv)
    ivAndEncrypted.set(new Uint8Array(encrypted), iv.length)

    return btoa(String.fromCharCode(...ivAndEncrypted))
  } catch (error) {
    console.error('AES 加密失败:', error)
    throw error
  }
}

/**
 * 使用 Web Crypto API 进行 AES 解密
 */
export async function aesDecrypt(encryptedData: string, key: string): Promise<string> {
  try {
    // 解码 Base64
    const data = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0))

    // 提取 IV
    const iv = data.slice(0, 16)
    const encrypted = data.slice(16)

    // 导入密钥
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key.padEnd(32, '0').slice(0, 32)),
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    )

    // 解密数据
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      encrypted
    )

    return new TextDecoder().decode(decrypted)
  } catch (error) {
    console.error('AES 解密失败:', error)
    throw error
  }
}

/**
 * Base64 编码
 */
export function base64Encode(data: string): string {
  return btoa(unescape(encodeURIComponent(data)))
}

/**
 * Base64 解码
 */
export function base64Decode(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)))
}

/**
 * MD5 哈希 (简化版)
 *
 * 注意: 这不是完整的 MD5 实现，仅用于演示
 * 实际项目应使用 crypto.subtle.digest()
 */
export async function md5(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}
