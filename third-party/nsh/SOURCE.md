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
`2c2a1767b2dce124905b911d92d30c490446e036`. The first upstream synchronization
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

Maka's workspace uses these local crates, including NSH's offscreen renderer and
image codec; changing them here changes the code built and tested with Maka.

Develop and verify changes in this tree together with their Maka callers. Send
reusable changes to `longbridge/nsh`. When synchronizing the fork or upstream,
review local differences against the recorded revision, use upstream APIs and
recommended patterns where appropriate, and remove patches that upstream has
superseded. Refresh the recorded source hashes to the newly imported revision;
they describe the import, not later Maka modifications.
