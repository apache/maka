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

# maka-fs-tools

[简体中文](README.zh-CN.md)

Implements file reads, search, edits, writes, patches and worktree operations. Callers provide the authorized filesystem scope. `ReadExecutor` handles paged reads; `MutationExecutor` and `WriteCoordinator` prepare and serialize writes. Patch parsing is delegated to the adjacent `patch` crate.

Writes, edits and patches prepare complete UTF-8 content through the original authorized file handles. They preserve existing inode and mode, revalidate target identity before writing, and await the original worker through cancellation and settlement. Edit requires a unique match; patch operations retain their source order and line-ending rules. Preparation retains complete strings in memory, and writes are not atomic replacements.

Text reads scan the original authorized file descriptor once per page, retaining only a bounded page candidate. The serialized response budget does not limit total text size. Every page validates the complete UTF-8 source (rejecting NUL), counts all lines and binds continuations to its content digest; reading later pages repeats that full scan. Cancellation is checked between chunks and the caller awaits the worker. This does not provide an atomic snapshot of concurrently edited files. Image reads preserve the complete original PNG/JPEG/GIF/WebP bytes, validate image headers and nonzero dimensions, and check cancellation between chunks. They do not resize or reencode images.

`workspace` prepares intrinsic identity through the original captured directory. For a usable Git repository, it appends `.maka-workspace.json` to the common `info/exclude` only when absent, preserving existing bytes. This fixed preparation covers selected subdirectories and linked worktrees; it requires the real private Root/control boundaries and an inspected binding for managed worktrees. An unusable nearest `.git` entry does not redirect preparation to an ancestor repository; failures writing a valid exclusion remain errors. Existing tracked files and user ignore rules retain their normal Git precedence.

`git` provides native, read-only repository status and per-file comparisons. Callers supply the original directory identity, private State Root and any validated managed-worktree binding, and retain the blocking worker until it settles. Git metadata and ignore/attribute control files are checked before library traversal; external commands and alternate object stores are not used. Status entries and text patches are returned in full. Repository metadata, control files and comparison results are buffered in memory. Cancellation is cooperative; queries do not promise bounded memory, a fixed execution time or an atomic repository snapshot.

`worktree` owns isolated Git checkouts and captures their final working files relative to the immutable allocation base. Callers must settle all workspace writers before capture. Capture reads complete images and path sets, buffers the complete patch, and verifies unchanged HEAD/index plus the full ownership record before returning. Cancellation is cooperative; capture does not promise bounded memory or an atomic snapshot of external edits. Reopening preserves child changes; removal requires the original ownership proof.

`files` lists direct children through held directory capabilities and reports native invalidation hints. The caller supplies the original workspace identity, private Root/control paths and validated managed-worktree binding; caller paths cannot create that exception. `WorkspacePath` is shared with Git and preserves exact relative pathname bytes. Listing is live and bounded, with no snapshot cache. A watch registers the workspace-to-target directory chain before readiness, ignores read/access notifications, coalesces changes and revalidates names before delivery. The original worker must await `Watch::close` through normal native watch/callback cleanup, even after client cancellation. Native filesystem notifications are not a durable event history.

Grep and Glob return the complete matching set within their admitted scope. They buffer sources and results, check caller cancellation, and use iterative traversal with active-cycle detection; they impose no separate source-size, result-count, traversal-depth or whole-search deadline. Hidden, ignored, binary and symlink behavior remains part of each tool’s documented scope. Regex compilation retains the pinned library’s nesting and compiled-memory guards; this is not a promise to accept every mathematically valid regular expression. Current-file captures and readable write previews preserve complete original content. File listings use continuation pages with a soft byte target: one complete first entry can always advance. Git retains dependency representation limits and reduced-trust allocation policy; changing pathname length never grants repository authority.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
