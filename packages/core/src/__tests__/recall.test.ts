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
import test from 'node:test';
import type { SessionSummary, StoredMessage } from '../session.js';
import { collectSearchableText, foldForMatch } from '../thread-search.js';
import {
  expandRecallPassage,
  RECALL_CANDIDATE_LIMIT,
  runRecall,
  type RecallCandidate,
  type RecallDeps,
  type RecallPassage,
} from '../recall.js';

let nextTs = 1_700_000_000_000;

function session(
  id: string,
  name: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'idle',
    lastMessageAt: nextTs,
    ...overrides,
  } as SessionSummary;
}

function userMessage(id: string, turnId: string, text: string): StoredMessage {
  return { type: 'user', id, turnId, ts: (nextTs += 1000), text } as StoredMessage;
}

function assistantMessage(id: string, turnId: string, text: string): StoredMessage {
  return { type: 'assistant', id, turnId, ts: (nextTs += 1000), text } as StoredMessage;
}

function toolResultMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'tool_result',
    id,
    turnId,
    ts: (nextTs += 1000),
    toolUseId: `${id}-call`,
    content: { kind: 'text', text },
  } as StoredMessage;
}

function systemNote(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'system_note',
    id,
    turnId,
    ts: (nextTs += 1000),
    kind: 'context_compacted',
    text,
  } as unknown as StoredMessage;
}

interface Corpus {
  readonly sessions: SessionSummary[];
  readonly messages: Map<string, StoredMessage[]>;
}

function corpus(
  entries: readonly { session: SessionSummary; messages: StoredMessage[] }[],
): Corpus {
  return {
    sessions: entries.map((entry) => entry.session),
    messages: new Map(entries.map((entry) => [entry.session.id, entry.messages])),
  };
}

/** Full-scan deps: no candidate source, so recall reads every transcript. */
function scanDeps(data: Corpus, overrides: Partial<RecallDeps> = {}): RecallDeps {
  return {
    listSessions: async () => data.sessions,
    readMessages: async (sessionId) => data.messages.get(sessionId) ?? null,
    getPrivacyContext: async () => ({ incognitoActive: false }),
    ...overrides,
  };
}

/**
 * Candidate deps that mimic the storage scan: they match the *serialized*
 * record, so they over-select on field names and structure exactly as
 * `instr(record_json, ?)` does in SQLite.
 */
function candidateDeps(data: Corpus, overrides: Partial<RecallDeps> = {}): RecallDeps {
  return {
    ...scanDeps(data),
    listCandidates: async ({ terms, sessionIds }) => {
      const candidates: RecallCandidate[] = [];
      for (const sessionId of sessionIds) {
        for (const message of data.messages.get(sessionId) ?? []) {
          if (collectSearchableText(message) === undefined) continue;
          const serialized = JSON.stringify(message).toLowerCase();
          if (terms.some((term) => serialized.includes(term.toLowerCase()))) {
            candidates.push({ sessionId, message });
          }
        }
      }
      return candidates;
    },
    countSearchableMessages: async ({ sessionIds }) => {
      let total = 0;
      for (const sessionId of sessionIds) {
        for (const message of data.messages.get(sessionId) ?? []) {
          if (collectSearchableText(message) !== undefined) total += 1;
        }
      }
      return total;
    },
    ...overrides,
  };
}

function anchorIds(passages: readonly RecallPassage[]): string[] {
  return passages.map((passage) => passage.anchorMessageId);
}

/**
 * The corpus both correctness suites run against. It deliberately mixes the
 * shapes that have broken retrieval before: a long tool result competing with
 * a short answer, a Session that discusses one term at length, and records
 * whose serialized form contains a term their visible text does not.
 */
function mixedCorpus(): Corpus {
  return corpus([
    {
      session: session('s-pet', 'cyberpet'),
      messages: [
        userMessage('m1', 't1', '宠物没出现啊，有bug'),
        assistantMessage('m2', 't1', '浮窗安装绑定到 App 启动生命周期，宠物现在会显示'),
        toolResultMessage('m3', 't1', `find 宠物 浮窗 显示 ${'宠物 浮窗 显示 '.repeat(40)}`),
        systemNote('m4', 't1', '宠物 浮窗 显示 显示 显示'),
        userMessage('m5', 't2', '还是不显示'),
        assistantMessage('m6', 't2', '再查一下浮窗的显示条件'),
      ],
    },
    {
      session: session('s-ctx', '未设置默认上下文导致报错原因'),
      messages: [
        userMessage('m7', 't3', '这个如何设置默认上下文长度？'),
        assistantMessage(
          'm8',
          't3',
          '本轮请求需要的 token 超过了模型上下文窗口预算，provider 设置里有 context window',
        ),
      ],
    },
    {
      session: session('s-prov', '如果我换成其他供应商'),
      messages: [
        userMessage('m9', 't4', '换供应商要改什么？'),
        assistantMessage('m10', 't4', '不只是改 key，模型名称和上下文限制都要改'),
      ],
    },
  ]);
}

/**
 * Reference implementation of the predicate, run over every message. Recall
 * must agree with it exactly, whatever path it took to find candidates.
 */
function scanMatchIds(data: Corpus, terms: readonly string[]): string[] {
  const folded = terms.map(foldForMatch);
  const ids: string[] = [];
  for (const messages of data.messages.values()) {
    for (const message of messages) {
      const raw = collectSearchableText(message);
      if (raw === undefined) continue;
      const text = foldForMatch(raw);
      if (folded.some((term) => text.includes(term))) ids.push(message.id);
    }
  }
  return ids.sort();
}

async function verifiedAnchorIds(deps: RecallDeps, terms: readonly string[]): Promise<string[]> {
  // A limit above the corpus size with a per-Session quota that cannot bind
  // turns the envelope into the full verified set, one passage per turn.
  const result = await runRecall({ terms, limit: 25 }, deps);
  assert.ok(result.ok);
  return anchorIds(result.passages).sort();
}

test('recall finds the same messages a full scan would', async () => {
  const data = mixedCorpus();
  for (const terms of [['宠物'], ['上下文', '窗口'], ['显示', 'token'], ['供应商']]) {
    const result = await runRecall({ terms, limit: 25 }, scanDeps(data));
    assert.ok(result.ok, `expected ok for ${terms.join('/')}`);
    const expected = new Set(scanMatchIds(data, terms));
    for (const anchor of anchorIds(result.passages)) {
      assert.ok(expected.has(anchor), `${anchor} is not a real match for ${terms.join('/')}`);
    }
  }
});

test('a candidate source changes speed, never the verified set', async () => {
  const data = mixedCorpus();
  for (const terms of [['宠物'], ['上下文', '窗口'], ['显示'], ['token', '预算']]) {
    const scanned = await verifiedAnchorIds(scanDeps(data), terms);
    const narrowed = await verifiedAnchorIds(candidateDeps(data), terms);
    assert.deepEqual(narrowed, scanned, `candidate path diverged for ${terms.join('/')}`);
  }
});

test('over-selected candidates are rejected by the predicate', async () => {
  const data = mixedCorpus();
  // `type`, `turnId` and `ts` appear in every serialized record but in no
  // visible text, so the candidate source offers everything and recall must
  // still return nothing.
  const result = await runRecall({ terms: ['turnId'] }, candidateDeps(data));
  assert.ok(result.ok);
  assert.equal(result.passages.length, 0);
  assert.match(result.gaps, /No transcript match for: turnId\./u);
});

test('a candidate source that declines falls back to a full scan', async () => {
  const data = mixedCorpus();
  let declined = 0;
  const deps = candidateDeps(data, {
    listCandidates: async () => {
      declined += 1;
      return null;
    },
  });
  const result = await runRecall({ terms: ['上下文'] }, deps);
  assert.ok(result.ok);
  assert.equal(declined, 1);
  assert.equal(result.scannedFully, true);
  assert.ok(result.passages.length > 0);
});

test('a term the stored form escapes bypasses the candidate source', async () => {
  const data = mixedCorpus();
  let asked = 0;
  const deps = candidateDeps(data, {
    listCandidates: async (input) => {
      asked += 1;
      return input.sessionIds.length === 0 ? [] : [];
    },
  });
  const quoted = await runRecall({ terms: ['says "hello"'] }, deps);
  assert.ok(quoted.ok);
  assert.equal(quoted.scannedFully, true, 'a quoted term must not use the candidate source');
  assert.equal(asked, 0);

  const newline = await runRecall({ terms: ['first\nsecond'] }, deps);
  assert.ok(newline.ok);
  assert.equal(newline.scannedFully, true, 'a multi-line term must not use the candidate source');
  assert.equal(asked, 0);
});

test('a dense tool result does not outrank the answer that explains it', async () => {
  const data = mixedCorpus();
  // `m3` is shaped like a grep result: forty repetitions of every term. BM25's
  // length normalization alone leaves it on top, which is what the tool-result
  // weight exists to correct.
  const result = await runRecall({ terms: ['宠物', '浮窗', '显示'], limit: 3 }, scanDeps(data));
  assert.ok(result.ok);
  assert.ok(result.passages.length > 0);
  // `m3` shares a turn with `m2`, so turn collapsing keeps it out of this
  // envelope; the tool-result anchor test covers that it stays reachable.
  assert.equal(result.passages[0]?.anchorMessageId, 'm2');
});

test('the per-Session quota admits other Sessions without dropping results', async () => {
  const data = mixedCorpus();
  const result = await runRecall({ terms: ['上下文', '模型', '显示'], limit: 6 }, scanDeps(data));
  assert.ok(result.ok);
  const sessions = new Set(result.passages.map((passage) => passage.sessionId));
  assert.ok(sessions.size >= 2, 'one Session must not take the whole envelope');
});

test('the quota is a ceiling, not an allocation', async () => {
  const data = corpus([
    {
      session: session('s-only', 'single session'),
      messages: [
        userMessage('a1', 'ta', '上下文 一'),
        assistantMessage('a2', 'tb', '上下文 二'),
        assistantMessage('a3', 'tc', '上下文 三'),
        assistantMessage('a4', 'td', '上下文 四'),
      ],
    },
  ]);
  const result = await runRecall({ terms: ['上下文'], limit: 4 }, scanDeps(data));
  assert.ok(result.ok);
  assert.equal(
    result.passages.length,
    4,
    'a topic confined to one Session must still fill the envelope',
  );
});

test('passages come back in rank order after the quota fills gaps', async () => {
  const data = mixedCorpus();
  const result = await runRecall({ terms: ['上下文', '窗口', '显示'], limit: 6 }, scanDeps(data));
  assert.ok(result.ok);
  const scores = result.passages.map((passage) => passage.score);
  assert.deepEqual(
    scores,
    [...scores].sort((left, right) => right - left),
    'the fill pass must not leave a high-scoring passage below a lower one',
  );
});

test('several hits in one turn collapse into a single passage', async () => {
  const data = corpus([
    {
      session: session('s-turn', 'one turn'),
      messages: [
        userMessage('b1', 'tz', '上下文 问题'),
        assistantMessage('b2', 'tz', '上下文 回答'),
        assistantMessage('b3', 'tz', '上下文 补充'),
      ],
    },
  ]);
  const result = await runRecall({ terms: ['上下文'], limit: 5 }, scanDeps(data));
  assert.ok(result.ok);
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0]?.turnId, 'tz');
});

test('a passage carries its exchange and marks the anchor', async () => {
  const data = mixedCorpus();
  const result = await runRecall({ terms: ['浮窗'], limit: 1 }, scanDeps(data));
  assert.ok(result.ok);
  const passage = result.passages[0];
  assert.ok(passage);
  const anchors = passage.messages.filter((message) => message.isAnchor);
  assert.equal(anchors.length, 1);
  assert.ok(
    passage.messages.some((message) => message.role === 'user'),
    'the question that opened the exchange belongs in the passage',
  );
});

test('coordination records never enter a passage', async () => {
  const data = mixedCorpus();
  const result = await runRecall({ terms: ['宠物', '浮窗', '显示'], limit: 10 }, scanDeps(data));
  assert.ok(result.ok);
  for (const passage of result.passages) {
    for (const message of passage.messages) {
      assert.notEqual(message.messageId, 'm4', 'a system note is not visible transcript');
    }
  }
});

test('a tool result joins a passage only as its anchor', async () => {
  const data = mixedCorpus();
  const result = await runRecall({ terms: ['find'], limit: 5 }, scanDeps(data));
  assert.ok(result.ok);
  const passage = result.passages.find((entry) => entry.anchorMessageId === 'm3');
  assert.ok(passage, 'the tool result should be reachable as an anchor');
  const toolMessages = passage.messages.filter((message) => message.matchKind === 'tool_result');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.isAnchor, true);
});

test('a credential-shaped term is refused before any corpus is read', async () => {
  const data = mixedCorpus();
  let read = 0;
  const deps = scanDeps(data, {
    listSessions: async () => {
      read += 1;
      return data.sessions;
    },
  });
  const result = await runRecall({ terms: ['sk-ant-api03-abcdefghijklmnop'] }, deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'invalid_query');
  assert.equal(read, 0, 'rejection must precede any history read');
});

test('recall is closed while incognito is active', async () => {
  const data = mixedCorpus();
  let read = 0;
  const deps = scanDeps(data, {
    getPrivacyContext: async () => ({ incognitoActive: true }),
    listSessions: async () => {
      read += 1;
      return data.sessions;
    },
  });
  const result = await runRecall({ terms: ['上下文'] }, deps);
  assert.ok(!result.ok && result.reason === 'incognito_active');
  assert.equal(read, 0);
});

test('an unverifiable privacy snapshot fails closed', async () => {
  const data = mixedCorpus();
  const deps = scanDeps(data, { getPrivacyContext: async () => 'not a snapshot' });
  const result = await runRecall({ terms: ['上下文'] }, deps);
  assert.ok(!result.ok && result.reason === 'incognito_active');
});

test('matching runs on redacted text, so a secret is unreachable', async () => {
  const data = corpus([
    {
      session: session('s-secret', 'leaky'),
      messages: [assistantMessage('c1', 'ts', 'the value is ghp_0123456789abcdefghij here')],
    },
  ]);
  // The term is not credential-shaped on its own, so admission lets it
  // through; redaction before matching is what makes it miss.
  const result = await runRecall({ terms: ['0123456789abcdefghij'] }, scanDeps(data));
  assert.ok(result.ok);
  assert.equal(result.passages.length, 0);
});

test('simulator transcripts stay out of recall', async () => {
  const data = corpus([
    {
      session: session('s-fake', 'simulated', { backend: 'fake' } as Partial<SessionSummary>),
      messages: [assistantMessage('d1', 'tf', '上下文 fabricated')],
    },
  ]);
  const result = await runRecall({ terms: ['上下文'] }, scanDeps(data));
  assert.ok(result.ok);
  assert.equal(result.passages.length, 0);
});

test('the active turn is excluded from its own recall', async () => {
  const data = corpus([
    {
      session: session('s-live', 'live'),
      messages: [
        userMessage('e1', 'live-turn', '上下文 刚说的'),
        assistantMessage('e2', 'earlier', '上下文 之前说的'),
      ],
    },
  ]);
  const result = await runRecall({ terms: ['上下文'] }, scanDeps(data), {
    activeSessionId: 's-live',
    excludeTurnIds: new Set(['live-turn']),
  });
  assert.ok(result.ok);
  assert.deepEqual(anchorIds(result.passages), ['e2']);
});

test('gaps name what was searched and what was missing', async () => {
  const data = mixedCorpus();
  const result = await runRecall({ terms: ['上下文', '原子发布'] }, scanDeps(data));
  assert.ok(result.ok);
  assert.match(result.gaps, /No transcript match for: 原子发布\./u);
  assert.match(result.gaps, /No distilled facts matched\./u);
  assert.match(result.gaps, /Searched 3 Session\(s\)\./u);
});

test('distilled facts are returned alongside passages', async () => {
  const data = mixedCorpus();
  const deps = scanDeps(data, {
    searchFacts: async ({ terms }) => [
      { content: '用户偏好 上下文 默认值', kind: 'preference', observedAt: 1, matchedTerms: terms },
    ],
  });
  const result = await runRecall({ terms: ['上下文'] }, deps);
  assert.ok(result.ok);
  assert.equal(result.facts.length, 1);
  assert.doesNotMatch(result.gaps, /No distilled facts matched\./u);
});

test('an unavailable fact store degrades recall instead of failing it', async () => {
  const data = mixedCorpus();
  const deps = scanDeps(data, {
    searchFacts: async () => {
      throw new Error('memory.sqlite is unavailable');
    },
  });
  const result = await runRecall({ terms: ['上下文'] }, deps);
  assert.ok(result.ok);
  assert.equal(result.facts.length, 0);
  assert.ok(result.passages.length > 0);
});

test('a fact carrying credential material is redacted on the way out', async () => {
  const data = mixedCorpus();
  const deps = scanDeps(data, {
    searchFacts: async () => [
      {
        content: 'token is ghp_0123456789abcdefghij',
        kind: 'context',
        observedAt: 1,
        matchedTerms: [],
      },
    ],
  });
  const result = await runRecall({ terms: ['上下文'] }, deps);
  assert.ok(result.ok);
  assert.doesNotMatch(result.facts[0]?.content ?? '', /ghp_0123456789abcdefghij/u);
});

test('malformed requests are refused with a typed reason', async () => {
  const data = mixedCorpus();
  const deps = scanDeps(data);
  for (const request of [
    null,
    [],
    {},
    { terms: [] },
    { terms: [''] },
    { terms: ['ok'], limit: 0 },
    { terms: ['ok'], limit: 1000 },
    { terms: ['ok'], since: 10, until: 5 },
    { terms: Array.from({ length: 9 }, (_, index) => `t${index}`) },
  ]) {
    const result = await runRecall(request, deps);
    assert.ok(!result.ok, `expected rejection for ${JSON.stringify(request)}`);
    assert.equal(result.reason, 'invalid_query');
  }
});

test('time bounds exclude messages outside the window', async () => {
  const data = mixedCorpus();
  const all = await runRecall({ terms: ['宠物'], limit: 25 }, scanDeps(data));
  assert.ok(all.ok);
  const cutoff = Math.max(...[...data.messages.values()].flat().map((message) => message.ts));
  const none = await runRecall({ terms: ['宠物'], since: cutoff + 1 }, scanDeps(data));
  assert.ok(none.ok);
  assert.equal(none.passages.length, 0);
});

test('expansion widens a passage around an anchor recall reported', async () => {
  const data = mixedCorpus();
  const recalled = await runRecall({ terms: ['浮窗'], limit: 1 }, scanDeps(data));
  assert.ok(recalled.ok);
  const passage = recalled.passages[0];
  assert.ok(passage);

  const expanded = await expandRecallPassage(
    { sessionId: passage.sessionId, anchorMessageId: passage.anchorMessageId },
    scanDeps(data),
  );
  assert.ok(expanded.ok);
  assert.ok(expanded.passage.messages.length >= passage.messages.length);
  assert.equal(expanded.passage.anchorMessageId, passage.anchorMessageId);
});

test('expansion refuses an anchor that is not visible transcript', async () => {
  const data = mixedCorpus();
  const result = await expandRecallPassage(
    { sessionId: 's-pet', anchorMessageId: 'm4' },
    scanDeps(data),
  );
  assert.ok(!result.ok && result.reason === 'not_found');
});

test('expansion refuses an anchor from another Session', async () => {
  const data = mixedCorpus();
  const result = await expandRecallPassage(
    { sessionId: 's-ctx', anchorMessageId: 'm2' },
    scanDeps(data),
  );
  assert.ok(!result.ok && result.reason === 'not_found');
});

test('expansion is closed while incognito is active', async () => {
  const data = mixedCorpus();
  const result = await expandRecallPassage(
    { sessionId: 's-pet', anchorMessageId: 'm2' },
    scanDeps(data, { getPrivacyContext: async () => ({ incognitoActive: true }) }),
  );
  assert.ok(!result.ok && result.reason === 'incognito_active');
});

test('an aborted signal settles promptly', async () => {
  const data = mixedCorpus();
  const controller = new AbortController();
  controller.abort();
  const result = await runRecall({ terms: ['上下文'] }, scanDeps(data), {
    abortSignal: controller.signal,
  });
  assert.ok(!result.ok && result.reason === 'aborted');
});

test('the candidate ceiling is high enough to be a decline, not a default', () => {
  assert.ok(RECALL_CANDIDATE_LIMIT >= 1000);
});
