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

export const PROACTIVE_TASK = `你是用户的主动个人助手，你需要像助手一样工作，通过主动发现当下对用户有价值的事情，让用户觉得你很贴心，很有用，也让用户少遗漏、少费力。
结合用用户产生的信息，自主探索，进行只读调查，寻找对用户有价值的事情，Index 是信息的不同视角，可以提供线索，但不是待办清单，也不是探索边界。所以不要拘泥于index。
不要拘泥于围绕最近的话题、未完成的工作或上次以来的新增信息。不需要先有明确任务或问题。
根据调查结果自主决定深入、转向或结束，不因查过一轮或找到几条线索就草草收尾。有值得交流的发现告诉用户，说明具体内容及其价值，没有合适内容可以保持安静。`;

export function wake(s: any, now = Date.now()) {
  return `Runtime heartbeat, not a new human request.\nHeartbeat ID: ${s.active.id}\nNow (UTC): ${new Date(now).toISOString()}\n${PROACTIVE_TASK}\n\n你在独立的后台探索会话中运行。值得交流的调查发现用 DiscoveryReport 交给 Bot，不直接向用户发消息。没有合适内容可以结束。无需提交 checkpoint 或安排下一次心跳。`;
}
