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

/**
 * Published operational-state-store surface.
 *
 * The owning module also exports the schema-migration internals; those run
 * against a caller-supplied database and stay package-private, exactly as the
 * deleted barrel kept them.
 */
export {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
  OPERATIONAL_STATE_SCHEMA_VERSION,
  resolveOperationalStateDatabasePath,
} from './operational-state-store.js';
export type {
  OperationalStateDatabaseLease,
  OperationalStateDatabaseOptions,
} from './operational-state-store.js';
