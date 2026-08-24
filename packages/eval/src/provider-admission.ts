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

export function isInferenceAdmissionEvent(
  event: Record<string, unknown>,
  anthropic: boolean,
): boolean {
  if (anthropic && event.type === 'message_start' && isRecord(event.message)) return true;
  if (
    typeof event.type === 'string' &&
    (event.type === 'response.created' ||
      event.type === 'response.in_progress' ||
      event.type === 'response.output_item.added' ||
      event.type === 'response.completed')
  ) {
    return true;
  }
  if (Array.isArray(event.choices)) return true;
  for (const candidate of [event, event.response, event.message]) {
    if (isRecord(candidate) && isRecord(candidate.usage)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
