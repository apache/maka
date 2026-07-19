import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const READINESS = new Set(['real', 'contract', 'unsupported']);
const EVIDENCE_CLASSES = new Set([
  'real-runtime',
  'fault-injection',
  'hermetic-protocol',
  'static-contract',
]);
const REAL_REPORT_PRODUCERS = new Set(['cu-real-model-launcher', 'cu-real-ax-model-e2e']);
const ACTIONS_WITHOUT_TARGET_OWNERSHIP = new Set(['list_apps', 'wait', 'cursor_position']);
const ACTIONS_WITHOUT_OBSERVATION_LINEAGE = new Set([
  'list_apps',
  'observe',
  'screenshot',
  'wait',
  'cursor_position',
]);

function optionValue(argv, names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index >= 0) return argv[index + 1];
  }
  return undefined;
}

function requiredOption(argv, names) {
  const value = optionValue(argv, names);
  if (!value || value.startsWith('--')) {
    throw new Error(`missing required option ${names.join('/')}`);
  }
  return value;
}

function asEntries(value, key, fileName) {
  const entries = Array.isArray(value) ? value : value?.[key];
  if (!Array.isArray(entries)) {
    throw new Error(`${fileName} must be an array or contain a ${key} array`);
  }
  return entries;
}

function requireId(entry, kind) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) {
    throw new Error(`${kind} entries require a non-empty id`);
  }
  return entry.id.trim();
}

function select(value, scenarioId) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return value;
  return value[scenarioId] ?? value.default;
}

function renderTemplate(value, variables) {
  if (typeof value === 'string') {
    return value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name) =>
      Object.hasOwn(variables, name) ? String(variables[name]) : match,
    );
  }
  if (Array.isArray(value)) {
    return value.map((part) => renderTemplate(part, variables));
  }
  return value;
}

function displayCommand(command) {
  if (Array.isArray(command)) {
    return command
      .map((part) => {
        const text = String(part);
        return /^[a-zA-Z0-9_./:=+-]+$/.test(text) ? text : JSON.stringify(text);
      })
      .join(' ');
  }
  return typeof command === 'string' ? command : null;
}

function finiteNumbers(values) {
  return values.flat(Infinity).filter((value) => Number.isFinite(value));
}

function percentile(sorted, value) {
  if (sorted.length === 0) return null;
  const index = Math.ceil((value / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export function summarizeLatency(values) {
  const numbers = finiteNumbers(Array.isArray(values) ? values : [values]);
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return {
    samples: numbers.length,
    averageMs: Math.round((total / numbers.length) * 100) / 100,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.at(-1),
  };
}

function valuesAtPath(value, path) {
  const segments = String(path).split('.').filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

function deepSubsetEqual(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => deepSubsetEqual(actual[index], value))
    );
  }
  if (expected && typeof expected === 'object') {
    return (
      actual != null &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) => deepSubsetEqual(actual[key], value))
    );
  }
  return Object.is(actual, expected);
}

function normalizeFixture(report, scenario) {
  const assertions = Array.isArray(scenario.expectedState) ? scenario.expectedState : [];
  if (assertions.length === 0) {
    return { status: 'not-defined', expected: [], actual: report.fixtureState ?? null };
  }
  if (!report.fixtureState || typeof report.fixtureState !== 'object') {
    return { status: 'unknown', expected: assertions, actual: null };
  }
  const results = assertions.map((assertion) => {
    const actual = valuesAtPath(report.fixtureState?.[assertion.windowId], assertion.path);
    return {
      ...assertion,
      actual,
      pass: actual !== undefined && assertionMatches(assertion, actual),
    };
  });
  return {
    status: results.every((result) => result.pass) ? 'pass' : 'fail',
    expected: assertions,
    actual: report.fixtureState,
    results,
  };
}

function assertionMatches(assertion, actual) {
  if (Object.hasOwn(assertion, 'equals')) return deepSubsetEqual(actual, assertion.equals);
  if (Object.hasOwn(assertion, 'greaterThan')) return actual > assertion.greaterThan;
  if (Object.hasOwn(assertion, 'greaterThanOrEqual')) return actual >= assertion.greaterThanOrEqual;
  if (Object.hasOwn(assertion, 'lessThan')) return actual < assertion.lessThan;
  if (Object.hasOwn(assertion, 'lessThanOrEqual')) return actual <= assertion.lessThanOrEqual;
  return false;
}

function effectId(effect) {
  if (typeof effect === 'string') return effect;
  if (effect && typeof effect === 'object') return effect.id ?? effect.name ?? effect.path;
  return undefined;
}

function normalizeForbiddenEffects(report, scenario) {
  const definitions = Array.isArray(scenario.forbiddenEffects) ? scenario.forbiddenEffects : [];
  const reported = report.forbiddenEffects;
  const observed = Array.isArray(reported?.observed) ? reported.observed : [];
  const observedIds = new Set(observed.map(effectId).filter(Boolean));
  const violations = [];
  let missingEvidence = false;

  for (const definition of definitions) {
    if (typeof definition === 'string') {
      if (observedIds.has(definition)) violations.push({ id: definition, source: 'reported' });
      continue;
    }
    if (!definition || typeof definition !== 'object') continue;
    const id = effectId(definition) ?? 'unnamed';
    if (observedIds.has(id)) {
      violations.push({ id, source: 'reported' });
      continue;
    }
    if (definition.path) {
      const actual = valuesAtPath(report.fixtureState?.[definition.windowId], definition.path);
      const safeValue = Object.hasOwn(definition, 'equals')
        ? definition.equals
        : definition.allowed;
      if (actual === undefined) {
        missingEvidence = true;
      } else if (safeValue !== undefined && !deepSubsetEqual(actual, safeValue)) {
        violations.push({
          id,
          source: `${definition.windowId}.${definition.path}`,
          expected: safeValue,
          actual,
        });
      }
    }
  }

  if (reported?.status === 'fail' || reported?.pass === false) {
    const reportedViolations = Array.isArray(reported.violations)
      ? reported.violations
      : [{ id: 'reported-failure', source: 'report' }];
    violations.push(...reportedViolations);
  }
  return {
    status:
      definitions.length === 0 && reported == null
        ? 'not-defined'
        : missingEvidence
          ? 'unknown'
          : violations.length > 0
            ? 'fail'
            : 'pass',
    forbidden: definitions,
    observed,
    violations,
  };
}

function countRetries(report, actions) {
  if (Number.isFinite(report.retries)) return report.retries;
  return actions.reduce((total, action) => {
    if (Number.isFinite(action?.retries)) return total + action.retries;
    return total + (action?.retry === true ? 1 : 0);
  }, 0);
}

export function normalizeReport(report, scenario) {
  const actions = Array.isArray(report.actions) ? report.actions : [];
  const actionModelValues = actions.map((action) => action?.modelLatencyMs ?? action?.modelLatency);
  const actionToolValues = actions.map(
    (action) => action?.toolLatencyMs ?? action?.toolLatency ?? action?.durationMs,
  );
  const actionDisplayValues = actions.map((action) => action?.displayLagMs ?? action?.displayLag);
  const modelValues =
    finiteNumbers(actionModelValues).length > 0
      ? actionModelValues
      : [report.modelLatencyMs, report.modelLatency];
  const toolValues =
    finiteNumbers(actionToolValues).length > 0
      ? actionToolValues
      : [report.toolLatencyMs, report.toolLatency];
  const displayValues =
    finiteNumbers(actionDisplayValues).length > 0
      ? actionDisplayValues
      : [report.displayLagMs, report.displayLag];
  return {
    evidenceClass: EVIDENCE_CLASSES.has(report.evidenceClass) ? report.evidenceClass : null,
    policyMode:
      report.policyMode === 'enforced' || report.policyMode === 'bypassed'
        ? report.policyMode
        : null,
    modelLatency: summarizeLatency(modelValues),
    toolLatency: summarizeLatency(toolValues),
    displayLag: summarizeLatency(displayValues),
    actionCount: Number.isFinite(report.actionCount) ? report.actionCount : actions.length,
    retries: countRetries(report, actions),
    fixture: normalizeFixture(report, scenario),
    forbiddenEffects: normalizeForbiddenEffects(report, scenario),
  };
}

export function validateRealReport(report, provider, scenario) {
  const errors = [];
  if (report.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof report.runId !== 'string' || !report.runId) errors.push('runId missing');
  if (typeof report.gitRevision !== 'string' || !/^[a-f0-9]{40}$/.test(report.gitRevision)) {
    errors.push('gitRevision missing or invalid');
  }
  const generatedAt = Date.parse(report.generatedAt);
  if (
    typeof report.generatedAt !== 'string' ||
    !Number.isFinite(generatedAt) ||
    new Date(generatedAt).toISOString() !== report.generatedAt
  )
    errors.push('generatedAt missing or invalid');
  if (
    report.contentLineage?.generator !==
      `scripts/${
        report.producer === 'cu-real-model-launcher'
          ? 'cu-real-model-launcher.mjs'
          : 'cu-real-ax-model-e2e.mjs'
      }` ||
    report.contentLineage?.gitRevision !== report.gitRevision ||
    report.contentLineage?.generatedAt !== report.generatedAt
  )
    errors.push('contentLineage mismatch');
  if (report.evidenceClass !== 'real-runtime') errors.push('evidenceClass must be real-runtime');
  if (report.scenarioId !== scenario.id) errors.push('scenarioId mismatch');
  if (report.status !== 'pass') errors.push('report status must be pass');
  if (report.transportClass !== 'live-network') errors.push('transportClass must be live-network');
  if (!REAL_REPORT_PRODUCERS.has(report.producer)) errors.push('producer missing or unknown');
  const expectedProducer = select(provider.producer, scenario.id);
  if (report.producer !== expectedProducer) errors.push('producer mismatch');
  if (report.policyMode !== 'enforced' && report.policyMode !== 'bypassed') {
    errors.push('policyMode missing or unknown');
  }
  if (report.qualificationEligible !== true) errors.push('qualificationEligible must be true');
  if (report.deprecated === true) errors.push('deprecated reports cannot qualify');
  if (report.provider !== provider.id) errors.push('provider mismatch');
  const expectedModel = select(provider.model ?? provider.modelId, scenario.id);
  if (typeof expectedModel !== 'string' || !expectedModel) errors.push('expected model missing');
  else if (report.model !== expectedModel) errors.push('model mismatch');
  if (report.terminal?.type !== 'complete' || report.terminal?.stopReason !== 'end_turn')
    errors.push('terminal must be complete/end_turn');
  const actions = Array.isArray(report.actions) ? report.actions : [];
  const ledgerCounts = actionCounts(actions);
  if (report.actionAttempts !== actions.length) errors.push('actionAttempts mismatch');
  if (report.actionCount !== actions.length) errors.push('actionCount mismatch');
  if (
    !deepSubsetEqual(report.actionCounts, ledgerCounts) ||
    Object.keys(report.actionCounts ?? {}).length !== Object.keys(ledgerCounts).length
  ) {
    errors.push('actionCounts mismatch');
  }
  if (report.minimumActionsPassed !== true) errors.push('minimumActionsPassed must be true');
  if (report.actionsWithinBudget !== true) errors.push('actionsWithinBudget must be true');
  if (
    actions.some(
      (action) =>
        !scenario.allowedActions.includes(action.type) || !actionResultAllowed(action, scenario),
    )
  ) {
    errors.push('actions must be successful or scenario-authorized expected failures, and allowed');
  }
  if (
    actions.some(
      (action) =>
        !ACTIONS_WITHOUT_TARGET_OWNERSHIP.has(action.type) &&
        !actionHasOwnedFixtureTrace(action, report.fixtureIdentity),
    )
  ) {
    errors.push('target ownership requires fixture PID/window trace evidence');
  }
  if (!actionLineageValid(actions)) {
    errors.push('action observation lineage is incomplete or out of order');
  }
  if (
    scenario.expectedFailures?.some(
      (expected) => expected.action === 'set_value' && expected.error === 'target_missing',
    ) &&
    !restartRecoveryValid(actions, report.driverTraces)
  ) {
    errors.push(
      'restart recovery requires target_missing, fresh observation, and successful AX retry',
    );
  }
  if (
    Array.isArray(scenario.expectedActionSequence) &&
    !deepSubsetEqual(
      actions.map((action) => action.type),
      scenario.expectedActionSequence,
    )
  ) {
    errors.push('action sequence mismatch');
  }
  if (Number.isInteger(scenario.maxTotalActions) && actions.length > scenario.maxTotalActions)
    errors.push('total action budget exceeded');
  for (const [action, maximum] of Object.entries(scenario.maxActionCounts ?? {})) {
    if (actions.filter((entry) => entry.type === action).length > maximum) {
      errors.push(`${action} action budget exceeded`);
    }
  }
  for (const [action, minimum] of Object.entries(scenario.minimumActionCounts ?? {})) {
    if (actions.filter((entry) => entry.type === action).length < minimum) {
      errors.push(`${action} minimum action count missing`);
    }
  }
  const mutationActions = actions.filter(
    (action) =>
      action.success === true &&
      !['list_apps', 'observe', 'screenshot', 'cursor_position', 'zoom', 'wait'].includes(
        action.type,
      ),
  );
  if (mutationActions.length > 0) {
    const traces = Array.isArray(report.driverTraces) ? report.driverTraces : [];
    const consumed = new Set();
    const missingDispatch = mutationActions.find((action) => {
      const index = traces.findIndex(
        (trace, traceIndex) =>
          !consumed.has(traceIndex) &&
          trace.type === 'dispatch' &&
          trace.toolCallId === action.toolCallId &&
          trace.actionType === action.type &&
          trace.pid === action.targetPid &&
          trace.windowId === action.targetWindowId &&
          (trace.address === 'ax' || trace.address === 'semantic'),
      );
      if (index < 0) return true;
      consumed.add(index);
      return false;
    });
    if (missingDispatch) {
      errors.push(`safe dispatch evidence missing for ${missingDispatch.type}`);
    }
    if (report.dispatchPathPassed !== true) errors.push('dispatchPathPassed must be true');
  }
  return errors;
}

function actionCounts(actions) {
  const counts = {};
  for (const action of actions) {
    const type = typeof action?.type === 'string' ? action.type : 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function restartRecoveryValid(actions, traces) {
  const staleIndex = actions.findIndex(
    (action) =>
      action.type === 'set_value' &&
      action.success === false &&
      action.expectedFailure === true &&
      action.resultCode === 'target_missing',
  );
  if (staleIndex < 0) return false;
  const stale = actions[staleIndex];
  const freshIndex = actions.findIndex(
    (action, index) =>
      index > staleIndex &&
      action.type === 'observe' &&
      action.success === true &&
      typeof action.resultObservationId === 'string' &&
      (action.targetPid !== stale.targetPid || action.targetWindowId !== stale.targetWindowId),
  );
  if (freshIndex < 0) return false;
  const fresh = actions[freshIndex];
  const retry = actions.find(
    (action, index) =>
      index > freshIndex &&
      action.type === 'set_value' &&
      action.success === true &&
      action.sourceObservationId === fresh.resultObservationId &&
      action.targetPid === fresh.targetPid &&
      action.targetWindowId === fresh.targetWindowId,
  );
  if (!retry) return false;
  return (
    Array.isArray(traces) &&
    traces.some(
      (trace) =>
        trace.type === 'dispatch' &&
        trace.toolCallId === retry.toolCallId &&
        trace.actionType === 'set_value' &&
        trace.pid === retry.targetPid &&
        trace.windowId === retry.targetWindowId &&
        trace.address === 'ax',
    )
  );
}

function actionHasOwnedFixtureTrace(action, fixtureIdentity) {
  return (
    action.targetOwned === true &&
    Array.isArray(fixtureIdentity?.instances) &&
    fixtureIdentity.instances.some(
      (instance) =>
        action.targetPid === instance.pid &&
        Array.isArray(instance.windowIds) &&
        instance.windowIds.includes(action.targetWindowId),
    )
  );
}

function actionResultAllowed(action, scenario) {
  if (action.success === true) return true;
  if (action.expectedFailure !== true || typeof action.resultCode !== 'string') return false;
  return (
    Array.isArray(scenario.expectedFailures) &&
    scenario.expectedFailures.some(
      (expected) => expected.action === action.type && expected.error === action.resultCode,
    )
  );
}

function actionLineageValid(actions) {
  let latestObservationId;
  let latestTarget;
  for (const action of actions) {
    if (
      !ACTIONS_WITHOUT_OBSERVATION_LINEAGE.has(action.type) &&
      (typeof action.sourceObservationId !== 'string' ||
        action.sourceObservationId !== latestObservationId ||
        action.targetPid !== latestTarget?.pid ||
        action.targetWindowId !== latestTarget?.windowId)
    ) {
      return false;
    }
    if (typeof action.resultObservationId === 'string') {
      latestObservationId = action.resultObservationId;
      latestTarget = { pid: action.targetPid, windowId: action.targetWindowId };
    } else if (action.type === 'observe') {
      return false;
    }
    if (action.expectedFailure === true && action.resultCode === 'target_missing') {
      latestObservationId = undefined;
      latestTarget = undefined;
    }
  }
  return true;
}

function rowStatus(readiness, report, metrics) {
  if (readiness === 'unsupported') return 'unsupported';
  if (readiness === 'contract') return 'contract-only';
  if (!report) return 'missing-report';
  if (metrics.fixture.status === 'fail' || metrics.forbiddenEffects.status === 'fail')
    return 'fail';
  if (metrics.fixture.status === 'unknown' || metrics.forbiddenEffects.status === 'unknown')
    return 'inconclusive';
  if (report.policyMode === 'bypassed') return 'pass-policy-bypassed';
  return 'pass';
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function resolveReportPath(rawPath, baseDir) {
  if (!rawPath) return null;
  return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

function reportTemplateFor(provider, scenario) {
  return (
    scenario.reports?.[provider.id] ??
    select(provider.reports, scenario.id) ??
    select(provider.reportTemplate ?? provider.report, scenario.id) ??
    select(scenario.reportTemplate ?? scenario.report, provider.id)
  );
}

export async function buildProviderMatrix({
  scenarios,
  providers,
  baseDir = process.cwd(),
  generatedAt = new Date().toISOString(),
  loadReport = readJson,
}) {
  const scenarioIds = new Set();
  for (const scenario of scenarios) {
    const id = requireId(scenario, 'scenario');
    if (scenarioIds.has(id)) throw new Error(`duplicate scenario id: ${id}`);
    scenarioIds.add(id);
  }
  const providerIds = new Set();
  for (const provider of providers) {
    const id = requireId(provider, 'provider');
    if (providerIds.has(id)) throw new Error(`duplicate provider id: ${id}`);
    providerIds.add(id);
  }

  const rows = [];
  for (const provider of providers) {
    for (const scenario of scenarios) {
      const readiness = select(provider.readiness, scenario.id);
      if (!READINESS.has(readiness)) {
        throw new Error(
          `provider ${provider.id} scenario ${scenario.id} has invalid readiness ${JSON.stringify(readiness)}`,
        );
      }
      const producer = select(provider.producer, scenario.id);
      if (readiness === 'real' && !REAL_REPORT_PRODUCERS.has(producer)) {
        throw new Error(
          `provider ${provider.id} scenario ${scenario.id} real readiness requires an explicit known producer`,
        );
      }
      const model = select(provider.model ?? provider.modelId, scenario.id);
      if (readiness === 'real' && (typeof model !== 'string' || !model)) {
        throw new Error(
          `provider ${provider.id} scenario ${scenario.id} real readiness requires an explicit model`,
        );
      }
      const reportTemplate = reportTemplateFor(provider, scenario);
      const variables = {
        provider: provider.id,
        providerId: provider.id,
        scenario: scenario.id,
        scenarioId: scenario.id,
        prompt: scenario.prompt ?? '',
        report: reportTemplate ?? '',
      };
      const commandTemplate = select(provider.commandTemplate ?? provider.command, scenario.id);
      const command = displayCommand(renderTemplate(commandTemplate, variables));
      const renderedReport = renderTemplate(reportTemplate, variables);
      const reportPath = resolveReportPath(renderedReport, baseDir);
      let report = null;
      let reportError = null;
      if (readiness === 'real' && reportPath) {
        try {
          report = await loadReport(reportPath);
          const validationErrors = validateRealReport(report, provider, scenario);
          if (validationErrors.length > 0) {
            reportError = validationErrors.join('; ');
            report = null;
          }
        } catch (error) {
          if (error?.code !== 'ENOENT')
            reportError = error instanceof Error ? error.message : String(error);
        }
      }
      const metrics = report
        ? normalizeReport(report, scenario)
        : {
            evidenceClass: null,
            policyMode: null,
            modelLatency: null,
            toolLatency: null,
            displayLag: null,
            actionCount: null,
            retries: null,
            fixture: {
              status: scenario.fixture == null ? 'not-defined' : 'unknown',
              expected: scenario.fixture?.expected ?? scenario.fixture ?? null,
              actual: null,
            },
            forbiddenEffects: {
              status: scenario.forbiddenEffects == null ? 'not-defined' : 'unknown',
              forbidden: scenario.forbiddenEffects ?? [],
              observed: [],
              violations: [],
            },
          };
      rows.push({
        providerId: provider.id,
        provider: provider.label ?? provider.name ?? provider.id,
        scenarioId: scenario.id,
        scenario: scenario.label ?? scenario.name ?? scenario.id,
        readiness,
        status: reportError ? 'invalid-report' : rowStatus(readiness, report, metrics),
        command,
        reportPath,
        reportError,
        ...metrics,
      });
    }
  }

  const readinessCounts = Object.fromEntries(
    [...READINESS].map((readiness) => [
      readiness,
      rows.filter((row) => row.readiness === readiness).length,
    ]),
  );
  const statusCounts = {};
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  return {
    schemaVersion: 1,
    generatedAt,
    summary: {
      providers: providers.length,
      scenarios: scenarios.length,
      cells: rows.length,
      readiness: readinessCounts,
      status: statusCounts,
    },
    rows,
  };
}

function latencyCell(summary) {
  return summary ? `${summary.p50Ms}/${summary.p95Ms}/${summary.averageMs} ms` : '-';
}

function escapeCell(value) {
  return String(value ?? '-')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

export function renderMarkdown(matrix) {
  const lines = [
    '# Computer Use Provider E2E Matrix',
    '',
    `Generated: ${matrix.generatedAt}`,
    '',
    `Providers: ${matrix.summary.providers} | Scenarios: ${matrix.summary.scenarios} | Cells: ${matrix.summary.cells}`,
    '',
    '| Provider | Scenario | Readiness | Evidence | Policy | Status | Model p50/p95/avg | Tool p50/p95/avg | Display p50/p95/avg | Actions | Retries | Fixture | Forbidden effects |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const row of matrix.rows) {
    lines.push(
      [
        row.provider,
        row.scenario,
        row.readiness,
        row.evidenceClass,
        row.policyMode,
        row.status,
        latencyCell(row.modelLatency),
        latencyCell(row.toolLatency),
        latencyCell(row.displayLag),
        row.actionCount,
        row.retries,
        row.fixture.status,
        row.forbiddenEffects.status,
      ]
        .map(escapeCell)
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |'),
    );
  }
  lines.push('', '## Commands', '');
  for (const row of matrix.rows) {
    lines.push(
      `- **${row.provider} / ${row.scenario}**: ${row.command ? `\`${row.command.replace(/`/g, '\\`')}\`` : '_none_'}`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: node scripts/cu-provider-matrix.mjs --scenarios scenarios.json ' +
        '--providers providers.json --json matrix.json --markdown matrix.md\n',
    );
    return;
  }
  const scenariosPath = resolve(requiredOption(argv, ['--scenarios']));
  const providersPath = resolve(requiredOption(argv, ['--providers']));
  const jsonPath = resolve(requiredOption(argv, ['--json', '--out-json']));
  const markdownPath = resolve(requiredOption(argv, ['--markdown', '--out-markdown']));
  const [scenarioInput, providerInput] = await Promise.all([
    readJson(scenariosPath),
    readJson(providersPath),
  ]);
  const scenarios = asEntries(scenarioInput, 'scenarios', scenariosPath);
  const providers = asEntries(providerInput, 'providers', providersPath);
  const matrix = await buildProviderMatrix({
    scenarios,
    providers,
    baseDir: dirname(scenariosPath),
  });
  await Promise.all([
    mkdir(dirname(jsonPath), { recursive: true }),
    mkdir(dirname(markdownPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, renderMarkdown(matrix), 'utf8'),
  ]);
  process.stdout.write(
    `Computer Use provider matrix: ${jsonPath}\nMarkdown report: ${markdownPath}\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCli().catch((error) => {
    console.error(
      `Computer Use provider matrix failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
