# File Review Extension: Full Composition Demo and Test Plan

This scenario exercises the extension refactor without using the Maka repository as a test target and without allowing an agent to edit source code.

## Fixture

The test creates a disposable directory containing:

- `incoming/release-notes.md`: a reviewable document with one deliberate policy violation.
- `review-hook.jsonl`: before/after records written by the Tool around Hook.
- `review-service.json`, `review-event.json`, and `review-refresh.json`: observable outputs from the Service, Event Listener, and Timer.

The fixture is read-only to the extension except for the explicitly scoped `outbox/audit.jsonl` append operation. It is deleted in teardown.

## Composition tree

```text
file-review-suite (parent entry)
├── document-reader (Tool: review_document)
├── review-console (UI: conversation.header + nested status slot)
└── review-policy (Service + Event/Listener + Hook + Timer)
```

The parent entry is enabled first. The loader projects only executable entries into runtime Fibers; grouping entries may remain Entry-only. The UI reports the persisted Entry Tree and active Fiber inspection separately, so the test can verify that the projection converges without treating the Fiber Tree as durable state.

## Real user flow

1. Maka receives: “Review the release notes and prepare an approval summary.”
2. The model invokes `review_document`; the Tool reads the fixture files and calls the policy Service.
3. The Service emits `review.started` and `review.completed`.
4. An around Hook records the real Tool call before and after execution, while an Event Listener persists the completed review payload.
5. The Timer writes an independent refresh heartbeat and the embedded UI contribution is projected into `conversation.header`.
6. The document is read again after execution to prove the model and extension did not edit it.
7. The test reloads the package bytes without changing Entry identity. The old Fiber remains usable until the candidate Fiber activates; a deliberately unhealthy candidate must fail and preserve the previous active Fiber.
8. Disable, restart, and re-enable verify persistence, scope isolation, and recovery.

## Assertions

- Entry Tree mutation is atomic and persisted.
- Runtime Fiber contains exactly the enabled child contributions.
- Tool invocation, Service call, Event dispatch, Hook ordering, and Timer tick are observable in isolated fixture outputs.
- Root UI remains native; extension UI is embedded in `conversation.header` and its nested slot.
- Failed activation does not replace the last healthy Fiber.
- Disabled entries disappear after restart and do not leak into another session scope.
- Maka source files remain unchanged; only the disposable fixture is modified.

## Test commands

Run the focused runtime-host coverage:

```bash
npm --workspace @maka/runtime-host run build
node --test \
  packages/runtime-host/dist/__tests__/extension-e2e.system.test.js \
  packages/runtime-host/dist/__tests__/extension-composition.test.js \
  packages/runtime-host/dist/__tests__/extension-controller.test.js \
  packages/runtime-host/dist/__tests__/extension-package-platform.system.test.js
```

Then run the real Electron lifecycle test. It installs one package containing Tool, UI, Event/Listener, Service, and Timer contributions, waits for its sandboxed UI to call the Host state/config bridge, and verifies disable, re-enable, and removal through the Desktop preload API:

```bash
npm --workspace @maka/desktop run build:with-deps
cd apps/desktop
npx playwright test extension-lifecycle.spec.ts --config e2e/playwright.config.ts
```
