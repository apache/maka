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

# Source headers

First-party source files carry the ASF header. The audit recognizes the header inside the file type's comment syntax and permits a preceding shebang; SQL accepts block and `--` comments with horizontal spacing differences in the license lines, preserves recognized headers byte for byte, and uses block comments for new headers. Third-party source keeps its original attribution.

```sh
node scripts/asf-license-headers.mjs check
node scripts/asf-license-headers.mjs check --report
node scripts/asf-license-headers.mjs write
```

`check` audits source files, including unignored new files; `--report` lists resolved exclusions. `write` adds headers to covered files. The pre-commit hook uses `check-staged` to inspect staged bytes. CI and source-release verification run the repository audit.

Covered extensions and names, exclusions, and reviewed provenance decisions live in [scripts/asf-license-headers.mjs](../scripts/asf-license-headers.mjs). Exclusions identify specific files or bounded source sets and state why a header does not belong. They cover upstream source and license texts, generated or verbatim payloads, byte-significant fixtures, formats without comments and binary assets. A failing audit alone is not a reason to add an exclusion.

SPDX identifiers, copyright lines and adaptation notices require a reviewed provenance decision before a whole-file ASF header is accepted. The scanner can identify these markers; it cannot establish ownership or licensing by itself. Keep third-party and mixed-origin attribution in [LICENSE](../LICENSE), [NOTICE](../NOTICE) and the relevant source record. Ownership questions require project review.

When adding a source format, update the coverage rules and run the writer. When changing an exclusion, review the resolved file list so the rule does not silently exempt unrelated files.
