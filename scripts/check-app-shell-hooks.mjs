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

/**
 * Convergence gate for #4109: which hooks are still called in the render bodies
 * of the shell components that sit above the whole tree.
 *
 * In React the position in the tree IS the scope of the state. A hook called in
 * the shell's render body has the whole tree as its scope; the same hook called
 * in a provider has its readers as its scope. `AppShellContent` today carries
 * 536 hooks above the entire tree, so a session switch produces ~19 commits,
 * ~14 of them full-tree renders, of which 96-99% is recoverable work.
 *
 * The fix is to move call sites, one feature at a time. That is slow, and a
 * checklist cannot tell whether it is progressing — extracting a feature into
 * its own slice does not change the scope of any state, and Session Navigation
 * proves it: a complete `model / controller / ui / ports` slice whose
 * controller is still invoked from this render body.
 *
 * A call site does have a definition of done, so this gate counts them. The
 * inventory below is EXACT, not a ceiling: growing past an entry fails, and so
 * does falling below one. Only failing on growth would let the counts drift
 * quietly downward and record no progress, which is the one thing this gate
 * exists to make visible. The cost is real — a change that removes an effect
 * has to edit this file — and that edit IS the record.
 *
 * Deliberately NOT a `--write` mode. Regenerating the inventory on demand would
 * let a new hook be accepted by rerunning a command, and the friction of
 * editing it by hand is the point. This is the opposite shape from
 * `check-astryx-surface-inventory.mjs`, whose invariant is "regenerate and
 * compare bytes, never a hand-written list". That is right for an inventory
 * that only has to describe the tree; this one has to RESIST it.
 *
 * Two shapes of migration, because the failure message cannot tell them apart:
 * when nothing in the shell body reads the feature, the call site moves into a
 * provider and React bails out of `children` (the mention catalog, #4109) — the
 * entry disappears. When the shell body DOES read it, moving the call site
 * still leaves a selector read behind, and the honest outcome is a smaller
 * entry rather than none. "Call it from the provider" is not advice to follow
 * blindly: cross-feature intent the shell issues must stay an explicit command,
 * never an implicit subscription bought to lower a number.
 *
 * The count is unweighted, so it measures migration progress and not render
 * cost: a subscription that fires five times per session switch and a hook that
 * runs once at mount both count as one. Falling counts do not by themselves
 * demonstrate a faster switch.
 *
 * Both `AppShell` and `AppShellContent` are counted. `AppShell` wraps the
 * content in the root providers, so a hook hoisted one level up has if anything
 * a WIDER scope — an inventory that watched only the inner component would
 * accept that move as progress.
 *
 * The counting is textual, because TypeScript 7 exposes no stable parser to
 * JavaScript (only `typescript/unstable/*`), and a gate that goes red whenever
 * a dependency moves is its own kind of noise. Textual counting is therefore
 * written to fail closed: `stripNonCode` blanks comments, strings and regex
 * literals in place, the body is delimited by brace balancing over that blanked
 * text rather than by a `\n}\n` guess, and a hook name is only counted where a
 * call actually follows it — including through an explicit type argument, which
 * an earlier version of this gate silently skipped over.
 *
 * Purely derived hooks (`useMemo`, `useCallback`, `useRef`, `useId`) are
 * ignored: they hold no state and subscribe to nothing, so they cannot widen
 * the scope of a render. Everything else counts, including React's own
 * `useState` / `useEffect`, because a custom hook is only a name for them.
 *
 * Run: npm run check:app-shell-hooks
 * Fix: move the call site into the feature's provider, then delete its entry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const shellFile = 'apps/desktop/src/renderer/app-shell.tsx';

/** Hooks that hold no state and subscribe to nothing. */
const DERIVED_HOOKS = new Set(['useMemo', 'useCallback', 'useRef', 'useId']);

/**
 * Hooks still called in each shell component's render body, with the number of
 * call sites. This inventory may only shrink. Each entry is one scope that is
 * still the whole tree rather than its readers.
 */
export const ALLOWED = {
  AppShell: {
    useState: 2,
    useSystemUiLocale: 1,
  },
  AppShellContent: {
    useActiveExecutionBoundary: 1,
    useActiveSessionEvents: 1,
    useAppShellBootstrapSubscriptions: 1,
    useAppShellComposerQuotes: 1,
    useAppShellHostEffects: 1,
    useAppShellNavRefSync: 1,
    useAppShellPersistenceEffects: 1,
    useAppShellProjectContext: 1,
    useAppShellSessionUiReads: 1,
    useAppShellSessionWorkspace: 1,
    useAppShellTurnPresentation: 1,
    useCommandPalette: 1,
    useComposerAttachments: 1,
    useEffect: 14,
    useGoalController: 1,
    useKeyboardHelp: 1,
    useLayoutEffect: 2,
    useModuleHubController: 1,
    useNewTaskChoice: 1,
    useOnboardingSnapshot: 1,
    usePlanModeState: 1,
    useSessionEventHealthPolling: 1,
    // Replaces `useSessionNavigationController`, which is now called inside
    // `SessionNavigationProvider`. The entry shrinks rather than disappearing,
    // because the shell body does read the rail: the command palette lists the
    // same visible sessions, the titlebar shows the linked parent, and the
    // frame publishes the rail's width as `--maka-sidenav-width`. What is left
    // holds nothing — three `useMemo`s over the catalog the shell already reads
    // and one subscription to the rail's geometry — where the controller it
    // replaces put three `useState`, four effects and a `useStableActions`
    // facade on this fiber.
    useSessionNavigationReads: 1,
    useSessionCollaborationDialog: 1,
    useSessionSettingIntent: 2,
    useSettingsModal: 1,
    useShellAppearance: 1,
    useShellChatModel: 1,
    useShellConnections: 3,
    useShellLiveTurn: 1,
    useShellMemoryPill: 1,
    useShellResume: 1,
    useShellRunUpdates: 1,
    useShellSearch: 1,
    useStableActions: 7,
    useState: 15,
    useTaskEntryController: 1,
    useTaskSubmissionReadiness: 1,
    useToast: 1,
    // The last of the three `useKeyedPendingRegistry` call sites this entry
    // replaces: #4113 moved the other two onto the session UI store, which is
    // already an external store, so their scope left this fiber entirely. This
    // one stays because the shell body reads `keys` to build the turn footer's
    // disabled mask.
    useTurnActionRegistry: 1,
    useWorkbarController: 1,
  },
};

/**
 * After these, a `/` opens a regex literal; anywhere else it is division.
 *
 * `<` and `>` are deliberately absent. They would qualify in expression
 * position, but in TSX they are far more often a tag: treating the `/` of
 * `</div>` as the start of a regex swallows everything up to the next slash,
 * which is exactly the silent under-count this gate must not have.
 */
const REGEX_MAY_FOLLOW = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '\n',
]);

/**
 * Blanks comments, string bodies and regex literals, replacing each with spaces
 * so that offsets and line numbers still line up with the original.
 *
 * Prose naming a hook is not a call site, and the shell's comments name hooks
 * at length. The two cases worth spelling out are the ones that break a naive
 * scanner: an apostrophe in JSX text (`<span>don't</span>`) is not a string
 * delimiter, and a regex literal may contain quotes (`/['"]/`) that would
 * otherwise swallow the rest of the file. Both would UNDER-count, which is the
 * dangerous direction for a gate whose only product is a number.
 */
export function stripNonCode(source) {
  const out = [...source];
  let index = 0;
  let lastMeaningful = '\n';
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && REGEX_MAY_FOLLOW.has(lastMeaningful)) {
      let scan = index + 1;
      let inClass = false;
      while (scan < source.length) {
        const c = source[scan];
        if (c === '\\') scan += 2;
        else if (c === '[') (inClass = true), (scan += 1);
        else if (c === ']') (inClass = false), (scan += 1);
        else if (c === '\n') break;
        else if (c === '/' && !inClass) break;
        else scan += 1;
      }
      // An unterminated candidate was division after all; leave it alone.
      if (scan < source.length && source[scan] === '/') {
        blank(index, scan + 1);
        lastMeaningful = '/';
        index = scan + 1;
        continue;
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      // In JSX text an apostrophe follows a word or a closing bracket, and no
      // JavaScript expression can put a string literal there.
      if (char === "'" && /[A-Za-z0-9_$>)\]}]/.test(lastMeaningful)) {
        lastMeaningful = char;
        index += 1;
        continue;
      }
      let scan = index + 1;
      while (scan < source.length && source[scan] !== char) {
        scan += source[scan] === '\\' ? 2 : 1;
      }
      blank(index + 1, scan);
      lastMeaningful = char;
      index = Math.min(scan + 1, source.length);
      continue;
    }
    if (!/\s/.test(char) || char === '\n') lastMeaningful = char;
    index += 1;
  }
  return out.join('');
}

/**
 * The body of a top-level component, delimited by brace balancing over text
 * whose strings and comments are already blanked. A `\n}\n` guess would stop at
 * the first brace that formatting happened to put in column zero.
 */
export function findComponentBody(blanked, name) {
  const declaration = new RegExp(
    String.raw`^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+${name}\b|^(?:export\s+)?(?:default\s+)?const\s+${name}\s*(?::[^=]+)?=`,
    'm',
  );
  const match = declaration.exec(blanked);
  if (match === null) return null;
  // Skip the parameter list. `function AppShellContent({ ... })` opens a brace
  // for its destructured parameter, and balancing from there returns the
  // parameter object rather than the body.
  const paren = blanked.indexOf('(', match.index);
  if (paren === -1) return null;
  let parens = 0;
  let afterParams = -1;
  for (let i = paren; i < blanked.length; i += 1) {
    if (blanked[i] === '(') parens += 1;
    else if (blanked[i] === ')') {
      parens -= 1;
      if (parens === 0) {
        afterParams = i + 1;
        break;
      }
    }
  }
  if (afterParams === -1) return null;
  const open = blanked.indexOf('{', afterParams);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < blanked.length; i += 1) {
    if (blanked[i] === '{') depth += 1;
    else if (blanked[i] === '}') {
      depth -= 1;
      if (depth === 0) return blanked.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * `useX(`, `React.useX(`, `useX<T>(`, `useX\n  (` and the bare `use(` of React
 * 19 all call a hook; `ReturnType<typeof useX>` does not, and neither does
 * `shellCopy.useSkillPrompt(name)` — the shell really does call that one.
 *
 * That last case is why the qualifier is the literal `React.` and not any
 * identifier: a general `<name>.useX(` rule would count a locale copy function
 * as a hook. The narrow rule leaves one hole, `import * as X from 'react'`,
 * which `assertCountableReactImport` closes by failing rather than by guessing.
 */
// One level of nesting is enough for `useX<Record<string, number>>(...)`;
// deeper generics in a hook call do not occur here and would only cost a
// miscount in the safe direction (a failure, not a silent pass).
const TYPE_ARGUMENTS = String.raw`<(?:[^<>()]|<[^<>()]*>)*>`;
const HOOK_CALL = new RegExp(
  String.raw`(?<![.\w$])(?:React\.)?(use(?:[A-Z][A-Za-z0-9]*)?)(?=\s*(?:${TYPE_ARGUMENTS}\s*)?\()`,
  'g',
);

/**
 * A namespace import of React would let `X.useState(...)` past a scanner that
 * only knows the name `React`, and the whole point of this gate is that it
 * cannot be widened by accident. It has no way to resolve the alias, so it
 * refuses the file instead of under-counting it.
 */
export function assertCountableReactImport(source) {
  const namespaceImport = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]react['"]/.exec(
    source,
  );
  if (!namespaceImport) return null;
  return (
    `imports React as the namespace \`${namespaceImport[1]}\`.\n` +
    '  This gate counts hook calls textually and knows only the name `React`,\n' +
    '  so `' +
    namespaceImport[1] +
    '.useState(...)` would be invisible to it.\n' +
    '  Use named imports, or teach the scanner the alias.'
  );
}

export function countHooks(body) {
  const counts = {};
  for (const match of body.matchAll(HOOK_CALL)) {
    // `React.useState` is the same call site as `useState`, and the inventory
    // names the hook, not the syntax that reached it.
    const name = match[1];
    if (DERIVED_HOOKS.has(name)) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

export function compareToInventory(counts, allowed) {
  const added = [];
  const grown = [];
  const stale = [];
  for (const [name, count] of Object.entries(counts)) {
    const budget = allowed[name];
    if (budget === undefined) added.push(name);
    else if (count > budget) grown.push({ name, budget, count });
  }
  for (const [name, budget] of Object.entries(allowed)) {
    const count = counts[name] ?? 0;
    if (count < budget) stale.push({ name, budget, count });
  }
  return { added, grown, stale };
}

function main() {
  const source = readFileSync(join(root, shellFile), 'utf8');
  // Against the raw source: `stripNonCode` blanks the `'react'` specifier.
  const uncountableImport = assertCountableReactImport(source);
  if (uncountableImport) {
    console.error(`${shellFile}: ${uncountableImport}`);
    process.exit(1);
  }
  const blanked = stripNonCode(source);
  const failures = [];
  let hooks = 0;
  let callSites = 0;

  for (const [component, allowed] of Object.entries(ALLOWED)) {
    const body = findComponentBody(blanked, component);
    if (body === null) {
      console.error(`${shellFile}: could not find the render body of ${component}`);
      process.exit(1);
    }

    const counts = countHooks(body);
    hooks += Object.keys(counts).length;
    callSites += Object.values(counts).reduce((sum, n) => sum + n, 0);
    const { added, grown, stale } = compareToInventory(counts, allowed);

    for (const name of added) {
      failures.push(
        `${shellFile}: ${name} is a new hook in ${component}'s render body.\n` +
          '  Its state would be scoped to the whole tree. Call it from the feature\n' +
          '  provider instead; add it to the inventory only if it genuinely belongs\n' +
          '  to the shell, and say why in the pull request (#4109).',
      );
    }
    for (const { name, budget, count } of grown) {
      failures.push(
        `${shellFile}: ${name} has ${count} call sites in ${component}, inventory allows ${budget}.`,
      );
    }
    for (const { name, budget, count } of stale) {
      // Deliberately not phrased as an instruction to lower the number. A drop
      // is usually a migration, but it is also what a mis-count looks like, and
      // a gate that tells you to shrink its own inventory can be talked into
      // emptying itself.
      failures.push(
        `${shellFile}: ${name} has ${count} call sites in ${component}, inventory says ${budget}.\n` +
          '  If a migration moved it, update the entry in scripts/check-app-shell-hooks.mjs.\n' +
          '  If you did not move it, the gate is miscounting — fix the gate, not the number.',
      );
    }
  }

  if (failures.length === 0) {
    console.log(
      `app-shell hook scope: ok (${hooks} hooks, ${callSites} call sites across ${Object.keys(ALLOWED).join(' + ')})`,
    );
    return;
  }
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
