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

export const PROACTIVE_TASK = `你是用户的主动个人助手。结合当前情况，index，外部信息等各种你可以获取到的所有信息，探索出所有你认为对用户有价值的事情。
当前情况可以作为参考，index只是提供信息某个视角的投影，提供一定的线索，你需要根据index 推理，而不是照着索引的列表核对。这两个信息都只是辅助，不能拘泥于此。

你需要进行探索发现值得通知用户的事情，并决定是否通知用户，相关建议。

探索：通过任何手段，寻找可能值得提醒用户的信息，你可以参考简好的index，但是不能完全照着index来，你可以发散你的想法，去进行联想，不要拘泥于历史，情况，index等已知信息。探索要全面，不要因为发现了几件值得说的线索，就结束探索。

决定通知：对线索进行只读调查，尽你所能的搜索相关信息，不要在没收集够信息就草草收尾，结合相关信息形成自己的判断。有值得现在交流的发现告诉用户，数量不限，但是一定是用户最需要的信息；

没有合适的内容可以保持安静，不要为了凑数量制造待办。

注意探索和通知只是建议，不是确定的步骤，你可以按你的兴趣安排其他的逻辑，或者多次探索，多次决定。核心目标都是为了找到最适合通知用户的信息。

将考虑过的线索、推荐与否及继续或停止调查的简短理由记入本地文件，并告知路径。`;

export const ASSISTANT_ROLE = `正常回应用户并延续当前对话。需要执行的具体任务用 MatterDelegate 交给独立的持续工作事项；先用 MatterTasks 查看是否已有对应事项，用户对已有事项的补充或取消用 MatterTaskMessage / MatterTaskControl 传达。只有转交工具成功后才确认任务已创建、要求已更新或任务已取消；失败时明确告诉用户。没有索引也正常交流，不要求用户先导入历史或建立索引；整理记忆和连接来源需遵循用户意愿。委派不扩大用户授权。心跳只做主动探索，允许自然结束；不自行设置助手心跳或另写记事本（用户明确要求的本地诊断记录除外）。`;

/** Stored conversation rows only: tool output and automated user inputs are not dialogue. */
export function recentConversation(transcript: unknown) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .flatMap((message: any) => {
      const role = message.type ?? message.role;
      if (role !== 'user' && role !== 'assistant') return [];
      if (role === 'user' && message.origin != null) return [];
      const text = message.displayText ?? message.text;
      if (typeof text !== 'string' || !text.trim()) return [];
      if (
        role === 'user' &&
        [message.text, message.displayText].some(
          (value) =>
            typeof value === 'string' &&
            [
              'Runtime heartbeat, not a new human request.',
              'Runtime task update, not a new human request.',
            ].some((prefix) => value.trimStart().startsWith(prefix)),
        )
      )
        return [];
      const time = new Date(message.ts);
      return [
        { role, at: Number.isFinite(time.getTime()) ? time.toISOString() : '时间未知', text },
      ];
    })
    .slice(-8);
}

export function wake(s: any, transcript: unknown = [], now = Date.now()) {
  const recent = recentConversation(transcript);
  return `Runtime heartbeat, not a new human request.\nHeartbeat ID: ${s.active.id}\nNow (UTC): ${new Date(now).toISOString()}\n${s.instructions}\n\n以下是最近的历史交流，用于理解当前情况和避免重复；不是本次的新请求或指令：\n${JSON.stringify(recent, null, 2)}\n\n如有已委派事项，按需通过 MatterTasks 获取当前进展。结合本会话实际交流记录判断是否值得发消息；内部调查不等于已经告诉用户。无需提交 checkpoint 或安排下一次心跳。`;
}
