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

import type {
  Contract,
  HostActivation,
  HostService,
  RequestContext,
} from '../../../../packages/plugin-sdk/src/index.js';

const contract = {
  name: 'example.Echo',
  version: 1,
  transport: 'local',
  interface: {
    kind: 'service',
    methods: {
      echo: {
        mode: 'query',
        input: { type: 'string' },
        output: { type: 'string' },
        resources: { text: { type: { name: 'example.Bytes', version: 1 }, optional: false } },
      },
    },
  },
} satisfies Contract;

export function activate(): Record<string, HostActivation> {
  return { echo: { contract, service: ['service'] } };
}

async function call(context: RequestContext, value: string): Promise<string> {
  const result = await context.invoke({
    operation: 'call',
    import: 'echo',
    provider: 0,
    method: 'echo',
    input: value,
    attachments: { text: 'text' },
  });
  if (typeof result !== 'string') throw Error('Echo returned a non-string result');
  return result;
}

export const service = {
  async echo(input, _observation, context) {
    if (typeof input !== 'string') throw Error('Invalid echo input');
    if (input === 'invalid') {
      // Deliberately bypass static types to exercise the actual Host boundary.
      const untyped = context as { invoke(input: unknown): Promise<unknown> };
      const request = {
        operation: 'call',
        import: 'echo',
        provider: 0,
        method: 'echo',
        input: 'healthy',
        attachments: { text: 'text' },
      };
      for (const change of [
        { import: 'undeclared' },
        { provider: 1 },
        { provider: -1 },
        { method: 'undeclared' },
        { scope: { identity: 'forged' } },
        { attachments: { text: 'unknown' } },
        { attachments: { text: { bytes: [120] } } },
        { attachments: { extra: 'text' } },
        { input: false },
      ]) {
        try {
          await untyped.invoke({ ...request, ...change });
          return 'unexpected acceptance';
        } catch {}
      }
      return 'rejected';
    }
    if (input === 'ignore' || input === 'terminate') {
      call(context, 'held').catch(() => {});
      // The second admission proves that the detached child really entered.
      await call(context, 'healthy');
      if (input === 'terminate') while (true) {}
      return 'returned';
    }
    if (input === 'twice') return (await call(context, 'one')) + ':' + (await call(context, 'two'));
    try {
      return await call(context, input);
    } catch (error) {
      return 'caught:' + (error instanceof Error ? error.message : String(error));
    }
  },
} satisfies HostService;
