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
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export class FeishuCliError extends Error {
  constructor(readonly code: string | number) {
    super(`Feishu CLI read failed (${code}); check login, permissions or source availability`);
  }
}
const exec = promisify(execFile);
export type CliConfig = {
  cliPath: string;
  accountId: string;
  appId: string;
  cliProfile?: string;
};
export type CliRun = (args: string[], signal?: AbortSignal) => Promise<any>;
/** Credentials stay in the official CLI/keychain. This transport never accepts model-supplied commands. */
export function createCli(
  config: CliConfig,
  run?: CliRun,
  pause = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }),
) {
  if (!isAbsolute(config.cliPath) || !config.accountId || !config.appId)
    throw Error('CLI requires absolute cliPath, pinned accountId and appId');
  const execute: CliRun =
    run ??
    (async (args, signal) => {
      try {
        const { stdout } = await exec(config.cliPath, args, {
          signal,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 120000,
          env: {
            ...process.env,
            LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
            LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
          },
        });
        return JSON.parse(stdout);
      } catch (error: any) {
        if (signal?.aborted) throw signal.reason;
        // Never propagate CLI stderr: OAuth diagnostics can contain credential-bearing links.
        let detail: any;
        for (const stream of [error.stderr, error.stdout]) {
          if (typeof stream !== 'string') continue;
          const at = stream.indexOf('{');
          if (at < 0) continue;
          try {
            detail = JSON.parse(stream.slice(at)).error;
            if (detail) break;
          } catch {}
        }
        const code = detail?.code ?? error.code ?? 'invalid_response';
        throw new FeishuCliError(/^[A-Za-z0-9_]+$/.test(String(code)) ? code : 'invalid_response');
      }
    });
  const invoke: CliRun = (args, signal) =>
    execute([...args, ...(config.cliProfile ? ['--profile', config.cliProfile] : [])], signal);
  const verified = new WeakMap<object, Promise<void>>();
  async function verify(caller: any) {
    const invocation = caller.invocation;
    if (!invocation) throw Error('Source requires invocation');
    invocation.abortSignal?.throwIfAborted();
    let pending = verified.get(invocation);
    if (!pending) {
      pending = (async () => {
        const status = await invoke(['auth', 'status', '--json'], invocation.abortSignal);
        // The CLI refreshes an expired access token on the next API read. Keep the
        // pinned identity checks; only a refreshable login may proceed.
        if (
          status.appId !== config.appId ||
          status.identities?.user?.openId !== config.accountId ||
          !['ready', 'needs_refresh'].includes(status.identities?.user?.status)
        )
          throw Error('Feishu CLI account changed or logged out; source access denied');
      })();
      verified.set(invocation, pending);
    }
    await pending;
  }
  const safe = new Set([
    'im +chat-list',
    'im +messages-search',
    'drive +search',
    'drive +inspect',
    'docs +fetch',
    'task tasks get',
    'task tasks list',
    'calendar +agenda',
    'calendar +get',
    'calendar calendars list',
    'wiki spaces list',
    'minutes +search',
    'minutes +detail',
    'mail +triage',
    'mail +message',
  ]);
  let nextRequestAt = 0;
  async function call(args: string[], caller: any) {
    const raw =
      args[0] === 'api' &&
      args[1] === 'GET' &&
      /^\/open-apis\/(?:docx\/v1\/documents\/[A-Za-z0-9_-]+|im\/v1\/(?:chats|messages(?:\/[A-Za-z0-9_-]+)?))$/.test(
        args[2],
      );
    if (
      !(
        raw ||
        (args[0] === 'api' && args[1] === 'POST' && args[2] === '/open-apis/im/v1/messages/search')
      ) &&
      ![args.slice(0, 2).join(' '), args.slice(0, 3).join(' ')].some((x) => safe.has(x))
    )
      throw Error('CLI command is not in the read-only allowlist');
    await verify(caller);
    const signal = caller.invocation.abortSignal;
    for (let attempt = 0; ; attempt++) {
      // Shared across sources and invocations: parallel metadata reads cannot create an unbounded burst.
      const slot = Math.max(Date.now(), nextRequestAt);
      nextRequestAt = slot + 250;
      if (slot > Date.now()) await pause(slot - Date.now(), signal);
      signal?.throwIfAborted();
      try {
        const result = await invoke([...args, '--as', 'user', '--format', 'json'], signal);
        if (!result.ok) throw new FeishuCliError(result.error?.code ?? 'invalid_response');
        if (result.identity !== 'user')
          throw Error('Feishu CLI did not return a successful user read');
        return result.data;
      } catch (error) {
        if (
          !(error instanceof FeishuCliError) ||
          !['99991400', '429'].includes(String(error.code)) ||
          attempt >= 3
        )
          throw error;
        const backoff = 1000 * 2 ** attempt;
        nextRequestAt = Math.max(nextRequestAt, Date.now() + backoff);
        await pause(backoff, signal);
      }
    }
  }
  return { call, verify };
}
