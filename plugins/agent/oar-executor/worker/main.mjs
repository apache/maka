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

import { createInterface } from 'node:readline';
import { Channel } from './channel.mjs';
import { HostTools } from './host-tools.mjs';
import { catalog, execute, setup, status } from './execution.mjs';
import { runtimes } from './runtimes.mjs';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const channel = new Channel();
const abort = new AbortController();
const tools = new HostTools(channel, abort.signal);
const first = Promise.withResolvers();
let started = false;
const reading = (async () => {
  try {
    for await (const line of input) {
      const message = JSON.parse(line);
      if (!started) {
        started = true;
        first.resolve(message);
      } else if (message.kind === 'ack') channel.acknowledge(message.sequence);
      else if (message.kind === 'cancel') abort.abort();
      else if (message.kind === 'tool_result') tools.receive(message);
      else throw new Error(`Unexpected OAR control: ${message.kind}`);
    }
    throw new Error('OAR Host input closed');
  } catch (error) {
    first.reject(error);
    channel.fail(error);
    tools.fail(error);
    abort.abort(error);
  }
})();

try {
  const request = await first.promise;
  const selected = () =>
    (request.runtimes ?? []).map((id) => {
      const runtime = runtimes.get(id);
      if (runtime) return runtime;
      return {
        id,
        brand: { name: id },
        installation: async () => ({
          kind: 'unsupported',
          reason: `Unknown OAR runtime: ${id}`,
        }),
      };
    });
  if (request.kind === 'status') {
    const value = await Promise.all(selected().map((runtime) => status(runtime, request.cwd)));
    channel.publish({ kind: 'status', value });
  } else if (request.kind === 'catalog' && request.runtime === undefined) {
    const value = await Promise.all(selected().map((runtime) => catalog(runtime, request.cwd)));
    channel.publish({ kind: 'catalog', value });
  } else {
    const runtime = runtimes.get(request.runtime);
    if (!runtime) {
      const message = `Unknown OAR runtime: ${request.runtime}`;
      if (request.kind === 'execute')
        channel.publish({
          kind: 'result',
          result: { kind: 'rejected', code: 'unsupported', message },
        });
      else if (request.kind === 'setup' || request.kind === 'catalog')
        channel.publish({
          kind: request.kind,
          value: { kind: 'unsupported', detail: message },
        });
      else throw new Error(`Unknown OAR request: ${request.kind}`);
    } else if (request.kind === 'catalog')
      channel.publish({
        kind: 'catalog',
        value: await catalog(runtime, request.cwd),
      });
    else if (request.kind === 'setup')
      channel.publish({ kind: 'setup', value: await setup(runtime, request) });
    else if (request.kind === 'execute') {
      const result = await execute(runtime, request, {
        signal: abort.signal,
        tools,
        abort: (error) => abort.abort(error),
        publish: (body) => channel.publish(body),
        committed: () => channel.committed(abort.signal),
      });
      channel.publish({ kind: 'result', result });
    } else throw new Error(`Unknown OAR request: ${request.kind}`);
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  input.close();
  process.stdin.destroy();
  await reading;
}
