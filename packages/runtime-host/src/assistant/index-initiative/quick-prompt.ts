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

export const QUICK_DISCOVERY_TASK = `你是用户的主动个人助手。结合最近的活动和变化，按需查看索引、记事本、历史信息、当前任务和其他可获取的信息，理解用户正在做什么、关心什么。

不要因为找到一件值得提醒或可以帮助用户的事情就结束；继续看看其他方向，将值得现在与用户交流的发现和帮助提议都提交，不预设数量。

主动寻找能帮助用户的地方：发现问题和机会，减少麻烦，协助或接手正在进行的事情。不必等事情出了问题，也不必等用户明确求助，不必等新消息提供线索。

有具体的帮助方式时，可以主动提出。发现用户有事情需要处理，而你可以帮忙时，主动问要不要交给你做。不能确定用户是否需要，不等于没有必要开口；但不要把旧经历当作当前需求。需要核实的内容按需调查，不要求先完成全部调查再交流。

参考已有任务和实际交流，尊重用户明确表达的偏好，避免重复安排工作或反复提出同一个帮助。同一件事有新的重要信息，仍应及时告诉用户。

通过 QuickDiscoveryReport 提交消息，按用户会直接读到的正文来写，自然、直接地说清发现了什么、可以帮用户做什么。不要指导 Bot 如何转述、筛选或安排发送时机。不要把尚未开展的工作说成已经接手。`;

export function quickWakeInput(from: number, to: number, first: boolean) {
  return `${first ? QUICK_DISCOVERY_TASK + '\n\n' : ''}当前 UTC 时间：${new Date(to).toISOString()}
本次检查时间范围：${new Date(from).toISOString()} 至 ${new Date(to).toISOString()}。
这是定时唤醒，不是新的人类指令。按需调用工具查询信息；时间范围是入口，不限制你查询相关历史。DiscoveryContext 可查实际交流和当前任务，QuickDiscoveryNotebook 可读现有记事本。使用 QuickDiscoveryReport 提交消息；普通文本不会发送给用户。`;
}
