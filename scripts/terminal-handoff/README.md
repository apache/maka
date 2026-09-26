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

# Real terminal handoff acceptance

Opt-in macOS/Linux test using a real model, Electron, Runtime Host, Unix PTY,
OpenSSH client and a loopback SSH server. It incurs provider usage. The fixture
does not modify the system SSH server or use the operating-system password.

After installing workspace dependencies, applying the repository dependency
patches and building Runtime Host and Desktop, install Paramiko in a temporary
Python environment. Put the provider key in a private file outside the checkout:

```sh
python3 -m venv /tmp/maka-handoff-python
/tmp/maka-handoff-python/bin/pip install paramiko
HANDOFF_PYTHON=/tmp/maka-handoff-python/bin/python \
HANDOFF_API_KEY_FILE=/path/to/private-key-file \
HANDOFF_BASE_URL=http://127.0.0.1:8080/v1 \
HANDOFF_MODEL=gpt-5.6-terra \
node scripts/terminal-handoff/real-model.mjs
```

The connection uses the custom Responses API with native `apply_patch` disabled,
so compatible providers need only support function tools. A transparent local
HTTP proxy checks every outgoing provider request for the generated test secrets;
it does not replace responses or rewrite tools. The real key stays in the test
process. Desktop's isolated profile contains only a proxy placeholder credential.

The test drives the actual password card through preload/main IPC, including
refresh with an unsubmitted draft, a rejected password and successful retry, a
second verification challenge, explicit Resume, a command
in the original shell, selecting a reviewed observation, and the model reading
that observation in the next turn. The server intentionally echoes both the
password and verification code, including a delayed echo after Resume.

Assertions cover provider requests, ordinary Session events, process/renderer
logs, live workspace files (including SQLite/WAL), and the closed Desktop profile.
The fixture prints an artifact directory containing three unmodified screenshots
and `result.json`. It does not capture authentication screens containing secrets.
Failures retain sanitized diagnostics. No profile or credential file belongs in
a commit; remove temporary profiles after reviewing them.

State ordering, input fencing and durable Interaction behavior have lower-tier
tests in Runtime and Runtime Host. This opt-in journey verifies the actual
Electron renderer/preload/main-to-Host boundary and real-provider tool discovery;
it does not add cases to the deterministic fake-backend E2E suite.
