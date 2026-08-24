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

/**
 * The tool-result archive is one capability, not three optional fields (#2026).
 *
 * When the context budget prunes a large tool result, the placeholder that
 * replaces it is a runtime-generated protocol value naming `ArchiveRead` as the
 * way back to the content. Writer, replay reader, ref-addressed reader and that
 * decoder tool therefore share one authority: a host either archives and can
 * read back, or does neither. Splitting them across backend options and tool
 * options made "writer on, decoder absent" representable, and it shipped twice
 * (#2025 and the child-agent path).
 *
 * Hosts supply only storage. The decoder travels with the capability and is
 * bound by the backend, so which host remembered to register a tool is no
 * longer part of the question.
 */

import { ARCHIVE_READ_TOOL_NAME, buildArchiveReadTool } from './archive-read-tool.js';
import type { ActiveToolResultArchiveCandidate } from './active-tool-result-prune.js';
import type { StaleToolResultArchiveCandidate } from './context-budget.js';
import type { ToolResultArchiveReader } from './tool-result-archive.js';
import type { ToolResultArchiveResourceReader } from './tool-result-archive-resource.js';
import type { MakaTool } from './tool-runtime.js';

export { ARCHIVE_READ_TOOL_NAME };

/**
 * What the writer is handed for one pruned body. The union spans both prune
 * paths — a stale prior-turn result and an active current-turn one — because
 * the archive is one authority over both.
 */
export type ToolResultArchiveRecorderInput = (
  | StaleToolResultArchiveCandidate
  | (ActiveToolResultArchiveCandidate & { runtimeEventId: string })
) & {
  sessionId: string;
  bodySha256: string;
};
export type ToolResultArchiveRecorder = (
  input: ToolResultArchiveRecorderInput,
) => Promise<{ artifactId: string } | void> | { artifactId: string } | void;

/** Host-owned storage for one archive authority. */
export interface ToolResultArchiveServices {
  /** Durably archives a pruned tool result body. */
  archiveToolResult: ToolResultArchiveRecorder;
  /** Replay hydration, addressed by the originating runtime event. */
  readToolResultArchive: ToolResultArchiveReader;
  /**
   * Ref-addressed read backing `ArchiveRead`. A `maka://archive/...` ref carries
   * only artifact id, hash and size — no runtime-event identity — so this read
   * must never synthesize one to satisfy the stricter replay path above.
   *
   * It MUST reject a read whose `sessionId` does not own the artifact. The
   * runtime passes down the invoking session's id but cannot verify ownership
   * itself, so this is the only place the session boundary is enforced, and the
   * argument that the decoder grants a child no reach it lacked rests on it.
   */
  readArchivedToolResultResource: ToolResultArchiveResourceReader['readArchivedToolResultResource'];
}

/**
 * One indivisible archive authority. Build it through
 * {@link createToolResultArchiveCapability}: the decoder is derived from the
 * same services the writer uses, so "archives, but the placeholder names a tool
 * nobody bound" has no spelling. A capability whose readers merely fail is of
 * course still constructible — but that failure is legible to the model and the
 * host, which is what the old missing-tool state never was.
 */
export interface ToolResultArchiveCapability {
  readonly services: ToolResultArchiveServices;
  readonly archiveReadTool: MakaTool;
}

export function createToolResultArchiveCapability(
  services: ToolResultArchiveServices,
): ToolResultArchiveCapability {
  return Object.freeze({
    services: Object.freeze({ ...services }),
    archiveReadTool: buildArchiveReadTool({
      readArchivedToolResultResource: services.readArchivedToolResultResource,
    }),
  });
}

/**
 * Add the decoder to a session's tool set when — and only when — that session
 * archives.
 *
 * No in-tree host binds `ArchiveRead` any more, so the dedup guard exists for
 * tool sets this runtime does not own: an embedder's custom tool, or an agent
 * definition that names it. Such a tool wins, which also means it — not this
 * capability — is what the placeholder's ref will be handed to. Advertising two
 * tools under one name would be worse.
 */
export function bindToolResultArchiveDecoder(
  tools: readonly MakaTool[],
  capability: ToolResultArchiveCapability | undefined,
): MakaTool[] {
  if (!capability) return [...tools];
  if (tools.some((tool) => tool.name === ARCHIVE_READ_TOOL_NAME)) return [...tools];
  return [...tools, capability.archiveReadTool];
}
