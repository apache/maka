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

-- Physical bytes are shared only inside this partition. Session records remain
-- the ownership/read authority; content identities never grant access.
CREATE TABLE artifact_contents (
    content_sha256 TEXT NOT NULL PRIMARY KEY,
    payload BLOB NOT NULL
);

-- Conflicting bytes under one digest abort migration rather than discard data.
INSERT INTO artifact_contents(content_sha256, payload)
SELECT content_sha256, payload FROM artifacts WHERE true
ON CONFLICT(content_sha256) DO UPDATE SET payload = NULL
WHERE artifact_contents.payload <> excluded.payload;

CREATE TABLE artifacts_shared (
    lookup_digest BLOB NOT NULL CHECK(length(lookup_digest) = 32),
    session_id TEXT NOT NULL REFERENCES session_control(id),
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    record_json TEXT NOT NULL,
    content_sha256 TEXT NOT NULL REFERENCES artifact_contents(content_sha256),
    canonical_at INTEGER CHECK(canonical_at IS NULL OR canonical_at > 0),
    PRIMARY KEY (session_id, id),
    CHECK(json_extract(record_json, '$.sessionId') = session_id),
    CHECK(json_extract(record_json, '$.id') = id),
    CHECK(json_extract(record_json, '$.createdAt') = created_at)
);

CREATE TABLE history_artifacts_shared (
    lookup_digest BLOB NOT NULL CHECK(length(lookup_digest) = 32),
    target_digest BLOB NOT NULL CHECK(length(target_digest) = 32),
    session_id TEXT NOT NULL REFERENCES session_history_copies(session_id),
    source_session_id TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    PRIMARY KEY(session_id, source_session_id, source_artifact_id),
    FOREIGN KEY(session_id, artifact_id) REFERENCES artifacts_shared(session_id, id)
);

INSERT INTO artifacts_shared(rowid, lookup_digest, session_id, id, created_at, record_json, content_sha256, canonical_at)
SELECT rowid, lookup_digest, session_id, id, created_at, record_json, content_sha256, canonical_at FROM artifacts;
INSERT INTO history_artifacts_shared SELECT * FROM session_history_artifacts;
DROP TABLE session_history_artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_shared RENAME TO artifacts;
ALTER TABLE history_artifacts_shared RENAME TO session_history_artifacts;

CREATE INDEX artifacts_session_order ON artifacts(session_id, created_at DESC, id);
CREATE INDEX artifacts_lookup_digest ON artifacts(lookup_digest);
CREATE INDEX artifacts_content_refs ON artifacts(content_sha256);
CREATE INDEX session_history_artifacts_locator ON session_history_artifacts(session_id, source_artifact_id, artifact_id);
CREATE INDEX history_artifacts_lookup_digest ON session_history_artifacts(lookup_digest);
CREATE INDEX history_artifacts_target_digest ON session_history_artifacts(target_digest);

-- Release bytes in the same transaction as the final owned reference, covering
-- user deletion, Session retirement and abandoned revisions without a refcount.
CREATE TRIGGER artifact_content_released AFTER DELETE ON artifacts BEGIN
    DELETE FROM artifact_contents WHERE content_sha256 = OLD.content_sha256
      AND NOT EXISTS (SELECT 1 FROM artifacts WHERE content_sha256 = OLD.content_sha256);
END;
