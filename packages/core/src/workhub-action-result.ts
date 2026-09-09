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

import { isRecord } from './record-schema.js';

export type WorkHubActionResult =
  | { readonly disposition: 'answer_here'; readonly coordinationTurnId: string }
  | { readonly disposition: 'clarify'; readonly coordinationTurnId: string }
  | {
      readonly disposition: 'delegate_existing';
      readonly targetSessionId: string;
      readonly targetTurnId: string;
      readonly steered?: true;
    }
  | {
      readonly disposition: 'create_new';
      readonly targetSessionId: string;
      readonly targetTurnId: string;
      readonly steered?: true;
    }
  | {
      readonly disposition: 'replace';
      readonly replacementDisposition: 'delegate_existing' | 'create_new';
      readonly targetSessionId: string;
      readonly targetTurnId: string;
      readonly steered?: true;
    }
  | {
      readonly disposition: 'stop_work';
      readonly outcome: 'cancelled_pending' | 'stop_delivered' | 'already_terminal' | 'not_owned';
      readonly targetSessionId: string;
      readonly targetTurnId?: string;
    }
  | {
      readonly disposition: 'resume_work';
      readonly outcome: 'resume_started' | 'already_running';
      readonly targetSessionId: string;
      readonly targetTurnId?: string;
    };

/** Coordination receipt, not a copy of target execution state. */
export interface WorkHubActionReceipt {
  actionId: string;
  userText: string;
  result: WorkHubActionResult;
  clarification?: string;
}

export function isWorkHubActionReceipt(value: unknown): value is WorkHubActionReceipt {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (k) => !['actionId', 'userText', 'result', 'clarification'].includes(k),
    ) ||
    typeof value.actionId !== 'string' ||
    !value.actionId ||
    typeof value.userText !== 'string' ||
    !value.userText.trim() ||
    (value.clarification !== undefined && typeof value.clarification !== 'string')
  )
    return false;
  return isWorkHubActionResult(value.result);
}

/** Shared closed result contract for Runtime receipts and Host protocol replies. */
export function isWorkHubActionResult(r: unknown): r is WorkHubActionResult {
  if (!isRecord(r)) return false;
  const text = (k: string) => typeof r[k] === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(r[k]);
  const keys = (allowed: string[]) => Object.keys(r).every((k) => allowed.includes(k));
  if (r.disposition === 'answer_here' || r.disposition === 'clarify')
    return keys(['disposition', 'coordinationTurnId']) && text('coordinationTurnId');
  if (
    r.disposition === 'delegate_existing' ||
    r.disposition === 'create_new' ||
    r.disposition === 'replace'
  )
    return (
      keys([
        'disposition',
        'targetSessionId',
        'targetTurnId',
        'steered',
        ...(r.disposition === 'replace' ? ['replacementDisposition'] : []),
      ]) &&
      text('targetSessionId') &&
      text('targetTurnId') &&
      (r.steered === undefined || r.steered === true) &&
      (r.disposition !== 'replace' ||
        r.replacementDisposition === 'delegate_existing' ||
        r.replacementDisposition === 'create_new')
    );
  if (r.disposition === 'stop_work' || r.disposition === 'resume_work')
    return (
      (r.disposition === 'stop_work'
        ? ((r.outcome !== 'stop_delivered' && r.outcome !== 'not_owned') ||
            r.targetTurnId !== undefined) &&
          (r.outcome !== 'cancelled_pending' || r.targetTurnId === undefined)
        : (r.outcome === 'resume_started') === (r.targetTurnId !== undefined)) &&
      keys(['disposition', 'outcome', 'targetSessionId', 'targetTurnId']) &&
      text('targetSessionId') &&
      (r.targetTurnId === undefined || text('targetTurnId')) &&
      (r.disposition === 'stop_work'
        ? ['cancelled_pending', 'stop_delivered', 'already_terminal', 'not_owned']
        : ['resume_started', 'already_running']
      ).includes(String(r.outcome))
    );
  return false;
}
