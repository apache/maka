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

import { join } from 'node:path';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';
import {
  createSqliteSessionMetadataStore,
  type SqliteSessionMetadataStore,
} from './sqlite-session-metadata-store.js';

/**
 * Open the graph-control repository owned by the operational database.
 * Session messages and graph state share runtime.sqlite as one authority.
 */
export function createAgentGraphControlStore(workspaceRoot: string): SqliteSessionMetadataStore {
  const databaseLease = acquireOperationalStateDatabase(workspaceRoot);
  return createSqliteSessionMetadataStore(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME), {
    databaseLease,
  });
}
