#!/usr/bin/env node
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Return allowScripts entries that no longer match an exact package in the
 * lockfile. npm treats these keys as exact name@version specifiers, so a
 * dependency bump can otherwise leave a silently ineffective approval behind.
 */
export function findStaleAllowScripts(allowScripts = {}, lockPackages = {}) {
  return Object.keys(allowScripts).filter((specifier) => {
    const separator = specifier.lastIndexOf('@');
    if (separator <= 0 || separator === specifier.length - 1) return true;

    const packageName = specifier.slice(0, separator);
    const version = specifier.slice(separator + 1);
    return !Object.entries(lockPackages).some(
      ([path, packageInfo]) =>
        (path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`)) &&
        packageInfo?.version === version,
    );
  });
}

function main() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const stale = findStaleAllowScripts(manifest.allowScripts, lockfile.packages);

  if (stale.length > 0) {
    throw new Error(
      `allowScripts contains entries not present at the locked version: ${stale.join(', ')}`,
    );
  }

  console.log(
    `allowScripts entries match package-lock.json (${Object.keys(manifest.allowScripts ?? {}).length})`,
  );
}

if (import.meta.main) main();
