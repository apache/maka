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
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Session Bundles statically import the `node:zlib` Zstandard bindings, which Node
 * added in 22.15.0 and 23.8.0. Releases 23.0 through 23.7 satisfy the `>=22.19.0`
 * baseline yet cannot load the Host at all, so they are excluded explicitly.
 */
export const SUPPORTED_NODE_RUNTIME_RANGE = '>=22.19.0 <23.0.0 || >=23.8.0';

const NODE_RUNTIME_PROBE_TIMEOUT_MS = 10_000;

/** A single slow spawn must not decide a runtime, so a timed out probe is retried. */
const NODE_RUNTIME_PROBE_ATTEMPTS = 2;

const NODE_RUNTIME_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/u;

/**
 * A deployment launches its pinned binary directly, so a runtime that cannot be
 * executed or that answers unintelligibly is unusable. A probe that never answered
 * establishes nothing either way and leaves the runtime unverified.
 */
export type NodeRuntimeProbe =
  | { readonly kind: 'version'; readonly version: string }
  | { readonly kind: 'unusable'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

/**
 * Why a runtime may not be pinned. `unverified` is not a verdict on the runtime: the
 * probe failed to reach one, and the caller should retry rather than reinstall.
 */
export interface NodeRuntimeRefusal {
  readonly kind: 'unusable' | 'unverified';
  readonly message: string;
}

export interface NodeRuntimeProbeOptions {
  readonly timeoutMs?: number;
  readonly attempts?: number;
}

export function isSupportedNodeRuntimeVersion(version: string): boolean {
  const parsed = NODE_RUNTIME_VERSION_PATTERN.exec(version.trim());
  if (!parsed) return false;
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  if (major > 23) return true;
  if (major === 23) return minor >= 8;
  if (major === 22) return minor >= 19;
  return false;
}

/**
 * Describes why a probed runtime may not be pinned, or nothing when it may be.
 *
 * Replacement retires the current owner and commits the successor before activation,
 * and an on-demand update deliberately retains that successor when activation fails.
 * Proceeding on a runtime nothing could verify can therefore make an unusable pin
 * authoritative with no way back, so an unverified runtime is refused as well.
 */
export function nodeRuntimeRefusal(
  probe: NodeRuntimeProbe,
  nodePath?: string,
): NodeRuntimeRefusal | undefined {
  const where = nodePath ? ` (${nodePath})` : '';
  if (probe.kind === 'unknown') {
    return {
      kind: 'unverified',
      message: `The managed Runtime Host could not verify the selected Node.js runtime${where}: ${probe.detail}. Retry once the machine is responsive.`,
    };
  }
  if (probe.kind === 'unusable') {
    return {
      kind: 'unusable',
      message: `The managed Runtime Host cannot use the selected Node.js runtime${where}: ${probe.detail}.`,
    };
  }
  if (isSupportedNodeRuntimeVersion(probe.version)) return undefined;
  return {
    kind: 'unusable',
    message: `The managed Runtime Host cannot run on Node.js ${probe.version}${where}; install Node.js ${SUPPORTED_NODE_RUNTIME_RANGE} and retry.`,
  };
}

/**
 * Reports what a Node binary says it is. A deployment carries a pinned path forward
 * from an earlier install, so only the binary's own answer is authoritative.
 */
export async function probeNodeRuntime(
  nodePath: string,
  options: NodeRuntimeProbeOptions = {},
): Promise<NodeRuntimeProbe> {
  if (typeof nodePath !== 'string' || nodePath.trim() === '') {
    return { kind: 'unknown', detail: 'the deployment names no runtime to probe' };
  }
  if (resolve(nodePath) === resolve(process.execPath)) {
    return { kind: 'version', version: process.versions.node };
  }
  const timeoutMs = options.timeoutMs ?? NODE_RUNTIME_PROBE_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? NODE_RUNTIME_PROBE_ATTEMPTS);
  let unanswered: NodeRuntimeProbe = {
    kind: 'unknown',
    detail: 'the runtime did not answer before the probe deadline',
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await runNodeRuntimeProbe(nodePath, timeoutMs);
    if (probe.kind !== 'unknown') return probe;
    unanswered = probe;
  }
  return unanswered;
}

async function runNodeRuntimeProbe(nodePath: string, timeoutMs: number): Promise<NodeRuntimeProbe> {
  try {
    const { stdout } = await execFileAsync(nodePath, ['-p', 'process.versions.node'], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    const version = stdout.trim();
    return NODE_RUNTIME_VERSION_PATTERN.test(version)
      ? { kind: 'version', version }
      : { kind: 'unusable', detail: 'it did not report a Node.js version' };
  } catch (error) {
    // A killed probe is this deadline, not the runtime refusing to run.
    if (isTimedOutProbe(error)) {
      return { kind: 'unknown', detail: 'the runtime did not answer before the probe deadline' };
    }
    return { kind: 'unusable', detail: probeFailureDetail(error) };
  }
}

function isTimedOutProbe(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'killed' in error &&
    (error as { killed?: unknown }).killed === true
  );
}

function probeFailureDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'it could not be executed';
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT') return 'the pinned binary does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'the pinned binary is not executable';
  if (typeof code === 'number') return `it exited with code ${code}`;
  return typeof code === 'string'
    ? `it could not be executed (${code})`
    : 'it could not be executed';
}
