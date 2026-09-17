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
import { foldForMatch } from '../thread-search.js';
import {
  expandRecallPassage,
  recallSearchableText,
  runRecall,
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

/**
 * A tool call with no `intent`, which is what the runtime actually writes. It
 * counts toward the corpus by type but projects to nothing, so it is the one
 * record where counting by type and counting by projection disagree.
 */
function toolCallMessage(id: string, turnId: string, toolName: string): StoredMessage {
  return {
    type: 'tool_call',
    id,
    turnId,
    ts: (nextTs += 1000),
    toolName,
    args: {},
  } as unknown as StoredMessage;
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
 * Candidate deps that implement the storage contract literally: a Session is a
 * candidate when the *folded serialized form* of any stored record contains a
 * folded term. Matching serialized records over-names on field names and
 * structure exactly as a scan of stored payloads does; folding only the stored
 * side (never the term) is what the real store is held to, so a term that
 * arrives unfolded is an error here rather than something the double quietly
 * repairs.
 */
function candidateDeps(data: Corpus, overrides: Partial<RecallDeps> = {}): RecallDeps {
  return {
    ...scanDeps(data),
    listCandidateSessions: async ({ terms, sessionIds }) => {
      for (const term of terms) {
        assert.equal(term, foldForMatch(term), `candidate source received an unfolded term`);
      }
      const candidates: string[] = [];
      for (const sessionId of sessionIds) {
        const serialized = (data.messages.get(sessionId) ?? []).map((message) =>
          foldForMatch(JSON.stringify(message)),
        );
        if (serialized.some((record) => terms.some((term) => record.includes(term)))) {
          candidates.push(sessionId);
        }
      }
      return candidates;
    },
    // Mirrors the SQLite store, which can only count by message type: a
    // storage-side source cannot tell whether a record projects to visible
    // text. Counting by projection here would hide a real divergence.
    countSearchableMessages: async ({ sessionIds }) => {
      let total = 0;
      for (const sessionId of sessionIds) {
        for (const message of data.messages.get(sessionId) ?? []) {
          if (['user', 'assistant', 'tool_call', 'tool_result'].includes(message.type)) {
            total += 1;
          }
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
        toolCallMessage('m5a', 't2', 'Grep'),
        toolCallMessage('m5b', 't2', 'Read'),
        toolCallMessage('m5c', 't2', 'Bash'),
        assistantMessage('m6', 't2', '再查一下浮窗的显示条件'),
      ],
    },
    {
      session: session('s-ctx', '未设置默认上下文导致报错原因'),
      messages: [
        userMessage('m7', 't3', '这个如何设置默认上下文长度？'),
        toolCallMessage('m7a', 't3', 'Read'),
        toolCallMessage('m7b', 't3', 'Grep'),
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
      const raw = recallSearchableText(message);
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
  // Mixed case is the common path for prose and the one a stored-form scan
  // gets wrong first: the record says `token`, the caller types `TOKEN`.
  for (const terms of [
    ['宠物'],
    ['上下文', '窗口'],
    ['显示'],
    ['token', '预算'],
    ['TOKEN', 'Context'],
    ['PROVIDER'],
  ]) {
    const scanned = await verifiedAnchorIds(scanDeps(data), terms);
    assert.ok(scanned.length > 0, `${terms.join('/')} must match something to test anything`);
    const narrowed = await verifiedAnchorIds(candidateDeps(data), terms);
    assert.deepEqual(narrowed, scanned, `candidate path diverged for ${terms.join('/')}`);
  }
});

test('a candidate source changes speed, never the ranking', async () => {
  const data = mixedCorpus();
  for (const terms of [
    ['宠物', '浮窗', '显示'],
    ['上下文', '窗口', 'token'],
    ['显示'],
    ['Token', 'CONTEXT', '上下文'],
  ]) {
    const scanned = await runRecall({ terms, limit: 6 }, scanDeps(data));
    const narrowed = await runRecall({ terms, limit: 6 }, candidateDeps(data));
    assert.ok(scanned.ok && narrowed.ok);
    // Order, not just membership: idf depends on the corpus size each path
    // reports, so the two must count the corpus the same way.
    assert.deepEqual(
      narrowed.passages.map((passage) => [passage.anchorMessageId, passage.score]),
      scanned.passages.map((passage) => [passage.anchorMessageId, passage.score]),
      `ranking diverged for ${terms.join('/')}`,
    );
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
    listCandidateSessions: async () => {
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

test('a candidate source without a corpus count is not used', async () => {
  const data = mixedCorpus();
  let asked = 0;
  const counting = candidateDeps(data);
  // idf needs the corpus size. A source that cannot report it would rank
  // differently from the full scan, so recall must read transcripts instead
  // rather than score against a guessed size.
  const withoutCount: RecallDeps = {
    ...counting,
    listCandidateSessions: async (input) => {
      asked += 1;
      return counting.listCandidateSessions!(input);
    },
  };
  delete (withoutCount as { countSearchableMessages?: unknown }).countSearchableMessages;
  const missing = await runRecall({ terms: ['上下文'] }, withoutCount);
  assert.ok(missing.ok);
  assert.equal(missing.scannedFully, true);
  assert.equal(asked, 0, 'the candidate source must not even be asked');

  const declining = await runRecall(
    { terms: ['上下文'] },
    candidateDeps(data, { countSearchableMessages: async () => null }),
  );
  assert.ok(declining.ok);
  assert.equal(declining.scannedFully, true);
  const scanned = await runRecall({ terms: ['上下文'] }, scanDeps(data));
  assert.ok(scanned.ok);
  assert.deepEqual(
    declining.passages.map((passage) => [passage.anchorMessageId, passage.score]),
    scanned.passages.map((passage) => [passage.anchorMessageId, passage.score]),
  );
});

test('a term the stored form escapes bypasses the candidate source', async () => {
  const data = mixedCorpus();
  let asked = 0;
  const deps = candidateDeps(data, {
    listCandidateSessions: async (input) => {
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

test('matched terms come back as the caller wrote them', async () => {
  const data = corpus([
    {
      session: session('s-case', 'casing'),
      messages: [assistantMessage('f1', 'tcase', 'the Context Window budget')],
    },
  ]);
  const result = await runRecall({ terms: ['Context', 'WINDOW'] }, scanDeps(data));
  assert.ok(result.ok);
  assert.deepEqual(result.passages[0]?.matchedTerms, ['Context', 'WINDOW']);
});

test('gaps never report a term that matched, whatever its case', async () => {
  const data = corpus([
    {
      session: session('s-case', 'casing'),
      messages: [assistantMessage('f1', 'tcase', 'the Context Window budget')],
    },
  ]);
  for (const deps of [scanDeps(data), candidateDeps(data)]) {
    const result = await runRecall({ terms: ['Context', 'zzz'] }, deps);
    assert.ok(result.ok);
    assert.deepEqual(result.passages[0]?.matchedTerms, ['Context']);
    assert.match(result.gaps, /No transcript match for: zzz\./u);
    assert.doesNotMatch(result.gaps, /Context/u);
  }
});

test('a question is accepted, never matched, and never echoed', async () => {
  const data = mixedCorpus();
  const withQuestion = await runRecall(
    { terms: ['上下文'], question: '完全不存在的词 zzzz' },
    scanDeps(data),
  );
  const without = await runRecall({ terms: ['上下文'] }, scanDeps(data));
  assert.ok(withQuestion.ok && without.ok);
  assert.deepEqual(
    anchorIds(withQuestion.passages),
    anchorIds(without.passages),
    'the question must not influence retrieval',
  );
  assert.equal(withQuestion.gaps, without.gaps);
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

test('a term found only in a redaction marker is not a hit', async () => {
  const data = corpus([
    {
      session: session('s-secret', 'leaky'),
      messages: [
        assistantMessage('c1', 'ts', 'set the token to ghp_0123456789abcdefghij and rerun'),
      ],
    },
  ]);
  // Redaction rewrites the text to `token to [redacted] and`. A term that
  // occurs only in that rewritten form was never said, and no scan of stored
  // records could offer it — so both paths must agree it is not a match.
  for (const terms of [['redacted'], ['[redacted] and'], ['to [red']]) {
    const scanned = await runRecall({ terms }, scanDeps(data));
    const narrowed = await runRecall({ terms }, candidateDeps(data));
    assert.ok(scanned.ok && narrowed.ok);
    assert.equal(scanned.passages.length, 0, `${terms[0]} matched a redaction artifact`);
    assert.equal(narrowed.passages.length, 0);
  }
  // Text on either side of the marker stays reachable, and comes back redacted.
  const around = await runRecall({ terms: ['rerun'] }, candidateDeps(data));
  assert.ok(around.ok);
  assert.equal(around.passages.length, 1);
  assert.match(around.passages[0]?.messages[0]?.text ?? '', /token to \[redacted\] and rerun/u);
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
    searchFacts: async () => [
      { content: '用户偏好 上下文 默认值', kind: 'preference', observedAt: 1 },
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
      { content: 'token is ghp_0123456789abcdefghij', kind: 'context', observedAt: 1 },
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

test('expansion refuses an anchor inside the active turn', async () => {
  const data = corpus([
    {
      session: session('s-live', 'live'),
      messages: [
        userMessage('e1', 'live-turn', '上下文 刚说的'),
        assistantMessage('e2', 'earlier', '上下文 之前说的'),
      ],
    },
  ]);
  const options = { activeSessionId: 's-live', excludeTurnIds: new Set(['live-turn']) };
  // The anchor is caller-supplied, so this is the one way the turn in flight
  // could be widened into view after recall itself refused to surface it.
  const live = await expandRecallPassage(
    { sessionId: 's-live', anchorMessageId: 'e1' },
    scanDeps(data),
    options,
  );
  assert.ok(!live.ok && live.reason === 'not_found');

  const earlier = await expandRecallPassage(
    { sessionId: 's-live', anchorMessageId: 'e2' },
    scanDeps(data),
    options,
  );
  assert.ok(earlier.ok);
  assert.equal(earlier.passage.anchorMessageId, 'e2');
  // The exclusion is scoped to the active Session: the same turn id elsewhere
  // is a different turn.
  const other = await expandRecallPassage(
    { sessionId: 's-live', anchorMessageId: 'e1' },
    scanDeps(data),
    { activeSessionId: 's-other', excludeTurnIds: new Set(['live-turn']) },
  );
  assert.ok(other.ok);
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

/**
 * The passage budget binds long before the span does, so which neighbours it
 * buys decides what the model reads. Spending it chronologically would keep
 * three far messages and drop the one immediately before the anchor — usually
 * the question the anchor answers — while reporting no more context available.
 */
test('the passage budget keeps the nearest context and says when it cut the rest', async () => {
  const filler = (label: string) => `${label} ${'x'.repeat(4000)}`;
  const data = corpus([
    {
      session: session('s-budget', 'budget'),
      messages: [
        userMessage('far-1', 'tb', filler('FAR ONE')),
        assistantMessage('far-2', 'tb', filler('FAR TWO')),
        userMessage('far-3', 'tb', filler('FAR THREE')),
        assistantMessage('near-before', 'tb', 'IMMEDIATE CONTEXT before'),
        userMessage('anchor', 'tb', '浮窗 的问题'),
        assistantMessage('near-after', 'tb', 'IMMEDIATE CONTEXT after'),
        userMessage('far-after', 'tb', filler('FAR AFTER')),
      ],
    },
  ]);

  const recalled = await runRecall({ terms: ['浮窗'] }, scanDeps(data));
  assert.ok(recalled.ok);
  const passage = recalled.passages[0];
  assert.ok(passage);
  const ids = passage.messages.map((message) => message.messageId);
  assert.deepEqual(ids.includes('anchor'), true);
  assert.ok(ids.includes('near-before'), `nearest preceding message was dropped: ${ids.join()}`);
  assert.ok(ids.includes('near-after'), `nearest following message was dropped: ${ids.join()}`);
  // Chronological order is what the caller reads, whatever order the budget
  // was spent in.
  assert.deepEqual(
    ids,
    [...ids].sort(
      (left, right) =>
        passage.messages.findIndex((message) => message.messageId === left) -
        passage.messages.findIndex((message) => message.messageId === right),
    ),
  );
  // Every neighbour the span selected but the budget could not fit must be
  // reported as more context, in the direction it was dropped from.
  const dropped = (selected: readonly string[]) => selected.some((id) => !ids.includes(id));
  assert.equal(passage.hasMoreBefore, dropped(['far-1', 'far-2', 'far-3', 'near-before']));
  assert.equal(passage.hasMoreAfter, dropped(['near-after', 'far-after']));
  assert.equal(passage.hasMoreBefore, true, 'the budget must bind on this fixture');
  assert.equal(passage.truncated, true);

  // The default expansion answers the flags: it must not repeat the ordering
  // error, and a caller that narrows the span gets the nearest context whole.
  const expanded = await expandRecallPassage(
    { sessionId: passage.sessionId, anchorMessageId: passage.anchorMessageId },
    scanDeps(data),
  );
  assert.ok(expanded.ok);
  const expandedIds = expanded.passage.messages.map((message) => message.messageId);
  assert.ok(expandedIds.includes('near-before'), expandedIds.join());
  assert.ok(expandedIds.includes('near-after'), expandedIds.join());

  const narrow = await expandRecallPassage(
    { sessionId: passage.sessionId, anchorMessageId: passage.anchorMessageId, before: 1, after: 1 },
    scanDeps(data),
  );
  assert.ok(narrow.ok);
  assert.deepEqual(
    narrow.passage.messages.map((message) => message.messageId),
    ['near-before', 'anchor', 'near-after'],
  );
});

test('a Session the source names but recall did not ask about is not read', async () => {
  const data = mixedCorpus();
  const read: string[] = [];
  const deps = candidateDeps(data, {
    listCandidateSessions: async () => ['s-pet', 'not-eligible'],
    readMessages: async (sessionId) => {
      read.push(sessionId);
      return data.messages.get(sessionId) ?? null;
    },
  });
  const result = await runRecall({ terms: ['宠物'] }, deps);
  assert.ok(result.ok);
  assert.deepEqual(
    read.filter((id) => id === 'not-eligible'),
    [],
  );
  assert.ok(result.passages.length > 0);
});

test('a tool result is matched on its output, not on the shape around it', () => {
  const json = toolResultMessage('r1', 't', 'unused');
  (json as { content: unknown }).content = {
    kind: 'json',
    value: { exitCode: 0, cwd: '/work', output: 'ninja: build stopped' },
  };
  // String values are text; keys, numbers and the kind tag are not.
  assert.equal(recallSearchableText(json), '/work\nninja: build stopped');

  const archived = toolResultMessage('r2', 't', 'unused');
  (archived as { content: unknown }).content = {
    kind: 'archived_tool_result',
    status: 'not_loaded',
    runtimeEventId: 'evt',
    toolCallId: 'call',
    toolName: 'Bash',
    originalEstimatedTokens: 1,
    originalBytes: 1,
    rewriteVersion: 2,
    reason: 'tool_result_pruned',
  };
  assert.equal(recallSearchableText(archived), undefined);

  const text = toolResultMessage('r3', 't', 'plain output');
  assert.equal(recallSearchableText(text), 'plain output');
});
