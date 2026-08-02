#!/usr/bin/env node
// A ruler for observation rendering.
//
// Observation is 43% of every Computer Use call a model makes, and it is the
// single largest thing the tool surface spends. Every proposal to spend less of
// it — collapse more containers, drop frames, shorten values, filter by default
// — has so far been argued rather than measured, because the only way to see
// what one costs was to run a real machine, once, unrepeatably.
//
// Recorded trajectories make it an offline question. `MAKA_CU_DEBUG_LOG` keeps
// each call's arguments verbatim and each result untruncated, so a trace holds
// both halves of what this needs: the full rendered tree an `observe` returned,
// and — in the calls that quote its `observation_id` back — which element of
// that tree the model went on to operate. Rendering the same tree a different
// way and asking whether the element it used is still findable is then a
// measurement, and it is repeatable, and it can run in CI.
//
//   node scripts/cu-prune-eval.mjs                        # /tmp/cu-desktop-scenarios
//   node scripts/cu-prune-eval.mjs /path/to/*.trace.jsonl
//   node scripts/cu-prune-eval.mjs --json report.json
//
// ---------------------------------------------------------------------------
// The warning that comes with the number
// ---------------------------------------------------------------------------
//
// From the team that built the same instrument for `unify-computer-use`, in
// their words: "An offline metric can falsify, never establish. Any pruning
// scheme must be run against a real chain before it ships."
//
// They also left the two traps this file is written around.
//
//  1. Retention is NOT judged by `element_id`. Collapsing renumbers nothing
//     today, but any scheme that did would score a perfect 100% while breaking
//     every reference. Presence is judged on `role` + `label` — what a model
//     actually reads a line by — because that is the question being asked.
//
//  2. Retention has a blind spot, and the blind spot is where it went wrong for
//     them: they measured 100% retention offline and watched the real chain
//     break anyway. The operated element was still in the tree. It was an
//     unnamed control, so the only way to point at it was through the name of
//     the container above it, and the container had been pruned. So this
//     reports a second number beside retention — whether the nearest NAMED
//     ancestor of the operated element also survived — and a scheme that keeps
//     the target while losing that is a scheme that fails in the field with a
//     clean scorecard.
//
// ---------------------------------------------------------------------------
// Why the strategies are not implemented here
// ---------------------------------------------------------------------------
//
// The same team reversed their own conclusion twice, both times because the
// evaluator carried a hand-written copy of the policy it was evaluating: once a
// suffix match was copied as an exact-set match and scored the control group at
// 0% retention, once a parser split a two-word role in half. So no policy is
// written in this file. `renderObservationText` from `@maka/runtime` is called
// with different options, and the options live next to the rule they change.
//
// The one thing this file does own is the reverse direction: a trace stores the
// rendered TEXT, not the element array behind it, so the text has to be read
// back into elements before it can be rendered again. That parser is the weak
// point, and it is gated rather than trusted — every observation is re-rendered
// from what was parsed and compared byte-for-byte against what was stored, and
// an observation that does not reproduce exactly is excluded from every number
// and counted in the report. Lines that do not parse at all are counted too.
// Nothing is skipped quietly.

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { estimateTokens } from '../packages/runtime/dist/context-budget-helpers.js';
import {
  elementLine,
  renderObservationText,
  splitMenu,
  walk,
} from '../packages/runtime/dist/computer-use-observation-text.js';

const DEFAULT_TRACE_DIR = '/tmp/cu-desktop-scenarios';

/** Matches the renderer's own cap, so the value-length arithmetic lines up. */
const RENDERED_VALUE_CAP = 256;

// ---------------------------------------------------------------------------
// Reading a rendered observation back into elements
// ---------------------------------------------------------------------------

/**
 * Read one JSON string starting at `from`, returning its value and end index.
 *
 * Labels are written with `JSON.stringify`, so a label may contain a quote, a
 * backslash or a newline. Splitting the line on `"` — or on whitespace — turns
 * one element into two, which is the failure mode that produced a wrong answer
 * the last time somebody built this.
 */
function readQuoted(text, from) {
  if (text[from] !== '"') return null;
  let index = from + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') {
      const raw = text.slice(from, index + 1);
      try {
        return { value: JSON.parse(raw), end: index + 1 };
      } catch {
        return null;
      }
    }
    index += 1;
  }
  return null;
}

/**
 * Undo the renderer's value truncation well enough to render it again.
 *
 * The dropped characters are gone — the trace holds what the model saw, not
 * what the field held. What is recoverable is the LENGTH, which the renderer
 * reports inline as `…(+N chars)`, and length is all that both the re-render
 * gate and the shorter-cap arithmetic need. Padding restores it. The padding is
 * never shown: re-rendering cuts it back off at exactly the same point.
 */
function unpad(text) {
  const marker = /…\(\+(\d+) chars\)$/.exec(text);
  if (!marker) return { text, renderedLength: text.length, truncated: false };
  const head = text.slice(0, marker.index);
  if (head.length !== RENDERED_VALUE_CAP)
    return { text, renderedLength: text.length, truncated: false };
  const dropped = Number(marker[1]);
  return {
    text: head + 'x'.repeat(dropped),
    renderedLength: text.length,
    truncated: true,
  };
}

/**
 * One `elementLine` read backwards.
 *
 * The grammar is fixed and positional:
 *
 *     <tabs><id> <role[/subrole]> ["label"] [="value"] [~"placeholder"]
 *           [[states]] [+actions] [@x,y wxh]
 *
 * Consumption is strict and total: a trailing character this does not
 * understand fails the line rather than being ignored, because a silently
 * dropped field is a silently wrong measurement.
 */
function parseElementLine(raw) {
  let depth = 0;
  while (raw[depth] === '\t') depth += 1;
  const text = raw.slice(depth);
  const head = /^(\S+) (\S+)/.exec(text);
  if (!head) return null;
  const roleToken = head[2];
  const slash = roleToken.indexOf('/');
  const element = {
    elementId: head[1],
    role: slash < 0 ? roleToken : roleToken.slice(0, slash),
  };
  // `roleOf` prints the subrole with its `AX` prefix stripped. Restoring the
  // prefix makes the round trip exact — it strips it again on the way out —
  // and every AX subrole carries one.
  if (slash >= 0) element.subrole = `AX${roleToken.slice(slash + 1)}`;

  let index = head[0].length;
  let renderedValueLength;
  while (index < text.length) {
    if (text[index] !== ' ') return null;
    index += 1;
    const char = text[index];
    if (char === '"' && element.label === undefined && element.value === undefined) {
      const quoted = readQuoted(text, index);
      if (!quoted) return null;
      element.label = quoted.value;
      index = quoted.end;
      continue;
    }
    if (char === '=' && text[index + 1] === '"') {
      const quoted = readQuoted(text, index + 1);
      if (!quoted) return null;
      const restored = unpad(quoted.value);
      element.value = restored.text;
      renderedValueLength = restored.renderedLength;
      index = quoted.end;
      continue;
    }
    if (char === '~' && text[index + 1] === '"') {
      const quoted = readQuoted(text, index + 1);
      if (!quoted) return null;
      element.placeholder = unpad(quoted.value).text;
      index = quoted.end;
      continue;
    }
    if (char === '[') {
      const close = text.indexOf(']', index);
      if (close < 0) return null;
      for (const state of text.slice(index + 1, close).split(',')) {
        if (state === 'disabled') element.enabled = false;
        else if (state === 'selected') element.selected = true;
        else if (state === 'focused') element.focused = true;
        else return null;
      }
      index = close + 1;
      continue;
    }
    if (char === '+') {
      let end = text.indexOf(' ', index);
      if (end < 0) end = text.length;
      element.actions = text.slice(index + 1, end).split(',');
      index = end;
      continue;
    }
    if (char === '@') {
      const frame = /^@(-?\d+),(-?\d+) (-?\d+)x(-?\d+)$/.exec(text.slice(index));
      if (!frame) return null;
      element.frame = {
        x: Number(frame[1]),
        y: Number(frame[2]),
        width: Number(frame[3]),
        height: Number(frame[4]),
      };
      index = text.length;
      continue;
    }
    return null;
  }
  return { element, depth, renderedValueLength };
}

/** Attach parents from indentation. The renderer's depth IS the parent link. */
function link(parsed) {
  const stack = [];
  const elements = [];
  for (const { element, depth } of parsed) {
    stack.length = depth;
    const parent = stack[depth - 1];
    if (parent !== undefined) element.parentElementId = parent;
    stack[depth] = element.elementId;
    elements.push(element);
  }
  return elements;
}

function parseHeader(line) {
  const observation = {};
  const idFrom = (key) => {
    const match = new RegExp(`(?:^| )${key}=(\\S+?)(?: |$)`).exec(`${line} `);
    return match ? match[1] : undefined;
  };
  observation.observationId = idFrom('observation_id');
  observation.appId = idFrom('app');
  observation.pid = Number(idFrom('pid'));
  observation.windowId = Number(idFrom('window_id'));
  const titleAt = line.indexOf(' window="');
  if (titleAt >= 0) {
    const quoted = readQuoted(line, titleAt + ' window='.length);
    if (quoted) observation.windowTitle = quoted.value;
  }
  if (/ truncated=true\(/.test(line)) observation.truncated = true;
  const query = / query="/.test(line);
  const shown = /showing (\d+) of (\d+)/.exec(line);
  return {
    observation,
    queried: query,
    shownOf: shown ? { shown: Number(shown[1]), of: Number(shown[2]) } : undefined,
  };
}

function parseMenuCaption(line) {
  const menu = {};
  const opened = /(?:^| )opened=("(?:[^"\\]|\\.)*")/.exec(line);
  if (opened) {
    try {
      menu.opened = JSON.parse(opened[1]);
    } catch {
      /* the caption is regenerated by the renderer either way */
    }
  }
  if (/ truncated=true\(/.test(line)) menu.truncated = true;
  return menu;
}

/**
 * A whole rendered observation, read back.
 *
 * Returns the reconstructed observation plus everything needed to judge it:
 * which lines refused to parse, and whether re-rendering the parsed elements
 * reproduces the stored body exactly.
 */
export function parseObservationText(text) {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('observation_id=')) return { ok: false, reason: 'no-header' };
  const { observation, queried, shownOf } = parseHeader(first);

  const unparsed = [];
  const windowRaw = [];
  const menuRaw = [];
  let menuCaption;
  let target = windowRaw;
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    if (line.startsWith('menu_bar=')) {
      menuCaption = line;
      target = menuRaw;
      continue;
    }
    const parsed = parseElementLine(line);
    if (!parsed) {
      unparsed.push(line);
      continue;
    }
    target.push({ ...parsed, raw: line });
  }

  const windowElements = link(windowRaw);
  const menuElements = link(menuRaw);
  observation.elements = [...windowElements, ...menuElements];
  if (menuCaption) observation.menu = parseMenuCaption(menuCaption);
  // The tree in the text is already filtered; re-applying the query would be
  // rendering a filter over a filtered tree. The header loses its `query=`
  // clause as a result, which is noted in the report and identical across every
  // strategy, so it cannot move a ratio.
  observation.query = undefined;

  // The gate. Re-render exactly what was parsed, with no policy applied at all,
  // and require the element lines back byte-for-byte.
  const split = splitMenu(observation.elements);
  const rerendered = [
    ...walk(split.window).map(([element]) => elementLine(element)),
    ...walk(split.menu).map(([element]) => elementLine(element)),
  ];
  const stored = [...windowRaw, ...menuRaw].map((entry) => entry.raw.replace(/^\t+/, ''));
  const faithful =
    unparsed.length === 0 &&
    rerendered.length === stored.length &&
    rerendered.every((line, at) => line === stored[at]);

  return {
    ok: true,
    observation,
    queried,
    shownOf,
    unparsed,
    faithful,
    firstDivergence: faithful
      ? undefined
      : {
          stored: stored.find((line, at) => line !== rerendered[at]),
          rerendered: rerendered.find((line, at) => line !== stored[at]),
        },
    renderedValueLengths: [...windowRaw, ...menuRaw]
      .map((entry) => entry.renderedValueLength)
      .filter((length) => length !== undefined),
    frameChars: [...windowRaw, ...menuRaw].reduce((sum, entry) => {
      const frame = / @-?\d+,-?\d+ -?\d+x-?\d+$/.exec(entry.raw);
      return sum + (frame ? frame[0].length : 0);
    }, 0),
    storedText: text,
  };
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * Deliberately includes two schemes nobody intends to ship.
 *
 * `drop-unnamed-leaves` is the naive prune that earlier research rejected after
 * counting 1,023 unnamed but operable elements across ten applications.
 * `keep-interactive-only` is the tempting one: keep the controls, drop the
 * scaffolding. They are here as negative controls, and they are not the same
 * control — the first breaks retention, the second breaks the thing retention
 * cannot see, which is whether an unnamed target still has a named container to
 * be described by. A metric that cannot fail is not measuring; each of these
 * exists to make one of the two numbers move.
 */
const INTERACTIVE_ROLES = new Set([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXTextField',
  'AXTextArea',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXMenuBar',
  'AXPopUpButton',
  'AXSlider',
  'AXRow',
  'AXCell',
  'AXWindow',
]);

const STRATEGIES = [
  {
    // The baseline is the strict form, which is what shipped before the
    // relaxed one was measured. It has to be asked for explicitly now, or the
    // baseline and the candidate would be the same renderer and every saving
    // would read as zero.
    name: 'single-child-only (previous default)',
    what: 'collapse structural containers holding exactly one child',
    render: (observation) => renderObservationText(observation, { multiChildWrappers: false }),
  },
  {
    name: 'current: collapse-multi-child',
    what: 'shipped: collapse structural containers holding one child OR MORE',
    render: (observation) => renderObservationText(observation),
  },
  {
    name: 'drop-unnamed-leaves (control)',
    control: true,
    what: 'NEGATIVE CONTROL — drop every childless element with no label and no value',
    render: (observation) => {
      const parents = new Set();
      for (const element of observation.elements) {
        if (element.parentElementId !== undefined) parents.add(element.parentElementId);
      }
      const kept = observation.elements.filter(
        (element) =>
          parents.has(element.elementId) ||
          (element.label ?? '') !== '' ||
          element.value !== undefined,
      );
      return renderObservationText({ ...observation, elements: kept });
    },
  },
  {
    name: 'keep-interactive-only (control)',
    control: true,
    what: 'NEGATIVE CONTROL — keep only recognised control roles, drop the containers around them',
    render: (observation) => {
      const kept = observation.elements.filter((element) => INTERACTIVE_ROLES.has(element.role));
      return renderObservationText({ ...observation, elements: kept });
    },
  },
];

/** The first strategy is the yardstick every other one is read against. */
const BASELINE = STRATEGIES[0].name;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** How a model points at a line: what it is, and what it is called. */
function signature(element) {
  return `${element.role} ${element.label ?? ''}`;
}

/** The signatures a rendered text actually offers, and how many of each. */
function offered(text) {
  const counts = new Map();
  for (const line of text.split('\n').slice(1)) {
    if (line === '' || line.startsWith('menu_bar=')) continue;
    const parsed = parseElementLine(line);
    if (!parsed) continue;
    const key = signature(parsed.element);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The nearest ancestor carrying a name.
 *
 * This is the blind spot made visible. An unnamed control is reachable in
 * prose only as "the one inside <named thing>", so if the named thing goes, the
 * target is present and unusable — which is exactly the outcome a 100%
 * retention score hid once already.
 */
function namedAncestor(element, byId) {
  let parent = element.parentElementId;
  for (let hops = 0; parent !== undefined && hops < 32; hops += 1) {
    const node = byId.get(parent);
    if (!node) return undefined;
    if ((node.label ?? '') !== '') return node;
    parent = node.parentElementId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function traceFiles(args) {
  // `--json <path>` names a file to write, not a trace to read. Taking the
  // value as a trace made the tool try to read its own output.
  const explicit = args.filter((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--json');
  if (explicit.length > 0) return explicit.map((path) => resolve(path));
  let entries;
  try {
    entries = readdirSync(DEFAULT_TRACE_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.trace.jsonl'))
    .map((name) => join(DEFAULT_TRACE_DIR, name))
    .filter((path) => statSync(path).isFile());
}

export async function loadCorpus(files) {
  const observations = [];
  const uses = [];
  const skipped = {
    badJson: 0,
    observeWithoutText: 0,
    noHeader: 0,
    unfaithful: 0,
    unparsedLines: 0,
  };
  const unfaithfulSamples = [];

  for (const file of files) {
    const scenario = basename(file).replace(/\.trace\.jsonl$/, '');
    const raw = await readFile(file, 'utf8');
    const byObservationId = new Map();
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        skipped.badJson += 1;
        continue;
      }
      if (record.kind !== 'call') continue;
      const args = record.rawArgs ?? record.modelFacingArgs ?? {};
      if (args.action === 'observe') {
        const text = record.resultModelText ?? '';
        if (typeof text !== 'string' || text === '') {
          // A refused or timed-out observe has no rendering to measure.
          skipped.observeWithoutText += 1;
          continue;
        }
        const parsed = parseObservationText(text);
        if (!parsed.ok) {
          skipped.noHeader += 1;
          continue;
        }
        skipped.unparsedLines += parsed.unparsed.length;
        if (!parsed.faithful) {
          skipped.unfaithful += 1;
          if (unfaithfulSamples.length < 5) {
            unfaithfulSamples.push({
              scenario,
              ...parsed.firstDivergence,
              unparsed: parsed.unparsed.slice(0, 2),
            });
          }
          continue;
        }
        const entry = { scenario, file, ...parsed, uses: [] };
        observations.push(entry);
        byObservationId.set(parsed.observation.observationId, entry);
        continue;
      }
      // An action quoting an observation_id says which element of that tree the
      // model went on to operate. That is the ground truth for retention, and
      // it is in the same file as the tree.
      const observationId = args.observation_id;
      if (typeof observationId !== 'string') continue;
      const owner = byObservationId.get(observationId);
      if (!owner) continue;
      const byId = new Map(
        owner.observation.elements.map((element) => [element.elementId, element]),
      );
      const push = (elementId, how) => {
        const element = byId.get(String(elementId));
        if (!element) return;
        const use = { action: args.action, how, element, ancestor: namedAncestor(element, byId) };
        owner.uses.push(use);
        uses.push(use);
      };
      if (args.element_id !== undefined) push(args.element_id, 'element_id');
      if (Array.isArray(args.steps)) {
        for (const step of args.steps) {
          if (step && step.element_id !== undefined) push(step.element_id, 'element_sequence');
        }
      }
    }
  }
  return { observations, uses, skipped, unfaithfulSamples };
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

function appOf(observation) {
  return observation.observation.appId ?? 'unknown';
}

function blankTally() {
  return {
    observations: 0,
    baselineTokens: 0,
    storedTokens: 0,
    recordedBeforeCollapse: 0,
    tokens: new Map(),
    uses: 0,
    retained: new Map(),
    ancestorKept: new Map(),
    ambiguous: new Map(),
    unnamedTargets: 0,
    noNamedAncestor: 0,
  };
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

export function measure(corpus) {
  const overall = blankTally();
  const perApp = new Map();
  const valueLengths = [];
  let frameChars = 0;

  for (const entry of corpus.observations) {
    const app = appOf(entry);
    if (!perApp.has(app)) perApp.set(app, blankTally());
    const tallies = [overall, perApp.get(app)];
    for (const tally of tallies) tally.observations += 1;
    valueLengths.push(...entry.renderedValueLengths);
    frameChars += entry.frameChars;

    const rendered = new Map();
    for (const strategy of STRATEGIES) {
      const text = strategy.render(entry.observation);
      rendered.set(strategy.name, text);
      const tokens = estimateTokens(text.length);
      for (const tally of tallies) bump(tally.tokens, strategy.name, tokens);
    }
    const baseline = estimateTokens(rendered.get(BASELINE).length);
    // The corpus spans several days of renderer changes: some observations were
    // recorded before the shipped single-child collapse existed, and their
    // stored text is longer than what the same tree renders as today. Comparing
    // strategies to a re-render rather than to the stored text is what keeps
    // that from being read as a saving; the difference is reported separately
    // as the shipped collapse's own measured value.
    for (const tally of tallies) {
      tally.baselineTokens += baseline;
      tally.storedTokens += estimateTokens(entry.storedText.length);
      if (entry.storedText.split('\n').length > rendered.get(BASELINE).split('\n').length) {
        tally.recordedBeforeCollapse += 1;
      }
    }

    const offers = new Map(
      STRATEGIES.map((strategy) => [strategy.name, offered(rendered.get(strategy.name))]),
    );
    for (const use of entry.uses) {
      for (const tally of tallies) {
        tally.uses += 1;
        if ((use.element.label ?? '') === '') tally.unnamedTargets += 1;
        if (!use.ancestor) tally.noNamedAncestor += 1;
      }
      for (const strategy of STRATEGIES) {
        const counts = offers.get(strategy.name);
        const found = counts.get(signature(use.element)) ?? 0;
        for (const tally of tallies) {
          if (found > 0) bump(tally.retained, strategy.name);
          if (found > 1) bump(tally.ambiguous, strategy.name);
          // No named ancestor is not a failure of the strategy — it is a
          // target that needs no context. Counted separately, above.
          if (!use.ancestor || (counts.get(signature(use.ancestor)) ?? 0) > 0) {
            bump(tally.ancestorKept, strategy.name);
          }
        }
      }
    }
  }

  return { overall, perApp, valueLengths, frameChars };
}

/**
 * What a shorter value cap would have saved, arithmetically.
 *
 * Not a rendered strategy: nothing here changes what the renderer does, so
 * there is nothing to score for retention. It is the one number the corpus can
 * answer on its own — every rendered value's length is in the text, and the
 * ones already cut announce by how much.
 */
function valueCapSavings(valueLengths, cap) {
  const marker = (dropped) => `…(+${dropped} chars)`.length;
  let saved = 0;
  for (const length of valueLengths) {
    if (length <= cap) continue;
    // A value already carrying a truncation marker is measured by what is
    // printed, which is what the model paid for.
    saved += length - cap - marker(length - cap);
  }
  return Math.max(0, saved);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function percent(part, whole) {
  if (whole === 0) return '   n/a';
  return `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

function reportTally(label, tally, lines) {
  lines.push(
    `${label}  (${tally.observations} observations, ${tally.uses} operated elements, ${tally.unnamedTargets} of them unnamed)`,
  );
  lines.push(
    '  strategy                          tokens   vs current   retention   named-ancestor   ambiguous',
  );
  for (const strategy of STRATEGIES) {
    const tokens = tally.tokens.get(strategy.name) ?? 0;
    const ratio = tally.baselineTokens === 0 ? 1 : tokens / tally.baselineTokens;
    lines.push(
      [
        `  ${strategy.name.padEnd(32)}`,
        String(tokens).padStart(7),
        `${(ratio * 100).toFixed(1).padStart(10)}%`,
        percent(tally.retained.get(strategy.name) ?? 0, tally.uses).padStart(12),
        percent(tally.ancestorKept.get(strategy.name) ?? 0, tally.uses).padStart(17),
        String(tally.ambiguous.get(strategy.name) ?? 0).padStart(11),
      ].join(''),
    );
  }
  if (tally.recordedBeforeCollapse > 0) {
    lines.push(
      `  (${tally.recordedBeforeCollapse} of these were recorded before the shipped collapse landed; ` +
        `as stored they were ${tally.storedTokens} tokens, so the shipped collapse is already worth ` +
        `${(((tally.storedTokens - tally.baselineTokens) / tally.storedTokens) * 100).toFixed(1)}% here)`,
    );
  }
  lines.push('');
}

async function main() {
  const args = process.argv.slice(2);
  const files = traceFiles(args);
  if (files.length === 0) {
    console.error(`no traces found. pass paths, or record into ${DEFAULT_TRACE_DIR}`);
    process.exit(2);
  }
  const corpus = await loadCorpus(files);
  const { overall, perApp, valueLengths, frameChars } = measure(corpus);

  const lines = [];
  lines.push(
    `corpus: ${files.length} trace files, ${corpus.observations.length} usable observations`,
  );
  lines.push(
    `dropped: ${corpus.skipped.observeWithoutText} observes with no rendering (refused/timed out), ` +
      `${corpus.skipped.noHeader} without a header, ${corpus.skipped.unfaithful} that did not re-render byte-identically, ` +
      `${corpus.skipped.unparsedLines} unparsed element lines, ${corpus.skipped.badJson} unreadable json lines`,
  );
  lines.push('');
  reportTally('ALL APPS', overall, lines);
  for (const [app, tally] of [...perApp.entries()].sort(
    (a, b) => b[1].tokens.get(BASELINE) - a[1].tokens.get(BASELINE),
  )) {
    reportTally(app, tally, lines);
  }

  lines.push('arithmetic on the same corpus (not rendered strategies, nothing to retain):');
  const currentTokens = overall.tokens.get(BASELINE) ?? 1;
  lines.push(
    `  element frames (@x,y wxh)   ${estimateTokens(frameChars)} tokens, ` +
      `${((estimateTokens(frameChars) / currentTokens) * 100).toFixed(1)}% of the current rendering`,
  );
  for (const cap of [128, 96, 64]) {
    const saved = estimateTokens(valueCapSavings(valueLengths, cap));
    lines.push(
      `  value cap ${String(cap).padStart(3)} (now ${RENDERED_VALUE_CAP})    ${saved} tokens, ` +
        `${((saved / currentTokens) * 100).toFixed(1)}% of the current rendering`,
    );
  }
  lines.push('');
  lines.push('offline metrics can falsify a rendering change, never establish one.');
  lines.push('run the real chain before shipping any of this.');

  if (corpus.unfaithfulSamples.length > 0) {
    lines.push('');
    lines.push('observations excluded for not re-rendering identically:');
    for (const sample of corpus.unfaithfulSamples) {
      lines.push(`  ${sample.scenario}`);
      if (sample.stored) lines.push(`    stored: ${sample.stored.slice(0, 160)}`);
      if (sample.rerendered) lines.push(`    ours  : ${sample.rerendered.slice(0, 160)}`);
      for (const line of sample.unparsed ?? []) lines.push(`    unparsed: ${line.slice(0, 160)}`);
    }
  }

  const text = lines.join('\n');
  console.log(text);

  const jsonAt = args.indexOf('--json');
  if (jsonAt >= 0 && args[jsonAt + 1]) {
    await writeFile(
      args[jsonAt + 1],
      `${JSON.stringify(
        {
          files: files.length,
          observations: corpus.observations.length,
          skipped: corpus.skipped,
          strategies: STRATEGIES.map((strategy) => ({
            name: strategy.name,
            what: strategy.what,
            control: strategy.control === true,
            tokens: overall.tokens.get(strategy.name),
            tokenRatio: (overall.tokens.get(strategy.name) ?? 0) / (overall.baselineTokens || 1),
            retention: (overall.retained.get(strategy.name) ?? 0) / (overall.uses || 1),
            namedAncestorKept: (overall.ancestorKept.get(strategy.name) ?? 0) / (overall.uses || 1),
          })),
          perApp: Object.fromEntries(
            [...perApp.entries()].map(([app, tally]) => [
              app,
              {
                observations: tally.observations,
                uses: tally.uses,
                tokens: Object.fromEntries(tally.tokens),
                retention: Object.fromEntries(
                  [...tally.retained.entries()].map(([name, kept]) => [
                    name,
                    kept / (tally.uses || 1),
                  ]),
                ),
              },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { STRATEGIES, signature, offered, namedAncestor, parseElementLine, valueCapSavings };
