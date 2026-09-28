# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

FROM base AS install
ARG MAKA_VERSION
RUN node -e 'if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(process.argv[1] || "")) throw new Error("MAKA_VERSION must be an exact npm version")' "$MAKA_VERSION"
RUN apt-get update \
    && apt-get install -y --no-install-recommends make g++ \
    && mkdir -p /opt/maka \
    && chown node:node /opt/maka
USER node
WORKDIR /opt/maka
# Verify the complete tarball, including bundled private @maka packages that
# cannot be checked individually with npm audit signatures.
RUN npm view "maka-agent@$MAKA_VERSION" dist --json --registry=https://registry.npmjs.org/ > registry-dist.json \
    && npm pack "maka-agent@$MAKA_VERSION" --ignore-scripts --json --registry=https://registry.npmjs.org/ > packed.json
RUN node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
const { integrity } = JSON.parse(readFileSync('registry-dist.json', 'utf8'));
const [{ filename }] = JSON.parse(readFileSync('packed.json', 'utf8'));
const actual = `sha512-${createHash('sha512').update(readFileSync(filename)).digest('base64')}`;
assert.equal(actual, integrity, 'maka-agent tarball must match the registry SHA-512 integrity');
renameSync(filename, 'maka-agent.tgz');
NODE
# Native dependencies such as node-pty need install scripts. Run them as node,
# only after the package bytes have been checked, and retain the install lockfile.
RUN printf '{"private":true}\n' > package.json \
    && npm install --save-exact --no-audit --no-fund --registry=https://registry.npmjs.org/ ./maka-agent.tgz \
    && test "$(node -p 'require("./node_modules/maka-agent/package.json").version')" = "$MAKA_VERSION" \
    && rm maka-agent.tgz packed.json registry-dist.json

FROM base
ARG MAKA_VERSION
LABEL org.opencontainers.image.title="Apache Maka (Incubating) CLI" \
      org.opencontainers.image.description="Developer convenience build; not an Apache Software Foundation release" \
      org.opencontainers.image.source="https://github.com/apache/maka" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$MAKA_VERSION"
COPY --from=install /opt/maka /opt/maka
RUN ln -s /opt/maka/node_modules/maka-agent/dist/cli.js /usr/local/bin/maka \
    && mkdir -p /workspace /home/node/.config/Maka \
    && chown -R node:node /workspace /home/node/.config
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "maka"]
CMD []
