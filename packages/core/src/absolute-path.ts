/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** Pure absolute-path helpers shared by permission and sandbox-boundary contracts. */
export function isNormalizedAbsolutePath(path: string): boolean {
  if (!path || path.includes('\0')) return false;
  if (isWindowsDrivePath(path)) {
    if (
      path.includes(':', 2) ||
      path.startsWith('\\\\') ||
      path.startsWith('\\\\?\\') ||
      path.startsWith('\\\\.\\')
    )
      return false;
    if (path.includes('/') || (path.length > 3 && path.endsWith('\\'))) return false;
    if (path.length === 3) return true;
    return !path
      .slice(3)
      .split('\\')
      .some((segment) => segment === '' || segment === '.' || segment === '..');
  }
  if (!path.startsWith('/') || path.includes('\\')) return false;
  if (path.length > 1 && path.endsWith('/')) return false;
  return !path
    .split('/')
    .some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..'));
}

export function pathWithinRoot(path: string, root: string): boolean {
  const normalizedPath = comparablePath(path);
  const normalizedRoot = comparablePath(root);
  if (
    !normalizedPath ||
    !normalizedRoot ||
    !isNormalizedAbsolutePath(normalizedPath) ||
    !isNormalizedAbsolutePath(normalizedRoot) ||
    isWindowsDrivePath(path) !== isWindowsDrivePath(root)
  ) {
    return false;
  }
  if (normalizedRoot === '/') return normalizedPath.startsWith('/');
  const separator = isWindowsDrivePath(root) ? '\\' : '/';
  const subtreePrefix = normalizedRoot.endsWith(separator)
    ? normalizedRoot
    : `${normalizedRoot}${separator}`;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(subtreePrefix);
}

export function samePath(a: string, b: string): boolean {
  if (isWindowsDrivePath(a) !== isWindowsDrivePath(b)) return false;
  return comparablePath(a) === comparablePath(b);
}

export function trimTrailingPathSeparators(value: string): string {
  if (value === '/' || /^[A-Za-z]:\\$/.test(value)) return value;
  return isWindowsDrivePath(value) ? value.replace(/\\+$/g, '') : value.replace(/\/+$/g, '');
}

function comparablePath(value: string): string {
  const trimmed = trimTrailingPathSeparators(value);
  return isWindowsDrivePath(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path);
}
