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

import { mount } from 'nsh';
import { TrajectoryRequestInspector } from '../../app/TrajectoryLedger';
import type { AgentHistoryRequest } from '../../app/trajectory';

const request: AgentHistoryRequest = {
  order: { path: [1], itemIndex: 0 },
  stepId: 'step',
  attemptId: 'attempt',
  modelId: 'example-model',
  purpose: 'main',
  startedAt: 0,
  firstTokenAt: 325,
  estimatedInputTokens: 3_125,
  contextWindow: 4_000_000,
  finished: {
    at: 6_184_000,
    outcome: 'success',
    usage: { input_tokens: 3_146, output_tokens: 984 },
  },
};

mount(() => <TrajectoryRequestInspector request={() => request} close={() => {}} />);
