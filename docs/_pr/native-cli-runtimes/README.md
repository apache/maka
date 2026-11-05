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

# Native CLI settings evidence

These images are cropped rasterizations of the actual NSH
`AppView::render` / Ratatui buffers captured by
`external_agents_ui_consent_native_catalog_cache_and_failure_isolation`.
They are not desktop screenshots or UI mockups. The test uses a real isolated
Host and the settings plugin with fixture CLI discovery; real CLI execution
and resume are verified separately.

The 180×160-cell captures retain their original RGB colors, symbols and layout.
The images show columns 34–145 and rows 50–110, rasterized at twice the original
8×16 cell size with Menlo. PNG metadata records each source buffer's SHA-256.

Reproduce the source captures:

```sh
MAKA_NSH_EVIDENCE=/tmp/native-cli-ui-evidence \
  cargo test -p maka-cli --test integration \
  external_agents_ui_consent_native_catalog_cache_and_failure_isolation -- --nocapture
```

## Runtime selection

![Native runtime selection](native-external-runtimes.png)

## Full-access consent

![Native full-access consent](native-external-consent.png)
