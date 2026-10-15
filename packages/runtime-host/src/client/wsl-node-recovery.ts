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

import type { RuntimeHostPosixOperatorCommand } from '../operator/operator-command.js';
import { decodeRuntimeHostPosixOperatorCommand } from '../operator/operator-command.js';
import {
  collectRuntimeHostWslOutput,
  formatRuntimeHostWslStderr,
  requireRuntimeHostWslOutput,
  resolveSystemRuntimeHostWslExecutable,
  spawnRuntimeHostWslProcess,
  waitForRuntimeHostWslProcess,
  type RuntimeHostWslProcessFactory,
} from './wsl-control.js';

export interface RuntimeHostWslNodeRecoveryInput {
  readonly distribution: string;
  readonly operator: RuntimeHostPosixOperatorCommand;
  readonly rootId: string;
  readonly signal?: AbortSignal;
}
export type RuntimeHostWslNodeRecovery = (
  input: RuntimeHostWslNodeRecoveryInput,
) => Promise<RuntimeHostPosixOperatorCommand>;

// Check each parent before treating absence as ENOENT. Inaccessible paths,
// dangling symlinks and existing non-executables must not trigger discovery.
const NODE_PATH_PROBE = `parent=/; remaining=\${1#/}
while :; do
  [ -d "$parent" ] && [ -x "$parent" ] || exit 2
  segment=\${remaining%%/*}
  candidate="$parent/$segment"
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then echo MAKA_WSL_NODE_MISSING_V1; exit 44; fi
  case "$remaining" in
    */*) parent="$candidate"; remaining=\${remaining#*/} ;;
    *) exit 0 ;;
  esac
done`;

export async function resolveRuntimeHostWslNodeOperator(
  input: RuntimeHostWslNodeRecoveryInput,
  recover: RuntimeHostWslNodeRecovery,
  overrides: {
    readonly processFactory?: RuntimeHostWslProcessFactory;
    readonly wslExecutable?: string;
  } = {},
): Promise<RuntimeHostPosixOperatorCommand> {
  input.signal?.throwIfAborted();
  const operator = decodeRuntimeHostPosixOperatorCommand(input.operator);
  if (operator.kind !== 'node') return operator;
  const child = (overrides.processFactory ?? spawnRuntimeHostWslProcess)(
    overrides.wslExecutable ?? resolveSystemRuntimeHostWslExecutable(),
    [
      '--distribution',
      input.distribution,
      '--exec',
      '/bin/sh',
      '-c',
      NODE_PATH_PROBE,
      'maka-node-probe',
      operator.nodePath,
    ],
  );
  const stdout = collectRuntimeHostWslOutput(child.stdout, 1024);
  const stderr = collectRuntimeHostWslOutput(child.stderr, 8192);
  const exited = waitForRuntimeHostWslProcess(child);
  const abort = () => child.kill();
  const timeout = setTimeout(abort, 15_000);
  input.signal?.addEventListener('abort', abort, { once: true });
  child.stdin.end();
  try {
    if (input.signal?.aborted) abort();
    const [exit, output, diagnostic] = await Promise.all([exited, stdout, stderr]);
    input.signal?.throwIfAborted();
    const probeOutput = requireRuntimeHostWslOutput(output).toString('utf8');
    if (exit.code === 0) return operator;
    if (exit.code !== 44 || probeOutput !== 'MAKA_WSL_NODE_MISSING_V1\n') {
      throw new Error(
        `WSL could not check the saved Node path${formatRuntimeHostWslStderr(diagnostic)}`,
      );
    }
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
  const recovered = decodeRuntimeHostPosixOperatorCommand(await recover({ ...input, operator }));
  if (recovered.kind !== 'node' || recovered.modulePath !== operator.modulePath) {
    throw new Error('WSL Node recovery returned a different operator');
  }
  return recovered;
}
