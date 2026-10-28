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

UPDATE context_obligations
SET sealed_unknown = 1
WHERE kind = 'tool' AND sealed_unknown = 0
  AND EXISTS (
    SELECT 1 FROM event_log terminal
    WHERE terminal.invocation_id = context_obligations.invocation_id
      AND terminal.kind = 'invocation_ended'
      AND json_extract(COALESCE(terminal.event_json, terminal.retained_json), '$.fact.outcome.kind')
        IN ('failed', 'cancelled')
  );
