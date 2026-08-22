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

# Maka documentation

This page is the authority map for Maka documentation. Code and contract tests remain the final authority when documentation disagrees with the implementation.

## Where information belongs

- Root and package READMEs describe stable product entry points, public seams, and local ownership.
- `docs/` contains current cross-cutting architecture, security, product, and validation contracts.
- GitHub issues and pull requests contain implementation plans, migration progress, and time-sensitive TODOs.
- `docs/archive/` preserves completed plans and superseded material for historical context. Archived documents are not current implementation guidance.

## Start here

- [Backend architecture](../ARCHITECTURE.md) ([中文](../ARCHITECTURE.zh-CN.md))
- [Desktop architecture](../apps/desktop/README.md)
- [Renderer architecture](../apps/desktop/src/renderer/README.md)
- [Evaluation kernel](../packages/eval/README.md)
- [Runtime package](../packages/runtime/README.md)
- [UI package architecture](../packages/ui/README.md)
- [Security policy](../SECURITY.md)

## Current contracts

### Runtime and Eval

- [Deep Research durable workspace](./deep-research-durable-workspace.md)
- [Session task ledger lifecycle](./session-task-ledger-lifecycle.md)
- [Work Board contract](./work-board-contract.md)
- [Runtime resume architecture](./architecture/runtime-resume-architecture.md) ([中文](./architecture/runtime-resume-architecture.zh-CN.md))
- [Runtime Host architecture](./architecture/runtime-host-architecture.md) ([中文](./architecture/runtime-host-architecture.zh-CN.md))
- [Remote Runtime Host setup](./runtime-host-remote-access.md) ([中文](./runtime-host-remote-access.zh-CN.md))
- [Runtime resume extraction ledger](./architecture/runtime-resume-extraction-ledger.zh-CN.md)
- [Runtime resume Phase 3–4 implementation route](./architecture/runtime-resume-phase3-phase4-workspace-checkpoint-design.zh-CN.md)
- [Skill catalog policy](./skill-catalog-policy.md)
- [Agent Swarm](./agent-swarm.md)
- [Agent Graph stream scheduling](./architecture/agent-graph-stream-scheduling-draft.md) ([中文](./architecture/agent-graph-stream-scheduling-draft.zh-CN.md))
- [IM 扫码接入 runtime architecture](./architecture/bot-onboarding-runtime.zh-CN.md)
- [Backend architecture chapters](./architecture/)

### Computer use

- [Foundation contract](./computer-use-foundation-contract.md)
- [Model-loop foundation](./computer-use-model-loop-foundation.md)
- [Evidence classes](./computer-use-evidence-classes.md)
- [Provider evidence contract](./computer-use-provider-evidence.md)
- [Host events contract](./computer-use-host-events-contract.md)

### Frontend and validation

- [Product design](../DESIGN.md)
- [Frontend CSS governance](./frontend-css-governance.md) ([中文](./frontend-css-governance.zh-CN.md))
- [Windows support baseline](./windows-support.md)

### Release operations

- [CLI/TUI distribution contract](./cli-distribution.md)
- [CLI npm release](./cli-npm-release.md) ([中文](./cli-npm-release.zh-CN.md))

### Security and privacy

- [Workspace privacy context](./workspace-privacy-context.md)
- [Runtime sandbox boundary](../packages/runtime/src/sandbox/README.md)

## Historical material

- [Runtime kernel extraction](./archive/runtime-kernel.md)
- [Runtime v2 architecture evolution](./archive/runtime-v2-architecture-evolution.md)
- [Runtime v2 implementation notes](./archive/runtime-v2-implementation-notes.md)
- [DeepSeek Reasonix cost runtime design](./archive/deepseek-reasonix-cost-runtime-design.md)
- [Documentation archive](./archive/README.md)

## Maintenance

- Add stable cross-cutting documentation to the closest section above.
- Put local architecture beside the code and link it from **Start here**.
- Keep progress and TODOs in issues or pull requests instead of copying them into stable documents.
- Move completed plans to `docs/archive/`; remove a document only after its unique references are updated or no longer needed.
- Prefer updating an existing authority over adding a parallel document.
- Keep PR follow-up records, incident investigations, and run logs in the pull request or `docs/archive/`, not as new current contracts. `notes/` and `docs/local/` are workspace-local scratch and stay untracked.
- Do not commit PR or issue screenshots under `docs/`. Attach temporary visual evidence on the GitHub thread; product hero/marketing images live under `.github/assets/`.
