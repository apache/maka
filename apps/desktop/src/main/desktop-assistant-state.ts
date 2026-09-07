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
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

const modelSchema = z.object({ connectionId: z.string(), connectionSlug: z.string(), model: z.string() });
const stateSchema = z.object({
  version: z.literal(1),
  models: z.record(z.string(), modelSchema),
  sessions: z.array(z.object({ hostId: z.string(), sessionId: z.string(), usedAt: z.number() })),
});
type State = z.infer<typeof stateSchema>;
export const ASSISTANT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Owns only assistant preferences and the exact Sessions created by this client. */
export class DesktopAssistantState {
  private readonly loaded: Promise<State>;
  private writes = Promise.resolve();

  constructor(private readonly path: string) {
    this.loaded = readFile(path, 'utf8')
      .then((text) => stateSchema.parse(JSON.parse(text)))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return { version: 1 as const, models: {}, sessions: [] };
        throw error;
      });
    // The first user operation reports an unreadable state file.
    void this.loaded.catch(() => undefined);
  }

  async model(hostId: string) { return (await this.loaded).models[hostId]; }

  async selectModel(hostId: string, model: z.infer<typeof modelSchema>) {
    (await this.loaded).models[hostId] = modelSchema.parse(model);
    await this.save();
  }

  async touch(hostId: string, sessionId: string, now = Date.now()) {
    const state = await this.loaded;
    const entry = state.sessions.find((item) => item.hostId === hostId && item.sessionId === sessionId);
    if (entry) entry.usedAt = now;
    else state.sessions.push({ hostId, sessionId, usedAt: now });
    await this.save();
  }

  async cleanup(client: Pick<DesktopRuntimeHostClient, 'hostId' | 'getSession' | 'removeSession'>, protectedSession?: string, now = Date.now()) {
    const state = await this.loaded;
    const removed: string[] = [];
    for (const entry of [...state.sessions]) {
      if (entry.hostId !== client.hostId || entry.sessionId === protectedSession || now - entry.usedAt <= ASSISTANT_RETENTION_MS) continue;
      const session = await client.getSession(entry.sessionId);
      if (session) {
        if (!session.labels.includes('mode:desktop_assistant')) continue;
        if (session.liveRunState || now - session.activityAt <= ASSISTANT_RETENTION_MS) continue;
        const result = await client.removeSession(entry.sessionId);
        if (result.disposition !== 'removed') continue;
      }
      state.sessions = state.sessions.filter((item) => item !== entry);
      removed.push(entry.sessionId);
      await this.save();
    }
    return removed;
  }

  private async save() {
    const text = JSON.stringify(await this.loaded);
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.path);
      } finally { await unlink(temporary).catch(() => undefined); }
    });
    this.writes = write;
    await write;
  }
}
