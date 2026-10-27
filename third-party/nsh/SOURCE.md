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

# Native Shell (NSH)

This directory initially imported the complete tracked source of
[`M4n5ter/nsh`, `tui/terminal-backend`](https://github.com/M4n5ter/nsh/tree/tui/terminal-backend)
at `de176695240d550f2b303643b8019146c7989e7f`. The upstream project is
[`longbridge/nsh`](https://github.com/longbridge/nsh).

`upstream.json` keeps that initial `repository` and `revision`. Its
`upstream_revision` records the latest integrated `longbridge/nsh` main revision:
`d4c43ea6bece16881a582275fdbeb754bebb3e4f`. The first upstream synchronization
starts from `6bb0b7908043132067456e4a21dd57c90a0bdce5`, already included in the
initial fork import.

`files` records each imported file's SHA-256. A `file_sources` entry identifies
the repository and revision supplying that file's current import baseline;
files without an entry retain the initial fork source. These hashes describe
source bytes, not later Maka adaptations or conflict resolutions (for example,
the README retains the terminal backend description). This is a mixed-source
vendor tree, not a claim that one upstream revision contains the fork features.
The source, tests, resources, original licenses and independent workspaces are
retained. `SOURCE.md` and `upstream.json` are Maka's provenance files.

The 0.3 API-home migration uses `nsh_core::element` and the root Rust prelude;
JavaScript host services live in `nsh`, mobile services in `nsh/mobile`, and
Input in `nsh/base`. Legacy external module names are not aliases. Selectable
views replace SelectionArea while retaining terminal cell-aware selection and
popup scope behavior. Application-owned Tooltip elements retain Maka's prior
bubble styling and reactive text; the obsolete string tooltip constructor is
not retained. Removal of the legacy Toast command does not remove terminal
`Surface::announce` visual accessibility announcements. Local retained-host,
focus-return and root-retirement safety, native keymap support, input editing,
and all fork-only resources remain part of the mixed-source tree. Deleted
selection, device, keymap and native-service pages move their local contracts
into the corresponding canonical documentation pages.

The subsequent bounded synchronization adds live slot bindings and sole-child
slot adoption, explicit nonpressable keyboard stops, listbox/option accessibility
roles, native navigation fixes, and Pie/Arc marks. Slot adoption does not replace
Maka's explicit Button trigger actions: Rust component hosts remain excluded.
The terminal and GPUI view-stop adaptations retain native component focus
capability, input exclusions, popup scopes and retirement ownership. Android
accessibility role indices 34/35 are separate from the preserved mount opcodes
34 (retire), 35 (project) and 36 (component slots). Cartesian stationary-hover
geometry refresh remains separate from selection notifications, while radial
placement follows the pointer without requiring a finite Cartesian x value.

The bounded RichEditor and typed-style synchronization through that revision
uses canonical typed styles for pointer events, text selection, line limits,
image fitting and box shadows. Direct Maka callers migrate with these APIs;
local selectable roots, source-backed TextView selection, Android mount opcodes
and terminal shadow rendering remain intact. Existing `ordered-float` 5.5.0 is
retained with the required core dependency edge rather than an unrelated upgrade.

This is a breaking source and bundle migration, not a compatibility alias layer.
Primitive `pointerEvents` moves into typed `style`; Text `numberOfLines`,
`ellipsizeMode` and `selectable` become style `numberOfLines`, `textOverflow` and
`userSelect`, and Image `resizeMode` becomes `objectFit`. Selectable View roots
and component-owned selection props remain distinct. Text, Image and Input
state styles use their respective typed style domains; canonical `line-clamp-*`,
`truncate`, `select-*`, `pointer-events-*` and `object-*` classes resolve through
those same style rules. Legacy single-shadow fields become `boxShadow` layers.
Consumers must regenerate declarations and rebuild old JS bundles with the
matching compiler/runtime; old prop or style aliases are not restored.
Maka's content-sized composer uses CSS `flex: initial`, and its conversation
wrapper explicitly keeps column layout when setting `display: flex`.
Retained terminal examples and selection/overlay documentation use the same
canonical primitive styles. A compiled-engine regression checks their mounted
values and reactive updates. A separate bundler smoke test compiles the retained
terminal workbench entry and its real import/asset graph. Neither test replaces
application TypeScript checks or mounted example UI coverage.

Independent local corrections retain RichEditor geometry on its owning thread,
retire its session subscription before dropping the geometry payload, and keep
host-specific keyboard conventions and explicit event policy. Plot stationary
geometry refresh also supports horizontal Bar bands without duplicate hover
notifications. Headless view focus commands follow mount-item order so later
blur and retirement decisions observe the current owner. The RichEditor terminal
sink uses the same leaf `BoxNone` and native post-mount `autoFocus` approach as
the code Editor; graphical backends and existing focus admission checks are not
weakened. These are local quality adaptations, not upstream import bytes.

The trailing-whitespace measurement integration preserves `TextEngine::measure_canvas`
for platform-specific advances (including the terminal font catalog), while
using upstream whitespace-inclusive measurement when that hook is absent.
Upstream selection/link geometry regressions and the local canvas override
regression are both retained.

The Editor / DiffView import adds their headless regressions, shared syntax
highlighting, per-engine registry setup, and pointer-event payload support.
Maka already passes `nsh_base::registry()` to its bundler and engine; these
components use that registration path rather than a second application runtime.
The iOS press bridge keeps the local owned `TextLink` representation while
forwarding upstream touch positions, modifiers and click counts. The shared
Unicode segmentation dependency follows upstream 1.13 for both the editor and
terminal backend. These integrations do not replace the local terminal input,
IME, completion or fallback-key capabilities described below.

The DataTable / Table import adds virtualized row and column views, table
accessibility roles, and pressable focus notifications through the existing
registry. The focus declarations retain the terminal scroll/list events and
input `focusable` behavior; headless keyboard focus coexists with the local
native contact and input-result tracking. Editor scheduling and idle collection
follow upstream's large-file work, without claiming its benchmark figures as
Maka measurements. The terminal input and lifecycle adaptations remain intact.

The pull-to-refresh import retains the terminal backend's existing physics and
48-point default refresh inset. A custom indicator uses its supplied height,
hides terminal spinner text, and receives pull distance through the existing
native animation value path. The iOS refresh replacement keeps pending-reveal
invalidation and the owned link-target representation. Shared text-engine hit
testing does not replace terminal cell-aware selection, IME or focus handling;
the new trait defaults estimate positions when a backend has no exact override.

The row-accessor import adds retained JS row values and typed key/function
accessors, plus timing and spring props. Generic component props default to
`any` when no rows infer their type; the local array/list-source overloads keep
their existing inference behavior. Component methods mark trailing `Option`
arguments optional in TypeScript. Their `Param` and `MethodSpec::params` tuples
now include the optional flag; Maka's bindings use the deriving macros rather
than constructing those tuples. Empty first canvas recordings are suppressed,
while an empty recording still clears an existing drawing.
The retained-row adaptation also treats a different JS retention handle as a
prop change even when numeric columns match, preserving arbitrary row fields.
QuickJS returns retained values only to their owning function table; foreign
hosts receive no value. Custom `JsHost` implementations that retain values must
implement `owns_retained` for their own handles. Rust-created rows retain their
numeric equality semantics; this is not deep JavaScript object comparison.

The local hint-observation integration retains an allocation lifetime separate
from the upstream layout tree's reusable slab index. This prevents a delayed
pointer observation from activating a newly allocated hint or anchor; the
existing hint-lifetime regression covers release and reuse. Keep this adaptation
until an upstream owner-identity mechanism provides the same guarantee.
The list integration also applies published source counts and splices before
issuing more paced bindings. This retains the fork's source-publication fence
while using upstream visible-first scheduling; regressions cover source changes
inside both visible and overscan row constructors.

The local GPUI text-input bridge exposes weak native editor identities through
`TextInputTarget`, including fields sharing one `AppView` focus handle. Targets
include the existing GPUI focus generation and the native `FOCUS` owner's weak
admission token, so leaving and returning to a field revokes its old target.
`TerminalPlatform::apply_composition` applies a committed prefix and remaining
preedit with selection offsets in UTF-16 code units, rechecks the original
editor after committing, and cancels temporary marks without committing them.
NSH owns the editor model and pixel rendering. Maka owns ordered delivery,
application admission and source-composition binding for the experimental
OSC 777 `nsh-text-input` extension; a matching terminal-side IME producer must
supply the composition snapshots. These local adaptations do not establish
stock-terminal support or end-to-end OS IME validation.

The code `Editor`'s terminal input sink uses `BoxNone` to leave pointer hits
with the underlying content while remaining a keyboard focus target. Its native
`autoFocus` prop handles initial focus after mounting; an early controller focus
request can precede attachment. Other renderers retain their existing sink
behavior, and terminal scope, disabled, ancestor and retirement checks remain
unchanged. This is a local integration correction, not an upstream sync.

The GPUI and terminal backends also implement node-scoped `Input.replaceRange`
for completion edits. The command checks the observed native edit count,
original text and UTF-16 selection before replacing a range in one undoable
edit; it does not simulate IME or clipboard input. Other backends retain their
existing unsupported-command behavior. These changes are local adaptations,
not changes to the recorded upstream import baseline.

The GPUI and terminal input editors also accept generic `tokens` rules. Native
Rust-regex captures derive styled ranges from the current committed source;
atomic ranges share caret, selection, replacement and deletion boundaries. The
native editor retains only the currently unfinished token beside its existing
text/selection undo snapshots. Plain text remains authoritative, and IME
preedit retains its existing separate display mapping. This is a local input
capability, not a Maka-specific parser or a hidden rich-text document format.

The terminal and GPUI backends support `keymap.bind(..., {fallback: true})`.
These bindings run after native controls, text editing, selection and navigation
have left a key unhandled, preserving native copy and earlier scoped bindings.
The backends declare this capability through `Environment.fallback_key_bindings`;
unsupported hosts reject fallback bindings. This local adaptation supplies a
generic input phase; application interrupt and exit policy remains with Maka.

The GPUI `AppView::paste` entry delivers a host-provided user paste through the
same focused-editor policy as the system clipboard. Terminal bracketed pastes
therefore report `onPaste` before the mounted `pasteBehavior` decides insertion,
while ordinary character and IME commits retain their text-input path.
Both backends interpret a complete pasted path list as file URIs only for an
input listening for file drops. Other input fields keep their literal text.
The file content is reported once through `onPaste`, or through `onFileDrop`
when no paste listener is mounted, without inserting the paths as text.

Maka's workspace uses these local crates, including NSH's offscreen renderer and
image codec; changing them here changes the code built and tested with Maka.

A manual dispatch of Maka's existing CI also runs the nested NSH core, base,
engine, JS, headless (with `agent`), terminal, bundler and development-tooling
(client/server) tests, followed by Web's portable `text` integration test.
This separate runner starts after Maka's test job, even if that job fails;
root workspace tests alone do not select these suites. A final, capacity-guarded
step selects the three animated-prop queue tests and the explicit-focus ownership
test in the owning GPUI workspace, verifies the three queue names and the exact
focus-test name, and runs them serially without opening a native window. The
focus test uses the production mounter, stop collection and activation helpers;
it does not validate OS-window focus dispatch. That workspace uses its own lock
and patches, not Maka's complete root dependency
graph; sharing a target directory does not imply equivalent cached artifacts.
Both vendored GPUI owning workspaces (`crates/gpui` and `examples/embed-gpui`)
explicitly reuse Maka's existing GPUI core, native platform, scheduler and
`async-io` path patches. The preserved input-target admission and cancellation
wake contracts depend on those adaptations; registry GPUI alone does not expose
them. These workspaces therefore require the containing Maka checkout, without
changing the root shipped dependency graph or disabling the local IME support.
The portable Web test does not validate browser rendering, and these selected
tests do not validate native platform runtimes or the `bundle`-gated testing
suite. A storage guard or timeout leaves the GPUI coverage incomplete.

Develop and verify changes in this tree together with their Maka callers. Send
reusable changes to `longbridge/nsh`. When synchronizing the fork or upstream,
review local differences against the recorded revision, use upstream APIs and
recommended patterns where appropriate, and remove patches that upstream has
superseded. Refresh the recorded source hashes to the newly imported revision;
they describe the import, not later Maka modifications.


The Plot and shared-gallery import keeps the base library unstyled: shared demo
finishes live in the private `examples/nsh-gallery-ui` source package, without
new external dependencies. Native component animated props use stable named
slots. The terminal backend evaluates those slots through its existing Graph,
retains prop-response events and intrinsic sizing, and resets delivered values
when bindings or component identity change. Android reserves opcode 36 for
component slots, preserving the local retirement and root-projection opcodes
34 and 35. These are local wire adaptations, not upstream source hashes.
Host theme tokens are available before first JS evaluation without dropping
other queued engine messages. The existing terminal lifecycle, retained-row
host-identity checks and focus regressions remain in place. Native platform
runtime and gallery appearance checks require their supported environments;
Linux core tests are not evidence of those visual checks.

The synchronization through `d4c43ea6` adds the Shader view, held typed-ahead
text in GPUI fields, arrow-key movement in `Tabs` and `RadioGroup`, RichEditor
keys chosen by the engine's OS, one unit per quantity, Android density remount,
`nsh/base` registry parts and the browser-engine web runtime. The GPUI hold
queue wraps the local `set_focus_target` transition, so inline-link targets and
focus admission tokens remain; any focus move arms it, and hover hint
observations are not counted as engine events. Core creation and remount share
`mount_state`; list cells keep the local publication path, and a remount does
not clear a list's mounted cells. Only `sticky_ranges` is added beside the
local sticky handling. `TextViewLinkTarget` registers with the `text_view` part.
Android's Shader mount item takes opcode 37, after the local 34 to 36. The
terminal backend ignores Shader mount items, so a shader view shows its
background and children. `wgpu` and `naga` follow version 30, which Maka's GPUI
build already uses, instead of upstream's 29; the shader readback keeps its
previous frame when wgpu 30 cannot map a range. Maka's root dependency graph
gains no packages from this synchronization.
