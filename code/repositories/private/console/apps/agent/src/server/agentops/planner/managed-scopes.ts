/**
 * Managed Scopes 处理
 * 判断配置键是否在受管范围内
 */

// ============================================================================
// Scope Matching
// ============================================================================

/**
 * 检查路径是否在受管范围内
 * 使用前缀匹配：如果 managedScopes 包含 "editor"，
 * 则 "editor"、"editor.fontSize"、"editor.tabSize" 都在范围内
 *
 * @param path 配置键路径 (dot-notation)
 * @param managedScopes 受管范围列表
 * @returns 是否在受管范围内
 *
 * @example
 * isInManagedScope("editor.fontSize", ["editor"])  // true
 * isInManagedScope("editor", ["editor"])           // true
 * isInManagedScope("terminal.fontSize", ["editor"]) // false
 * isInManagedScope("editor.font.size", ["editor.font"]) // true
 */
export function isInManagedScope(
  path: string,
  managedScopes: string[]
): boolean {
  return managedScopes.some((scope) => {
    // 完全匹配
    if (path === scope) {
      return true
    }
    // 前缀匹配（scope 是 path 的前缀）
    if (path.startsWith(scope + '.')) {
      return true
    }
    // path 是 scope 的前缀（用于处理整个对象）
    if (scope.startsWith(path + '.')) {
      return true
    }
    return false
  })
}

/**
 * 过滤出在受管范围内的路径
 */
export function filterManagedPaths(
  paths: string[],
  managedScopes: string[]
): string[] {
  return paths.filter((path) => isInManagedScope(path, managedScopes))
}

/**
 * 过滤出不在受管范围内的路径
 */
export function filterUnmanagedPaths(
  paths: string[],
  managedScopes: string[]
): string[] {
  return paths.filter((path) => !isInManagedScope(path, managedScopes))
}
