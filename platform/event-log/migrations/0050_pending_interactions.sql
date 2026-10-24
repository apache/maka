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

-- Canonical requests and outcomes remain append-only. This derived membership
-- contains only work that can still need an outcome, independent of old history.
CREATE TABLE interaction_pending (
    request_id TEXT PRIMARY KEY NOT NULL REFERENCES interaction_requests(request_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX interaction_pending_order ON interaction_pending(session_id, created_at, request_id);
CREATE INDEX interaction_pending_session_cursor ON interaction_pending(session_id, request_id);

-- One-time backfill; steady reads never re-run the historical anti-join.
INSERT INTO interaction_pending
SELECT request_id, session_id, created_at FROM interaction_requests request
WHERE NOT EXISTS (SELECT 1 FROM interaction_outcomes outcome
                  WHERE outcome.request_id=request.request_id);

CREATE TRIGGER interaction_pending_request_insert AFTER INSERT ON interaction_requests
BEGIN
    INSERT INTO interaction_pending(request_id, session_id, created_at)
    SELECT NEW.request_id, NEW.session_id, NEW.created_at
    WHERE NOT EXISTS (SELECT 1 FROM interaction_outcomes WHERE request_id=NEW.request_id);
END;
CREATE TRIGGER interaction_pending_outcome_insert AFTER INSERT ON interaction_outcomes
BEGIN
    DELETE FROM interaction_pending WHERE request_id=NEW.request_id;
END;
-- Deletion/import cleanup restores membership only while its canonical request
-- still exists and no replacement outcome exists. Trigger work shares the
-- canonical transaction, including retries, rollback, and crash recovery.
CREATE TRIGGER interaction_pending_outcome_delete AFTER DELETE ON interaction_outcomes
BEGIN
    INSERT INTO interaction_pending(request_id, session_id, created_at)
    SELECT request_id, session_id, created_at FROM interaction_requests
    WHERE request_id=OLD.request_id
      AND NOT EXISTS (SELECT 1 FROM interaction_outcomes WHERE request_id=OLD.request_id)
    ON CONFLICT(request_id) DO NOTHING;
END;
