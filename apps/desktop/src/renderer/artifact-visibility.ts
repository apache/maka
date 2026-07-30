import type { ArtifactRecord, ArtifactSource } from '@maka/core';

const USER_VISIBLE_ARTIFACT_SOURCES = {
  tool_result: true,
  tool_result_archive: true,
  synthesis_cache_block: false,
  history_compact_block: false,
  history_compact_source: false,
  provider_request_capture: false,
  deep_research: true,
  user_upload: false,
  export: true,
  snapshot: true,
  fixture: true,
} satisfies Record<ArtifactSource, boolean>;

export function filterUserVisibleArtifacts(records: readonly ArtifactRecord[]): ArtifactRecord[] {
  return records.filter(
    (record) => record.source === undefined || USER_VISIBLE_ARTIFACT_SOURCES[record.source],
  );
}
