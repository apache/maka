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

// Local reproducible ablation: production source transforms run in memory only.
import { execFileSync, spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '../..');
const dir = resolve(
  root,
  process.env.MAKA_ABLATION_RESULTS ?? 'perf-results/pricing-ablation-20260930/reproduced',
);
const probes = process.env.MAKA_ABLATION_PROBES === '1';
const base = process.env.MAKA_ABLATION_TREE ?? '2f5459c0fd178790dee756f54316b56027f065c9';
const controller = 'apps/desktop/src/renderer/features/usage/controller/pricing-controller.ts';
const editor = 'apps/desktop/src/renderer/features/usage/ui/pricing-editor.tsx';
const viewModel = 'apps/desktop/src/renderer/features/usage/pricing-view-model.ts';
const client = 'apps/desktop/src/main/runtime-host-client.ts';
const protocol = 'packages/runtime-host/src/protocol/usage-pricing.ts';
const editorTest = 'apps/desktop/src/main/__tests__/pricing-editor.test.ts';
const clientTest = 'apps/desktop/src/main/__tests__/runtime-host-client-pricing.test.ts';
const paths = [controller, editor, viewModel, client, protocol, editorTest, clientTest];
const sources = Object.fromEntries(
  paths.map((p) => [
    p,
    execFileSync('git', ['show', `${base}:${p}`], { cwd: root, encoding: 'utf8' }),
  ]),
);
const once = (s, a, b) => {
  if (s.split(a).length !== 2) throw new Error(`[ABLATION INVALID] Expected one site: ${a}`);
  return s.replace(a, b);
};
const section = (s, a, b, replacement) => {
  const i = s.indexOf(a),
    j = s.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`[ABLATION INVALID] Missing section ${a}`);
  return s.slice(0, i) + replacement + s.slice(j);
};
const variants = [];
const add = (id, question, path, transform) =>
  variants.push({ id, question, changes: path ? { [path]: transform } : {} });
add('baseline', 'Unmodified merged control');
add('latest-cas-base', 'Can every save adopt the current list revision?', controller, (s) =>
  once(s, '    const base = mutationBase;', '    const base = snapshot;'),
);
add(
  'unpinned-validation',
  'Can an open editor validate against background-refreshed rows?',
  controller,
  (s) =>
    once(
      s,
      '  const editorSnapshot = mutationBase ?? snapshot;',
      '  const editorSnapshot = snapshot;',
    ),
);
add(
  'no-host-witness',
  'Can render lifecycle alone fence the pre-render Host event gap?',
  controller,
  (s) =>
    once(
      once(s, '      (target === null || target.isCurrent())', '      true'),
      '    if (writesBlocked || !base || !target?.isCurrent()) return;',
      '    if (writesBlocked || !base || !target) return;',
    ),
);
add(
  'no-lifecycle-fence',
  'Can the target witness alone handle StrictMode and view disposal?',
  controller,
  (s) => once(s, '      lifecycleRef.current === lifecycle &&', '      true &&'),
);
add(
  'no-mutation-read-fence',
  'May a refresh started before a mutation land afterward?',
  controller,
  (s) => {
    const start = s.indexOf('  function applyOutcome(');
    return s.slice(0, start) + once(s.slice(start), '    reloadTicketRef.current += 1;', '');
  },
);
add('no-read-order', 'Can same-generation refreshes share a ticket?', controller, (s) =>
  once(
    s,
    '    const ticket = ++reloadTicketRef.current;',
    '    const ticket = reloadTicketRef.current;',
  ),
);
add(
  'no-persistent-draft',
  'May editor input live only as long as the disposable view?',
  controller,
  (s) =>
    once(
      s,
      '  const [editor, setScopeEditor] = usePricingEditorDraft();',
      '  const [editor, setScopeEditor] = useState<ReturnType<typeof usePricingEditorDraft>[0]>(null);',
    ),
);
add(
  'no-sync-input-ref',
  'May submit and late outcomes wait for React to commit input?',
  controller,
  (s) => once(s, '    editorRef.current = next;', ''),
);
add(
  'close-newer-input',
  'May successful writes dismiss input typed after dispatch?',
  controller,
  (s) => once(s, '    if (current.draft === attempt.draft) {', '    if (true) {'),
);
add(
  'no-dialog-ownership',
  'May late reconciliation control a cancelled or replaced dialog?',
  controller,
  (s) =>
    once(
      s,
      '    const ownsDialog = attempt.dialogGeneration === dialogGenerationRef.current;',
      '    const ownsDialog = true;',
    ),
);
add('no-host-review', 'May a recovered draft save without new-Host review?', controller, (s) =>
  once(s, '    needsReview ||\n', ''),
);
add(
  'no-unknown-write-block',
  'May a second write proceed before uncertain outcome reconciliation?',
  controller,
  (s) =>
    once(
      s,
      "  const writesBlocked =\n    needsReview ||\n    writeState.kind === 'refresh_failed' ||\n    writeState.kind === 'reconcile_unavailable';",
      '  const writesBlocked = needsReview;',
    ),
);
add(
  'no-write-guard',
  'Can pending React state alone prevent same-tick duplicate submission?',
  controller,
  (s) => once(s, "    if (!guard.begin('write')) return;", ''),
);
add(
  'all-catalog-duplicates',
  'Are built-in rows duplicates when adding an override?',
  controller,
  (s) =>
    once(
      s,
      "  const overrideKeys = useMemo(() => editorSnapshot?.entries\n    .filter((row) => row.source === 'custom')",
      '  const overrideKeys = useMemo(() => editorSnapshot?.entries',
    ),
);
add('no-rate-syntax', 'Can Number coercion replace decimal syntax validation?', viewModel, (s) =>
  once(
    s,
    '  if (!/^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?$/i.test(trimmed)) return NaN;',
    '',
  ),
);
add('no-underflow-check', 'Can nonzero subnormal text silently become zero?', viewModel, (s) =>
  once(s, '  if (value === 0 && /[1-9]/.test(trimmed.split(/e/i)[0]!)) return NaN;', ''),
);
add('negative-rates', 'Can finite negative rates be admitted?', viewModel, (s) =>
  once(s, '  return Number.isFinite(value) && value >= 0;', '  return Number.isFinite(value);'),
);
add(
  'blank-is-zero',
  'Are blank optional cache rates equivalent to explicit zero?',
  viewModel,
  (s) => once(s, "  if (trimmed === '') return null;", "  if (trimmed === '') return 0;"),
);
add(
  'no-custom-provenance',
  'Is equal built-in pricing enough to confirm an upsert?',
  protocol,
  (s) =>
    once(
      s,
      "current?.source === 'custom' && canonicalPricingConfigsEqual(current.pricing, target.pricing)",
      'current !== undefined && canonicalPricingConfigsEqual(current.pricing, target.pricing)',
    ),
);
add(
  'reset-means-no-override',
  'Can reset-to-builtin and become-unpriced share one success predicate?',
  protocol,
  (s) =>
    once(
      s,
      "return current?.source === 'builtin';",
      "return current === undefined || current.source === 'builtin';",
    ),
);
add('no-connection-identity', 'Is Host epoch alone enough to identify a write base?', client, (s) =>
  once(
    s,
    'input.base.hostEpoch !== this.connection.hostEpoch ||\n      input.base.connectionId !== this.connection.connectionId',
    'input.base.hostEpoch !== this.connection.hostEpoch',
  ),
);
add('no-page-canonicality', 'May pages contain unordered or duplicate model keys?', client, (s) =>
  once(s, '    if (!pricingEntriesAreCanonical(entries)) {', '    if (false) {'),
);
add('no-page-progress-check', 'Does response correlation alone stop offset cycles?', client, (s) =>
  once(s, '      if (offset <= page.offset || offsets.has(offset)) {', '      if (false) {'),
);
add(
  'no-stable-focus-fallback',
  'Does the removed row trigger suffice for focus restoration?',
  controller,
  (s) => once(s, '    else addButtonRef.current?.focus();', ''),
);
add(
  'no-reveal-cache-error',
  'Can invalid collapsed cache fields remain hidden after Save?',
  editor,
  (s) =>
    once(
      s,
      '    if (validation.errors.cacheRead || validation.errors.cacheWrite) c.setCacheOpen(true);',
      '',
    ),
);
add(
  'no-catalog-aria-binding',
  'Does Astryx now propagate combobox validation without the Pricing patch?',
  editor,
  (s) =>
    section(
      once(s, '                    ref={bindCatalogField}\n', ''),
      '  const bindCatalogField =',
      '  useLayoutEffect(() => {',
      '',
    ),
);
add(
  'no-dialog-focus-repair',
  'Does native dialog focus handle disabled or removed focused controls?',
  editor,
  (s) =>
    section(s, '  useLayoutEffect(() => {\n    const dialog = ref.current;', '  return ref;', ''),
);
add(
  'no-offset-history',
  'Is visited-offset storage redundant with strictly increasing offsets?',
  client,
  (s) =>
    once(
      once(
        once(s, '    const offsets = new Set<number>([0]);\n', ''),
        'offset <= page.offset || offsets.has(offset)',
        'offset <= page.offset',
      ),
      '      offsets.add(offset);\n',
      '',
    ),
);
add('one-load-error-clear', 'Can the same refresh clear its error just once?', controller, (s) =>
  once(
    s,
    '      if (!isCurrent(lifecycle) || ticket !== reloadTicketRef.current) return;\n      setLoadError(null);',
    '      if (!isCurrent(lifecycle) || ticket !== reloadTicketRef.current) return;',
  ),
);
add(
  'one-close-conflict-clear',
  'Does setEditor(null) already retire the settled conflict?',
  controller,
  (s) =>
    once(
      s,
      "    if (writeState.kind === 'conflict') {\n      setWriteState({ kind: 'idle' });\n    }\n",
      '',
    ),
);
const combined = (id, ids) => {
  const changes = {};
  for (const v of ids.map((id) => variants.find((v) => v.id === id)))
    for (const [p, fn] of Object.entries(v.changes)) {
      const before = changes[p] ?? ((s) => s);
      changes[p] = (s) => fn(before(s));
    }
  variants.push({ id, question: ids.join(' + '), changes });
};
combined('combined-simplification', [
  'no-offset-history',
  'one-load-error-clear',
  'one-close-conflict-clear',
]);
combined('no-host-fences', ['no-host-witness', 'no-lifecycle-fence']);
combined('no-async-ownership', ['no-dialog-ownership', 'close-newer-input']);
const suite = [
  'apps/desktop/dist/main/__tests__/pricing-editor.test.js',
  'apps/desktop/dist/main/__tests__/pricing-view-model.test.js',
  'apps/desktop/dist/main/__tests__/runtime-host-client-pricing.test.js',
  'apps/desktop/dist/main/__tests__/runtime-host-pricing-ipc-main.test.js',
  'apps/desktop/dist/main/__tests__/runtime-host-usage-ipc-main.test.js',
  'apps/desktop/dist/main/__tests__/usage-settings-view.test.js',
  'packages/runtime-host/dist/__tests__/usage-pricing-protocol.test.js',
];
const sha = (s) => createHash('sha256').update(s).digest('hex');
if (process.env.MAKA_ABLATION_CHILD === '1') {
  const variant = variants.find((v) => v.id === process.env.MAKA_ABLATION_VARIANT);
  if (!variant) throw new Error('Unknown ablation');
  const transformed = Object.fromEntries(
    paths.map((p) => [p, variant.changes[p]?.(sources[p]) ?? sources[p]]),
  );
  // Keep diagnostics finite on failed DOM identity checks; preserve the predicate.
  transformed[editorTest] = transformed[editorTest]
    .replace('assert.equal(focused, addButton,', 'assert.ok(focused === addButton,')
    .replaceAll(
      'assert.equal(openDialog(harness.doc), undefined',
      'assert.equal(openDialog(harness.doc) === undefined, true',
    )
    .replace(
      'afterEach(() => {',
      'const experimentRoots = new Set<Root>();\nafterEach(async () => {\n  await act(async () => { for (const root of experimentRoots) root.unmount(); });\n  experimentRoots.clear();',
    )
    .replace(
      'const root = createRoot(container);',
      'const root = createRoot(container);\n  experimentRoots.add(root);',
    );
  if (probes) {
    transformed[editorTest] += readFileSync(resolve(scriptDir, 'pricing-editor.probes.ts'), 'utf8');
    transformed[clientTest] += readFileSync(resolve(scriptDir, 'pricing-client.probes.ts'), 'utf8');
  }
  const distMap = new Map(
    paths.map((p) => [resolve(root, p.replace('/src/', '/dist/').replace(/\.tsx?$/, '.js')), p]),
  );
  const loaded = [];
  registerHooks({
    load(url, ctx, next) {
      const p = url.startsWith('file:') ? distMap.get(fileURLToPath(url)) : undefined;
      if (!p) return next(url, ctx);
      loaded.push({ path: p, changed: transformed[p] !== sources[p], hash: sha(transformed[p]) });
      return {
        format: 'module',
        shortCircuit: true,
        source: transformSync(transformed[p], {
          loader: p.endsWith('.tsx') ? 'tsx' : 'ts',
          format: 'esm',
          target: 'es2022',
          jsx: 'automatic',
          sourcefile: p,
          sourcemap: 'inline',
        }).code,
      };
    },
  });
  process.on('exit', () =>
    writeFileSync(
      resolve(process.env.MAKA_ABLATION_OUTPUT, `loaded-${process.pid}.json`),
      JSON.stringify(loaded),
    ),
  );
} else {
  const requested = process.argv.slice(2);
  const chosen = requested.length ? variants.filter((v) => requested.includes(v.id)) : variants;
  mkdirSync(resolve(dir, 'runs'), { recursive: true });
  writeFileSync(
    resolve(dir, 'manifest.json'),
    JSON.stringify(
      {
        base,
        node: process.version,
        probes,
        lockHash: sha(readFileSync(resolve(root, 'package-lock.json'))),
        suite,
        sources: Object.fromEntries(paths.map((p) => [p, sha(sources[p])])),
        variants: variants.map(({ id, question }) => ({ id, question })),
      },
      null,
      2,
    ),
  );
  if (chosen.length === 0) throw new Error('No matching ablation variants');
  const results = [];
  for (const variant of chosen) {
    const out = resolve(dir, 'runs', variant.id);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const started = Date.now();
    let preparationError;
    const changed = {};
    try {
      for (const [p, fn] of Object.entries(variant.changes)) {
        const s = fn(sources[p]);
        if (s === sources[p]) throw new Error('[ABLATION INVALID] No source change');
        changed[p] = s;
        transformSync(s, {
          loader: p.endsWith('.tsx') ? 'tsx' : 'ts',
          format: 'esm',
          jsx: 'automatic',
        });
        const local = resolve(out, p);
        mkdirSync(dirname(local), { recursive: true });
        writeFileSync(local, s);
      }
    } catch (e) {
      preparationError = String(e);
    }
    if (!preparationError)
      for (const [p, source] of Object.entries(sources)) {
        const local = resolve(out, p);
        mkdirSync(dirname(local), { recursive: true });
        writeFileSync(local, changed[p] ?? source);
      }
    const run = preparationError
      ? { status: null, stdout: '', stderr: preparationError }
      : spawnSync(
          process.execPath,
          [
            '--import',
            pathToPath(),
            '--test',
            '--test-force-exit',
            '--test-concurrency=1',
            `--test-reporter=${resolve(scriptDir, 'pricing-ablation-reporter.mjs')}`,
            ...suite,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 90000,
            maxBuffer: 16 * 1024 * 1024,
            env: {
              ...process.env,
              MAKA_ABLATION_CHILD: '1',
              MAKA_ABLATION_VARIANT: variant.id,
              MAKA_ABLATION_OUTPUT: out,
            },
          },
        );
    writeFileSync(resolve(out, 'events.jsonl'), run.stdout ?? '');
    writeFileSync(resolve(out, 'stderr.log'), run.stderr ?? '');
    const events = (run.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const summary = events.filter((e) => e.type === 'test:summary' && !e.data.file).at(-1)?.data;
    const failures = events.filter(
      (e) => e.type === 'test:fail' && e.failureType !== 'subtestsFailed',
    );
    const loaded = readdirSync(out)
      .filter((p) => p.startsWith('loaded-'))
      .flatMap((p) => JSON.parse(readFileSync(resolve(out, p), 'utf8')));
    const mutationsLoaded = Object.keys(changed).every((p) =>
      loaded.some((l) => l.path === p && l.changed),
    );
    const modulesLoaded = paths.every((p) => loaded.some((item) => item.path === p));
    const expectedTests = probes ? 124 : 114;
    const behavioralFailures = failures.filter((f) => f.error.includes('ERR_ASSERTION'));
    const invalid =
      (run.status !== 0 && behavioralFailures.length === 0) ||
      summary?.counts.tests !== expectedTests ||
      preparationError ||
      run.error ||
      !summary ||
      !mutationsLoaded ||
      !modulesLoaded ||
      (run.stdout ?? '').includes('[ABLATION INVALID]');
    const result = {
      id: variant.id,
      question: variant.question,
      probes,
      verdict: invalid ? 'invalid' : run.status === 0 ? 'survived' : 'killed',
      exit: run.status,
      durationMs: Date.now() - started,
      summary,
      failures,
      behavioralFailures,
      mutationsLoaded,
      modulesLoaded,
      loaded,
      preparationError,
    };
    results.push(result);
    writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        id: result.id,
        verdict: result.verdict,
        counts: summary?.counts,
        failures: failures.map((f) => f.name),
        error: preparationError,
      }),
    );
    if (variant.id === 'baseline' && result.verdict !== 'survived') break;
  }
  writeFileSync(resolve(dir, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));
  if (
    results.some(
      (result) =>
        result.verdict === 'invalid' || (result.id === 'baseline' && result.verdict !== 'survived'),
    )
  )
    process.exitCode = 1;
}
function pathToPath() {
  return fileURLToPath(import.meta.url);
}
