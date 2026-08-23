#!/usr/bin/env node
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

// What confused the model.
//
// `MAKA_CU_DEBUG_LOG` is meant to record every Computer Use call a real run
// made: arguments verbatim, result untruncated, interleaved with the executor's
// own dispatch trace. Reading one by hand tells you what happened; reading
// twenty tells you what the tool surface keeps doing to models.
//
// NOTHING WRITES THAT JOURNAL YET. `MAKA_CU_DEBUG_LOG` and the `CuDebugRecord`
// shape read below have no producer anywhere in this repository — not on
// `main`, not on any open branch other than the harness scripts that pass the
// variable through. So the record shape here has never been checked against a
// writer, and the first writer to land will disagree with it in some way. That
// is why every field this file reads is required rather than defaulted: a
// record it cannot classify is reported and exits non-zero, instead of being
// counted as a call that went fine. See `classify` below.
//
// This looks for the shapes that mean a model was stuck rather than working:
//
//   repeated       the same call, twice or more, unchanged. It read the reply
//                  and had no better idea than to send it again.
//   thrash         the same action, different arguments each time — it is
//                  guessing at the schema, not at the screen.
//   refused        which codes came back, and what the model did next. A code
//                  followed by a different action is recovery; a code followed
//                  by the same action is a dead end.
//   blind          a mutating action with no observation of its target since
//                  the last thing that could have invalidated one.
//   abandoned      the turn ended within one call of a refusal.
//   cost           calls per task, and how much of that was spent recovering.
//
//   node scripts/computer-use.mjs trace-analyse /tmp/cu-desktop-scenarios/*.trace.jsonl
//
// Every shape below is exported for focused analysis of the journal format.
// against fixtures in the journal's own format. An analyser whose counters
// cannot be shown to move is an analyser that reports zero forever, which is
// exactly what three of these did before the test existed.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The vocabulary comes from the product, not from a copy of it kept here. Two
// regexes used to restate the action names; by the time anyone looked, neither
// matched a single coordinate action — `left_click` was in neither list — so a
// trajectory of twenty blind coordinate clicks reported BLIND 0, and every
// name the regexes did contain (`click`, `type_text`, `drag`, `launch_app`,
// `window_action`, `element_sequence`, `wait_for_text`) had zero occurrences
// on the wire. Importing the enum makes that failure impossible: an action
// added to the tool is classified here the day it lands.
import {
  CU_TOOL_ACTION_TYPES,
  isCuMutatingAction,
  isCuObservingAction,
} from '@maka/core/computer-use';

/** The call as the model asked for it, with the volatile parts removed. */
export function signature(args) {
  const copy = { ...args };
  // An observation id changes every turn by design; two calls differing only
  // there are the same call as far as the model's intent goes.
  delete copy.observation_id;
  // Key order is not intent. A model that sends the same call three times can
  // serialise it three ways, and reading those as three argument shapes
  // reported verbatim repetition as schema-guessing — the exact confusion this
  // file exists to name. Sort so the signature depends on content only.
  return `${copy.action ?? '?'} ${stableStringify(copy)}`;
}

/** JSON with object keys in sorted order, at every depth. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Which window of which application a call is aimed at.
 *
 * An observation is of one target. Carrying it across a target change is the
 * same mistake as carrying it across a mutation: the tree the model is holding
 * describes something else.
 */
export function targetKey(args) {
  const app = args.app ?? args.bundle_id ?? args.app_id ?? '';
  const window = args.window_id ?? '';
  return `${app}|${window}`;
}

// Actions that read take an observation lease; everything else on the wire
// takes an action lease. That partition is `@maka/core`'s, imported above.

/**
 * Whether a result handed the model a fresh tree.
 *
 * Maka attaches an observation to the result of an action, so a click is not
 * only a mutation — it is also a look, and the call after it is not blind. The
 * marker is the `observation_id` key of the JSON the renderer writes
 * (`packages/runtime/src/computer-use-tools.ts`, `observationText` and
 * `persistedObservationText`), which is protocol — `observation_id` is what the
 * next action has to quote back — rather than prose.
 *
 * This used to test for `observation_id=`, a shell-style form with zero
 * occurrences in the product. It therefore returned false for every real
 * observation, which made `blindCalls` unable to see that an action had handed
 * back a replacement tree: a correct run of four clicks that each returned one
 * reported BLIND 3. The counter flagged the product working.
 */
export function carriesObservation(text) {
  return /"observation_id"\s*:\s*"/.test(String(text ?? ''));
}

/**
 * Text that reads like a failure whether or not a code could be read out of it.
 *
 * This exists to make finding 3 below loud. Refusal detection used to hinge on
 * one regex over rendered prose; when the executor changed its wording every
 * refusal count, dead-end count and the whole failure-by-action table silently
 * went to zero and the report still looked like a clean run.
 */
const LOOKS_FAILED = /\bfailed\b|\brefused\b|unsupported_action|\bblocked\b|\berror\b/i;

/**
 * One decision the model made.
 *
 * The journal carries two kinds of line. `kind: "call"` is a tool call, with
 * `rawArgs` as the model sent them and `modelFacingArgs` as the model was shown
 * them — they differ when the host projects a narrower surface, and a
 * disagreement between the two is worth seeing. `kind: "driver"` is the
 * executor's dispatch trace, which is what happened rather than what was asked.
 *
 * Nothing writes this shape yet (see the header). So the fields are read
 * strictly: a `call` line without an arguments object, without an action name,
 * or without any result at all is a record this file does not understand, and
 * it is returned with `malformed` set so the report can say so and exit
 * non-zero. Defaulting those to `{}` and `''` instead — which is what this did
 * — turned twenty records of a shape it had never seen into
 * `{"calls":20,"refusals":0,"blind":0,"actions":["?"]}` and exit 0: a clean
 * bill of health for a corpus it had not read one field of.
 */
export function classify(record) {
  if (record.kind !== 'call') return null;
  // `rawArgs` first: `modelFacingArgs` is the narrowed projection, and two
  // calls that differ only in a field the projection drops read as the same
  // call — which is how fourteen identical retries were counted as eight
  // different argument shapes.
  const args = isPlainObject(record.rawArgs)
    ? record.rawArgs
    : isPlainObject(record.modelFacingArgs)
      ? record.modelFacingArgs
      : null;
  // A failed call has no `resultModelText` at all; reading only that field made
  // every refusal invisible, so the refusal counts were the ones this analyser
  // exists to produce.
  const resultText =
    typeof record.resultText === 'string'
      ? record.resultText
      : typeof record.resultModelText === 'string'
        ? record.resultModelText
        : null;
  const structural = typeof record.error === 'string' && record.error ? record.error : null;
  const action = typeof args?.action === 'string' ? args.action : null;
  // What is wrong with this line, in the words a reader can act on. Empty means
  // the record was understood.
  const malformed = [];
  if (args === null) malformed.push('no rawArgs/modelFacingArgs object');
  else if (action === null) malformed.push('no action name in the arguments');
  else if (!CU_TOOL_ACTION_TYPES.includes(action)) {
    malformed.push(`action "${action}" is not on the maka_computer wire enum`);
  }
  if (resultText === null && structural === null) {
    malformed.push('no resultText, resultModelText or error field');
  }
  const text = resultText ?? '';
  // The structural field first. `CuDebugRecord.error` is the executor's own
  // code, written beside the result rather than inside it, so it survives any
  // change to how a refusal is worded for the model. The regex stays as a
  // second source for journals written before the field existed — and when
  // neither yields a code but the text reads like a failure, that is recorded
  // as `unclassified` and printed, rather than counted as a success.
  const fromText = /failed:\s*([a-z_]+)/.exec(text)?.[1] ?? null;
  const failed = structural ?? fromText;
  return {
    action: action ?? '?',
    args: args ?? {},
    signature: signature(args ?? {}),
    target: targetKey(args ?? {}),
    failed,
    unclassified: failed === null && LOOKS_FAILED.test(text),
    malformed,
    observed: carriesObservation(text),
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    text,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mutating calls made with no live observation of the thing being mutated.
 *
 * The earlier implementation searched every preceding call for any observe at
 * all, so after the first `observe` in a run nothing could ever be flagged: a
 * trajectory that looked once and then fired twenty clicks reported BLIND 0.
 * What makes a call blind is not the absence of an observation somewhere in the
 * past — it is acting on a tree that has since been invalidated, by the model's
 * own mutation or by pointing somewhere else.
 */
export function blindCalls(calls) {
  const blind = [];
  // The target the model currently holds a live tree for, or null for none.
  let observedTarget = null;
  for (const call of calls) {
    const observing = isCuObservingAction(call.action);
    const mutating = isCuMutatingAction(call.action);
    if (observing) {
      if (call.observed || call.failed === null) observedTarget = call.target;
      continue;
    }
    if (!mutating) continue;
    if (observedTarget === null || observedTarget !== call.target) blind.push(call);
    // The mutation retires whatever tree was held, unless its own result
    // carried a replacement — which Maka's do, and which is why this is read
    // from the result rather than assumed either way.
    observedTarget = call.observed ? call.target : null;
  }
  return blind;
}

/**
 * Whether the turn ended within one call of a refusal.
 *
 * Documented that way from the start and implemented as "the last call was a
 * refusal", which misses the commonest shape of giving up: a refusal, one more
 * attempt, and then nothing.
 */
export function endedAbandoned(calls) {
  return calls.slice(-2).some((call) => call.failed !== null);
}

/**
 * The journal, split into the calls it carried and the lines it lost.
 *
 * A line that will not parse is not a line that can be ignored: a journal
 * truncated mid-write, or written by something other than the executor, would
 * otherwise present as a short but tidy trajectory. The count is returned so
 * the report can say how much of the file it failed to read.
 */
export function parseJournal(raw) {
  const calls = [];
  const unreadable = [];
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      unreadable.push(index + 1);
      continue;
    }
    const call = classify(record);
    if (call) calls.push(call);
  }
  return { calls, unreadable, lines: lines.length };
}

export function parseTrace(raw) {
  return parseJournal(raw).calls;
}

/** Everything one trajectory has to say about itself. */
export function analyseCalls(calls) {
  const seen = new Map();
  const repeated = [];
  for (const call of calls) {
    const n = (seen.get(call.signature) ?? 0) + 1;
    seen.set(call.signature, n);
    if (n === 2) repeated.push(call.signature);
  }

  const byAction = new Map();
  for (const call of calls) {
    if (!byAction.has(call.action)) byAction.set(call.action, new Set());
    // The signature, not the raw arguments: `observation_id` changes every turn
    // by design, so counting raw shapes reported fourteen identical retries as
    // eight different guesses at the schema. `repeated` already went through
    // the signature, so the two measures had been disagreeing about what
    // "the same call" means.
    byAction.get(call.action).add(call.signature);
  }
  const thrash = [...byAction.entries()]
    .filter(([, shapes]) => shapes.size >= 3)
    .map(([action, shapes]) => `${action}×${shapes.size} shapes`);

  const refusals = calls.filter((c) => c.failed);
  const deadEnds = refusals.filter((c) => {
    const at = calls.indexOf(c);
    const next = calls[at + 1];
    return next && next.action === c.action;
  });

  return {
    calls: calls.length,
    refusals: refusals.length,
    unclassified: calls.filter((c) => c.unclassified).length,
    // Records this file could not read as a Computer Use call, with the reason.
    // Anything in here makes every number beside it untrustworthy, so it is
    // printed and it decides the exit code.
    malformed: calls.flatMap((c) => c.malformed ?? []),
    codes: [...new Set(refusals.map((c) => c.failed))],
    repeated,
    thrash,
    deadEnds: deadEnds.length,
    blind: blindCalls(calls).length,
    abandoned: endedAbandoned(calls),
    actions: [...new Set(calls.map((c) => c.action))],
  };
}

async function main(files) {
  const report = [];
  const everyCall = [];
  for (const file of files) {
    // A file that cannot be read is not an empty file. Reporting the two the
    // same way is how a mistyped glob reads as a clean corpus.
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      report.push({ file, unreadableFile: String(error?.message ?? error) });
      continue;
    }
    if (!raw.trim()) {
      report.push({ file, empty: true });
      continue;
    }
    const { calls, unreadable, lines } = parseJournal(raw);
    report.push({ file, unreadable, lines, ...analyseCalls(calls) });
    calls.forEach((call, index) => {
      everyCall.push({ ...call, next: calls[index + 1]?.action ?? null });
    });
  }

  for (const r of report) {
    console.log(`\n=== ${basename(r.file)}`);
    if (r.unreadableFile) {
      console.log(`    COULD NOT READ — ${r.unreadableFile}`);
      continue;
    }
    if (r.empty) {
      console.log(
        '    (no trace — the run wrote nothing, which usually means MAKA_CU_DEBUG_LOG was not set)',
      );
      continue;
    }
    console.log(
      `    ${r.calls} calls, ${r.refusals} refused${r.abandoned ? ', ended on a refusal' : ''}`,
    );
    console.log(`    actions: ${r.actions.join(' ')}`);
    if (r.codes.length > 0) console.log(`    codes: ${r.codes.join(' ')}`);
    if (r.unreadable.length > 0) {
      console.log(
        `    UNREADABLE — ${r.unreadable.length} of ${r.lines} line(s) are not JSON` +
          ` (first at line ${r.unreadable[0]}). This journal is truncated or was not written by` +
          ' the executor; everything below is what survived.',
      );
    }
    if (r.malformed.length > 0) {
      // The reason the exit code is non-zero. Nothing writes this journal yet,
      // so the likeliest cause is that the first producer to land disagrees
      // with the shape read here — and the wrong answer to that is a table of
      // zeroes that reads like a run with no problems.
      const reasons = [...new Set(r.malformed)];
      console.log(
        `    NOT A COMPUTER USE CALL — ${r.malformed.length} record(s) this analyser cannot` +
          ' classify. Every number in this block is computed over the rest:',
      );
      for (const reason of reasons.slice(0, 6)) console.log(`      ${reason}`);
    }
    if (r.unclassified > 0) {
      // Loud, because the alternative is a table of zeroes that reads like a
      // clean run. Every one of these is a result the executor rendered as a
      // failure and this file could not put a code to.
      console.log(
        `    UNCLASSIFIED — ${r.unclassified} result(s) read as a failure with no code this` +
          ' analyser recognises. The refusal counts below are undercounting.',
      );
    }
    if (r.repeated.length > 0) {
      console.log(`    REPEATED — the same call sent again after reading the reply:`);
      for (const sig of r.repeated.slice(0, 4)) console.log(`      ${sig.slice(0, 140)}`);
    }
    if (r.thrash.length > 0)
      console.log(`    THRASH — guessing at the schema: ${r.thrash.join(', ')}`);
    if (r.deadEnds > 0)
      console.log(`    DEAD END — ${r.deadEnds} refusal(s) followed by the same action again`);
    if (r.blind > 0)
      console.log(`    BLIND — ${r.blind} mutating call(s) with no live observation of the target`);
  }

  // Which action wastes the most, and what a model does after each refusal.
  //
  // The per-run shapes above say a run went badly; these two say what to fix. On
  // the 30 runs that produced them: `secondary_action` was 36 of 217 calls with
  // 29 failures — the worst rate on the surface, and every one of them `raise` —
  // and the two commonest sequences in the whole corpus were
  // `secondary_action→dispatch_refused → secondary_action` (12) and
  // `secondary_action→reobserve_required → observe` (13). One action, 25 wasted
  // calls, and neither number is visible one run at a time.
  if (everyCall.length > 0) {
    const byAction = new Map();
    for (const call of everyCall) {
      const row = byAction.get(call.action) ?? { calls: 0, failed: 0 };
      row.calls += 1;
      if (call.failed) row.failed += 1;
      byAction.set(call.action, row);
    }
    const ranked = [...byAction.entries()]
      .filter(([, row]) => row.failed > 0)
      .sort((a, b) => b[1].failed - a[1].failed);
    if (ranked.length > 0) {
      console.log('\nWHAT FAILS, BY ACTION');
      for (const [action, row] of ranked) {
        console.log(
          `    ${action.padEnd(20)} ${String(row.failed).padStart(3)}/${String(row.calls).padEnd(3)} ` +
            `(${Math.round((row.failed / row.calls) * 100)}%)`,
        );
      }
    }

    const sequences = new Map();
    for (const call of everyCall) {
      if (!call.failed || !call.next) continue;
      const key = `${call.action}→${call.failed} then ${call.next}`;
      sequences.set(key, (sequences.get(key) ?? 0) + 1);
    }
    const common = [...sequences.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (common.length > 0) {
      console.log('\nWHAT A MODEL DOES NEXT, AFTER A REFUSAL');
      // Same action again is a dead end; `observe` is the round trip a refusal
      // that kept its frame would not have cost.
      for (const [key, n] of common) console.log(`    ${key.padEnd(52)} × ${n}`);
    }
  }

  const total = report.filter((r) => !r.empty && !r.unreadableFile);
  if (total.length > 0) {
    const calls = total.reduce((n, r) => n + r.calls, 0);
    const refused = total.reduce((n, r) => n + r.refusals, 0);
    const unclassified = total.reduce((n, r) => n + r.unclassified, 0);
    console.log(
      `\nacross ${total.length} runs: ${calls} calls, ${refused} refused (${Math.round((refused / Math.max(calls, 1)) * 100)}%), ` +
        `${total.reduce((n, r) => n + r.repeated.length, 0)} repeated, ${total.reduce((n, r) => n + r.deadEnds, 0)} dead ends`,
    );
    if (unclassified > 0) {
      console.log(
        `${unclassified} result(s) across the corpus read as a failure with no recognised code.` +
          ' Fix the code extraction before trusting any number above.',
      );
    }
  }

  // Anything below this line is a reason to distrust everything above it, so it
  // decides the exit code rather than being one more paragraph of output.
  const unreadableFiles = report.filter((r) => r.unreadableFile).length;
  const unreadableLines = total.reduce((n, r) => n + r.unreadable.length, 0);
  const malformed = total.reduce((n, r) => n + r.malformed.length, 0);
  if (unreadableFiles > 0 || unreadableLines > 0 || malformed > 0) {
    console.log(
      `\nREFUSING TO REPORT ON THIS CORPUS: ${unreadableFiles} file(s) unreadable,` +
        ` ${unreadableLines} line(s) not JSON, ${malformed} record(s) not a Computer Use call.` +
        ' Nothing writes MAKA_CU_DEBUG_LOG in this repository yet, so the shape read here has' +
        ' never been checked against a writer — a corpus this file cannot classify is a' +
        ' disagreement to fix, not a run with no problems.',
    );
    return 3;
  }
  // A corpus that produced no calls at all is not a clean run — it is a run
  // whose journal was never written. Nothing on `main` writes
  // `MAKA_CU_DEBUG_LOG` yet, so this is the expected state until the executor
  // that does lands, and it must not read as "no problems found".
  if (total.length === 0 || total.every((r) => r.calls === 0)) {
    console.log(
      '\nno trajectory in any of these files carried a single Computer Use call.' +
        ' There is nothing here to analyse.',
    );
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (files.length === 0) {
    console.log('usage: node scripts/computer-use.mjs trace-analyse <trace.jsonl...>');
    process.exit(2);
  }
  process.exit(await main(files));
}
