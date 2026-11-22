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

# gix-index long pathname padding

Sources are copied from the published `gix-index` 0.58.0 crate at
[upstream revision dd39fb66e3b1551c9fe849043e39b357a9799ca1](https://github.com/GitoxideLabs/gitoxide/tree/dd39fb66e3b1551c9fe849043e39b357a9799ca1/gix-index).
Original Apache-2.0 and MIT license texts are preserved. `upstream.json` records
the original file inventory and SHA-256 hashes before the local patch,
along with the published crate checksum. The normalized manifest and production
dependencies remain unchanged. Registry installation metadata and the upstream
build lockfile are omitted.

The only runtime change is in `src/decode/entries.rs::load_one`: version 2 and 3
index entries whose pathname length uses the `0xFFF` sentinel now consume the
same terminating NUL and alignment padding as shorter pathnames. Previously the
sentinel branch consumed only one NUL and left any remaining padding to be
parsed as the following entry or extension. Both branches now determine the
pathname length, split immediately before its NUL, and use the existing
entry-relative padding calculation. Version 4 prefix-compressed paths remain
unchanged because that format has no alignment padding.

This corrects the dependency parser for original valid index bytes. The
application does not rewrite an index, select a different index version, add an
alternate parser, or materialize a raw Git pathname. The existing workspace Git
fixture exercises a real version 2 index with 4097-byte and 4100-byte paths,
compares complete staged patches with Git, and verifies the original index and
HEAD bytes remain unchanged. The two entries cover both a single terminating NUL
and additional alignment padding. Validation of this local patch is performed
with the combined repository checks; source provenance alone is not a passing
runtime claim.
