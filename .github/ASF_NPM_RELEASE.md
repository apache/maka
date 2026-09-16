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

# Apache Maka npm source-RC preflight

This runbook validates the `maka-agent` npm convenience artifact while an
Apache Maka (Incubating) source release candidate is under review. The source
archive is the ASF release artifact. The npm package is published only after
the source release is approved, from the exact approved commit.

This follows the practice used by Apache OpenDAL while incubating: its Node.js
workflow validated release-candidate tags without publishing, and a final tag
on the same commit triggered npm publication after approval. OpenDAL's ASF
distribution contained the signed source release, not a separately signed npm
tarball.

## Preflight contract

The workflow:

- runs only in `apache/maka` from an annotated
  `v<version>-incubating-rc<rc>` tag;
- requires that tag to resolve to the dispatched commit on `main`;
- requires the source-tag version to match the root, Desktop, and CLI product
  versions; and
- builds one clean-source npm tarball and validates that artifact across the
  supported Linux, macOS, Windows, and Eval matrix.

The resulting workflow artifact is diagnostic evidence for the source RC. It
is not an ASF release artifact or the npm publication input. The workflow has
no publishing credentials and cannot stage a package, publish a version, or
move a dist-tag.

## Run the preflight

Dispatch **Validate ASF npm package from source RC** from the exact source
candidate tag:

```sh
version="$(node -p 'require("./package.json").version')"
rc=1
source_reference_tag="v${version}-incubating-rc${rc}"
gh workflow run asf-npm-candidate.yml --ref "$source_reference_tag"
```

A successful run shows that the package can be built and installed from the
candidate commit on the supported matrix. It does not authenticate the source
tag signature or establish that either required source-release vote has
passed. Those remain responsibilities of the source-release process.

If the source candidate changes, create a new source RC and run the preflight
again. Rerunning the preflight for the same commit is safe because it has no
registry side effects.

## Publication boundary

After both source-release votes approve the candidate, the product Release
workflow creates `v<version>` at that approved commit. The npm Stage workflow
then builds and validates one tarball from that final tag in jobs without OIDC. The OIDC job runs
only reviewed `main` publisher code, submits those exact bytes through the main-restricted
`npm-publication` Environment, and records both product-source and publisher identities. Human approval with npm 2FA makes the package
public; Finalize verifies the registry bytes, integrity, signature, provenance,
and dist-tag.

The npm tarball therefore does not need an ASF detached PGP signature, an ASF
SHA-512 sidecar, inclusion in `dist/dev` or `dist/release`, or byte identity
with a pre-vote build. Its release identity comes from the approved source
commit and final product tag; its publication integrity comes from npm staging,
Trusted Publishing provenance, and the registry verification performed by
Finalize.

The project currently retains `maka-agent`, but must record explicit mentor or
ASF Brand confirmation before the first compliant publication. The Incubator
npm guide shows an `apache-<project>` name, while Apache OpenDAL published the
unprefixed `opendal` package throughout incubation. OpenDAL's package predates
its incubation entry whereas `maka-agent` does not, so that precedent supports
asking to retain the name but does not settle Maka's naming decision.

## References

- [ASF Incubator distribution guide: npm](https://incubator.apache.org/guides/distribution.html#npm)
- [ASF Release Policy](https://www.apache.org/legal/release-policy.html)
- [OpenDAL incubating release guide at v0.44.0](https://github.com/apache/opendal/blob/v0.44.0/website/community/committers/release.md)
- [OpenDAL incubating Node.js workflow at v0.44.0](https://github.com/apache/opendal/blob/v0.44.0/.github/workflows/bindings_nodejs.yml)
- [OpenDAL 0.44.0 source artifacts in the ASF archive](https://archive.apache.org/dist/incubator/opendal/0.44.0/)
- [OpenDAL current Node.js release workflow](https://github.com/apache/opendal/blob/main/.github/workflows/release_nodejs.yml)
