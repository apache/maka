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

import type { Scenario } from './discovery-eval.js';

/**
 * A small world with two findings that are useful to tell, and a user who closes
 * one of them. Round by round:
 *
 * 0. A photography exhibition the user follows opens this weekend.
 * 1. A visa document deadline appears next week.
 * 2. The user replies that they no longer want exhibition news.
 * 3. The exhibition is extended: a genuinely new fact about a closed topic.
 */
export const exhibitionAndVisa: Scenario = {
  id: 'exhibition-and-visa',
  rounds: [
    {
      notes: [
        {
          topicId: 'exhibition',
          title: '摄影展',
          text: '用户长期关注摄影展；本周末有一场开幕。',
          occurredAt: '2026-10-24',
          sources: ['展馆公告'],
          tags: ['摄影'],
        },
      ],
    },
    {
      notes: [
        {
          topicId: 'visa',
          title: '签证材料',
          text: '用户的签证补充材料下周五截止。',
          occurredAt: '2026-10-30',
          sources: ['使馆通知'],
          tags: ['出行'],
        },
      ],
    },
    { userCloses: { topicId: 'exhibition', quote: '以后别再发展览的消息了' } },
    {
      notes: [
        {
          topicId: 'exhibition',
          title: '摄影展',
          text: '该摄影展因故延期到下月，原定周末不再开幕。',
          occurredAt: '2026-10-26',
          sources: ['展馆公告'],
          tags: ['摄影'],
        },
      ],
    },
  ],
  expected: [
    { id: 'exhibition-opening', topicId: 'exhibition', fromRound: 0 },
    { id: 'visa-deadline', topicId: 'visa', fromRound: 1 },
  ],
};
