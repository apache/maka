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

import { openai } from '@ai-sdk/openai';

export const openAiApplyPatchProviderTool = openai.tools.applyPatch({});
const inputSchema = openAiApplyPatchProviderTool.inputSchema;
export const openAiApplyPatchInputSchema =
  typeof inputSchema === 'function' ? inputSchema() : inputSchema;

/** Models documented by OpenAI as supporting the native Apply Patch tool. */
export function openAiModelSupportsApplyPatch(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return (
    /^gpt-5\.(?:1|2|5)(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ||
    /^gpt-5\.4(?:-(?:mini|nano|pro))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id) ||
    /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)
  );
}
