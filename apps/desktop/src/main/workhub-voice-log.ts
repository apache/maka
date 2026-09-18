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

/** Only collaboration facts belong in the voice archive; raw events still drive media. */
export function compactVoiceLogEvent(kind: string, data: Record<string, unknown>):
  { kind: string; data: Record<string, unknown> } | undefined {
  if (kind === 'transport') {
    const type = String(data.type);
    if (type === 'maka.audio_activity')
      return { kind: 'playback_activity', data: { active: data.active, source: 'renderer_audio' } };
    if (!['turn.created', 'turn.done'].includes(type)) return;
    const turn = data.turn as Record<string, unknown> | undefined;
    return { kind: 'media_event', data: { type, eventId: data.event_id,
      turnId: turn?.id ?? data.turn_id, role: turn?.role,
      startMs: turn?.start_ms, endMs: turn?.end_ms } };
  }
  if (kind === 'reply_submitted') return { kind, data: { requestId: data.requestId, itemId: data.itemId, deliveryId: data.deliveryId } };
  if (kind === 'speech_submitted') return { kind, data: { deliveryId: data.deliveryId } };
  if (kind === 'delegation') return { kind, data: {
    requestId: data.requestId, userTurnId: data.userTurnId, text: data.text,
  } };
  if (['delegation_receipt', 'transport_error', 'call_started', 'call_closed', 'text_request'].includes(kind))
    return { kind, data };
  return;
}
