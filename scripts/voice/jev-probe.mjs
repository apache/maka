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

// Uses the same main-process evaluator and private credential source as the app.
import { evaluateVoice } from '../../apps/desktop/dist/main/workhub-voice-jev.js';
const cases = [
  {
    name: '重复回答',
    expected: 'discard',
    facts: [
      { role: 'user', text: '九减四是多少？' },
      { role: 'assistant', text: '五。' },
    ],
    text: '九减四等于五。',
  },
  {
    name: '明确取消',
    expected: 'discard',
    facts: [{ role: 'user', text: '别讲故事了，我不想听了。' }],
    text: '继续讲林舟的灯塔故事。',
  },
  {
    name: '改变要求',
    expected: 'rework',
    facts: [{ role: 'user', text: '刚才那封邮件改成英文再读给我。' }],
    text: '邮件正文：您好，会议改到明天下午。',
  },
  {
    name: '仍需回复',
    expected: 'inject',
    facts: [{ role: 'user', text: '请告诉我计算结果。' }],
    text: '你委托计算的结果是四十二。',
  },
];
for (const c of cases) {
  const start = Date.now();
  try {
    const result = await evaluateVoice(
      {
        facts: c.facts,
        queue: [{ id: 'candidate', text: c.text, context: '' }],
        responses: [],
        deliveries: [],
      },
      AbortSignal.timeout(15000),
    );
    console.log(
      JSON.stringify({
        name: c.name,
        ms: Date.now() - start,
        expected: c.expected,
        result,
        pass: result.items.candidate === c.expected,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        name: c.name,
        ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
    break;
  }
}
