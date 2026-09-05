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

import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
} from '@maka/core/session';

export interface SqliteSessionRolePredicate {
  readonly sql: string;
  readonly parameters: readonly string[];
}

/**
 * The reserved Coordination identity remains non-ordinary even when its role
 * metadata is corrupt or missing. This keeps damaged authority state out of
 * ordinary catalogs and write paths until the Host can be repaired.
 */
export function sqliteOrdinarySessionRolePredicate(): SqliteSessionRolePredicate {
  return {
    sql: `(
      metadata.session_id <> ?
      AND json_type(metadata.payload_json, '$.role') IS NULL
    )`,
    parameters: [WORKHUB_COORDINATION_SESSION_ID],
  };
}

/** Returns only rows that Runtime recovery may safely rebuild. */
export function sqliteRecoverableSessionRolePredicate(): SqliteSessionRolePredicate {
  const ordinary = sqliteOrdinarySessionRolePredicate();
  return {
    sql: `(
      ${ordinary.sql}
      OR (
        metadata.session_id = ?
        AND json_type(metadata.payload_json, '$.role') = 'text'
        AND json_extract(metadata.payload_json, '$.role') = ?
      )
    )`,
    parameters: [
      ...ordinary.parameters,
      WORKHUB_COORDINATION_SESSION_ID,
      WORKHUB_COORDINATION_SESSION_ROLE,
    ],
  };
}
