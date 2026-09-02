# Shared `maka.cu.windows/0` comparison contract

`protocol-contract.json` is the machine-readable source for the C# and Rust
comparison. The harness treats both executables as opaque helpers; it never
branches on language or executable name.

The resulting `comparison-results.json` stores `subjects[]` entries with an
artifact fingerprint (`path`, `sizeBytes`, `sha256`, `lastWrite`) and nested
`runs[]`. Each run records the complete Node command/argument array, working
directory, duration, exit code/signal, parsed checks, and complete raw
stdout/stderr. The top level records fixture artifact metadata, Windows/arch,
Node version, contract SHA-256, harness SHA-256, and `startedAt`/`finishedAt`.
Its summary has three levels: subject state counts, per-driver state/check
counts, and per-check pass/fail/blocked counts.

## Wire contract

Both helpers speak UTF-8, LF-delimited JSON-RPC 2.0 over stdin/stdout. Request
IDs are preserved in responses. A request without an ID is a notification and
must not produce a response, including `$/cancel` notifications. The harness
uses a 10 s handshake deadline, a 20 s request deadline, a 3 s WGC frame
deadline, a 2 s cancellation grace, and a 1 s shutdown grace.

The shared security assertions are behavioral: the host supplies an explicit
HWND; observation returns a target process/window generation and opaque
snapshot-scoped RuntimeId tokens; actions spend snapshots before mutation and
revalidate HWND/PID/process-start/window-generation/RuntimeId; and unknown
outcomes are never upgraded to verified. Both implementations expose the same
UIA action vocabulary: `set_value`, `click_element`, `select`, `toggle`, and
`scroll`. `scroll` accepts `direction` (`horizontal` or `vertical`) and an
explicit amount (`small_increment`, `small_decrement`, `large_increment`,
`large_decrement`, or `no_amount`).

`press_enter` remains deliberately typed as `status=refused`,
`reason=unsupported_enter`; it never implies keyboard input. The explicit
compatibility tier is opt-in through `authorize_compat`, followed by exactly
one `act` using `compat_type_text` or `compat_press_enter`. Authorization is
opaque, process-local, five-second, one-shot, and bound to the exact snapshot,
RuntimeId, HWND/PID/process start/window/helper generation, operation and
bounded payload. Before the one `SendInput` batch the helper must confirm the
target top-level window is foreground and the exact UIA element is focused;
failure consumes both capabilities and returns typed `refused`. Text rejects
control characters and is limited to 1024 characters. Missing readback,
including generic Enter, is `unknown`, never task success, and is never
replayed.

## Cancellation and lifecycle

`$/cancel` acknowledges the cancellation request separately. The original
request must still settle. If dispatch has not started, an `act` returns the
typed refused outcome `reason=cancelled_before_dispatch` and `snapshotSpent=true`.
After dispatch, the helper reports the actual or unknown operation outcome and
never claims that cancellation undid a provider mutation. A blocked provider
does not block the control plane; the supervisor force-terminates the helper
after 2 s and starts a new helper generation. Parent death, stdin EOF, and
shutdown are bounded and cannot leave a helper waiting indefinitely.

## SetValue readback (2026-09-02)

Both helpers dispatch `ValuePattern.SetValue` once, after spending the snapshot.
Only post-dispatch reads may retry: 1000 ms monotonic budget, up to 21 probes,
50 ms between mismatches (clamped to the remaining budget). Each probe checks
the saved HWND/PID/process start/window generation and exact element RuntimeId
before and after a freshly acquired **current** ValuePattern read. It does not
re-match another element by name, reuse Cached.Value, or inspect Document text.
Input and accepted readback text are capped at 1024 Unicode scalar values.

Password/identity/read errors terminate verification conservatively. Cancellation
during verification returns `unknown`, not a claim that the write was undone.
A provider error after SetValue dispatch also returns `unknown`. A match received
after the verification deadline is not accepted. These checks cannot preempt an
individual blocked COM call; the existing host grace/kill/restart remains required.

The optional `outcome.readback` object records phase-local `status`, `verification`,
`attempts`, `elapsedMs`, `maxMillis`, `intervalMillis`, and `source`. It is null if
the action did not reach the verifier. The enclosing outcome is authoritative:
final target revalidation can downgrade a locally matched readback to unknown.
Independent fixture/page completion evidence never rewrites this outcome.

`value-readback-cases.json` is shared by the C# policy tests and Rust unit tests.
`value-readback-harness.mjs` uses a real WPF ValuePattern provider with deliberate
staleness/errors and an independent mutation counter; it also tests spent-token
replay, password transitions, cancellation, target invalidation, and close.

## Directional scroll readback (contract revision 0.1.1, 2026-09-02)

This explicitly tightens the earlier private comparison contract: `scroll`
requires the token's own **ScrollPattern**. ScrollItem-only elements no longer
advertise the `scroll` action; submitting it returns `refused` without calling
`ScrollIntoView`. No `scroll_into_view` operation is added by this change.
The wire protocol name remains `maka.cu.windows/0`; this is not a public backend.

Preflight reads Current axis state, rejects unscrollable axes, non-finite or
out-of-range percentages, and the requested end boundary. `no_amount` remains
syntactically accepted but is explicitly refused as `scroll_no_amount`; a no-op
cannot claim `effect=scrolled`. Accepted attempts still spend their snapshot.

One Scroll call is followed by fresh, read-only Current ScrollPattern probes
against the same saved target identity and RuntimeId, checked before and after
each read. The monotonic budget is 1000 ms, interval at most 50 ms, cap 21 probes.
Only a finite percentage in [0,100] moving in the requested direction verifies
the operation. Unchanged positions may retry; wrong direction, invalid values,
lost axis, identity/read failure or cancellation stop with unknown. Provider
errors after dispatch are unknown, since the operation might already have run.
Late values are rejected; an individual COM call is still not preemptible.

`outcome.readback` records the common phase-local fields plus `direction`,
`amount`, `beforePercent`, and bounded `samples[{elapsedMs,percent}]`.
Unavailable/non-finite samples serialize as null, never as a fake zero.
`source` specifies CurrentHorizontalScrollPercent or CurrentVerticalScrollPercent.
Observe optionally exposes `scrollState` with current horizontal/vertical
percentages (-1 means the axis does not scroll; non-finite values become null).
Neither subsequent observe evidence nor a page oracle rewrites the original
action outcome. Position confirmation is not a claim that a whole-page task
or any particular pixel-distance request has completed.

`scroll-readback-cases.json` is shared by both pure policy suites.
`scroll-readback-harness.mjs` drives the same real WPF IScrollProvider fixture
against both artifacts, with independent position/mutation-count evidence.

## Capture

`capture` accepts the same HWND and `windowGeneration` returned by `observe`.
An available result is a bounded PNG/base64 frame with path
`wgc_createforwindow`, created through `IGraphicsCaptureItemInterop.CreateForWindow`
and D3D11 staging readback. Any unavailable path is typed as
`status=unavailable`, `path=none`, and a `capture_unavailable:` reason. GDI,
desktop/screen-rectangle, foreground, and covering-pixel fallbacks are not
part of the contract.

## Harness invocation

Build/publish both helpers and run:

```powershell
node comparison-harness.mjs `
  <csharp-helper.exe> `
  <rust-helper.exe> `
  <fixture.exe> `
  --out comparison-results.json
```

The harness runs the same fixture binary and the same existing lifecycle and
protocol regression drivers for both opaque executable paths, sequentially,
and stores raw stdout/stderr plus parsed PASS/FAIL checks in the JSON output.
Each driver has an expected check count and summary sentinel; any emitted
`FAIL`, missing check, missing `failures=0`/`protocol failures=0`, non-zero exit,
or empty/malformed output fails closed. An unavailable desktop, missing
executable, or driver timeout is represented as `blocked`; it is never
converted to `pass`.

## App-task harnesses

`app-task-harness.mjs` runs the same semantic and explicit-compatibility checks
against both helpers and the temporary WPF fixture. Its `executionState` is the
task-success field: only a verified mutation/readback is `pass`; unsupported or
focus-refused compatibility input is `blocked`, while
`contractConformance=pass` records that the refusal was typed and safe. A
post-dispatch unconfirmed result is `unknown`, never `pass`. Separate
`securityChecks` cover missing-token, payload/op confusion, reuse and
cross-snapshot negatives; these are conformance checks, not user-task
successes.
`browser-task-harness.mjs` launches Chrome with a temporary profile and
a local page only; unavailable Chromium UIA patterns are recorded as
`blocked`. `real-app-probe.mjs` records read-only availability and app
versions. LibreOffice and WinUI/UWP are not converted to pass merely because
an executable/package is installed.
