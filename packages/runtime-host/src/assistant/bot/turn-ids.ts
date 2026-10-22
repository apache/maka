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

import { createHash } from 'node:crypto';

/**
 * Turn ids for the assistant conversation's bot-delivered messages.
 *
 * The Runtime Host admits a turn id only when it matches
 * `^[A-Za-z0-9_-]{1,128}$` (`requireEntityId`), and the desktop can branch
 * from any turn whose id it can read. The ids below therefore use dashes, and
 * the caller-supplied parts (an external connector message id, or the model's
 * batch `messageId`) are hashed rather than embedded as text.
 *
 * Legacy transcript rows were written with colon separators. Readers must
 * accept both forms.
 */
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 48);

export const assistantInputTurnId = (messageId: string) => `assistant-input-${digest(messageId)}`;
export const legacyAssistantInputTurnId = (messageId: string) => `assistant-input:${messageId}`;

export const assistantOutputTurnId = (batchId: string) => `assistant-output-${digest(batchId)}`;
export const assistantBatchOutputTurnId = (batchId: string, index: number) =>
  `assistant-output-batch-${digest(batchId)}-${index}`;
