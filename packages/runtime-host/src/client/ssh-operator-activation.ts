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

import { spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES,
  decodeRuntimeHostActivationFrame,
  type RuntimeHostActivationResult,
} from '../operator/index.js';
import {
  decodeRuntimeHostOperatorCommand,
  runtimeHostOperatorInvocation,
  type RuntimeHostOperatorCommand,
} from '../operator/operator-command.js';
import { requireHostRootId } from '../protocol/index.js';
import {
  normalizeRuntimeHostSshDestination,
  type RuntimeHostSshInteraction,
} from './ssh-tunnel.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface RuntimeHostSshOperatorActivationInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operator: RuntimeHostOperatorCommand;
  readonly rootId: string;
  readonly interaction: RuntimeHostSshInteraction;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class RuntimeHostSshOperatorActivationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeHostSshOperatorActivationError';
  }
}

export interface RuntimeHostSshOperatorProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  kill(signal: NodeJS.Signals): void;
}

export type RuntimeHostSshOperatorProcessFactory = (input: {
  readonly executable: 'ssh';
  readonly args: readonly string[];
  readonly interaction: Exclude<RuntimeHostSshInteraction, 'terminal'>;
}) => RuntimeHostSshOperatorProcess;

export async function activateRuntimeHostSshOperator(
  input: RuntimeHostSshOperatorActivationInput,
  overrides: { readonly spawnProcess?: RuntimeHostSshOperatorProcessFactory } = {},
): Promise<RuntimeHostActivationResult> {
  input.signal?.throwIfAborted();
  if (input.interaction === 'terminal') {
    throw new RuntimeHostSshOperatorActivationError(
      'Interactive SSH activation requires a Client terminal provider',
    );
  }
  const destination = normalizeRuntimeHostSshDestination(input.destination);
  const sshPort = input.sshPort === undefined ? undefined : requirePort(input.sshPort);
  const operator = decodeRuntimeHostOperatorCommand(input.operator);
  const rootId = requireHostRootId(input.rootId);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new RangeError('Runtime Host SSH activation timeout must be between 1 and 120000 ms');
  }
  const remoteCommand = runtimeHostSshOperatorRemoteCommand(operator, [
    'activate',
    '--framed',
    '--root-id',
    rootId,
  ]);
  const args = [
    '-T',
    '-o',
    input.interaction === 'batch' ? 'BatchMode=yes' : 'BatchMode=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'RemoteCommand=none',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(Math.min(timeoutMs, 15_000) / 1_000))}`,
    ...(sshPort === undefined ? [] : ['-p', String(sshPort)]),
    destination,
    remoteCommand,
  ];
  const child = (overrides.spawnProcess ?? spawnSshOperatorProcess)({
    executable: 'ssh',
    args,
    interaction: input.interaction,
  });
  return waitForActivation(child, input, timeoutMs);
}

export function runtimeHostSshOperatorRemoteCommand(
  operator: RuntimeHostOperatorCommand,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  options: { readonly missingOperatorIsSuccess?: boolean } = {},
): string {
  const invocation = runtimeHostOperatorInvocation(operator, args);
  const entries = Object.entries(environment);
  for (const [name] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error('Runtime Host operator environment variable name is invalid');
    }
  }
  if (operator.kind === 'legacy_posix_executable' || operator.platform === 'posix') {
    const command = [invocation.executable, ...invocation.args].map(quotePosix).join(' ');
    const variables = entries.map(([name, value]) => `${name}=${quotePosix(value)}`).join(' ');
    const execute = `${variables ? `${variables} ` : ''}exec ${command}`;
    if (!options.missingOperatorIsSuccess) return execute;
    const operatorPath = operator.kind === 'node' ? operator.modulePath : operator.executablePath;
    const artifact = quotePosix(operatorPath);
    const deploymentRoot = quotePosix(posix.dirname(operatorPath));
    return `if [ ! -e ${artifact} ]; then [ ! -e ${deploymentRoot} ] && exit 0; exit 1; fi; ${execute}`;
  }
  if (operator.kind !== 'node') throw new Error('Windows Runtime Host operator must use Node');
  const payload = Buffer.from(
    JSON.stringify({
      ...invocation,
      environment,
      modulePath: operator.modulePath,
      deploymentRoot: win32.dirname(operator.modulePath),
      missingOperatorIsSuccess: options.missingOperatorIsSuccess === true,
    }),
    'utf8',
  ).toString('base64');
  const script = [
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    `if($p.missingOperatorIsSuccess -and -not (Test-Path -LiteralPath $p.modulePath -PathType Leaf)){if(-not (Test-Path -LiteralPath $p.deploymentRoot)){exit 0}else{exit 1}}`,
    `foreach($e in $p.environment.psobject.Properties){[Environment]::SetEnvironmentVariable($e.Name,[string]$e.Value,'Process')}`,
    `$code=1`,
    `try{& ([string]$p.executable) @($p.args|ForEach-Object {[string]$_});$code=if($null -eq $LASTEXITCODE){1}else{$LASTEXITCODE}}catch{$code=1}`,
    `exit $code`,
  ].join(';');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

async function waitForActivation(
  child: RuntimeHostSshOperatorProcess,
  input: RuntimeHostSshOperatorActivationInput,
  timeoutMs: number,
): Promise<RuntimeHostActivationResult> {
  let stdout = Buffer.alloc(0);
  let overflow = false;
  let timedOut = false;
  child.stdout?.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([stdout, bytes]);
    if (combined.length > RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES + 256) {
      overflow = true;
      child.kill('SIGKILL');
      return;
    }
    stdout = combined;
  });
  const onAbort = () => child.kill('SIGTERM');
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const [exit] = await Promise.all([
      child.exited,
      child.stdout === null ? Promise.resolve() : finished(child.stdout, { cleanup: true }),
    ]);
    input.signal?.throwIfAborted();
    if (overflow) {
      throw new RuntimeHostSshOperatorActivationError(
        'Runtime Host SSH operator returned too much output',
      );
    }
    const output = stdout.toString('utf8');
    const line = output.endsWith('\r\n')
      ? output.slice(0, -2)
      : output.endsWith('\n')
        ? output.slice(0, -1)
        : output;
    if (line.includes('\n') || line.includes('\r')) {
      throw new RuntimeHostSshOperatorActivationError(
        'Runtime Host SSH operator returned multiple or malformed frames',
      );
    }
    const frame = decodeRuntimeHostActivationFrame(line);
    if (!frame) {
      throw new RuntimeHostSshOperatorActivationError(
        timedOut
          ? 'Runtime Host SSH activation timed out'
          : exit.code === null
            ? 'Runtime Host SSH activation was terminated'
            : `Runtime Host SSH activation exited with code ${exit.code}`,
      );
    }
    if (frame.kind === 'error') {
      throw new RuntimeHostSshOperatorActivationError(frame.error.message);
    }
    if (exit.code !== 0 || exit.signal !== null || frame.rootId !== input.rootId) {
      throw new RuntimeHostSshOperatorActivationError(
        'Runtime Host SSH activation returned an inconsistent result',
      );
    }
    return frame;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

function spawnSshOperatorProcess(input: {
  readonly executable: 'ssh';
  readonly args: readonly string[];
  readonly interaction: Exclude<RuntimeHostSshInteraction, 'terminal'>;
}): RuntimeHostSshOperatorProcess {
  const child = spawn(input.executable, [...input.args], {
    shell: false,
    windowsHide: input.interaction === 'batch',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return {
    stdout: child.stdout,
    exited: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

function requirePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError('Runtime Host SSH port must be between 1 and 65535');
  }
  return value;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
