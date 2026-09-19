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

import { dirname, isAbsolute, resolve } from 'node:path';
import type { AcpAgentAdapter, AcpConfiguredAgent } from '@maka/acp-executor-plugin';
import type { Context } from '@maka/runtime/plugin-kernel';

export const ANTIGRAVITY_ACP_EXECUTOR_ID = 'antigravity-acp';

export interface AntigravityAcpConfig {
  readonly executable: string;
  readonly helper?: string;
  readonly model?: string;
}

/** Antigravity-specific launch and environment policy; ACP mechanics live in the parent service. */
export const antigravityAcpAdapter: AcpAgentAdapter<AntigravityAcpConfig> = Object.freeze({
  id: ANTIGRAVITY_ACP_EXECUTOR_ID,
  displayName: 'Antigravity',
  clientName: 'maka-antigravity-acp-plugin',
  configure(value: AntigravityAcpConfig): AcpConfiguredAgent {
    const config = validateConfig(value);
    const helper = config.helper ?? resolve(dirname(config.executable), 'localharness_external');
    return Object.freeze({
      launch: Object.freeze({
        executable: config.executable,
        requiredExecutables: Object.freeze([helper]),
        cwd: dirname(config.executable),
        env: antigravityEnvironment(process.env, helper),
        ...(config.model ? { initialConfig: Object.freeze({ model: config.model }) } : {}),
      }),
    });
  },
});

export function validateConfig(value: AntigravityAcpConfig): AntigravityAcpConfig {
  if (!value || typeof value !== 'object') throw new TypeError('ACP Plugin config is required');
  const executable = absolutePath(value.executable, 'executable');
  const helper = value.helper === undefined ? undefined : absolutePath(value.helper, 'helper');
  const model = value.model?.trim();
  if (value.model !== undefined && !model) throw new TypeError('ACP Plugin model is invalid');
  return Object.freeze({ executable, ...(helper ? { helper } : {}), ...(model ? { model } : {}) });
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/u.test(value))
    throw new TypeError(`ACP Plugin ${label} must be an absolute path`);
  return resolve(value);
}

export function antigravityEnvironment(base: NodeJS.ProcessEnv, helper: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    BROWSER: '/usr/bin/true',
    PYTHONUNBUFFERED: '1',
    ANTIGRAVITY_HARNESS_PATH: helper,
  };
  const bypass = [env.NO_PROXY, env.no_proxy, 'localhost', '127.0.0.1', '::1']
    .flatMap((entry) => entry?.split(',') ?? [])
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index)
    .join(',');
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;
  return env;
}

const host = Object.freeze({
  inject: ['acp'] as const,
  apply(ctx: Context, config: AntigravityAcpConfig) {
    ctx.acp.register(ctx, antigravityAcpAdapter, config);
  },
});

export default Object.freeze({
  packageId: 'antigravity-acp',
  contributions: Object.freeze([{ id: ANTIGRAVITY_ACP_EXECUTOR_ID, kind: 'executor' }]),
  host,
});
