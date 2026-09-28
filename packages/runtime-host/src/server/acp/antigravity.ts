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

import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import type { ExternalAgentSetupAction } from '../../protocol/external-agent-setup.js';
import { AcpSetupError, withAcpConnection } from './connection.js';

const AUTH_PREFIX = 'Open the following link to authenticate the ACP server: ';
const INITIALIZE_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export async function runAntigravitySetup(input: {
  executable: string;
  action: Exclude<ExternalAgentSetupAction, 'install'>;
  signal: AbortSignal;
  onAuthorizationUrl(url: string): Promise<void>;
}): Promise<void> {
  const localAbort = new AbortController();
  const signal = AbortSignal.any([input.signal, localAbort.signal]);
  let timeout = setTimeout(
    () => localAbort.abort(new AcpSetupError('timed_out')),
    INITIALIZE_TIMEOUT_MS,
  );
  let authorization = Promise.resolve();
  let lastUrl: string | undefined;
  const output = createAntigravityStderrHandler((url) => {
    if (signal.aborted || url === lastUrl) return;
    lastUrl = url;
    authorization = authorization.then(async () => {
      signal.throwIfAborted();
      if (input.action !== 'login') throw new AcpSetupError('authentication_unavailable');
      await input.onAuthorizationUrl(url);
    });
    void authorization.catch((error) =>
      localAbort.abort(
        error instanceof AcpSetupError ? error : new AcpSetupError('browser_failed'),
      ),
    );
  });
  try {
    signal.throwIfAborted();
    const executable = await checkedFile(input.executable, 'executable_unavailable');
    const helper = await checkedFile(
      join(dirname(executable), 'localharness_external'),
      'helper_unavailable',
    );
    await withAcpConnection(
      {
        executable,
        cwd: dirname(executable),
        signal,
        // Verified with official 1.1.1: BROWSER=true suppresses Python's automatic browser launch;
        // the printed link is presented through the existing Desktop capability instead.
        env: {
          ...process.env,
          BROWSER: '/usr/bin/true',
          PYTHONUNBUFFERED: '1',
          ANTIGRAVITY_HARNESS_PATH: helper,
        },
        onStderr: output,
      },
      async (connection) => {
        const initialized = await connection.agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        });
        if (initialized.protocolVersion !== 1) throw new AcpSetupError('connection_failed');
        if (input.action === 'check') return;
        if (!initialized.authMethods?.some((method) => method.id === 'oauth-personal'))
          throw new AcpSetupError('authentication_unavailable');
        clearTimeout(timeout);
        timeout = setTimeout(
          () => localAbort.abort(new AcpSetupError('timed_out')),
          LOGIN_TIMEOUT_MS,
        );
        try {
          await connection.agent.request(methods.agent.authenticate, {
            methodId: 'oauth-personal',
          });
        } catch (error) {
          signal.throwIfAborted();
          // Observed official 1.1.1 response after a successful browser grant.
          if (
            error instanceof RequestError &&
            error.code === -32000 &&
            error.message.includes('Onboarding failed: User is ineligible for free-tier.')
          ) {
            throw new AcpSetupError('account_ineligible');
          }
          throw new AcpSetupError('authentication_failed');
        }
        await authorization;
        signal.throwIfAborted();
      },
    );
  } catch (error) {
    if (error instanceof AcpSetupError) throw error;
    signal.throwIfAborted();
    throw new AcpSetupError('connection_failed');
  } finally {
    clearTimeout(timeout);
  }
}

async function checkedFile(
  path: string,
  failure: 'executable_unavailable' | 'helper_unavailable',
): Promise<string> {
  try {
    if (!isAbsolute(path)) throw new Error('Absolute path required');
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isFile()) throw new Error('File required');
    await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    throw new AcpSetupError(failure);
  }
}

/** Official 1.1.1 prints its login link to stderr; ordinary diagnostics are discarded. */
export function createAntigravityStderrHandler(onAuthorizationUrl: (url: string) => void) {
  const recognize = (line: string): boolean => {
    if (!line.startsWith(AUTH_PREFIX)) return false;
    const value = line.slice(AUTH_PREFIX.length).trim();
    try {
      const url = new URL(value);
      if (value.length > 8192 || url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Invalid URL');
      onAuthorizationUrl(url.toString());
    } catch (error) {
      if (error instanceof AcpSetupError) throw error;
      throw new AcpSetupError('authentication_failed');
    }
    return true;
  };
  const stderrDecoder = new StringDecoder('utf8');
  let stderrPending = '';
  return (chunk: Buffer) => {
    stderrPending += stderrDecoder.write(chunk);
    let end: number;
    while ((end = stderrPending.indexOf('\n')) >= 0) {
      const line = stderrPending.slice(0, end).replace(/\r$/, '');
      stderrPending = stderrPending.slice(end + 1);
      recognize(line);
    }
    if (Buffer.byteLength(stderrPending) > 32768) throw new AcpSetupError('connection_failed');
  };
}
