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

import type {
  ComputerAppRisk,
  InteractionAnswer,
  InteractionRequest,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { message as uiMessage, type UiText } from './text-value.ts';

export type ComputerAppRequest = Extract<InteractionRequest, { kind: 'computer_app' }>;
type Answer = Extract<InteractionAnswer, { kind: 'computer_app' }>;

export function computerAppOptions(request: ComputerAppRequest): Array<{
  label: UiText;
  answer: Answer;
}> {
  return [
    { label: uiMessage('Allow once'), answer: { kind: 'computer_app', decision: 'once' } },
    {
      label: uiMessage('Allow for this session'),
      answer: { kind: 'computer_app', decision: 'session' },
    },
    ...(request.allowAlways
      ? [
          {
            label: uiMessage('Always allow'),
            answer: { kind: 'computer_app' as const, decision: 'always' as const },
          },
        ]
      : []),
    { label: uiMessage('Deny'), answer: { kind: 'computer_app', decision: 'deny' } },
  ];
}

export function computerAppRiskMessage(risk: ComputerAppRisk | null | undefined): UiText {
  if (risk === 'high') return uiMessage('Application risk: high');
  if (risk === 'low') return uiMessage('Application risk: low');
  return uiMessage('Application risk is unknown. Review its identity before allowing access.');
}
