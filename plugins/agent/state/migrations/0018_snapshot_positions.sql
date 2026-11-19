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

-- Derived coordinates into the immutable inventory, not UI rows or text copies.
CREATE TABLE agent_history_snapshot_positions (
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot) DEFERRABLE INITIALLY DEFERRED,
 kind TEXT NOT NULL CHECK(kind IN ('canonical','imported')),
 major INTEGER NOT NULL CHECK(major>=0),
 minor INTEGER NOT NULL CHECK(minor>=0),
 run TEXT,
 admission_sequence INTEGER,
 fact TEXT,
 internal INTEGER NOT NULL CHECK(internal IN (0,1)),
 CHECK((kind='canonical' AND major>0 AND run IS NOT NULL AND fact IS NOT NULL
        AND admission_sequence IS NOT NULL AND admission_sequence>0 AND admission_sequence<=major)
    OR (kind='imported' AND run IS NULL AND fact IS NULL AND admission_sequence IS NULL)),
 PRIMARY KEY(snapshot,kind,major,minor)
) WITHOUT ROWID;
CREATE INDEX agent_history_snapshot_position_visible
 ON agent_history_snapshot_positions(snapshot,kind,internal,major,minor);
