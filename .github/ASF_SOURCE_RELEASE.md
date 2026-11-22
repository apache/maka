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

# ASF source release

Source candidates are created from an exact committed revision. Root package and lockfile versions must agree, and the archive excludes build products and local agent state.

```sh
just source <version> <commit>
node scripts/asf-source-release.mjs verify --artifact <archive.tar.gz>
```

The source-candidate workflow builds and tests the extracted archive, including its independent website. Review the archive, license inventory and verification results before signing:

```sh
node scripts/asf-source-release.mjs sign --artifact <archive.tar.gz> --key <fingerprint> --revision <commit>
node scripts/asf-source-release.mjs verify --artifact <archive.tar.gz> --keys <KEYS>
```

Signing reproduces the archive from the named commit before adding its signature. Follow the Apache Incubator release voting process; a GitHub prerelease or npm preview is not an ASF release.

Native npm artifacts are built from the verified source archive through `just package`. Collect the native packages and source together, run `just release-prepare`, and only then use `just publish` for the verified preview set.
