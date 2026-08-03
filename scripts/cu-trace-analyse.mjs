#!/usr/bin/env node
// What confused the model.
//
// `MAKA_CU_DEBUG_LOG` records every Computer Use call a real run made:
// arguments verbatim, result untruncated, interleaved with the executor's own
// dispatch trace. Reading one by hand tells you what happened; reading twenty
// tells you what the tool surface keeps doing to models.
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
//   node scripts/cu-trace-analyse.mjs /tmp/cu-desktop-scenarios/*.trace.jsonl
//
// Every shape below is exported and tested from `cu-trace-analyse.test.mjs`
// against fixtures in the journal's own format. An analyser whose counters
// cannot be shown to move is an analyser that reports zero forever, which is
// exactly what three of these did before the test existed.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** The call as the model asked for it, with the volatile parts removed. */
export function signature(args) {
  const copy = { ...args };
  // An observation id changes every turn by design; two calls differing only
  // there are the same call as far as the model's intent goes.
  delete copy.observation_id;
  return `${copy.action ?? '?'} ${JSON.stringify(copy)}`;
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

/** Actions that read. Everything else that dispatches is a mutation. */
const OBSERVING = /^(observe|screenshot|list_apps|wait_for_text|wait_for_text_gone)$/;
const MUTATING =
  /^(click|click_element|double_click|middle_click|triple_click|secondary_action|set_value|type_text|press_key|select_text|scroll|scroll_element|element_sequence|drag|window_action|launch_app)$/;

/**
 * Whether a result handed the model a fresh tree.
 *
 * Maka attaches an observation to the result of an action, so a click is not
 * only a mutation — it is also a look, and the call after it is not blind. The
 * marker is the observation header the renderer writes, which is protocol
 * (`observation_id` is what an action has to quote back) rather than prose.
 */
export function carriesObservation(text) {
  return /observation_id=/.test(String(text ?? ''));
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
 */
export function classify(record) {
  if (record.kind !== 'call') return null;
  // `rawArgs` first: `modelFacingArgs` is the narrowed projection, and two
  // calls that differ only in a field the projection drops read as the same
  // call — which is how fourteen identical retries were counted as eight
  // different argument shapes.
  const args = record.rawArgs ?? record.modelFacingArgs ?? {};
  // A failed call has no `resultModelText` at all; reading only that field made
  // every refusal invisible, so the refusal counts were the ones this analyser
  // exists to produce.
  const text = String(record.resultText ?? record.resultModelText ?? '');
  // The structural field first. `CuDebugRecord.error` is the executor's own
  // code, written beside the result rather than inside it, so it survives any
  // change to how a refusal is worded for the model. The regex stays as a
  // second source for journals written before the field existed — and when
  // neither yields a code but the text reads like a failure, that is recorded
  // as `unclassified` and printed, rather than counted as a success.
  const structural = typeof record.error === 'string' && record.error ? record.error : null;
  const fromText = /failed:\s*([a-z_]+)/.exec(text)?.[1] ?? null;
  const failed = structural ?? fromText;
  return {
    action: args.action ?? '?',
    args,
    signature: signature(args),
    target: targetKey(args),
    failed,
    unclassified: failed === null && LOOKS_FAILED.test(text),
    observed: carriesObservation(text),
    durationMs: record.durationMs ?? 0,
    text,
  };
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
    const observing = OBSERVING.test(call.action);
    const mutating = MUTATING.test(call.action);
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

export function parseTrace(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map(classify)
    .filter(Boolean);
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
    const raw = await readFile(file, 'utf8').catch(() => '');
    if (!raw.trim()) {
      report.push({ file, empty: true });
      continue;
    }
    const calls = parseTrace(raw);
    report.push({ file, ...analyseCalls(calls) });
    calls.forEach((call, index) => {
      everyCall.push({ ...call, next: calls[index + 1]?.action ?? null });
    });
  }

  for (const r of report) {
    console.log(`\n=== ${basename(r.file)}`);
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

  const total = report.filter((r) => !r.empty);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (files.length === 0) {
    console.log('usage: node scripts/cu-trace-analyse.mjs <trace.jsonl...>');
    process.exit(2);
  }
  process.exit(await main(files));
}
