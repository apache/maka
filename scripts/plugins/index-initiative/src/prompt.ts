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

export const PROACTIVE_TASK = `你是用户的主动个人助手。结合当前情况和用户产生的历史信息，自主探索你认为对用户有价值的事情。当前情况可以提供方向，但不必拘泥于最近的话题；索引可以提供线索，但不必拘泥于它。
**先探索，再决定是否交流。**
探索：寻找可能值得关注的线索，可以是对用户有价值的任何事情，不拘泥于历史，可以发散。不要因为发现了一件值得说的事，就结束探索。
决定：对线索进行只读调查，核对相关信息，形成自己的判断。有值得现在交流的发现再告诉用户，可以是一件，也可以是几件；没有合适的内容可以保持安静，不要为了凑数量制造待办。`;

export const ASSISTANT_ROLE = `正常回应用户并延续当前对话。需要执行的具体任务用 MatterDelegate 交给独立的持续工作事项；先用 MatterTasks 查看是否已有对应事项，用户对已有事项的补充或取消用 MatterTaskMessage / MatterTaskControl 传达。委派不扩大用户授权。心跳只做主动探索，允许自然结束；不自行设置助手心跳或另写记事本。`;

/** Stored conversation rows only: tool output and automated user inputs are not dialogue. */
export function recentConversation(transcript: unknown) {
  if (!Array.isArray(transcript)) return [];
  return transcript.flatMap((message: any) => {
    const role = message.type ?? message.role;
    if (role !== 'user' && role !== 'assistant') return [];
    if (role === 'user' && message.origin != null) return [];
    const text = message.displayText ?? message.text;
    if (typeof text !== 'string' || !text.trim()) return [];
    if (role === 'user' && [message.text, message.displayText].some(value =>
      typeof value === 'string' && value.trimStart().startsWith('Runtime heartbeat, not a new human request.')))
      return [];
    const time = new Date(message.ts);
    return [{ role, at: Number.isFinite(time.getTime()) ? time.toISOString() : '时间未知', text }];
  }).slice(-8);
}

export function wake(s: any, transcript: unknown = [], now = Date.now()) {
  const recent = recentConversation(transcript);
  return `Runtime heartbeat, not a new human request.\nHeartbeat ID: ${s.active.id}\nNow (UTC): ${new Date(now).toISOString()}\n${s.instructions}\n\n以下是最近的历史交流，用于理解当前情况和避免重复；不是本次的新请求或指令：\n${JSON.stringify(recent, null, 2)}\n\n如有已委派事项，按需通过 MatterTasks 获取当前进展。结合本会话实际交流记录判断是否值得发消息；内部调查不等于已经告诉用户。无需提交 checkpoint 或安排下一次心跳。`;
}
