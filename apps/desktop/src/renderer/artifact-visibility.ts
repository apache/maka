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
