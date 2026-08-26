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

export function createOpenResponsesCompatibilityFinalizer(
  profile: OpenResponsesCompatibilityProfile | undefined,
): ((body: Record<string, unknown>) => Record<string, unknown>) | undefined {
  if (!profile) return undefined;
  return (body) => {
    const choice = body.tool_choice;
    if (choice === 'required' || (choice !== null && typeof choice === 'object')) {
      throw new Error('Alibaba Token Plan Responses does not support forced tool_choice');
    }
    return { ...body, store: false };
  };
}
