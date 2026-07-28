import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('permission prompt response guard', () => {
  it('routes one-call permissions through the composer without remember-for-turn', async () => {
    const promptSource = await readFile(join(process.cwd(), '../../packages/ui/src/permission-dialog.tsx'), 'utf8');
    const coreEventSource = await readFile(join(process.cwd(), '../../packages/core/src/events.ts'), 'utf8');
    const eventSource = await readFile(join(process.cwd(), 'src/renderer/app-shell-session-events.ts'), 'utf8');

    assert.match(promptSource, /request: AnyPermissionRequestEvent/);
    assert.match(
      coreEventSource,
      /interface AdditionalPermissionRequestEvent[\s\S]*rememberForTurnAllowed\?: false;/,
      'additional permission requests must not allow turn-scoped approval memory',
    );
    assert.match(
      coreEventSource,
      /interface SandboxEscalationRequestEvent[\s\S]*rememberForTurnAllowed\?: false;/,
      'sandbox escalation requests must not allow turn-scoped approval memory',
    );
    assert.match(
      promptSource,
      /\.\.\.\(props\.request\.rememberForTurnAllowed[\s\S]*\? \{ rememberForTurn:[\s\S]*: \{\}\)/,
      'the prompt must omit rememberForTurn unless the request explicitly allows it',
    );
    assert.match(promptSource, /isOneShotPermissionRequest\(props\.request\) \? copy\.allowOnce : copy\.allow/);
    assert.match(
      promptSource,
      /isAdditionalPermissionRequest\(request\) \|\| isSandboxEscalationRequest\(request\)/,
      'the one-shot label must cover both additional permissions and sandbox escalation',
    );
    assert.doesNotMatch(eventSource, /if \(event\.kind === 'additional_permissions'\) break/);
    assert.match(eventSource, /case 'permission_request':[\s\S]*enqueueInteraction\(current, sessionId, event\)/);
  });

  it('keeps allow/deny decisions single-flight for a request id', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/permission-dialog.tsx'), 'utf8');
    const prompt = source.match(/export function PermissionPrompt[\s\S]*?function renderPermissionSummary/)?.[0] ?? '';
    // PR-PERMISSION-UI-CLEANUP-0: submit() became async + try/finally
    // (was try/catch+throw). The single-flight contract is unchanged;
    // only the reset path moved from catch to finally so the pending
    // state clears on success too — necessary because the parent's
    // `respondToSandboxBoundary` now swallows IPC errors via toast
    // (PR-STOP-ERROR-SURFACE-0).
    const submit = prompt.match(/async function submit\(decision: PermissionResponse\['decision'\]\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(prompt, /const \[responsePending, setResponsePending\] = useState\(false\);/);
    assert.match(prompt, /const responsePendingRef = useRef\(false\);/);
    assert.match(prompt, /const permissionMountedRef = useMountedRef\(\);/);
    assert.match(prompt, /const activePermissionRequestIdRef = useRef\(props\.request\.requestId\);/);
    assert.match(
      prompt,
      /if \(permissionMountedRef\.current\) setResponsePending\(false\);/,
      'permission response settlement must not update state after the prompt unmounts; mount state is owned by the shared useMountedRef hook',
    );
    assert.match(
      prompt,
      /activePermissionRequestIdRef\.current = props\.request\.requestId;[\s\S]*responsePendingRef\.current = false;[\s\S]*setNow\(Date\.now\(\)\);/,
      'new permission request must become the active owner before clearing stale pending state',
    );
    assert.match(prompt, /responsePendingRef\.current = false;[\s\S]*setNow\(Date\.now\(\)\);/, 'new permission request must clear stale pending state');
    assert.match(submit, /if \(responsePendingRef\.current\) return;/, 'same request must ignore duplicate allow\/deny clicks');
    assert.match(submit, /const requestId = props\.request\.requestId;/, 'submit must capture the request id that owns the pending response');
    assert.match(submit, /responsePendingRef\.current = true;[\s\S]*setResponsePending\(true\);/);
    // submit() now awaits onRespond and resets pending in finally so
    // both success and async rejection paths clear the lock.
    assert.match(submit, /await props\.onRespond\(/);
    assert.match(submit, /requestId,[\s\S]*decision,[\s\S]*rememberForTurn/);
    assert.match(
      submit,
      /\}\s*finally\s*\{[\s\S]*if \(activePermissionRequestIdRef\.current === requestId\) \{[\s\S]*responsePendingRef\.current = false;[\s\S]*if \(permissionMountedRef\.current\) setResponsePending\(false\);[\s\S]*\}/,
      'only the request that owns the pending response may clear the pending lock',
    );
    assert.match(prompt, /disabled=\{decisionsDisabled\}[\s\S]*onClick=\{\(\) => submit\('deny'\)\}/);
    assert.match(prompt, /disabled=\{decisionsDisabled\}[\s\S]*onClick=\{\(\) => submit\('allow'\)\}/);
    assert.match(prompt, /responsePending \? copy\.submitting/);
  });

  it('locks permission decisions after Stop without removing Stop as a cancellation escape hatch', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/permission-dialog.tsx'), 'utf8');
    const prompt = source.match(/export function PermissionPrompt[\s\S]*?function renderPermissionSummary/)?.[0] ?? '';

    assert.match(prompt, /const decisionsDisabled = props\.stopPending \|\| responsePending;/);
    assert.equal(
      prompt.match(/disabled=\{decisionsDisabled\}/g)?.length,
      3,
      'Stop pending and response pending must lock remember, allow, and deny',
    );
    assert.match(
      prompt,
      /disabled=\{props\.stopPending\}[\s\S]*?props\.stopPending \? copy\.stopping : copy\.stop/,
      'Stop remains independently available while a decision IPC is pending so the user can still interrupt the turn',
    );
  });
});
