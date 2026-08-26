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

import {
  PROJECT_DIRECTORY_MAX_ROOTS,
  PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
} from '@maka/runtime-host/protocol';

export function requireProjectDirectoryRoots(
  value: unknown,
): readonly { readonly label: string; readonly path: string }[] {
  if (!Array.isArray(value) || value.length > PROJECT_DIRECTORY_MAX_ROOTS) {
    throw new Error('Runtime Host Project directory policy is invalid');
  }
  const roots = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Runtime Host Project directory is invalid');
    }
    const root = candidate as Record<string, unknown>;
    if (
      Object.keys(root).length !== 2 ||
      typeof root.label !== 'string' ||
      root.label.length === 0 ||
      Buffer.byteLength(root.label, 'utf8') > PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(root.label) ||
      typeof root.path !== 'string' ||
      root.path.length === 0 ||
      Buffer.byteLength(root.path, 'utf8') > 4 * 1024 ||
      /[\u0000-\u001f\u007f]/u.test(root.path)
    ) {
      throw new Error('Runtime Host Project directory is invalid');
    }
    return { label: root.label, path: root.path };
  });
  if (new Set(roots.map(({ label }) => label)).size !== roots.length) {
    throw new Error('Runtime Host Project directory labels must be unique');
  }
  return roots;
}
