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


CREATE TABLE pending_content_releases (
 content_id INTEGER PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE
);
CREATE TRIGGER pending_content_released
 AFTER DELETE ON pending_content_releases
 WHEN EXISTS(SELECT 1 FROM contents WHERE id=old.content_id) BEGIN
 DELETE FROM contents WHERE id=old.content_id
   AND NOT EXISTS(SELECT 1 FROM content_references r WHERE r.content_id=old.content_id);
END;
