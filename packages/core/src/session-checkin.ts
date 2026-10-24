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

/** Check-in card vocabulary shared by the Runtime, the Host protocol and clients. */

export const CHECKIN_MAX_CARDS = 4;
export const CHECKIN_TITLE_MAX_CHARS = 80;
export const CHECKIN_QUOTE_MAX_CHARS = 300;
export const CHECKIN_INSTRUCTION_MAX_CHARS = 2_000;

export const CHECKIN_CARD_ACTIONS = ['resume', 'continue', 'new_session', 'answer'] as const;
export type CheckinCardAction = (typeof CHECKIN_CARD_ACTIONS)[number];

export const CHECKIN_EVIDENCE_SOURCES = ['signal', 'user_request', 'assistant_message'] as const;
export type CheckinEvidenceSource = (typeof CHECKIN_EVIDENCE_SOURCES)[number];

/**
 * One card: unfinished work in a Session, the quoted evidence for it and the
 * action a click takes. Check-in never proposes improvements to delivered work.
 */
export interface CheckinCard {
  readonly sessionId: string;
  /** Session revision the card was made against; a click rechecks it. */
  readonly sessionRevision: number;
  readonly sessionName: string;
  readonly title: string;
  readonly evidence: { readonly source: CheckinEvidenceSource; readonly quote: string };
  readonly action: CheckinCardAction;
  /** Self-contained task for `continue` and `new_session`; a `resume` may carry one as its fallback. */
  readonly instruction?: string;
}

export function isCheckinCardAction(value: unknown): value is CheckinCardAction {
  return typeof value === 'string' && (CHECKIN_CARD_ACTIONS as readonly string[]).includes(value);
}

export function isCheckinEvidenceSource(value: unknown): value is CheckinEvidenceSource {
  return (
    typeof value === 'string' && (CHECKIN_EVIDENCE_SOURCES as readonly string[]).includes(value)
  );
}
