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
 * Classifiers for the assistant conversation's bot-delivered turns.
 *
 * The Runtime Host mints these ids (runtime-host `assistant/bot/turn-ids.ts`)
 * and the UI classifies the turns by them, so both sides share these
 * predicates. Current ids use dashes; transcripts written before the dash form
 * use colons, and both are recognized.
 *
 * Keep this module free of Node-only imports: the UI bundles it.
 */
export function isAssistantInputTurnId(turnId: string): boolean {
  return turnId.startsWith('assistant-input-') || turnId.startsWith('assistant-input:');
}

export function isAssistantOutputTurnId(turnId: string): boolean {
  return turnId.startsWith('assistant-output-') || turnId.startsWith('assistant-output:');
}
