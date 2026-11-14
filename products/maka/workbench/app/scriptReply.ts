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
 * A script cell's result. The Host records it in two forms: the typed
 * observation, and what the model received, which is one line of JSON and
 * then whatever the script printed.
 */
export type ScriptReply = {
  state: 'running' | 'completed' | 'interrupted';
  /** Interrupted, or finished and reported an error. */
  failed: boolean;
  /** Why it stopped or failed, in words. */
  diagnostic: string | null;
  /** What it printed, or the value it returned when it printed nothing. */
  output: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A diagnostic can itself be JSON: {"ok":false,"error":{"message":…}}.
function reason(diagnostic: unknown): string | null {
  if (isRecord(diagnostic)) {
    const message = isRecord(diagnostic.error) ? diagnostic.error.message : diagnostic.message;
    return typeof message === 'string' && message.trim() ? message : null;
  }
  if (typeof diagnostic !== 'string' || !diagnostic.trim()) return null;
  if (/^\s*\{/.test(diagnostic)) {
    try {
      const inner = reason(JSON.parse(diagnostic));
      if (inner) return inner;
    } catch {}
  }
  return diagnostic;
}

function texts(content: unknown): string {
  return Array.isArray(content)
    ? content
        .flatMap((item) => {
          const text = isRecord(item) ? item.text : null;
          return typeof text === 'string' && text.trim() ? [text] : [];
        })
        .join('\n')
    : '';
}

function returned(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
}

function states(state: unknown): ScriptReply['state'] | null {
  return state === 'running' || state === 'completed' || state === 'interrupted' ? state : null;
}

function reply(
  state: ScriptReply['state'],
  result: unknown,
  diagnostic: unknown,
  printed: string,
): ScriptReply {
  const outcome = isRecord(result) ? result : null;
  const reported = state === 'completed' && outcome?.ok === false;
  return {
    state,
    failed: state === 'interrupted' || reported,
    diagnostic: reported
      ? reason(outcome!.error)
      : state === 'interrupted'
        ? reason(diagnostic)
        : null,
    output: printed || (state === 'completed' && !reported ? returned(outcome?.value) : ''),
  };
}

const summaryLine = /^\s*\{"state":"(?:running|completed|interrupted)","cell_id":/;
const clippedDiagnostic = /"diagnostic":"((?:[^"\\]|\\.)*)"/;

export function scriptReply(value: unknown): ScriptReply | null {
  const observation = isRecord(value) && isRecord(value.observation) ? value.observation : null;
  if (observation) {
    const state = states(observation.state);
    if (!state) return null;
    const report = isRecord(observation.report) ? observation.report : null;
    const prior = isRecord(report?.priorOutput) ? report.priorOutput.content : undefined;
    return reply(
      state,
      observation.result,
      report?.diagnostic,
      texts(observation.content ?? prior),
    );
  }
  if (typeof value !== 'string' || !summaryLine.test(value)) return null;
  const end = value.indexOf('\n');
  const head = end < 0 ? value : value.slice(0, end);
  const printed = end < 0 ? '' : value.slice(end + 1);
  let summary: unknown;
  try {
    summary = JSON.parse(head);
  } catch {
    // The Host cut a long reply short. Why a script stopped is near its start.
    const found = clippedDiagnostic.exec(head);
    if (!found) return null;
    try {
      return reply('interrupted', null, JSON.parse(`"${found[1]}"`), '');
    } catch {
      return null;
    }
  }
  const state = isRecord(summary) ? states(summary.state) : null;
  return state && isRecord(summary)
    ? reply(state, summary.result, summary.diagnostic, printed)
    : null;
}
