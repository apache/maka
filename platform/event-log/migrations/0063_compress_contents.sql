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

-- Transparently store zstd-compressed blobs in contents while keeping
-- content_sha256 and logical_bytes anchored to the uncompressed bytes.
-- encoding: 0 = raw uncompressed bytes (logical_bytes IS NULL),
--           1 = single zstd frame (<= 64 KiB, logical_bytes = uncompressed length),
--           2 = seekable framed zstd (64 KiB independent frames + standard Zstd
--               Seekable Format skippable footer, logical_bytes = uncompressed length),
--           3 = single zstd frame using bundled schema-only dictionary v1
--               (128 B..=4 KiB JSON-like envelopes, logical_bytes = uncompressed length).
-- Enforce invariants via triggers instead of ALTER TABLE ... CHECK so upgrading
-- existing databases is an O(1) metadata-only change (zero startup stall).
-- Existing raw rows (id <= target_max_id) are recompressed in bounded background
-- batches by Root material maintenance alongside incremental_vacuum.
ALTER TABLE contents ADD COLUMN encoding INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contents ADD COLUMN logical_bytes INTEGER;

CREATE TRIGGER content_encoding_valid BEFORE INSERT ON contents
WHEN COALESCE(
    (NEW.encoding = 0 AND NEW.logical_bytes IS NULL)
    OR (NEW.encoding IN (1, 2, 3) AND NEW.logical_bytes IS NOT NULL AND NEW.logical_bytes >= 0),
    0
) = 0
BEGIN
    SELECT RAISE(ABORT, 'invalid content encoding');
END;

DROP TRIGGER content_immutable;
CREATE TRIGGER content_immutable BEFORE UPDATE ON contents
WHEN COALESCE(
    OLD.encoding = 0
    AND OLD.logical_bytes IS NULL
    AND NEW.id = OLD.id
    AND NEW.content_sha256 = OLD.content_sha256
    AND NEW.logical_bytes = length(OLD.payload)
    AND length(NEW.payload) < length(OLD.payload)
    AND CASE
        WHEN NEW.encoding IN (1, 3) THEN maka_content_bytes(NEW.payload, NEW.encoding) = OLD.payload
        WHEN NEW.encoding = 2 THEN length(OLD.payload) > 65536
        ELSE 0
    END,
    0
) = 0
BEGIN
    SELECT RAISE(ABORT, 'content is immutable');
END;

CREATE TABLE content_recompression_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    cursor_id INTEGER NOT NULL CHECK(cursor_id >= 0),
    target_max_id INTEGER NOT NULL CHECK(target_max_id >= 0)
);
INSERT INTO content_recompression_state(singleton, cursor_id, target_max_id)
VALUES (1, 0, COALESCE((SELECT MAX(id) FROM contents), 0));
