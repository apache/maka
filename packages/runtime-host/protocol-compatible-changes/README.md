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

# Compatible protocol changes

`RUNTIME_HOST_COMPATIBILITY_EPOCH` is the generation Client and Host exchange at
handshake; a mismatch rejects the connection. The guard in
`scripts/protocol-epoch-check.mjs` therefore treats every touched file under
`packages/runtime-host/src/protocol/` as a protocol change and demands an epoch the
base branch has not seen. That proxy is deliberately coarse: a needless bump costs a
number, a missed one ships two incompatible protocols under one epoch (#3313).

A file here is the exemption, for a change the wire provably cannot observe:

```json
{
  "epoch": 121,
  "files": ["packages/runtime-host/src/protocol/codec.ts"],
  "reason": "Renames a local helper without changing any codec or message shape"
}
```

- `epoch` pins the declaration to the epoch your branch carries. When another change
  moves it first, re-pin, and re-read the reason: it has to still hold.
- `files` must name every protocol file your branch changed, or the guard fails on
  the ones it does not cover.
- `reason` is read by a human. Nothing checks it, so it earns its keep only by being
  specific about why no peer can tell the difference.

Legitimate: renaming or un-exporting an internal helper, moving a constant, tightening
a decoder to reject what it already rejected. Not legitimate: any new or removed field,
key, error code, or accepted value — those move the epoch, whatever the intent.

CI checks the whole branch against its base, so one declaration covers the PR. When a
later commit touches another protocol file, amend this file rather than adding a second
one. Declarations are read only while they are new to the branch; once landed they are
history, which is why the older files here still pin long-past epochs.
