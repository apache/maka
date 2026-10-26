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

# Playwright browser utilities

`injected.js` is the unchanged `source` string published in `playwright-core`
1.58.2's `lib/generated/injectedScriptSource.js`. It comes from the
[official npm package](https://registry.npmjs.org/playwright-core/1.58.2), independently
of any reference application. The corresponding upstream revision is recorded in
[upstream.json](upstream.json), together with archive integrity and file hashes.
Upstream's Apache-2.0 license, notice, and bundled third-party notices are preserved.

Maka loads these utilities into an isolated world on its existing CDP connection.
It does not install the npm package or launch a Node process during native builds
or browser use. The typed Host protocol selects the supported operations.

Verify the vendored files offline:

```sh
node scripts/computer-use-parity/update-playwright.mjs --check
```

Recreate them from the pinned upstream archive with `--refresh`. This checks both
the npm SHA-512 integrity and recorded SHA-256 before extracting only the named
members. No package module or install script is executed.
