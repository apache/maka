# Provenance

Created on 2026-09-30 in `feat/index-initiative`, based on commit `2ab87d3816d4ffe585abcd44edf977d030df77c9` plus the existing uncommitted memory-network/runtime snapshot from `feat/memory-index-network`.

The new implementation is contained in `scripts/plugins/index-initiative`. Existing runtime and memory-network modifications in this worktree were inherited, not introduced for initiative. The source memory worktree remains independent.

Build, Host API fixture bundling and extension packaging scripts derive from the repository's Apache-2.0 memory-network plugin. Runtime dependency: Zod (MIT); its license is included in the packaged extension. No model key, user history or live database is included.
