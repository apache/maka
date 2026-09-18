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

import { randomUUID } from 'node:crypto';
import type { VoiceLogInput, WorkHubVoiceObservation, WorkHubVoiceState } from '@maka/runtime-host/protocol';

/** Realtime persistence independent of semantic checks and WorkHub execution. */
export class WorkHubVoiceLogWriter {
  private pending: VoiceLogInput[] = [];
  private writing?: Promise<void>;
  private closed = false;
  constructor(private readonly options: {
    callId: string;
    write(input: WorkHubVoiceObservation): Promise<WorkHubVoiceState>;
    onError(message: string): void;
  }) {}
  record(entry: VoiceLogInput): void {
    this.pending.push(entry);
    void this.drain().catch(error => this.options.onError(`Could not save voice log: ${String(error)}`));
  }
  async drain(): Promise<void> {
    while (this.pending.length || this.writing) {
      if (!this.writing) {
        const entries = this.pending.slice(0, 32);
        this.writing = this.options.write({
          id: randomUUID(), callId: this.options.callId, entries,
        }).then(() => { this.pending.splice(0, entries.length); })
          .finally(() => { this.writing = undefined; });
      }
      await this.writing;
    }
  }
  async close(): Promise<void> { this.closed = true; await this.drain(); }
}
