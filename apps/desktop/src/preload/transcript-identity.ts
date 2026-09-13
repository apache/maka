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

import type { DesktopTranscriptBatch } from './transcript-contract.js';

/**
 * Durable transcript sequence identity: the Session's generation and the
 * Runtime Host epoch that produced it.
 *
 * The renderer keeps this alongside the open handle so range requests always
 * carry the epoch of the Host the renderer currently accepts batches from.
 * A replacement Host sends a reset batch with a new generation and epoch;
 * adopting that identity lets the next range request pass the Main-process
 * guard, while requests already dispatched with the previous epoch still fail
 * closed on the old Host.
 */
export interface DesktopTranscriptIdentity {
  readonly generation: string;
  readonly hostEpoch: string;
}

/**
 * Adopts a batch's identity when none is tracked yet or when the batch is a
 * reset; otherwise keeps the current identity. Returns the current identity
 * by reference when nothing changed so callers can detect adoption.
 */
export function adoptTranscriptIdentity(
  current: DesktopTranscriptIdentity | undefined,
  batch: DesktopTranscriptBatch,
): DesktopTranscriptIdentity {
  if (current !== undefined && !batch.reset) return current;
  return { generation: batch.generation, hostEpoch: batch.hostEpoch };
}
