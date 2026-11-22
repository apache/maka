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

CREATE TABLE agent_rooms (
    session TEXT PRIMARY KEY REFERENCES session_control(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    UNIQUE(owner, session)
) WITHOUT ROWID;

CREATE TABLE agent_room_messages (
    owner TEXT NOT NULL,
    session TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    message TEXT NOT NULL,
    at INTEGER NOT NULL,
    reply_to TEXT,
    body_json TEXT NOT NULL CHECK(json_valid(body_json)),
    PRIMARY KEY(owner, session, sequence),
    UNIQUE(owner, session, message),
    FOREIGN KEY(owner, session) REFERENCES agent_rooms(owner, session) ON DELETE CASCADE,
    FOREIGN KEY(owner, session, reply_to) REFERENCES agent_room_messages(owner, session, message)
) WITHOUT ROWID;

CREATE INDEX agent_room_messages_time ON agent_room_messages(owner, session, at DESC, sequence DESC);

CREATE TRIGGER agent_room_insert AFTER INSERT ON agent_rooms BEGIN
    UPDATE agent_catalog_revision SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER agent_room_message_insert AFTER INSERT ON agent_room_messages BEGIN
    UPDATE agent_catalog_revision SET revision=revision+1 WHERE singleton=1;
END;
