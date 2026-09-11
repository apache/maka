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

import type { SessionSummary } from '@maka/core/session';

/**
 * Why an import did not produce a task. Each maps to a specific, actionable
 * banner in the import page. Carried as a typed result rather than a thrown
 * error because Electron IPC strips the custom `code` off a `RuntimeHostOperationError`
 * on its way to the renderer — the reason must be decided in Desktop Main, where
 * the code is still intact, and handed across as data.
 */
export type ExternalSessionImportFailureReason =
  /** Import ran but its outcome is unknown; the catalog must be re-read (not retried blindly). */
  | 'commit_outcome_unknown'
  /** No usable model connection to attach the imported task to — configure a model first. */
  | 'no_model'
  /** The source conversation could not be read or converted (e.g. too large or malformed). */
  | 'source_unreadable';

/** Stable Desktop IPC result for the import failures the page renders distinctly. */
export type ExternalSessionImportIpcResult<T extends SessionSummary = SessionSummary> =
  | { readonly ok: true; readonly session: T }
  | { readonly ok: false; readonly reason: ExternalSessionImportFailureReason };
