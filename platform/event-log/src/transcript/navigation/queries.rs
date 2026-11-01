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

pub(super) const FENCE: &str = "
SELECT MAX(sequence) FROM (
 SELECT MAX(event.sequence) AS sequence FROM runtime_events event
 JOIN runtime_events opening ON opening.invocation_id = event.invocation_id AND opening.kind = 'invocation_opened'
 WHERE (event.event_header IS NOT NULL AND event.event_session=?1)
 AND json_extract(opening.event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
 UNION ALL
 SELECT MAX(h.sequence) FROM session_history_members h
 JOIN runtime_events event ON event.sequence=h.sequence
 JOIN runtime_events opening ON opening.invocation_id = event.invocation_id AND opening.kind = 'invocation_opened'
 WHERE h.session_id = ?1
 AND json_extract(opening.event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff'))";

pub(super) const ROWS: &str = "
SELECT row.source_sequence,row.item_index,row.turn_id,row.role,source.kind
FROM transcript_directory row JOIN runtime_events source ON source.sequence=row.source_sequence
WHERE row.session_id=?1 AND row.source_sequence<=?2
AND (row.source_sequence,row.item_index)>=(COALESCE(?3,1),COALESCE(?4,0))
ORDER BY row.source_sequence,row.item_index LIMIT 257";

pub(super) const LANDMARKS: &str = "
WITH sources AS (
 SELECT opening.invocation_id,opening.sequence,json_extract(opening.event_header,'$.invocation.turn_id') AS turn_id
 FROM runtime_events opening
 WHERE json_extract(opening.event_header,'$.invocation.session_id')=?1
 AND opening.kind='invocation_opened' AND opening.sequence<=?2
 AND json_extract(opening.event_header,'$.fact.input.kind') IN ('message','continuation')
 UNION ALL
 SELECT opening.invocation_id,opening.sequence,json_extract(opening.event_header,'$.invocation.turn_id')
 FROM session_history_members h JOIN runtime_events opening ON opening.sequence=h.sequence
 WHERE h.session_id=?1 AND h.sequence<=?2 AND opening.kind='invocation_opened'
 AND json_extract(opening.event_header,'$.fact.input.kind') IN ('message','continuation')
), openings AS (
 SELECT invocation_id,sequence,ROW_NUMBER() OVER (PARTITION BY turn_id ORDER BY sequence) AS first
 FROM sources
), candidates AS (
 SELECT invocation_id, sequence, ROW_NUMBER() OVER (ORDER BY sequence) - 1 AS rank, COUNT(*) OVER () AS total
 FROM openings WHERE first = 1
), samples(n) AS (
 SELECT 0 UNION ALL SELECT n + 1 FROM samples WHERE n + 1 < ?3
)
SELECT DISTINCT invocation_id, sequence FROM candidates
JOIN samples ON rank = CASE WHEN ?3 = 1 THEN total - 1 ELSE n * (total - 1) / (?3 - 1) END
ORDER BY sequence";

pub(super) const PROMPT: &str = "
SELECT row.turn_id,row.source_sequence,row.item_index
FROM runtime_events source JOIN transcript_directory row ON row.source_sequence=source.sequence
WHERE source.invocation_id=?2 AND source.kind IN ('invocation_opened','message_steered')
AND row.role='user' AND row.session_id=?1 AND row.source_sequence<=?3
ORDER BY row.source_sequence,row.item_index LIMIT 1";

pub(super) const BOUNDS: &str = "
SELECT first.source_sequence, first.item_index, last.source_sequence, last.item_index
FROM (
 SELECT source_sequence, item_index FROM transcript_directory
 WHERE session_id = ?1 AND turn_id = ?2 AND source_sequence <= ?3
 ORDER BY source_sequence, item_index LIMIT 1
) first CROSS JOIN (
 SELECT source_sequence, item_index FROM transcript_directory
 WHERE session_id = ?1 AND turn_id = ?2 AND source_sequence <= ?3
 ORDER BY source_sequence DESC, item_index DESC LIMIT 1
) last";
