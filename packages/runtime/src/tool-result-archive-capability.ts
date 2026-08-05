/**
 * The tool-result archive is one capability, not three optional fields (#2026).
 *
 * When the context budget prunes a large tool result, the placeholder that
 * replaces it is a runtime-generated protocol value naming `ArchiveRead` as the
 * way back to the content. Writer, replay reader, ref-addressed reader and that
 * decoder tool therefore share one authority: a host either archives and can
 * read back, or does neither. Splitting them across backend options and tool
 * options made "writer on, decoder absent" representable, and it shipped twice
 * (#2025 on the headless surface, and the child-agent path).
 *
 * Hosts supply only storage. The decoder travels with the capability and is
 * bound by the backend, so which host remembered to register a tool is no
 * longer part of the question.
 */

import { buildArchiveReadTool } from './archive-read-tool.js';
import type { ToolResultArchiveRecorder } from './ai-sdk-compaction-contract.js';
import type { ToolResultArchiveReader } from './tool-result-archive.js';
import type { ToolResultArchiveResourceReader } from './tool-result-archive-resource.js';
import type { MakaTool } from './tool-runtime.js';

export const ARCHIVE_READ_TOOL_NAME = 'ArchiveRead';

/** Host-owned storage for one archive authority. */
export interface ToolResultArchiveServices {
  /** Durably archives a pruned tool result body. */
  archiveToolResult: ToolResultArchiveRecorder;
  /** Replay hydration, addressed by the originating runtime event. */
  readToolResultArchive: ToolResultArchiveReader;
  /** Ref-addressed read backing `ArchiveRead`; carries no runtime-event identity. */
  readArchivedToolResultResource: ToolResultArchiveResourceReader['readArchivedToolResultResource'];
}

/**
 * One indivisible archive authority. Constructible only through
 * {@link createToolResultArchiveCapability}, so a half-built capability has no
 * spelling.
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
 * archives. Idempotent, so a host that still binds `ArchiveRead` itself keeps
 * exactly one of it while the surfaces are being migrated.
 */
export function bindToolResultArchiveDecoder(
  tools: readonly MakaTool[],
  capability: ToolResultArchiveCapability | undefined,
): MakaTool[] {
  if (!capability) return [...tools];
  if (tools.some((tool) => tool.name === ARCHIVE_READ_TOOL_NAME)) return [...tools];
  return [...tools, capability.archiveReadTool];
}
