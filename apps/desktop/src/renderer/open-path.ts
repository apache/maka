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
 * Renderer-side helpers for the structured `app:openPath` IPC contract.
 *
 * Backend (see `apps/desktop/src/main/open-path-guard.ts`) returns either
 * `{ ok: true; opened: string }` or `{ ok: false; reason }`, where the reason
 * is a closed enum — surfaces should not interpolate the raw value into UI;
 * use `openPathFailureCopy` for human-facing strings. Both helpers live in the
 * shell catalog beside the copy they read, so feature code reaches the same
 * implementation.
 */

export { openPathActionLabel, openPathFailureCopy } from './locales/shell-copy.js';
