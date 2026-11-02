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

ALTER TABLE session_control ADD COLUMN catalog_activity_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_control ADD COLUMN catalog_recency INTEGER
    GENERATED ALWAYS AS (-max(created_at, catalog_activity_at)) VIRTUAL;

UPDATE session_control SET catalog_activity_at = COALESCE((
    SELECT message_at FROM catalog_messages INDEXED BY catalog_latest_message
    WHERE session_id = session_control.id
    ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1
), 0);

DROP INDEX session_catalog_pin_order;
CREATE INDEX session_catalog_pin_order
    ON session_control(catalog_unpinned, catalog_recency, id);

UPDATE session_catalog_revision SET revision = revision + 1 WHERE singleton = 1;
