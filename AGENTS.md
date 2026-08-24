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

# AGENTS.md

Guidance for AI coding agents working in this repository.

## Frontend work: query the Storybook MCP before writing UI code

UI code lives in `packages/ui` (shared components) and `apps/desktop` (desktop
app). Before writing or modifying UI code, discover what already exists through
the Storybook MCP server instead of reading component sources to guess props
and usage:

1. Start Storybook on demand (dev-only server; nothing auto-starts it):

   ```
   npm --workspace @maka/desktop run storybook -- --no-open
   ```

2. Connect to the MCP endpoint at `http://localhost:6006/mcp` (registered for
   agents in the root `.mcp.json`). The endpoint only responds while Storybook
   is running; if it is unreachable, start it as above.

3. Query, then write:

   - `list-all-documentation` — every documented story/component
   - `get-documentation-for-story` — props and usage for one story
   - `get-documentation` — docs entry for a component

Prefer composing existing `packages/ui` components. Introduce a new component
only when nothing existing fits, and give it a story so it becomes discoverable
through the same interface. Avoid adding third-party UI dependencies without a
clear need.
