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

import type { Contract, HostActivation, HostService } from '../src/index.js';

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

export const service = {
  async echo(input, _observation, context) {
    if (typeof input !== 'string') throw Error('Invalid echo input');
    const result = await context.invoke({
      operation: 'call',
      import: 'echo',
      provider: 0,
      method: 'echo',
      input,
      attachments: { text: 'text' },
    });
    if (typeof result !== 'string') throw Error('Echo returned a non-string result');
    return result;
  },
} satisfies HostService;
