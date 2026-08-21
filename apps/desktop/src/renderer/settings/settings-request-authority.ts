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

interface SettingsRequestTicket {
  readonly key: string;
  readonly generation: number;
}

/**
 * Separates Runtime Host read refreshes from mutations while fencing both to
 * the currently selected Host epoch. Catalog refreshes may invalidate reads
 * without discarding a same-Host mutation that has already reached Desktop.
 */
export function createSettingsRequestAuthority(initialKey?: string) {
  let targetKey = initialKey;
  let settingsReadGeneration = 0;
  let connectionsReadGeneration = 0;
  let settingsWriteGeneration = 0;

  function ticket(key: string, generation: number): SettingsRequestTicket {
    return { key, generation };
  }

  return {
    selectTarget(nextKey: string | undefined): void {
      if (targetKey === nextKey) return;
      targetKey = nextKey;
      settingsReadGeneration += 1;
      connectionsReadGeneration += 1;
      settingsWriteGeneration += 1;
    },

    invalidateReads(): void {
      settingsReadGeneration += 1;
      connectionsReadGeneration += 1;
    },

    beginSettingsRead(key: string): SettingsRequestTicket | undefined {
      if (key !== targetKey) return undefined;
      settingsReadGeneration += 1;
      return ticket(key, settingsReadGeneration);
    },

    acceptsSettingsRead(candidate: SettingsRequestTicket): boolean {
      return candidate.key === targetKey &&
        candidate.generation === settingsReadGeneration;
    },

    beginConnectionsRead(key: string): SettingsRequestTicket | undefined {
      if (key !== targetKey) return undefined;
      connectionsReadGeneration += 1;
      return ticket(key, connectionsReadGeneration);
    },

    acceptsConnectionsRead(candidate: SettingsRequestTicket): boolean {
      return candidate.key === targetKey &&
        candidate.generation === connectionsReadGeneration;
    },

    beginSettingsWrite(key: string): SettingsRequestTicket | undefined {
      if (key !== targetKey) return undefined;
      settingsWriteGeneration += 1;
      return ticket(key, settingsWriteGeneration);
    },

    acceptsSettingsWrite(candidate: SettingsRequestTicket): boolean {
      return candidate.key === targetKey &&
        candidate.generation === settingsWriteGeneration;
    },
  };
}
