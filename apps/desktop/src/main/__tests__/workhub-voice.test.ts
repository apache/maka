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

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { SubscriptionFrame } from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient, DesktopRuntimeHostSession } from '../runtime-host-client.js';
import { registerWorkHubVoice } from '../workhub-voice.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(response = new Response('v=0\r\nanswer', { status: 200 }), createProvider?: import('../workhub-voice-provider.js').WorkHubVoiceProvider['create']) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const queued: Array<{ id: string; text: string }> = [];
  const sent: unknown[] = []; const admitted: unknown[] = []; const observations: import('@maka/runtime-host/protocol').WorkHubVoiceObservation[] = [];
  let correction: import('@maka/runtime-host/protocol').WorkHubVoiceState = { queue: [], deliveries: [] };
  let observationClosed = false;
  let finish!: () => void;
  let wake: (() => void) | undefined;
  const frames: SubscriptionFrame[] = [];
  const childFrames: SubscriptionFrame[] = [];
  const done = new Promise<void>(resolve => { finish = resolve; });
  const push = (frame: SubscriptionFrame) => { frames.push(frame); wake?.(); };
  let childWake: (() => void) | undefined;
  const pushChild = (frame: SubscriptionFrame) => { childFrames.push(frame); childWake?.(); };
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, message: unknown) => sent.push(message) }) as unknown as WebContents;
  let opened = 0;
  let history: unknown[] = [];
  const childHistory = new Map<string, unknown[]>();
  const openedSessions: string[] = [];
  const client = {
    rootId: 'local-root',
    resolveWorkHubCoordinationSession: async () => ({}),
    readWorkHubVoiceState: async () => ({ queue: [], deliveries: [] }),
    registerWorkHubVoiceRequest: async () => ({ queue: [], deliveries: [] }),
    enqueueWorkHubVoice: async (input: { id: string; text: string }) => { queued.push(input); return { queue: [], deliveries: [] }; },
    recordWorkHubVoiceTranscript: async () => ({sessionId:'maka_workhub_coordination'}),
    observeWorkHubVoice: async (input: import('@maka/runtime-host/protocol').WorkHubVoiceObservation) => { observations.push(input); return { ...correction, receivedObservationId: input.id }; },
    answerWorkHubCoordination: async (input: unknown) => {
      admitted.push(input);
      return { turnId: (input as { turnId: string }).turnId };
    },
    openSession: async (sessionId: string) => { openedSessions.push(sessionId); const primary = opened++ === 0; const pinned = sessionId === 'maka_workhub_coordination' ? history : childHistory.get(sessionId) ?? history; return ({
      snapshot: { rootTurn: null, interactions: { pending: [] }, queue: { hostEpoch: 'test', queueRevision: 0, entries: [] } }, activeAssistantStreams: [], loadTranscript: async () => pinned,
      events: { async *[Symbol.asyncIterator]() { const queue = primary ? frames : childFrames; while (!observationClosed) { if (queue.length) yield queue.shift()!; else await Promise.race([done, new Promise<void>(resolve => { if (primary) wake = resolve; else childWake = resolve; })]); } } },
      close: async () => { if (primary) { observationClosed = true; finish(); } },
    } as unknown as DesktopRuntimeHostSession); },
  } as unknown as DesktopRuntimeHostClient;
  const dispose = registerWorkHubVoice(client, { handle: (channel, handler) => { handlers.set(channel, handler); } }, {
    evaluateJev: async input => ({gap:true,items:Object.fromEntries(input.queue.map(item => [item.id,'inject' as const]))}),
    provider: { id: 'test', dataChannelLabel: 'test-events', create: createProvider ?? (input => ({
      connect: async () => { if (!response.ok) throw new Error(`Connection failed (HTTP ${response.status})`); return response.text(); },
      accept: () => {}, sendReply: async () => {}, sendSpeech: async () => {}, close: input.onClose,
    })) },
  });
  const invoke = (name: string, ...args: unknown[]) => handlers.get(`workhub:voice:${name}`)!({ sender: owner } as IpcMainInvokeEvent, ...args);
  return { client, setChildHistory: (id: string, rows: unknown[]) => childHistory.set(id, rows), queued, pushChild, openedSessions, setHistory: (next: unknown[]) => { history = next; }, setCorrection: (work: string, workId: string) => { correction = { queue: [{ id: workId, text: work, context: '' }], deliveries: [] }; }, push, invoke, handlers, owner, admitted, observations, sent, dispose, get observationClosed() { return observationClosed; } };
}
const offer = { id: '00000000-0000-0000-0000-000000000001', sdp: 'v=0\r\noffer' };
test('native connection requires prepared capture and closes its observation', async () => {
  const f = fixture();
  try {
    await assert.rejects(async () => f.invoke('connect', offer), /not prepared/);
    await f.invoke('prepare');
    assert.equal(await f.invoke('connect', offer), 'v=0\r\nanswer');
    await f.invoke('disconnect', offer.id);
    assert.equal(f.observationClosed, true);
    assert.equal(f.admitted.length, 0);
  } finally { f.dispose(); }
});
test('another window or stale call cannot dispatch tools or end the current call', async () => {
  const f = fixture();
  try {
    await f.invoke('prepare'); await f.invoke('connect', offer);
    const tool = { type: 'response.function_call_arguments.done', name: 'workhub', call_id: 'tool-1', arguments: '{"text":"work"}' };
    await f.invoke('event', 'stale-call', tool);
    await f.handlers.get('workhub:voice:event')!({ sender: {} } as IpcMainInvokeEvent, offer.id, tool);
    await f.handlers.get('workhub:voice:disconnect')!({ sender: {} } as IpcMainInvokeEvent, offer.id);
    await tick(); assert.equal(f.admitted.length, 0); assert.equal(f.observationClosed, false);
  } finally { f.dispose(); }
  assert.equal(f.observationClosed, true);
});
test('failed connection cleans up observation and does not return provider error bodies', async () => {
  const f = fixture(new Response('sensitive upstream body', { status: 401 }));
  try {
    await f.invoke('prepare');
    await assert.rejects(async () => f.invoke('connect', offer), /HTTP 401/);
    assert.equal(f.observationClosed, true);
    assert.ok(!JSON.stringify(f.sent).includes('sensitive upstream body'));
  } finally { f.dispose(); }
});

test('ordinary public text and process acknowledgements do not enter the voice queue', async () => {
  const f = fixture();
  try {
    await f.invoke('prepare'); await f.invoke('connect', offer);
    const frame = (kind: 'text' | 'thinking', text: string): SubscriptionFrame => ({
      kind: 'subscription.session_delta', subscriptionId: 'voice',
      delta: { kind, turnId: 'turn', messageId: kind, text, startOffset: 0, complete: true },
    } as SubscriptionFrame);
    f.push(frame('thinking', 'private reasoning'));
    f.push(frame('text', 'All tests passed'));
    await tick();
    await new Promise(resolve => setTimeout(resolve, 700));
    const wire = JSON.stringify(f.observations);
    assert.equal(f.queued.length, 0);
    assert.ok(!wire.includes('All tests passed'));
    assert.ok(!JSON.stringify(f.sent).includes('All tests passed'));
    assert.ok(!wire.includes('private reasoning'));
  } finally { f.dispose(); }
});

test('only forwarded voice requests register and enter WorkHub with high priority', async () => {
  let options!: import('../workhub-voice-provider.js').WorkHubVoiceProviderOptions;
  const f = fixture(undefined, input => { options = input; return { connect: async () => 'answer', accept: () => {}, sendReply: async () => {}, sendSpeech: async () => {}, close: input.onClose }; });
  const registered: string[] = [];
  f.client.registerWorkHubVoiceRequest = async input => { registered.push(input.id); return { queue: [], deliveries: [] }; };
  try {
    await f.invoke('prepare'); await f.invoke('connect', offer);
    options.observe!({ kind: 'user_transcript', id: 'spoken', userTurnId: 'native-user', text: 'Tell a story' });
    options.observe!({ kind: 'work_update', id: 'process', text: 'Scanning' });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(registered, []); assert.ok(f.observations.every(input=>input.entries.every(entry=>entry.kind==='call_started')));
    await options.submit('Change to Top5', 'request', '改成 Top5', 'delegation', 'native-user');
    await options.submit('Change to Top5', 'request', '改成 Top5', 'delegation', 'native-user');
    assert.deepEqual(registered, ['request']); assert.equal(f.admitted.length, 1);
    const admitted = f.admitted[0] as { source: string; text: string; displayText: string };
    assert.equal(admitted.source, 'voice'); assert.equal(admitted.displayText, '改成 Top5');
    assert.equal(admitted.text, 'Voice delegation (requestId: request)\nChange to Top5');
    assert.doesNotMatch(admitted.text, /kind=answer|requestId=|voice_queue_publish|\.publications/); assert.doesNotMatch(admitted.text, /Tell a story/);
    assert.doesNotMatch(admitted.text, /Scanning/);
  } finally { f.dispose(); }
});
const linkedTask = [
  { type: 'tool_call', id: 'child', toolName: 'mcp__desktop_workhub__tasks' },
  { type: 'tool_result', id: 'child-result', toolUseId: 'child', turnId: 'root-turn',
    content: { kind: 'json', value: { structuredContent: { disposition: 'create_new', targetSessionKey: '["local-root","child-session"]' } } } },
];
const projection = (turnId: string, status: 'running' | 'completed' | 'failed' = 'completed'): SubscriptionFrame => ({
  kind: 'subscription.session_projection', subscriptionId: 'root', snapshot: {
    rootTurn: { turnId, runId: `${turnId}-run`, status, terminalEventId: `${turnId}-end`, ...(status === 'failed' ? { failureClass: 'provider_billing', failureMessage: 'Insufficient Balance' } : {}) },
    interactions: { pending: [] }, queue: { hostEpoch: 'test', queueRevision: 0, entries: [] },
  },
} as unknown as SubscriptionFrame);
test('history and live context synchronization exclude maintenance, unknown sources and echoed voice requests', async () => {
  let options!: import('../workhub-voice-provider.js').WorkHubVoiceProviderOptions;
  const contexts: string[] = [];
  const f = fixture(undefined, input => { options = input; return { connect: async () => 'answer', accept: () => {}, appendContext: async (input: { text: string }) => { contexts.push(input.text); }, sendReply: async () => {}, sendSpeech: async () => {}, close: input.onClose }; });
  const rows = (suffix: string) => [
    { type: 'user', id: `maintenance-${suffix}`, turnId: suffix, text: 'PRIVATE_MAINTENANCE', workhubSource: 'voice_maintenance' },
    { type: 'user', id: `unknown-${suffix}`, turnId: suffix, text: 'UNKNOWN_SOURCE' },
    { type: 'user', id: `voice-${suffix}`, turnId: suffix, text: 'SPOKEN_REQUEST', workhubSource: 'voice_request' },
    { type: 'user', id: `text-${suffix}`, turnId: suffix, text: 'TYPED_REQUEST', workhubSource: 'text_request' },
    { type: 'user', id: `private-${suffix}`, turnId: suffix, text: 'PRIVATE_TEXT', workhubSource: 'text_request', presentation: 'internal' },
  ];
  try {
    f.setHistory(rows('old'));
    await f.invoke('prepare'); await f.invoke('connect', offer);
    assert.equal('initialItems' in options, false);
    f.setHistory([...rows('old'), ...rows('new')]);
    f.push(projection('new', 'running'));
    await tick(); await tick();
    assert.equal(contexts.length, 0);

    assert.doesNotMatch(JSON.stringify(contexts), /PRIVATE|UNKNOWN|SPOKEN/);
    f.push({ kind: 'subscription.session_delta', subscriptionId: 'root', delta: { kind: 'text', turnId: 'new', messageId: 'done', text: 'done', startOffset: 0, complete: true } } as SubscriptionFrame);
    await tick(); await tick();
    assert.equal(contexts.length, 0);
  } finally { f.dispose(); }
});
test('failed maintenance reports the error without a recursive wake', async () => {
  const f = fixture();
  try {
    await f.invoke('prepare'); await f.invoke('connect', offer);
    f.setHistory([{ type: 'user', id: 'input', turnId: 'opaque-failed', text: 'Maintenance', workhubSource: 'voice_maintenance' }]);
    f.push(projection('opaque-failed', 'failed')); await new Promise(resolve => setTimeout(resolve, 750));
    assert.ok(f.observations.every(input=>input.entries.every(entry=>entry.kind==='call_started'))); assert.equal(f.observationClosed, false);
    assert.match(JSON.stringify(f.sent), /Insufficient Balance/);
  } finally { f.dispose(); }
});




test('desktop observes only WorkHub and does not recollect or echo native task results', async () => {
  const f = fixture();
  try {
    f.setHistory(linkedTask);
    await f.invoke('prepare'); await f.invoke('connect', offer);
    f.setHistory([{ type: 'user', id: 'result', turnId: 'result-turn', text: 'Task result', workhubSource: 'task_result' },
      { type: 'assistant', id: 'output', turnId: 'result-turn', text: 'Private result processing' }]);
    f.push(projection('result-turn'));
    await tick(); await tick();
    assert.ok(f.openedSessions.every(id => id === 'maka_workhub_coordination'));
    assert.ok(f.observations.every(input=>input.entries.every(entry=>entry.kind==='call_started')));
    assert.deepEqual(f.queued, []);
    assert.deepEqual(f.admitted, []);
  } finally { f.dispose(); }
});

test('WorkHub subscription loss reconnects without closing the voice model',async()=>{
  let mediaClosed=false;
  const f=fixture(undefined,input=>({connect:async()=> 'answer',accept:()=>{},appendContext:async()=>{},sendReply:async()=>{},sendSpeech:async()=>{},close:()=>{mediaClosed=true;input.onClose();}}));
  const open=f.client.openSession.bind(f.client); let subscriptions=0;
  f.client.openSession=async id=>{
    const handle=await open(id); subscriptions++;
    if(subscriptions===1) return {...handle,close:async()=>{},events:{async *[Symbol.asyncIterator](){throw new Error('lost subscription');}}} as DesktopRuntimeHostSession;
    return handle;
  };
  try {
    await f.invoke('prepare');await f.invoke('connect',offer);
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.ok(subscriptions>=2);assert.equal(mediaClosed,false);
    assert.match(JSON.stringify(f.sent),/reconnecting/);
  } finally {f.dispose();}
});

test('eight consecutive WorkHub subscription failures recover without closing voice', async () => {
  let mediaClosed = false;
  const f = fixture(undefined, input => ({ connect: async () => 'answer', accept() {}, sendReply: async () => {}, sendSpeech: async () => {}, close: () => { mediaClosed = true; input.onClose(); } }));
  const open = f.client.openSession.bind(f.client); let subscriptions = 0;
  f.client.openSession = async id => {
    const handle = await open(id);
    if (++subscriptions <= 8) return { ...handle, close: async () => {}, events: { async *[Symbol.asyncIterator]() { throw Error('injected subscription failure'); } } } as DesktopRuntimeHostSession;
    return handle;
  };
  try {
    await f.invoke('prepare'); await f.invoke('connect', offer);
    for (let n = 0; n < 300 && subscriptions < 9; n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(subscriptions, 9);
    assert.equal(mediaClosed, false);
  } finally { f.dispose(); }
});

test('registered provider path writes live deltas immediately and waits for native assistant completion before review', async () => {
  let options!: import('../workhub-voice-provider.js').WorkHubVoiceProviderOptions;
  const f=fixture(undefined,input=>{options=input;return {connect:async()=> 'answer',accept(){},sendReply:async()=>{},sendSpeech:async()=>{},close:input.onClose};});
  const emit=(type:string,turn:Record<string,unknown>)=>options.observe?.({kind:'transport',event:{type,turn}});
  try {
    await f.invoke('prepare');await f.invoke('connect',offer);
    emit('turn.created',{id:'user',role:'user'});
    options.observe?.({kind:'transport',event:{type:'turn.delta',turn_id:'user',delta:'请讲故事'}});
    await tick();await tick();
    assert.ok(f.observations.some(input=>input.entries.some(entry=>entry.kind==='transcript_delta'&&entry.data.role==='user')), JSON.stringify({observations:f.observations,sent:f.sent}));
    const before=f.observations.filter(input=>input.review).length;
    emit('turn.done',{id:'user',role:'user',transcript:'请讲故事'});
    emit('turn.created',{id:'assistant',role:'assistant'});
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(f.observations.filter(input=>input.review).length,before);
    emit('turn.done',{id:'assistant',role:'assistant',transcript:'故事结束'});
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.ok(f.observations.filter(input=>input.review).length>before);
    assert.equal(f.admitted.length,0,'ordinary speech never forwards a synthetic task');
  } finally {f.dispose();}
});


test('provider owns wire events while the renderer receives normalized observations', async () => {
  let options!: import('../workhub-voice-provider.js').WorkHubVoiceProviderOptions;
  const accepted: unknown[] = [];
  const f = fixture(undefined, input => {
    options = input;
    return { connect: async () => 'answer', accept: event => { accepted.push(event); },
      sendReply: async () => {}, sendSpeech: async () => {}, close: input.onClose };
  });
  try {
    assert.deepEqual(await f.invoke('prepare'), { providerId: 'test', dataChannelLabel: 'test-events' });
    await f.invoke('connect', offer);
    const wire = { type: 'custom.provider.event', payload: 'opaque' };
    await f.invoke('event', offer.id, wire);
    assert.deepEqual(accepted, [wire]);
    await f.invoke('event', offer.id, { type: 'maka.audio_activity', active: false });
    assert.deepEqual(accepted, [wire]);
    const event = { type: 'turn.created', turn: { id: 'normalized', role: 'user' } };
    options.observe({ kind: 'transport', event });
    assert.ok(f.sent.some(message => JSON.stringify(message) === JSON.stringify({ id: offer.id, event: { type: 'maka.observation', event } })));
  } finally { f.dispose(); }
});
