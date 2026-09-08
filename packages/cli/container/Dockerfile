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

FROM node:24-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

FROM base AS install
ARG MAKA_VERSION
RUN node -e 'if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(process.argv[1] || "")) throw new Error("MAKA_VERSION must be an exact npm version")' "$MAKA_VERSION"
RUN apt-get update \
    && apt-get install -y --no-install-recommends make g++ \
    && npm install --global --no-audit --no-fund --registry=https://registry.npmjs.org/ "maka-agent@$MAKA_VERSION" \
    && test "$(node -p 'require("/usr/local/lib/node_modules/maka-agent/package.json").version')" = "$MAKA_VERSION"

FROM base
ARG MAKA_VERSION
LABEL org.opencontainers.image.title="Apache Maka (Incubating) CLI" \
      org.opencontainers.image.description="Developer convenience build; not an Apache Software Foundation release" \
      org.opencontainers.image.source="https://github.com/apache/maka" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$MAKA_VERSION"
COPY --from=install /usr/local/lib/node_modules/maka-agent /usr/local/lib/node_modules/maka-agent
RUN ln -s /usr/local/lib/node_modules/maka-agent/dist/cli.js /usr/local/bin/maka \
    && mkdir -p /workspace /home/node/.config/Maka \
    && chown -R node:node /workspace /home/node/.config
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "maka"]
CMD []
