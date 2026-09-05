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

import type { StatusDotVariant } from '@astryxdesign/core/StatusDot';

/**
 * What a state MEANS, named once for the whole app.
 *
 * Seven places used to map their own domain states straight onto StatusDot
 * variants, which made the app's status colours a matter of seven independent
 * opinions: the same "success" was `accent` on the MCP page and `success` in
 * session history, and the same "error" was called `destructive` in one file
 * and `error` in five others.
 *
 * The fix is a layer, not a merge. Domain knowledge — that a blocked plan run
 * is a warning, that a shadowed skill needs attention — stays with the surface
 * that owns it, because only that surface knows it. What those surfaces now
 * share is the vocabulary they express it in, and the single decision below
 * about what each word looks like.
 *
 * There is deliberately no `info`. Two callers had one and meant opposite
 * things by it: the MCP page meant "informational, do not draw the eye" and
 * session history meant "something is happening here". One vague word standing
 * for both is what let them drift apart unnoticed — they now pick `neutral` and
 * `active` respectively, and the disagreement is visible in the call site
 * rather than hidden in a shared name.
 */
/**
 * Choosing between these turns on two questions, in order:
 *
 *   1. Is something happening, and if so who is doing it? The SYSTEM working
 *      is `active`; waiting on the USER is `attention`. Collapsing those two
 *      is the mistake that produced this vocabulary's worst case — an expired
 *      credential reported as "in progress" when nothing is progressing.
 *   2. If nothing is happening, is this a verified good outcome (`success`), a
 *      broken one (`error`), or simply a fact (`neutral`)?
 *
 * `success` is reserved for a health that was PROVEN — a connection test that
 * passed, a credential that validated. A switch merely being on is not proof
 * of anything and reads as `active` (participating) or `neutral` (present),
 * which is why an enabled skill is not green.
 */
export type StatusSemantic =
  /** Proven healthy: a test passed, a credential validated, a server answered. */
  | 'success'
  /** The system is working on it right now — running, authorizing, in flight. */
  | 'active'
  /** Waiting on a person: re-auth needed, review pending, paused, untested. */
  | 'attention'
  /** Broken now: failed delivery, invalid metadata, unreachable server. */
  | 'error'
  /** A settled fact, nothing to do: disabled, configured, completed-and-spent. */
  | 'neutral';

/**
 * The one place a status word becomes a colour.
 *
 * `active` is `accent` because accent has always meant "live" here (a
 * scheduled reminder waiting to fire wears it); it is not a second green.
 * `attention` is `warning` rather than `error` because the state is "look at
 * this when you can", not "this is broken".
 */
const SEMANTIC_TO_DOT: Record<StatusSemantic, StatusDotVariant> = {
  success: 'success',
  active: 'accent',
  attention: 'warning',
  error: 'error',
  neutral: 'neutral',
};

/**
 * Every status dot in the app now comes through here.
 *
 * The name was chosen to avoid colliding with the settings surface's own
 * `statusDotVariant` while both existed; that one is gone, so the collision is
 * too. Kept as `dotForStatus` because it reads as what it does and renaming it
 * back would churn a dozen call sites for nothing.
 *
 * `StatusTone` still exists next to it, and deliberately: Astryx's Badge has an
 * `info` pill and its own `neutral`, so a Badge can express a shade a dot
 * cannot. One surface still renders those. Two vocabularies, because there are
 * genuinely two — not because nobody cleaned up.
 */
export function dotForStatus(semantic: StatusSemantic): StatusDotVariant {
  return SEMANTIC_TO_DOT[semantic];
}
