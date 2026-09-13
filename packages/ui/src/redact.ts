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
 * Re-export the shared display-layer redactor from `@maka/core` (#1065).
 *
 * The patterns and `<redacted>` marker are the single source of truth for
 * display redaction, shared by the desktop quiet panel and the TUI.
 * The backend has its own separate redactor (`@maka/core/redaction.ts`)
 * for log/persistence sanitization.
 */
export {
  redactReversibleStreamingSuffix,
  redactSecrets,
  redactStableStreamingSuffix,
} from '@maka/core/display-redaction';
