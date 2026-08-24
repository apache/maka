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
 * The `/skill:<name>` invocation grammar (issue #1148) — one string, because
 * every client that reads or writes a draft has to agree on where a token
 * starts and ends: the TUI's highlighter and autocomplete, the Desktop
 * composer's chips, and Runtime's submit-time parser and stripper.
 *
 * It lives in core rather than in Runtime because the Desktop composer needs
 * it to render a draft, long before anything is sent, and the renderer has no
 * business depending on Runtime for that.
 *
 * A token is valid at the start of the text or after whitespace, so paths and
 * URLs (`a/skill:b`, `https://x/skill:y`) never produce false positives.
 * `<name>` uses the skill id charset; resolution downstream matches by id
 * first, then by display name.
 *
 * Always construct a fresh `RegExp` from this source at the point of use: a
 * shared instance with the `g` flag carries `lastIndex` between calls.
 */
export const SKILL_INVOCATION_TOKEN_SOURCE = String.raw`(?:^|(?<=\s))\/skill:([A-Za-z0-9._-]+)`;
