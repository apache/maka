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

import { mount } from 'nsh';
import { HostProvider, type Host } from '../../app/host';
import { TurnUsage } from '../../app/TurnUsage';

const attempts = [
  { usage: { input_tokens: null, output_tokens: 0 }, costUsd: null },
  { usage: { input_tokens: 1200, output_tokens: 240, cache_read_tokens: 0 }, costUsd: 0.006 },
  { usage: { input_tokens: 20, output_tokens: 10 }, costUsd: 0 },
].map((fields, index) => ({
  kind: 'model',
  attempt: {
    ...fields,
    requestId: String(index),
    sessionId: 'session',
    origin: { kind: 'agent', purpose: 'main', execution: { sessionId: 'session', turnId: 'turn' } },
  },
}));
const host = {
  query: async () => ({
    attempts,
    total: attempts.length,
    through: { stateDomain: 'test', sequence: 1 },
  }),
} as unknown as Host;

mount(() => (
  <HostProvider value={host}>
    <TurnUsage sessionId="session" turnId="turn" current={() => true} close={() => {}} />
  </HostProvider>
));
