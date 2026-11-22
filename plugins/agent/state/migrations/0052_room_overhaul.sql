-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements.  See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership.  The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License.  You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied.  See the License for the
-- specific language governing permissions and limitations
-- under the License.

ALTER TABLE agent_rooms ADD COLUMN topic TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_rooms ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_room_messages ADD COLUMN edited_at INTEGER;
ALTER TABLE agent_room_messages ADD COLUMN deleted_at INTEGER;

CREATE INDEX agent_room_messages_reply_to
    ON agent_room_messages(owner, session, reply_to)
    WHERE reply_to IS NOT NULL;

CREATE TABLE agent_room_members (
    owner TEXT NOT NULL,
    session TEXT NOT NULL,
    member_session TEXT NOT NULL REFERENCES session_control(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY(owner, session, member_session),
    FOREIGN KEY(owner, session) REFERENCES agent_rooms(owner, session) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX agent_room_members_member ON agent_room_members(member_session);

-- Backfill roster for pre-existing 0040 Rooms from still-live Agent authors and accepted deliveries.
INSERT OR IGNORE INTO agent_room_members(owner, session, member_session, added_at)
SELECT m.owner, m.session, json_extract(m.body_json, '$.author.execution.sessionId'), MIN(m.at)
FROM agent_room_messages m
WHERE json_extract(m.body_json, '$.author.kind') = 'session'
  AND json_extract(m.body_json, '$.author.execution.sessionId') IS NOT NULL
  AND json_extract(m.body_json, '$.author.execution.sessionId') <> m.session
  AND EXISTS(
      SELECT 1 FROM session_control s
      WHERE s.id = json_extract(m.body_json, '$.author.execution.sessionId')
        AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id = s.id AND d.remove_session = 1)
  )
  AND NOT EXISTS(
      SELECT 1 FROM agent_rooms r
      WHERE r.owner = m.owner AND r.session = json_extract(m.body_json, '$.author.execution.sessionId')
  )
GROUP BY m.owner, m.session, json_extract(m.body_json, '$.author.execution.sessionId');

INSERT OR IGNORE INTO agent_room_members(owner, session, member_session, added_at)
SELECT m.owner, m.session, json_extract(d.value, '$.sessionId'), MIN(m.at)
FROM agent_room_messages m, json_each(m.body_json, '$.deliveries') d
WHERE json_extract(d.value, '$.kind') = 'accepted'
  AND json_extract(d.value, '$.sessionId') IS NOT NULL
  AND json_extract(d.value, '$.sessionId') <> m.session
  AND EXISTS(
      SELECT 1 FROM session_control s
      WHERE s.id = json_extract(d.value, '$.sessionId')
        AND NOT EXISTS(SELECT 1 FROM session_retirements ret WHERE ret.session_id = s.id AND ret.remove_session = 1)
  )
  AND NOT EXISTS(
      SELECT 1 FROM agent_rooms r
      WHERE r.owner = m.owner AND r.session = json_extract(d.value, '$.sessionId')
  )
GROUP BY m.owner, m.session, json_extract(d.value, '$.sessionId');

CREATE TABLE agent_room_reactions (
    owner TEXT NOT NULL,
    session TEXT NOT NULL,
    message TEXT NOT NULL,
    actor TEXT NOT NULL,
    emoji TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(owner, session, message, actor, emoji),
    FOREIGN KEY(owner, session, message) REFERENCES agent_room_messages(owner, session, message) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE agent_room_pins (
    owner TEXT NOT NULL,
    session TEXT NOT NULL,
    message TEXT NOT NULL,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY(owner, session, message),
    FOREIGN KEY(owner, session, message) REFERENCES agent_room_messages(owner, session, message) ON DELETE CASCADE
) WITHOUT ROWID;

-- Integer doc_id mapping lets FTS5 update/delete by rowid in O(log N) instead of full-table scanning all Rooms.
CREATE TABLE agent_room_search_docs (
    doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    session TEXT NOT NULL,
    message TEXT NOT NULL,
    UNIQUE(owner, session, message),
    FOREIGN KEY(owner, session, message) REFERENCES agent_room_messages(owner, session, message) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE agent_room_search USING fts5(
    body,
    tokenize='trigram'
);

INSERT INTO agent_room_search_docs(owner, session, message)
SELECT owner, session, message
FROM agent_room_messages
WHERE deleted_at IS NULL;

INSERT INTO agent_room_search(rowid, body)
SELECT d.doc_id, COALESCE(json_extract(m.body_json, '$.content.text'), '')
FROM agent_room_search_docs d
JOIN agent_room_messages m
  ON m.owner = d.owner AND m.session = d.session AND m.message = d.message;

CREATE TRIGGER agent_room_topic_update AFTER UPDATE OF topic ON agent_rooms BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = NEW.owner AND session = NEW.session;
    UPDATE agent_catalog_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER agent_room_member_insert AFTER INSERT ON agent_room_members BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = NEW.owner AND session = NEW.session;
    UPDATE agent_catalog_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER agent_room_member_delete AFTER DELETE ON agent_room_members BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = OLD.owner AND session = OLD.session;
    UPDATE agent_catalog_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER agent_room_message_rev_insert AFTER INSERT ON agent_room_messages BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = NEW.owner AND session = NEW.session;
END;
CREATE TRIGGER agent_room_message_update AFTER UPDATE OF body_json, edited_at, deleted_at ON agent_room_messages BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = NEW.owner AND session = NEW.session;
    UPDATE agent_catalog_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER agent_room_reaction_insert AFTER INSERT ON agent_room_reactions BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = NEW.owner AND session = NEW.session;
END;
CREATE TRIGGER agent_room_reaction_delete AFTER DELETE ON agent_room_reactions BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = OLD.owner AND session = OLD.session;
END;

CREATE TRIGGER agent_room_pin_insert AFTER INSERT ON agent_room_pins BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = NEW.owner AND session = NEW.session;
END;
CREATE TRIGGER agent_room_pin_delete AFTER DELETE ON agent_room_pins BEGIN
    UPDATE agent_rooms SET revision = revision + 1 WHERE owner = OLD.owner AND session = OLD.session;
END;

CREATE TRIGGER agent_room_search_insert AFTER INSERT ON agent_room_messages WHEN NEW.deleted_at IS NULL BEGIN
    INSERT INTO agent_room_search_docs(owner, session, message)
    VALUES (NEW.owner, NEW.session, NEW.message);
    INSERT INTO agent_room_search(rowid, body)
    VALUES (last_insert_rowid(), COALESCE(json_extract(NEW.body_json, '$.content.text'), ''));
END;

CREATE TRIGGER agent_room_search_update AFTER UPDATE OF body_json, deleted_at ON agent_room_messages BEGIN
    DELETE FROM agent_room_search
    WHERE rowid = (
        SELECT doc_id FROM agent_room_search_docs
        WHERE owner = OLD.owner AND session = OLD.session AND message = OLD.message
    );
    DELETE FROM agent_room_search_docs
    WHERE NEW.deleted_at IS NOT NULL
      AND owner = OLD.owner AND session = OLD.session AND message = OLD.message;
    INSERT OR IGNORE INTO agent_room_search_docs(owner, session, message)
    SELECT NEW.owner, NEW.session, NEW.message
    WHERE NEW.deleted_at IS NULL;
    INSERT INTO agent_room_search(rowid, body)
    SELECT d.doc_id, COALESCE(json_extract(NEW.body_json, '$.content.text'), '')
    FROM agent_room_search_docs d
    WHERE NEW.deleted_at IS NULL
      AND d.owner = NEW.owner AND d.session = NEW.session AND d.message = NEW.message;
END;

CREATE TRIGGER agent_room_search_delete BEFORE DELETE ON agent_room_messages BEGIN
    DELETE FROM agent_room_search
    WHERE rowid = (
        SELECT doc_id FROM agent_room_search_docs
        WHERE owner = OLD.owner AND session = OLD.session AND message = OLD.message
    );
END;
