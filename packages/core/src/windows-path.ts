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

import { isNormalizedAbsolutePath } from './absolute-path.js';

/**
 * Canonical Windows path helpers shared by core permission contracts and the
 * Windows sandbox compiler/backend. A canonical Windows path is drive-absolute
 * (`C:\...`), backslash-separated, free of `.`/`..`/empty segments and free of
 * trailing separators (except the volume root itself). UNC and device paths
 * are rejected: sandbox roots and broker artifacts are always local files.
 */
export function isCanonicalWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path) && isNormalizedAbsolutePath(path);
}

/**
 * Returns `path` unchanged when it is canonical, otherwise throws. Callers
 * that must additionally reject volume roots (e.g. sandbox grant targets)
 * layer that check on top.
 */
export function canonicalWindowsPath(path: string): string {
  if (!isCanonicalWindowsPath(path)) {
    throw new Error(
      `Windows sandbox path must be absolute, use backslashes and be lexically canonical: ${path}`,
    );
  }
  return path;
}
