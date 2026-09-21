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
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Select data before entering the existing dev launcher; it owns app lifetime. */
export function worktreeDevelopmentLaunch(argv = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const root = realpathSync(options.repoRoot ?? REPO_ROOT);
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const args = [];
  let explicit;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--user-data-dir' || argument.startsWith('--user-data-dir=')) {
      if (explicit !== undefined) throw new Error('Specify --user-data-dir only once.');
      explicit =
        argument === '--user-data-dir' ? argv[++index] : argument.slice('--user-data-dir='.length);
      if (!explicit || explicit.startsWith('--'))
        throw new Error('--user-data-dir requires a directory.');
    } else args.push(argument);
  }
  let userDataDir;
  if (explicit !== undefined) {
    userDataDir = paths.resolve(root, explicit);
  } else {
    let appData;
    if (platform === 'darwin') appData = paths.join(home, 'Library', 'Application Support');
    else if (platform === 'win32') appData = env.APPDATA || paths.join(home, 'AppData', 'Roaming');
    else appData = env.XDG_CONFIG_HOME || paths.join(home, '.config');
    // Relative XDG_CONFIG_HOME values are invalid; never depend on launcher cwd.
    if (!paths.isAbsolute(appData))
      appData = paths.join(home, platform === 'win32' ? 'AppData/Roaming' : '.config');
    const id = createHash('sha256').update(root).digest('hex').slice(0, 12);
    const label =
      paths
        .basename(root)
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .slice(0, 40) || 'worktree';
    userDataDir = paths.join(appData, 'Maka Dev Worktrees', `${label}-${id}`);
  }
  return { userDataDir, argv: [...args, `--user-data-dir=${userDataDir}`] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const launch = worktreeDevelopmentLaunch(process.argv.slice(2));
  console.log(`[maka-dev] Worktree data directory: ${launch.userDataDir}`);
  process.argv = [
    process.argv[0],
    fileURLToPath(new URL('./dev.mjs', import.meta.url)),
    ...launch.argv,
  ];
  await import('./dev.mjs');
}
