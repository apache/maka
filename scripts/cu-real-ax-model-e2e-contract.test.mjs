import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [launcher, harness, probe, monitor] = await Promise.all([
  readFile(new URL('./cu-real-ax-model-e2e-launcher.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./cu-real-ax-model-e2e.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./cu-physical-input-age.swift', import.meta.url), 'utf8'),
  readFile(new URL('./cu-real-e2e-monitor.swift', import.meta.url), 'utf8'),
]);

test('real AX model E2E owns fixture lifecycle and never activates it', () => {
  assert.match(launcher, /CUA_LAB_BACKGROUND/);
  assert.doesNotMatch(launcher, /activateBundle|tell application id/);
  assert.match(launcher, /--concurrent-user/);
  assert.match(launcher, /caffeinate', \['-dimsu'\]/);
  assert.match(launcher, /runFixtureScript\('stop\.sh'\)/);
});

test('real AX model E2E uses production Runtime and backend with an enforced semantic budget', () => {
  assert.match(harness, /new AiSdkBackend/);
  assert.match(harness, /createCuaDriverBackend/);
  assert.match(harness, /getAIModel/);
  assert.match(harness, /MAKA_CU_MODEL_PROVIDER/);
  assert.match(harness, /claude-sonnet-4-6/);
  assert.match(harness, /allowCompatibilityInputDispatch: false/);
  assert.match(harness, /new Set\(\['list_apps', 'observe', 'set_value', 'wait'\]\)/);
  assert.match(harness, /scenario === 'observe-only'/);
  assert.match(harness, /scenario === 'intervention-recovery'/);
  assert.match(harness, /scenario === 'restart-recovery'/);
  assert.match(harness, /scenario === 'ax-click'/);
  assert.match(harness, /scenario === 'ax-multi-step'/);
  assert.match(harness, /scenario === 'ambiguity'/);
  assert.match(
    harness,
    /model ambiguity scenario did not attempt and observe fail-closed rejection/,
  );
  assert.doesNotMatch(harness, /safelyDeclined/);
  assert.match(harness, /error: 'user_intervened'/);
  assert.match(
    harness,
    /evidenceClass = scenario === 'intervention-recovery'[\s\S]*'fault-injection'/,
  );
  assert.match(harness, /layer: 'runtime'/);
  assert.match(harness, /target_missing/);
  assert.match(harness, /ambiguousRecoveryObserved/);
  assert.match(harness, /observe again before retrying/);
  assert.match(launcher, /restart-request\.json/);
  assert.match(launcher, /restart-complete\.json/);
  assert.match(harness, /action budget exceeded/);
  assert.match(harness, /currentScenario === 'restart-recovery'[\s\S]*\? 2/);
  assert.match(harness, /expectedFailures:[\s\S]*action: 'set_value', error: 'target_missing'/);
  assert.match(harness, /qualificationScenario\.expectedFailures\.some/);
  assert.match(harness, /totalActionAttempts = nextTotal[\s\S]*actions\.push\(attempt\)/);
  assert.match(harness, /unsupported_action_policy/);
  assert.match(harness, /action_budget_exceeded/);
  assert.match(harness, /target_mismatch/);
  assert.match(
    harness,
    /catch \(error\)[\s\S]*attempt\.text = `maka_computer\.\$\{action\} failed/,
  );
  assert.match(harness, /actions\.push\(attempt\)[\s\S]*throw new Error\(message\)/);
  assert.match(harness, /actionResultsPassed = actions\.every/);
  assert.match(harness, /status: qualified \? 'pass' : 'fail'/);
  assert.match(harness, /if \(!qualified\)[\s\S]*qualification rejected canonical action evidence/);
  assert.match(harness, /terminalEvent\?\.type !== 'complete'/);
  assert.match(harness, /terminalEvent\.stopReason !== 'end_turn'/);
  assert.match(harness, /clickAction\?\.sourceObservationId !== setAction\.resultObservationId/);
  assert.match(harness, /fixtureIdentity/);
  assert.match(harness, /transportClass: 'live-network'/);
  assert.match(harness, /qualificationEligible: evidenceClass === 'real-runtime'/);
  assert.match(harness, /address === 'ax'/);
  assert.match(harness, /address === 'px'/);
  assert.match(harness, /policyMode: 'enforced'/);
  assert.match(harness, /sanitizeCuDirectReport/);
  assert.match(harness, /trace\.toolCallId !== 'fixture-mutate-ambiguity'/);
  assert.match(harness, /actionAttempts: totalActionAttempts/);
  assert.match(
    harness,
    /restart recovery requires stale target_missing, fresh observation, and successful AX retry/,
  );
  assert.match(harness, /runId: randomUUID\(\)/);
  assert.match(harness, /contentLineage/);
  assert.match(launcher, /MAKA_CU_AX_MODEL_REPORT: reportPath/);
  assert.match(launcher, /Real AX model Computer Use report/);
});

test('physical input probe is read-only', () => {
  assert.match(probe, /secondsSinceLastEventType/);
  assert.match(probe, /\.scrollWheel/);
  assert.doesNotMatch(probe, /mouseEventSource|event\.post|pulse/);
});

test('launcher validates every READY field emitted by the safety monitor', () => {
  assert.match(launcher, /physicalInputAge: Number\(fields\[4\]\)/);
  assert.match(launcher, /bundleIdentifier: fields\[5\]/);
  assert.match(launcher, /canonicalAppPath: fields\[6\]/);
  assert.match(launcher, /baseline\.mode !== 'concurrent_user'/);
  assert.match(launcher, /Number\.isFinite\(baseline\.physicalInputAge\)/);
  // The fixture is launched with `open -n -g`, so the baseline asserts it does
  // NOT own the foreground. Both identity fields are still validated; only the
  // direction changed, because requiring the fixture to be frontmost would
  // contradict the launch mode and the background execution under test.
  assert.match(launcher, /baseline\.bundleIdentifier === fixtureBundleId/);
  assert.match(launcher, /baseline\.canonicalAppPath === expectedAppPath/);
  assert.match(launcher, /baseline\.frontmostPID === fixturePID/);
});

test('launcher keeps the fixture out of the foreground for the whole run', () => {
  // `--concurrent-user` only catches the OOP host PID; denying the bundle covers
  // every process the fixture owns, so a UI process stealing focus mid-scenario
  // also fails the run rather than silently passing.
  assert.match(launcher, /'--deny-frontmost-bundle'/);
  assert.match(monitor, /--deny-frontmost-bundle/);
  assert.match(monitor, /denied bundle became frontmost during E2E/);
});

test('candidate qualification keeps artifact identity checks and supports a relocated lab', () => {
  assert.match(launcher, /MAKA_CU_AX_MODEL_LAB_ROOT/);
  assert.match(harness, /MAKA_CU_AX_MODEL_LAB_ROOT/);
  assert.match(launcher, /overrideConfigured !== 0 && overrideConfigured !== 3/);
  assert.match(launcher, /expected SHA-256, and expected version/);
  assert.match(launcher, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(
    launcher,
    /copyFile\([\s\S]*MAKA_CU_AX_MODEL_DRIVER_OVERRIDE|copyFile\([\s\S]*driverOverride/,
  );
  assert.match(launcher, /MAKA_CU_AX_MODEL_EXPECTED_SHA256/);
  assert.match(launcher, /MAKA_CU_AX_MODEL_EXPECTED_VERSION/);
  assert.match(harness, /expectedBinarySha256/);
  assert.match(harness, /expectedServerVersion/);
});
