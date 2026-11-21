/**
 * JSON Path 工具
 * 提供 flatten/unflatten 和路径操作能力
 */

// ============================================================================
// Types
// ============================================================================

/**
 * 扁平化后的键值对
 * key 使用 dot-notation (如 "editor.fontSize")
 */
export type FlatObject = Record<string, unknown>

// ============================================================================
// Flatten / Unflatten
// ============================================================================

/**
 * 将嵌套对象扁平化为 dot-notation 键值对
 * @example
 * flatten({ editor: { fontSize: 14 } })
 * // => { "editor.fontSize": 14 }
 */
export function flatten(
  obj: Record<string, unknown>,
  prefix = ''
): FlatObject {
  const result: FlatObject = {}

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key

    if (isPlainObject(value)) {
      Object.assign(result, flatten(value as Record<string, unknown>, fullKey))
    } else {
      result[fullKey] = value
    }
  }

  return result
}

/**
 * 将 dot-notation 键值对还原为嵌套对象
 * @example
 * unflatten({ "editor.fontSize": 14 })
 * // => { editor: { fontSize: 14 } }
 */
export function unflatten(flat: FlatObject): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(flat)) {
    setByPath(result, key, value)
  }

  return result
}

/**
 * 通过 dot-notation 路径设置值
 */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const keys = path.split('.')
  let current = obj

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!
    if (!(key in current) || !isPlainObject(current[key])) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }

  const lastKey = keys[keys.length - 1]!
  current[lastKey] = value
}

/**
 * 通过 dot-notation 路径获取值
 */
export function getByPath(
  obj: Record<string, unknown>,
  path: string
): unknown {
  const keys = path.split('.')
  let current: unknown = obj

  for (const key of keys) {
    if (!isPlainObject(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }

  return current
}

/**
 * 通过 dot-notation 路径删除值
 */
export function deleteByPath(
  obj: Record<string, unknown>,
  path: string
): boolean {
  const keys = path.split('.')
  let current = obj

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!
    if (!isPlainObject(current[key])) {
      return false
    }
    current = current[key] as Record<string, unknown>
  }

  const lastKey = keys[keys.length - 1]!
  if (lastKey in current) {
    delete current[lastKey]
    return true
  }
  return false
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 检查值是否为普通对象（非数组、非 null）
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
}
