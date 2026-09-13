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

import type { OpenResponsesCompatibilityProfile } from './provider-runtime-policy.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredToolCount(body: Record<string, unknown>): number | undefined {
  const choice = body.tool_choice;
  if (choice === 'required') {
    return Array.isArray(body.tools) ? body.tools.length : 0;
  }
  if (isRecord(choice) && choice.type === 'allowed_tools' && choice.mode === 'required') {
    return Array.isArray(choice.tools) ? choice.tools.length : 0;
  }
  return undefined;
}

export function createOpenResponsesCompatibilityFinalizer(
  profile: OpenResponsesCompatibilityProfile | undefined,
): ((body: Record<string, unknown>) => Record<string, unknown>) | undefined {
  if (!profile) return undefined;
  return (body) => {
    const choice = body.tool_choice;
    const forcedToolCount = requiredToolCount(body);
    if (forcedToolCount !== undefined && forcedToolCount !== 1) {
      throw new Error('Alibaba Token Plan Responses requires exactly one tool for tool_choice');
    }
    if (isRecord(choice) && choice.type !== 'allowed_tools') {
      throw new Error('Alibaba Token Plan Responses does not support this tool_choice object');
    }
    return { ...body, store: false };
  };
}
