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
//   blind          a mutating action with no observation in front of it.
//   abandoned      the turn ended within one call of a refusal.
//   cost           calls per task, and how much of that was spent recovering.
//
//   node scripts/cu-trace-analyse.mjs /tmp/cu-desktop-scenarios/*.trace.jsonl
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (files.length === 0) {
  console.log('usage: node scripts/cu-trace-analyse.mjs <trace.jsonl...>');
  process.exit(2);
}

/** The call as the model asked for it, with the volatile parts removed. */
function signature(args) {
  const copy = { ...args };
  // An observation id changes every turn by design; two calls differing only
  // there are the same call as far as the model's intent goes.
  delete copy.observation_id;
  return `${copy.action ?? '?'} ${JSON.stringify(copy)}`;
}

/**
 * One decision the model made.
 *
 * The journal carries two kinds of line. `kind: "call"` is a tool call, with
 * `rawArgs` as the model sent them and `modelFacingArgs` as the model was shown
 * them — they differ when the host projects a narrower surface, and a
 * disagreement between the two is worth seeing. `kind: "driver"` is the
 * executor's dispatch trace, which is what happened rather than what was asked.
 */
function classify(record) {
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
  const failed = /failed:\s*([a-z_]+)/.exec(text);
  return {
    action: args.action ?? '?',
    args,
    signature: signature(args),
    failed: failed?.[1] ?? null,
    durationMs: record.durationMs ?? 0,
    text,
  };
}

const report = [];
for (const file of files) {
  const raw = await readFile(file, 'utf8').catch(() => '');
  if (!raw.trim()) {
    report.push({ file, empty: true });
    continue;
  }
  const calls = raw
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
  const deadEnds = refusals.filter((c, i) => {
    const at = calls.indexOf(c);
    const next = calls[at + 1];
    return next && next.action === c.action;
  });
  const blind = calls.filter((c, i) => {
    if (
      !/click_element|set_value|press_key|select_text|scroll_element|element_sequence/.test(
        c.action,
      )
    )
      return false;
    const before = calls.slice(0, i).reverse();
    const lastObserve = before.find((p) => /observe|screenshot/.test(p.action));
    return !lastObserve;
  });
  const abandoned =
    refusals.length > 0 && calls.length > 0 && calls[calls.length - 1]?.failed !== null;

  report.push({
    file,
    calls: calls.length,
    refusals: refusals.length,
    codes: [...new Set(refusals.map((c) => c.failed))],
    repeated,
    thrash,
    deadEnds: deadEnds.length,
    blind: blind.length,
    abandoned,
    actions: [...new Set(calls.map((c) => c.action))],
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
  if (r.repeated.length > 0) {
    console.log(`    REPEATED — the same call sent again after reading the reply:`);
    for (const sig of r.repeated.slice(0, 4)) console.log(`      ${sig.slice(0, 140)}`);
  }
  if (r.thrash.length > 0)
    console.log(`    THRASH — guessing at the schema: ${r.thrash.join(', ')}`);
  if (r.deadEnds > 0)
    console.log(`    DEAD END — ${r.deadEnds} refusal(s) followed by the same action again`);
  if (r.blind > 0)
    console.log(`    BLIND — ${r.blind} mutating call(s) with no observation in front`);
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
const everyCall = [];
for (const file of files) {
  const raw = await readFile(file, 'utf8').catch(() => '');
  const parsed = raw
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
  parsed.forEach((call, index) => {
    everyCall.push({ ...call, next: parsed[index + 1]?.action ?? null });
  });
}

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
  console.log(
    `\nacross ${total.length} runs: ${calls} calls, ${refused} refused (${Math.round((refused / Math.max(calls, 1)) * 100)}%), ` +
      `${total.reduce((n, r) => n + r.repeated.length, 0)} repeated, ${total.reduce((n, r) => n + r.deadEnds, 0)} dead ends`,
  );
}
