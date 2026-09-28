<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Private terminal handoff

For [#5309](https://github.com/apache/maka/issues/5309), an agent can request
human input in its existing background PTY. Desktop shows the original command,
execution-host identity and terminal ref, and uses the same `ChatComposer`,
`TextInput` and buttons as existing user interactions. Submitting one private
line and returning control are separate actions. Resume records the user's
decision, not a claim that authentication succeeded.

**Open acceptance gap:** the manual sharing mechanism has been removed. The
agent can resume writes in the original terminal, but cannot yet observe its
post-handoff results. Output remains private until a replacement boundary has
been validated. This is not a complete implementation of issue #5309's result
observation requirement.

The agent decides when to request this capability through a structured tool
call. Neither chat keywords nor a password prompt automatically opens the card.
Supported sessions advertise discovery from the existing Bash description:
starting a PTY alone does not reveal the private input surface. The discovered
WriteStdin description teaches the action; the UI responds only to the
validated `terminal_handoff_request` event.

## Feedback and recovery

The transport reports submission, definite rejection, uncertain delivery and
process closure independently of authentication. Invalid single-line input is
rejected before sending and can be corrected. A lost connection clears the
private display/draft and disables Submit and Resume. Reconnect reclaims the
original resource without replaying input; an uncertain receipt remains fenced.
Process exit, cancellation and an unavailable original process have distinct
closed-card messages and do not retain private output.

The explicit **Done, continue task** action confirms completion and resumes the
original terminal in one click. There is no second confirmation checkbox.
Unsubmitted input, uncertain delivery, disconnection and a recognized pending
password prompt block Resume. Clicking the action is a user attestation, not
automatic proof of login success; receiving output never resumes automatically.
An eye button lets users inspect their own draft. It defaults to masked and
returns to masked on submission, clearing, hiding, disconnection or completion.
Reveal does not send the draft or make it available to assistant observations.

Completion removes the input card, its header, details and action buttons. The
terminal remains a private, read-only display using the same capture fence and
original process. Reloading or switching tabs restores that display without
reopening the input flow. Another handoff request creates a new input card.
While the initial phase is unknown, only the terminal loading container is
shown. A registration failure exposes reconnect instead of leaving a spinner.

During input, one message describes the current actionable state: uncertain
delivery takes precedence over a disconnected surface, invalid input and a
recognized authentication rejection. Ordinary submission/prompt feedback is a
short status line. The original command stays visible so the user can check its
destination; the agent's explanation, full Host identity and resource ref live
in collapsed connection details.

Renderer-only program adapters may translate known prompts into fixed friendly
hints. The first adapter covers the standard English OpenSSH password prompt and
`Permission denied, please try again.` followed by a new password prompt. It
also blocks Resume while that prompt remains visible. It never classifies an
arbitrary output as successful authentication, changes transport state, publishes
output or sends input. Unsupported programs, compound commands, prompts and
locales retain the original private response. Additional verified programs can
extend the pure renderer function; there is no registry for the single current
recognizer, and no SSH logic belongs in the Host.

## Owners and extension points

- `ShellRunProcessManager` remains the sole process/PTY owner. The
  `PtyHandoffController` interface exposes prepare, private input, private
  observation and resume. There is no private-output publication operation.
- `HostRuntimeResourceCoordinator` owns resource serialization and a volatile
  controller identity/sequence. The existing Interaction coordinator owns the
  pending request, durable decision, Run cancellation and Session projection.
- Workbar owns Desktop surface registration. Restored cards await its shared
  registration promise before claiming a controller; cards never advertise a
  second surface. Host resync invalidates that promise, and a failed registration
  can be retried. The display carries text only: `phase` controls the UI, while
  Runtime retains its internal input fence.
- `WriteStdin({ref, handoff: {message}})` waits on that Interaction. It is offered
  only when an interactive Desktop surface is registered for the Session and
  the platform provides an input fence. No new task, shell or terminal process
  is created. Ordinary actions and handoff are mutually exclusive.
- `runtime.resource.handoff` is a bounded, nonjournalled `control` operation.
  Its private payload never becomes a model tool argument or generic form
  answer. The canonical answer contains only resume/cancel; the live answer
  also carries the controller identity for stale-card fencing.

This boundary can support other terminal workflows without recognizing SSH,
sudo or password-prompt strings. The current UI submits one line at a time;
arbitrary human TUI keys/mouse input and additional authentication adapters can
extend the private control path without changing process ownership or using
chat drafts.

## Input and lifecycle guarantees

Admission changes the resource's input epoch. Previously queued agent writes
cannot cross this boundary. The Unix driver owns a bounded nonblocking write
queue and drains earlier accepted bytes to the OS before the human can write.
This is not a claim that the child already consumed those bytes.
Each actual write uses the pinned node-pty patch's synchronous writer and its
own write-stream/socket close fence. Runtime never retains a raw fd for writes:
Linux PTY masters can share the same `fstat` identity even after fd reuse.
Expected input closure drops pending bytes without reporting an integrity fault.

Each private submission has a monotonically increasing sequence and an identity
scoped to the original live request and authenticated connection. Duplicate
delivery returns the recorded receipt without rewriting bytes. A delivery
failure returns `outcome_unknown`, never retries, and prevents additional input
or Resume; stopping the terminal remains available. Ordinary terminal controls
cannot bypass the handoff path.

Disconnect releases the controller, not the input fence. Reattaching or
refreshing claims a new card identity on the original PTY; old identities lose
write/Resume authority. A missing renderer has a bounded readiness deadline;
human input itself has no handoff deadline (the original process timeout still
applies). Cancel, Turn stop, resource exit and Host shutdown close the pending
Interaction. A restarted Host does not recreate a lost authenticated process.

The authenticated PTY belongs to the task, not the conversation turn. Later
turns can write to the same resource without another password while it remains
alive. Its configured process timeout still applies; another message does not
renew it. Losing only the Desktop surface does not imply that SSH disconnected.

Hiding a resumed card releases only its controller. Returning, including after
reload, can still display the same private output to the user. Only closed
tombstones have a 128-entry retention cap; live resumed terminals remain tied to
their resource lifetime. Resume rechecks delivery certainty inside the resource
queue. A failed terminal side effect rejects that handoff without poisoning the
Host's Interaction authority for other tasks.
An already-open terminal tab refreshes its request from the canonical handoff
event if the same process needs human input again.

The authenticated owner/grant is the authorization boundary, not a particular
Desktop device. While a card owns a handoff, other connections cannot reclaim
it. After release/disconnection, another authorized client of the same owner
may register a private surface and claim it; the old controller then expires.

## Output privacy and the unresolved result boundary

Before the first human write, PTY output switches to a separate volatile parser.
The normal parser, raw replay buffer, Session projections, tool results and
storage receive no subsequent private bytes. **This remains true after Resume**:
an arbitrary terminal can echo credentials late, and changing visibility based
on timing, an echo flag or password matching would not provide this guarantee.

Resume discards the authentication display and returns agent write authority.
New output remains private. Selection, sharing UI, the Host protocol action and
the Runtime publication method have all been removed. An old client cannot
publish text through that removed protocol action. Resume does not publish any
terminal text. The agent can continue writing commands, but must report its
inability to observe the result rather than claim success or ask the user to
copy private output into the conversation.
Terminal device/status queries are answered by the private parser directly to
the PTY, so interactive programs still work after Resume; replies and screen
contents are not published to the model.

Private buffers stay in the live process and visible renderer. Drafts clear on
submit, hide, refresh and completion. Desktop computer-use calls are fenced
while a private surface is visible, and mounting waits for in-flight capture to
settle before allowing private display/input. This is an application boundary,
not protection against an external screen recorder or a malicious local process.

## Supported scope and acceptance

The first implementation supports Unix PTYs on macOS/Linux. Windows and
headless clients do not advertise the handoff action until they implement the
same input-fence and private-surface contract. Remote transport continues to use
the existing authenticated Runtime Host connection; a remote-host acceptance
run and Windows ConPTY support are follow-up work. No permission mode changes
occur during handoff or Resume.

The opt-in [real-model harness](../scripts/terminal-handoff/README.md) was run on
macOS with `gpt-5.6-terra`, a real local OpenAI-compatible endpoint, actual SSH
password authentication (including rejection and retry) and a second terminal
challenge. The follow-up natural-language journey names no tools or handoff
parameters: the model discovers the capability itself. The original shell's
unexported marker and `/tmp` working directory survived in the private display.
The current harness checks that this result is not silently published after
sharing removal. Its report marks `fullIssueAcceptance: false` and
`automaticResultObservation: false`; passing the scoped input/continuation tests
does not mean the original issue is complete. Reload clears the unsubmitted
password and recovers the same handoff. The resumed private display also survives
collapse/expand, changing terminal tabs, and reloading. In the latest run, two
additional conversation turns reused that same connection without another input
card. Fourteen provider requests, 19 workspace files and 69 live-profile files
contained neither test credential. The App remained open, so the profile scan
was performed before shutdown.

The latest simplification is validated without screenshots. Earlier review
images remain historical evidence and do not represent the current layout.

The normal terminal wrapper uses lifecycle/resync events instead of permanent
lookup polling. Private text is polled only by the mounted active card, avoiding
a second retained output subscription or replay store. No credential store,
generic secret form, Session clone or automatic output-unprotect abstraction was
introduced.

Two process-local ablations validated the boundaries: removing private-output
isolation made the real PTY test detect a secret in a public projection; removing
the input-epoch check allowed a queued pre-handoff agent write through and failed
the coordinator regression. Both protections were retained. The mutations were
applied only through a test-process module loader, never to the running app or
the committed implementation.

The UX ablation removed the checkbox and tested the actual product contract:
rendering a ready-looking prompt never resumes; one deliberate completion click
resumes the original request; uncertain delivery, disconnect, a pending password
and an unsubmitted draft remain fenced. All five checks passed, so the redundant
checkbox/state was removed. The earlier checkbox-specific regression merely
pinned that UI choice and did not establish its necessity.

The next simplification merged duplicate connection flags and removed the
single-program adapter registry. Existing feedback/recovery checks still pass.
Removing the uncertain-delivery latch in a process-local ablation made a later
healthy observation re-enable completion after a lost submission receipt, and
the recovery regression failed. That necessary memory remains in the existing
notice state; no separate uncertainty boolean is required.

The surface-ownership ablation removed the card's second advertisement and the
unused `display.inputOpen` field; restoration, retry and Runtime privacy checks
still pass. Removing the shared-registration wait instead caused a restored
card to claim control before its surface was available. Removing the initial
loading branch brought back the old input card while the authoritative phase
was pending. These two guards remain; they require no additional UI state.

Two further real-PTY ablations exposed the output-policy problem. Removing
publication leaves the model unable to read the requested command's result.
Making new output public after Resume leaks the fixture's delayed credential
echo. Sharing has now been removed as requested; the remaining result-observation
gap is explicit rather than hidden behind a replacement confirmation.

An isolated parser experiment also rejected automatic matching of submitted
values as a substitute for that boundary. It hid complete echoes, pending
prefixes, SGR-separated text and line wrapping, but a cursor edit deleting an
already-masked prefix revealed the remaining credential fragment. An encoded
credential also escaped exact matching. No such experimental filter is used by
the product. Adapters remain renderer-local functions rather than introducing
a plugin registry or another lifecycle owner.

The review follow-up replaced the Driver's fd fingerprint with node-pty's own
close fence. A Linux two-PTY ablation removed that fence while retaining all
other code: the old terminal's queued test password reached the replacement PTY
and the regression failed. The restored fence passes on Linux; macOS also
passes the read-stream-close variant. The fingerprint abstraction was removed
from the Driver because it cannot prove PTY ownership.
