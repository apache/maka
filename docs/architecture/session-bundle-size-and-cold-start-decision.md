---
doc_id: architecture.session-bundle-size-and-cold-start
title: "Session Bundle Size, Cold Start, and Storage Policy"
language: en
source_language: en
document_status: decision-record
status: proposed
date: 2026-07-23
issue: 1336
---

# Session Bundle Size, Cold Start, and Storage Policy

This is the timeboxed measurement record for [#1336](https://github.com/maka-agent/maka-agent/issues/1336). It defines the measurement contract and provisional implementation constraints. It does not turn synthetic fixtures or a developer workstation into production telemetry.

## Decision Status

The following are provisional planning constraints until the command is run against a sufficiently large set of sanitized real session exports:

1. Keep a per-session inline bundle below **32 MiB compressed**. Put the manifest and normal session state inline; offload large workspace and artifact blobs by content address before the bundle reaches the cap.
2. Treat `node_modules` as an image/cache concern and `.git` as a workspace materialization concern. Neither belongs in Session Bundle state.
3. Use an S3-with-CAS-class repository: immutable content-addressed blobs plus a small mutable manifest pointer committed with conditional write semantics.
4. Use Node 24's native Zstandard implementation for the `tar.zst` codec. Do not spawn an external compressor on the activation path.
5. Keep hydrate plus local runtime bootstrap separate from provider first-token latency. The command reports a planning estimate only when an explicit provider TTFB input is supplied.

These are candidate budgets, not measured SLOs. A report is decision-ready only when it is produced from sanitized real session exports.

## Measurement Method

The checked-in command is:

```bash
npm run measure:session-bundle -- \
  --workspace /path/to/a/real/checkout \
  --session-export /path/to/sanitized/state-1 \
  --session-export /path/to/sanitized/state-2 \
  --iterations 2 \
  --provider-ttfb-ms 250
```

`--session-export` is repeatable and each path must contain exactly one real exported state tree with `sessions/<id>/session.jsonl`. Canonical paths and session IDs must both be unique, so copying one export to another directory cannot manufacture percentile evidence. JSON and JSONL files receive a defense-in-depth redaction pass before measurement; exports must already be sanitized and must never contain credentials. `--provider-ttfb-ms` is optional; when omitted, the report records that no provider estimate was supplied and omits the first-token planning estimate.

For each sample the command:

- walks the selected checkout without following symlinks and recursively excludes every path segment named `.git` or `node_modules` from the portable workspace stream;
- excludes common workspace secret files such as `.env`, credentials/secrets files, private keys, certificates, and logs from the portable workspace stream;
- materializes the selected state export and builds a real POSIX `manifest.json + state/** + workspace/**` tar stream;
- compresses that exact tar stream with gzip, Brotli, and Node native Zstandard for codec comparison;
- extracts and validates the archive, including byte counts and SHA-256 digests;
- starts a fresh Node process, extracts the archive, opens the real session/runtime stores, constructs the Harbor cell runtime, and completes one FakeBackend turn;
- reports provider TTFB only as the explicit input to a planning estimate. It is not a network measurement.

When no `--session-export` is supplied, the command creates one real Maka FakeBackend run as a smoke fixture. That path validates the archive and bootstrap implementation but is explicitly marked `fake-bootstrap-smoke-only` and `decisionReady: false`.

## Evidence Contract

The JSON report records:

- `evidence.kind` and `evidence.decisionReady`;
- the exact archive format and layout;
- raw tar and compressed byte distributions;
- per-sample state, archive, hydrate, and fresh-process bootstrap measurements;
- workspace byte categories and the recursively filtered portable byte count;
- provider input provenance and the resulting planning estimate.

Only a report with `evidence.kind: sanitized-real-session-exports` and at least 100 measured samples is marked `evidence.decisionReady: true` and may be used to update the budgets below. A smaller or smoke report is suitable for regression tests and implementation debugging only.

## Bundle and Repository Policy

Use an S3-with-CAS-class repository, not a process-local or etcd-class value store:

```text
maka/session/{sessionId}/manifest       mutable pointer, conditional update
maka/blob/{sha256}                     immutable state/workspace/artifact blob
```

The manifest is small and contains `schemaVersion`, `sessionId`, revision, activation identity, and ordered file/blob references. The control plane commits a new revision with an `If-Match`-class condition on the previous manifest revision. Blobs are immutable and may be uploaded before the manifest; an unreferenced blob is garbage-collectable.

v1 limits:

- 32 MiB maximum for an inline compressed session value;
- 256 KiB maximum manifest size;
- offload any individual file over 1 MiB, or offload the complete bundle when it would exceed 24 MiB before the hard 32 MiB rejection;
- keep secrets, provider connections, device identity, activation input, and logs out of both the manifest and blobs.

The 24 MiB soft threshold leaves room for manifest growth, tar framing, metadata, and measurement variance. The 32 MiB hard limit gives the repository a deterministic failure mode instead of allowing an activation to create an unexpectedly slow value.

The repository interface should remain small:

```ts
interface SessionRepository {
  checkout(sessionId: string): Promise<{ revision: string; manifest: Uint8Array | null }>;
  putBlob(digest: string, bytes: Uint8Array): Promise<void>;
  commitManifest(
    sessionId: string,
    expectedRevision: string,
    manifest: Uint8Array,
  ): Promise<boolean>;
}
```

## Cold-Start Accounting

The command separates these phases:

1. archive hydrate: read, Zstandard decompress, tar extraction, digest validation;
2. fresh-process Maka bootstrap: open stores, materialize the workspace, rebase the restored session paths, create the Harbor cell, and signal local runtime/session readiness before invoking FakeBackend; the child still completes and validates the turn after the timing point;
3. provider first-token latency: an explicit external input, not measured by this command.

The operational budget is therefore expressed as two independent budgets:

- hydrate plus local bootstrap: a p99 target measured on the versioned image and a warm regional object-store path;
- provider first token: a provider-specific target measured in the activation environment.

No end-to-end first-token claim should be made by adding an invented provider number to a synthetic local benchmark. The report keeps the input visible so this distinction remains auditable.

## Workspace Dependency Policy

| Entry | v1 policy | Reason |
| --- | --- | --- |
| `node_modules/` | Exclude from the bundle. Bake Maka runtime dependencies into the versioned image. Materialize project dependencies from the lockfile through a cache keyed by lockfile and platform. | Reinstalling on every activation makes cold start dependent on a package registry. |
| `.git/` | Exclude from the bundle. Materialize the repository at a commit/ref and persist uncommitted work as a patch or content-addressed workspace overlay. | Repository object growth is unrelated to session state growth. |
| source workspace | Include small, session-owned changes inline when the cap allows. Offload large files by digest. | Workspace material must not make KV hydration unbounded. |

## Follow-Up Measurements

- Capture at least 100 sanitized real coding sessions before converting the 32 MiB cap or any latency target into a production SLO.
- Measure remote object-store throughput, TLS, and regional p99 separately from local filesystem measurements.
- Add provider-specific activation benchmarks before promising an end-to-end first-token target.
- Keep tar traversal, path safety, quota enforcement, and manifest-integrity tests alongside the import/export implementation.
- Re-run the command against a clean release checkout; a developer worktree is not a representative release baseline.

## Reproducibility

The script is exposed as:

```bash
npm run measure:session-bundle -- --workspace /path/to/checkout
```

It prints JSON so CI can archive the raw report and compare drift without making the decision record depend on hand-copied numbers.
