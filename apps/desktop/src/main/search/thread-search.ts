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
 * Desktop compatibility facade for the shared local transcript search.
 * Runtime Host Agent tools and the Desktop search modal intentionally use the
 * same bounded, redacted implementation.
 */
export {
  MAX_SESSIONS_SCANNED,
  SNIPPET_CONTEXT_HALF,
  SNIPPET_MAX_CODE_POINTS,
  THREAD_SOURCE,
  TOOL_RESULT_SCAN_CAP_BYTES,
  TOTAL_PAYLOAD_CAP_BYTES,
  buildSnippet,
  capCodePoints,
  collectSearchableText,
  findMatch,
  foldForMatch,
  formatSearchResultSummary,
  runThreadSearch,
  threadSearchMatchKind,
  type ThreadSearchDeps,
  type ThreadSearchSuccess,
} from '@maka/core/thread-search';
