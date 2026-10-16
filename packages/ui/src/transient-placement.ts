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

/**
 * The slice of a materialized Turn that transient placement needs: whether
 * the Turn already renders a given message id as its own user row. Turn view
 * models satisfy this structurally; tests construct the slice directly.
 */
export interface TurnUserRowSource {
  readonly user?: { readonly id: string };
  readonly timeline: ReadonlyArray<{ readonly kind: string; readonly messageId?: string }>;
}

/**
 * True when the transcript already renders this message id as a Turn's own
 * user row: the Turn's primary prompt (`user.id`) or an admitted `user`
 * timeline item (steering) carrying the same id.
 *
 * The durable local copy of a Host-accepted message keeps rendering while its
 * Turn is live. Once the Turn carries the message itself, that copy must
 * disappear: the inline slot already drops it, and the tail slot has to drop
 * it too, or the same text shows twice — once inside the Turn and once below
 * the running status with the delivery chip.
 *
 * Sound only because transcript ids and durable local-copy ids share one id
 * space (the Host echoes the client-generated message id); the inline slot
 * has always relied on the same equality for its `user` timeline check.
 */
export function turnRendersUserMessage(
  turns: ReadonlyArray<TurnUserRowSource>,
  messageId: string,
): boolean {
  return turns.some((turn) =>
    turn.user?.id === messageId
    || turn.timeline.some((item) => item.kind === 'user' && item.messageId === messageId),
  );
}

/**
 * The transients that still render after the last Turn: not already routed
 * into the tail Turn's inline slot, and not already visible as a Turn's own
 * user row. A distinct message admitted into the live Turn while its user row
 * is on screen stays here, so queued prompts keep showing below the Turn —
 * only true duplicates disappear.
 */
export function selectTailTransientMessages<Message extends { readonly id: string }>(
  transientMessages: ReadonlyArray<Message>,
  inlineTransientMessageIds: ReadonlySet<string>,
  turns: ReadonlyArray<TurnUserRowSource>,
): ReadonlyArray<Message> {
  return transientMessages.filter((message) =>
    !inlineTransientMessageIds.has(message.id)
    && !turnRendersUserMessage(turns, message.id),
  );
}
