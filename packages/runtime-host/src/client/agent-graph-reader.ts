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
  AgentGraphEpochListInput,
  AgentGraphEpochListResult,
  AgentGraphEpochSummary,
} from '../protocol/index.js';

const MAX_EPOCH_PAGES = 64;

/** One bounded, newest-first directory of Graph epochs read from the Host. */
export interface AgentGraphEpochDirectory {
  readonly epochs: readonly AgentGraphEpochSummary[];
  /**
   * True when the read hit its page bound while more valid pages remained.
   * Consumers must surface this instead of presenting the directory as
   * complete.
   */
  readonly truncated: boolean;
}

export interface AgentGraphReadConnection {
  request(
    operation: 'agent.graph.epochs.query',
    input: AgentGraphEpochListInput,
  ): Promise<AgentGraphEpochListResult>;
}

/** Collect one bounded, newest-first directory of Graph epochs from the Host. */
export async function readRuntimeHostAgentGraphEpochs(
  connection: AgentGraphReadConnection,
  rootSessionId: string,
): Promise<AgentGraphEpochDirectory> {
  const epochs: AgentGraphEpochSummary[] = [];
  const cursors = new Set<number>();
  let beforeEpoch: number | undefined;
  for (let pageCount = 0; pageCount < MAX_EPOCH_PAGES; pageCount += 1) {
    const page = await connection.request('agent.graph.epochs.query', {
      rootSessionId,
      ...(beforeEpoch === undefined ? {} : { beforeEpoch }),
    });
    epochs.push(...page.epochs);
    if (page.nextBeforeEpoch === null) return { epochs, truncated: false };
    if (cursors.has(page.nextBeforeEpoch)) {
      throw new Error('Agent graph epoch query returned a repeated cursor');
    }
    cursors.add(page.nextBeforeEpoch);
    beforeEpoch = page.nextBeforeEpoch;
  }
  return { epochs, truncated: true };
}
