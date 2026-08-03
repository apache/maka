const SAFE_TRACE_KEYS = new Set([
  'type',
  'actionType',
  'path',
  'effect',
  'verified',
  'supported',
  'ok',
  'durationMs',
  'at',
  'toolCallId',
  'pid',
  'windowId',
  'expectedPid',
  'expectedWindowId',
  'winnerPid',
  'winnerWindowId',
  'winnerZIndex',
  'address',
  'tool',
]);
const SAFE_TRACE_TYPES = new Set([
  'dispatch',
  'fallback',
  'occlusion',
  'outcome',
  'semantic_result',
  'snapshot',
  'target',
  'tool_start',
  'tool_result',
  'complete',
  'abort',
  'error',
]);
const SAFE_ACTION_TYPES = new Set([
  'list_apps',
  'observe',
  'click_element',
  'set_value',
  'select_text',
  'secondary_action',
  'press_key',
  'screenshot',
  'cursor_position',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'type',
  'key',
  'hold_key',
  'scroll',
  'wait',
  'zoom',
  'unknown',
]);
const SAFE_TRACE_PATHS = new Set(['ax', 'cdp', 'cgevent', 'screenshot-detail']);
const SAFE_TRACE_EFFECTS = new Set(['confirmed', 'unverifiable']);
const SAFE_DISPATCH_ADDRESSES = new Set(['ax', 'px', 'semantic', 'none']);
const SAFE_DISPATCH_TOOLS = new Set([
  'click',
  'set_value',
  'page',
  'press_key',
  'scroll',
  'drag',
  'zoom',
]);

function safeUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function actionType(action) {
  return typeof action?.type === 'string'
    ? action.type
    : typeof action?.action === 'string'
      ? action.action
      : 'unknown';
}

function safeToken(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function resultCode(text) {
  if (typeof text !== 'string') return undefined;
  const failed = text.match(/\bfailed:\s*([a-z][a-z0-9_]{1,63})\b/i);
  if (failed) return failed[1];
  const status = text.match(/\b(?:ok|error)=([a-z][a-z0-9_]{1,63})\b/i);
  return status?.[1];
}

export function sanitizeCuActionRecord(record) {
  const type = actionType(record?.action ?? record);
  return {
    type: SAFE_ACTION_TYPES.has(type) ? type : 'unknown',
    ...(safeId(record?.toolCallId) ? { toolCallId: safeId(record.toolCallId) } : {}),
    ...(safeId(record?.sourceObservationId)
      ? { sourceObservationId: safeId(record.sourceObservationId) }
      : {}),
    ...(type !== 'screenshot' && safeId(record?.resultObservationId)
      ? { resultObservationId: safeId(record.resultObservationId) }
      : {}),
    ...(Number.isInteger(record?.targetPid) && record.targetPid > 0
      ? { targetPid: record.targetPid }
      : {}),
    ...(Number.isInteger(record?.targetWindowId) && record.targetWindowId > 0
      ? { targetWindowId: record.targetWindowId }
      : {}),
    ...(typeof record?.success === 'boolean' ? { success: record.success } : {}),
    ...(typeof record?.targetOwned === 'boolean' ? { targetOwned: record.targetOwned } : {}),
    ...(record?.expectedFailure === true ? { expectedFailure: true } : {}),
    ...(Number.isFinite(record?.durationMs) ? { durationMs: record.durationMs } : {}),
    ...(Number.isFinite(record?.modelLatencyMs) ? { modelLatencyMs: record.modelLatencyMs } : {}),
    ...(Number.isFinite(record?.toolLatencyMs) ? { toolLatencyMs: record.toolLatencyMs } : {}),
    ...(Number.isFinite(record?.displayLagMs) ? { displayLagMs: record.displayLagMs } : {}),
    ...(resultCode(record?.text) ? { resultCode: resultCode(record.text) } : {}),
  };
}

export function sanitizeCuTrace(trace) {
  if (!trace || typeof trace !== 'object') return null;
  if (!SAFE_TRACE_TYPES.has(trace.type)) return null;
  const sanitized = {};
  for (const [key, value] of Object.entries(trace)) {
    if (!SAFE_TRACE_KEYS.has(key)) continue;
    if (key === 'type') {
      sanitized.type = trace.type;
      continue;
    }
    if (key === 'actionType') {
      const action = safeToken(value, SAFE_ACTION_TYPES);
      if (action) sanitized.actionType = action;
      continue;
    }
    if (key === 'path') {
      const path = safeToken(value, SAFE_TRACE_PATHS);
      if (path) sanitized.path = path;
      continue;
    }
    if (key === 'effect') {
      const effect = safeToken(value, SAFE_TRACE_EFFECTS);
      if (effect) sanitized.effect = effect;
      continue;
    }
    if (key === 'address') {
      const address = safeToken(value, SAFE_DISPATCH_ADDRESSES);
      if (address) sanitized.address = address;
      continue;
    }
    if (key === 'tool') {
      const tool = safeToken(value, SAFE_DISPATCH_TOOLS);
      if (tool) sanitized.tool = tool;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export function sanitizeCuDirectReport(report) {
  return sanitizeCuReport({
    ...report,
    endpointOrigin: safeUrlOrigin(report?.endpointOrigin ?? report?.baseUrl),
  });
}

export function sanitizeCuReport(report) {
  const terminal = report?.terminal;
  const fixtureState = report?.fixtureState;
  const expectedState = Array.isArray(report?.expectedState)
    ? report.expectedState.map(sanitizeAssertionResult).filter(Boolean)
    : [];
  const violations = Array.isArray(report?.forbiddenEffects?.violations)
    ? report.forbiddenEffects.violations.map(sanitizeAssertionResult).filter(Boolean)
    : [];
  return {
    schemaVersion: report?.schemaVersion === 1 ? 1 : undefined,
    runId: safeId(report?.runId),
    gitRevision: safeGitRevision(report?.gitRevision),
    generatedAt: safeTimestamp(report?.generatedAt),
    contentLineage: sanitizeContentLineage(report?.contentLineage),
    evidenceClass: safeToken(
      report?.evidenceClass,
      new Set(['real-runtime', 'fault-injection', 'hermetic-protocol', 'static-contract']),
    ),
    scenarioId: safeId(report?.scenarioId),
    producer: safeId(report?.producer),
    transportClass: safeToken(
      report?.transportClass,
      new Set(['live-network', 'hermetic', 'static']),
    ),
    policyMode: safeToken(report?.policyMode, new Set(['enforced', 'bypassed'])),
    qualificationEligible: report?.qualificationEligible === true,
    deprecated: report?.deprecated === true,
    toolExposure: safeToken(report?.toolExposure, new Set(['direct-e2e', 'deferred'])),
    provider: safeId(report?.provider),
    model: safeId(report?.model),
    endpointOrigin: safeUrlOrigin(report.baseUrl),
    status: safeToken(report?.status, new Set(['pass', 'fail', 'inconclusive'])),
    terminal:
      terminal && typeof terminal === 'object'
        ? {
            type: safeToken(terminal.type, new Set(['complete', 'abort', 'error'])),
            stopReason: safeToken(
              terminal.stopReason,
              new Set([
                'end_turn',
                'max_tokens',
                'step_limit',
                'error',
                'user_stop',
                'permission_handoff',
              ]),
            ),
          }
        : undefined,
    fixtureIdentity: sanitizeFixtureIdentity(report?.fixtureIdentity),
    faultInjection: sanitizeFaultInjection(report?.faultInjection),
    run:
      report?.run && typeof report.run === 'object'
        ? {
            status: safeToken(
              report.run.status,
              new Set([
                'created',
                'running',
                'waiting_for_user',
                'completed',
                'failed',
                'cancelled',
              ]),
            ),
            failureClass: safeId(report.run.failureClass),
            ...(Number.isFinite(report.run.durationMs)
              ? { durationMs: report.run.durationMs }
              : {}),
          }
        : undefined,
    ...(Number.isFinite(report?.totalLatencyMs) ? { totalLatencyMs: report.totalLatencyMs } : {}),
    actionAttempts: Number.isInteger(report?.actionAttempts) ? report.actionAttempts : undefined,
    actionCount: Number.isInteger(report?.actionCount) ? report.actionCount : undefined,
    actionCounts: sanitizeCountMap(report?.actionCounts),
    minimumActionsPassed: report?.minimumActionsPassed === true,
    actionsWithinBudget: report?.actionsWithinBudget === true,
    dispatchPathPassed: report?.dispatchPathPassed === true,
    actions: Array.isArray(report?.actions) ? report.actions.map(sanitizeCuActionRecord) : [],
    fixtureState: sanitizeFixtureState(fixtureState),
    expectedState,
    forbiddenEffects: {
      status: safeToken(report?.forbiddenEffects?.status, new Set(['pass', 'fail'])),
      violations,
    },
    traces: Array.isArray(report?.traces) ? report.traces.map(sanitizeCuTrace).filter(Boolean) : [],
    driverTraces: Array.isArray(report?.driverTraces)
      ? report.driverTraces.map(sanitizeCuTrace).filter(Boolean)
      : [],
  };
}

function sanitizeContentLineage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const generator = safeScriptPath(value.generator);
  const gitRevision = safeGitRevision(value.gitRevision);
  const generatedAt = safeTimestamp(value.generatedAt);
  if (!generator || !gitRevision || !generatedAt) return undefined;
  return { generator, gitRevision, generatedAt };
}

function safeScriptPath(value) {
  return typeof value === 'string' && /^scripts\/[A-Za-z0-9._/-]{1,192}$/.test(value)
    ? value
    : undefined;
}

function safeGitRevision(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : undefined;
}

function safeTimestamp(value) {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : undefined;
}

function sanitizeFixtureIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidates = Array.isArray(value.instances) ? value.instances : [value];
  const instances = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const pid = Number.isInteger(candidate.pid) && candidate.pid > 0 ? candidate.pid : undefined;
    const windowIds = Array.isArray(candidate.windowIds)
      ? [...new Set(candidate.windowIds.filter((entry) => Number.isInteger(entry) && entry > 0))]
      : [];
    return pid && windowIds.length > 0 ? [{ pid, windowIds }] : [];
  });
  if (instances.length === 0) return undefined;
  return {
    instances: instances.filter(
      (candidate, index) =>
        instances.findIndex(
          (entry) =>
            entry.pid === candidate.pid &&
            JSON.stringify(entry.windowIds) === JSON.stringify(candidate.windowIds),
        ) === index,
    ),
  };
}

function sanitizeFaultInjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const layer = safeToken(value.layer, new Set(['runtime']));
  const kind = safeId(value.kind);
  return layer && kind ? { layer, kind } : undefined;
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function sanitizeCountMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, count]) =>
      SAFE_ACTION_TYPES.has(key) && Number.isInteger(count) && count >= 0 ? [[key, count]] : [],
    ),
  );
}

function sanitizeFixtureState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([windowId, state]) => {
      if (!safeId(windowId) || !state || typeof state !== 'object' || Array.isArray(state)) {
        return [];
      }
      const safeState = Object.fromEntries(
        Object.entries(state).flatMap(([key, field]) =>
          safeId(key) &&
          (typeof field === 'boolean' ||
            typeof field === 'number' ||
            (typeof field === 'string' && /^[A-Za-z0-9 .:_-]{0,128}$/.test(field)))
            ? [[key, field]]
            : [],
        ),
      );
      return [[windowId, safeState]];
    }),
  );
}

function sanitizeAssertionResult(value) {
  if (!value || typeof value !== 'object') return null;
  const windowId = safeId(value.windowId);
  const path = safeId(value.path);
  if (!windowId || !path || typeof value.pass !== 'boolean') return null;
  return {
    windowId,
    path,
    pass: value.pass,
    ...(typeof value.actual === 'boolean' ||
    typeof value.actual === 'number' ||
    typeof value.actual === 'string'
      ? { actual: value.actual }
      : {}),
  };
}
