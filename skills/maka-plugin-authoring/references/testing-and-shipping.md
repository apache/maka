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

# Validate the actual artifact

Compile UI source before inspecting the package:

```sh
maka application build-ui --entry ui.tsx --output ui-build
```

Stage the resulting module and assets according to `ui-build/manifest.json`, then compute and check the exact package reference:

```sh
maka application inspect-package --package plugin
maka application check --input composition.json --package plugin
maka application export-package --package plugin --output plugin.maka-plugin
```

Export creates a new file. A package check validates declarations and bindings, not handler or UI behavior. Exercise actual service calls and the contribution in the running workbench. For UI, check its command or view, configuration, update, disable and cleanup behavior. If it owns mutations, retain and recover the original receipt rather than replaying an unknown operation.

On macOS/Linux, copy `assets/starter/verify-host.py` beside `create.mjs` and `host.mjs`, then run `python3 verify-host.py --maka /path/to/maka`. The fixture generates an Echo package and an explicit consumer in a temporary Root, starts the real Host, verifies strings and invalid input, then closes and removes it. Its raw IPC code belongs to the launcher fixture, not plugin business code.

The starter's counter demonstrates local NSH state; Echo demonstrates a Host query. They do not need a model connection. Add durable effects through the service that owns the data when the feature needs them.

For an isolated Host test, initialize a Root with `maka host init --root PATH`, then commit its checked source using `maka application commit --root PATH --deployment UUID --expected-revision 0 --input composition.json --package plugin`. Updates use the observed revision and preserve instance identities. To exercise a UI plugin, install it into the existing business Host and insert its UI instance; do not replace unrelated business instances with the starter's one-node graph. Run `maka --root HOST_ROOT` to open the terminal client.

In a checkout, use focused behavior tests and SDK/product type checks. Rendering and input belong in the actual backend checks. Measure streaming input and scrolling with the release artifact and consistent feature flags. A separately built product artifact needs its own output directory; concurrent writers must not share `dist`.

[Runtime UI authoring](runtime-ui.md) lists the Agent tools for changing the connected source.
