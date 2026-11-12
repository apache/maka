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

import { writeFile } from 'node:fs/promises';
export async function output(prompt: string, draft: any = {}) {
  const path = /完成后把增量操作写入 (.+)，格式：/.exec(prompt)?.[1];
  if (!path) throw Error('Missing notebook output path');
  await writeFile(
    path,
    JSON.stringify({ notes: [], feedbackDecisions: [], messages: [], ...draft }),
  );
}
export function view(prompt: string) {
  return /记事本：(.+)/.exec(prompt)![1];
}
export const note = {
  topicId: 'exhibition',
  title: '展览',
  text: '用户曾关注摄影展；近期开放安排待了解。',
  occurredAt: null,
  sources: ['用户历史'],
  tags: ['摄影'],
};
