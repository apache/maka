import type { ArtifactDescriptor, ArtifactSource } from '@maka/core/artifacts';

const USER_VISIBLE_ARTIFACT_SOURCES = {
  tool_result: false,
  tool_result_archive: false,
  synthesis_cache_block: false,
  history_compact_block: false,
  history_compact_source: false,
  provider_request_capture: false,
  session_effect: false,
  subagent_writeback: true,
  deep_research: true,
  user_upload: false,
  export: true,
  snapshot: true,
  fixture: true,
} satisfies Record<ArtifactSource, boolean>;

export function filterUserVisibleArtifacts(
  records: readonly ArtifactDescriptor[],
): ArtifactDescriptor[] {
  return records.filter(
    (record) => record.source === undefined || USER_VISIBLE_ARTIFACT_SOURCES[record.source],
  );
}
