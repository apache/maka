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

export type ToolMode = 'direct' | 'code_mode';

/**
 * The user-facing tool-mode preference: the two concrete Runtime modes plus
 * `auto`, the absence of an override. `auto` is a settings-layer value only —
 * it resolves (once, at the product boundary) into a concrete `ToolMode` or
 * into field omission and never reaches Runtime execution or persistence.
 */
export type ToolModePreference = 'auto' | ToolMode;

export const DEFAULT_TOOL_MODE: ToolMode = 'direct';

export const DEFAULT_TOOL_MODE_PREFERENCE: ToolModePreference = 'auto';

export function isToolMode(value: unknown): value is ToolMode {
  return value === 'direct' || value === 'code_mode';
}

export function isToolModePreference(value: unknown): value is ToolModePreference {
  return value === 'auto' || isToolMode(value);
}
