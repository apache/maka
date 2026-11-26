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

# `maka-agent`

`maka-agent` is a convenience alias for [`@maka-agent/cli`](https://www.npmjs.com/package/@maka-agent/cli). Installing either package provides the `maka` command backed by the matching native platform binary (`darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`, or `win32-x64`).

```sh
# Stable release (once published on @latest):
npm install --global maka-agent
# Developer nightly build (unofficial, NOT an ASF release):
npm install --global maka-agent@nightly
```

Official Apache Software Foundation releases are the signed source archives at [maka.apache.org/en/downloads](https://maka.apache.org/en/downloads/). Pre-built npm packages are convenience binaries, and `@nightly` builds are unofficial developer previews not approved by an ASF release vote.
