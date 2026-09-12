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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_TEXT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_BYTES_MAX_BUFFER = Number.MAX_SAFE_INTEGER;

export interface GitExecOptions {
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly gitIndexFile?: string;
}

/**
 * Runs Git with repository discovery isolated from ambient Git environment
 * variables. Callers may provide a temporary index for patch construction.
 */
export async function execGitText(
  cwd: string,
  args: readonly string[],
  options: GitExecOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: gitEnvironment(options),
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? DEFAULT_TEXT_MAX_BUFFER,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

export async function execGitBytes(
  cwd: string,
  args: readonly string[],
  options: GitExecOptions = {},
): Promise<Uint8Array> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: gitEnvironment(options),
    encoding: 'buffer',
    maxBuffer: options.maxBuffer ?? DEFAULT_BYTES_MAX_BUFFER,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });
  return new Uint8Array(stdout);
}

function gitEnvironment(options: GitExecOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  if (options.gitIndexFile === undefined) {
    delete env.GIT_INDEX_FILE;
  } else {
    env.GIT_INDEX_FILE = options.gitIndexFile;
  }
  return env;
}
