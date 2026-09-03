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
import { resolve } from 'node:path';
import { normalizePath, type Plugin } from 'vite';

export function workspacePackagesPlugin(repoRoot: string): Plugin {
  return {
    name: 'maka-workspace-packages',
    apply: 'serve',
    configResolved(config) {
      const manifest = resolve(repoRoot, 'package.json');
      const { workspaces } = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces: string[] };
      // Workspace exports change resolution just like Vite config does. A file
      // watch alone leaves the native resolver's package cache stale.
      config.configFileDependencies.push(
        normalizePath(manifest),
        ...workspaces.map((workspace) => normalizePath(resolve(repoRoot, workspace, 'package.json'))),
      );
    },
  };
}
