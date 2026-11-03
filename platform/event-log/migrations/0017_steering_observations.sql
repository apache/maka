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

UPDATE context_semantic_rows
SET row_json=json_set(row_json, '$.kind.ToolResult.kind', 'output')
WHERE kind='tool_result' AND json_type(row_json, '$.kind.ToolResult.kind') IS NULL;

UPDATE context_semantic_rows
SET row_json=json_set(row_json, '$.kind.UnknownTool.kind', 'output')
WHERE kind='unknown_tool' AND json_type(row_json, '$.kind.UnknownTool.kind') IS NULL;

UPDATE context_semantic_rows
SET directory_bytes=maka_steering_row_directory(row_json)
WHERE kind IN ('tool_result', 'unknown_tool');

UPDATE context_semantic_frontiers
SET frontier_json=maka_steering_frontier(frontier_json);
