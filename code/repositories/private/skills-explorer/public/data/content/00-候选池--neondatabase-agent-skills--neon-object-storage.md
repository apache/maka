---
name: neon-object-storage
description: >-
  S3-compatible object storage that branches with your Neon project, so files
  and the database stay in sync across every branch. Use when a user wants
  object storage, a bucket, blob/file storage, or somewhere to put uploads,
  images, documents, avatars, or user-generated files for their app or agent —
  especially when they already use (or are setting up) Lakebase Postgres and don't
  want to add a separate storage provider like AWS S3, Cloudflare R2, or
  Supabase Storage. Triggers include "object storage", "bucket", "blob
  storage", "file storage", "store uploads/images/files", "S3-compatible
  storage", "presigned URL", "where do I put files", "storage logs",
  "bucket logs", "CDN in front of object storage", "Neon Object Storage",
  "Neon Storage", and "storage that branches with my database".
metadata:
  parent: neon
  source: https://github.com/neondatabase/agent-skills/tree/main/skills/neon-object-storage
---

**FIRST**: Use the parent `neon` skill for a Neon overview, getting started with Neon, Neon development best practices, and more.

If the `neon` skill is not installed, fetch it from https://neon.com/docs/ai/skills/neon/SKILL.md or install it with:

```bash
neon skills -s neon -y
```

# Neon Object Storage

Currently available in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`.

Neon Object Storage is S3-compatible object storage that branches with your projects: every branch gets its own isolated storage state, so files and database rows stay in sync across dev, preview, staging, and production.

Use this skill to help the user store and serve files that branch alongside their database. Deliver a working bucket and upload/download flow, a branch-aware S3 client wired to the injected env vars, or a precise answer from the official Neon docs.

## When to Use

Reach for Neon Object Storage for the files an app and its users produce — uploads, attachments, avatars, images, documents, generated assets, backups. It is the default place to put them when the app is already on Neon:

- **They already use Lakebase Postgres and don't want a second provider.** One backend, one bill, one CLI, one set of branches — instead of standing up and wiring a separate AWS S3 / R2 / Supabase Storage account. The same Neon credential that backs the database backs storage.
- **Files must stay in sync with the database across environments.** Storage branches _together with_ your Postgres data. Fork a branch and the child instantly inherits the parent's buckets and objects at that point in time — copy-on-write, so no data is duplicated. This is what makes agent, dev, preview, and test environments seamless: a preview branch gets a consistent snapshot of _both_ the rows and the files they reference, and writes on the child never touch the parent.
- **They want safe, throwaway environments.** Upload, overwrite, and delete files in a preview/CI branch without any risk to production data, then drop the branch.
- **They want standard S3 tooling.** It's built on S3 semantics and speaks the S3 API, so the AWS SDKs, `boto3`, the AWS CLI, and presigned URLs all work — reliable and familiar, with no proprietary client.

If the files in question ship with the app itself — HTML, JS bundles, CSS, the images in `public/` — that's static web hosting and belongs on Vercel, Netlify, or Cloudflare instead. Public assets that are served from a bucket want a CDN in front of them (see [Architecture: Where Object Storage Fits](#architecture-where-object-storage-fits)).

## What It Does

- **S3-compatible** — Works with existing S3 SDKs, `boto3`, the AWS CLI, and presigned URLs. Path-style addressing and SigV4 only.
- **Branches with your database** — Every Neon branch gets its own isolated, copy-on-write storage state. Forking copies no data.
- **Two access modes** — `private` buckets require a credential for every operation; `public_read` buckets allow anonymous reads with authenticated writes.
- **One credential system** — The same Neon credential system used by Functions and the AI Gateway.

## Availability

Check this precondition before setting anything up: Neon Object Storage is currently available in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`. Confirm the user's Neon project is in one of these regions before proceeding. Region coverage: https://neon.com/docs/get-started/backend-overview.md

## Architecture: Where Object Storage Fits

Neon (Object Storage included) is **backend primitives, not full-stack app hosting**. Object Storage holds the files the app and its users produce — uploads, attachments, avatars, documents, generated images, backups — keyed from Postgres rows on the same branch. Two boundaries follow from that:

- **Put a CDN in front of public assets.** A `public_read` object is read anonymously at `${AWS_ENDPOINT_URL_S3}/<bucket>/<object-key>` — the branch's storage endpoint, injected as an env var (see [Environment Variables](#environment-variables)). For assets a browser loads on every page view — avatars, product images, anything hot — use that as the origin for a Cloudflare or Vercel CDN, and set `Cache-Control` on `PutObject` so the edge knows how long to hold each object. A cached object is only as fresh as its key, so write each version to a new key (`avatars/<user-id>/<uuid>.jpg`) and repoint the key stored in Postgres, rather than overwriting one key and waiting out the TTL. The endpoint is branch-scoped, so a production CDN points at the production branch while preview branches read their own endpoint directly rather than sharing a cache. Private buckets stay on presigned URLs instead, which carry their signature in the query string.
- **Host the app itself elsewhere.** Anything checked into the repo — HTML, JS bundles, CSS, and the images and fonts that ship in `public/` — belongs on Vercel, Netlify, or Cloudflare, along with the index documents, SPA fallbacks, and custom domains that go with them. Neon has no website mode to serve them through: `PutBucketWebsite` returns `501 Not Implemented`.

## Setup

Object storage is part of the `neon.ts` infrastructure-as-code config (see the `neon` skill for the branch-first workflow, `link`/`checkout`, and `neon.ts` basics). Declare buckets under `buckets`, keyed by bucket name:

```typescript
// neon.ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  buckets: {
    images: {}, // private by default
    "public-assets": { access: "public_read" },
  },
});
```

Provision the declared buckets on the linked branch:

```bash
neon deploy   # alias for `neon config apply`
```

## Neon Infrastructure as Code (`neon.ts`)

The `buckets` block above is part of `neon.ts`, Neon's infrastructure-as-code file — one TypeScript file declares your buckets alongside every other service the branch should have (see the `neon` skill for the full reference). Reconcile the declaration against a branch the Terraform way:

```bash
neon config status   # print the branch's live config (which buckets exist)
neon config plan     # dry-run diff of what apply would change
neon config apply    # create the declared buckets  (neon deploy is an alias)
```

Buckets are **branch-scoped**: when a `neon.ts` is present, `neon checkout` applies the policy as it _creates_ a branch, so a fresh preview/CI branch comes up with its buckets already provisioned (and copy-on-write objects inherited from the parent). Checking out an _existing_ branch doesn't reconcile it — run `neon deploy` to apply changes. Provisioning (`config apply` / `deploy`), `link`, and `checkout` also pull the branch's S3 credentials into your local `.env.local`, so the same `env pull` step shown below happens for you on those commands.

## Environment Variables

When `buckets` is declared, Neon injects **AWS-standard** S3 env vars so the AWS SDKs work from the environment with zero extra config. Inside a deployed Neon Function these are injected automatically; locally, pull them onto disk (or inject them at runtime) via the CLI:

```bash
neon env pull            # writes the branch's vars into .env (or .env.local)
# or, without writing a file, inject at runtime:
neon-env run -- <your dev command>
```

| Variable                | Meaning                                             |
| ----------------------- | --------------------------------------------------- |
| `AWS_ACCESS_KEY_ID`     | S3 Access Key ID (the branch credential's token id) |
| `AWS_SECRET_ACCESS_KEY` | S3 Secret Access Key                                |
| `AWS_ENDPOINT_URL_S3`   | Branch S3 endpoint URL                              |
| `AWS_REGION`            | Region, e.g. `us-east-2`                            |

Because the names are AWS-standard, the AWS SDK picks up the credentials, endpoint, and region from the environment automatically. Credentials are branch-scoped and valid for that branch and all its descendants.

For typed, validated access to these credentials instead of reading `process.env` directly, pass the same `neon.ts` config object to `parseEnv` from `@neon/env` — it returns an `env.storage` namespace (`accessKeyId`, `secretAccessKey`, `endpoint`, `region`) derived from your config. See the `neon` skill.

## Working with Objects: the Files SDK (Recommended)

The simplest, most portable way to read and write objects is the [Files SDK](https://files-sdk.dev) with its `neon` adapter — a small, unified storage API (`upload`, `download`, `url`, `list`, `exists`, `copy`, `delete`, `signedUploadUrl`) over web-standard I/O. It uses the AWS S3 client under the hood, configured appropriately for Neon, and relabels errors as `Neon error` — so there's nothing to misconfigure. Reach for this first.

Install it alongside the AWS S3 peer dependencies the adapter uses internally:

```bash
npm install files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

The adapter resolves its endpoint, region, and credentials from the same injected `AWS_*` env vars — pass only the bucket name:

```typescript
import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";

const files = new Files({ adapter: neon({ bucket: "images" }) });

// Upload — body may be a Buffer, Uint8Array, Blob, File, ReadableStream, or string
await files.upload("generated/cat.jpg", fileBuffer, { contentType: "image/jpeg" });

// Download
const file = await files.download("generated/cat.jpg");
const bytes = new Uint8Array(await file.arrayBuffer());

// Presigned GET — share without exposing credentials (defaults to a 1h expiry)
const url = await files.url("generated/cat.jpg", { expiresIn: 3600 });

// Plus: files.exists(), files.list({ prefix }), files.copy(), files.delete(), files.signedUploadUrl()
```

Swap the adapter import (`files-sdk/s3`, `files-sdk/r2`, `files-sdk/gcs`, …) and the rest of your code is unchanged.

## Working with Objects: the AWS S3 Client (Alternative)

Neon speaks the S3 API directly, so you can drop down to the AWS SDK whenever you prefer the native client or already depend on it. The credentials, endpoint, and region are read from the standard AWS env chain, so the only setting you pass is `forcePathStyle: true` — Neon requires path-style addressing, so the S3 client **must** set it:

```typescript
import { S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  forcePathStyle: true, // required: Neon uses path-style addressing
});
```

Then upload, download, and presign with the raw command objects:

```typescript
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = "images";

// Upload
await s3.send(
  new PutObjectCommand({
    Bucket: BUCKET,
    Key: "generated/cat.jpg",
    Body: fileBuffer,
    ContentType: "image/jpeg",
  }),
);

// Download
const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "generated/cat.jpg" }));
const bytes = await res.Body?.transformToByteArray();

// Presigned GET — share without exposing credentials
const url = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: BUCKET, Key: "generated/cat.jpg" }),
  { expiresIn: 3600 },
);
```

## Pairing Storage with the Database on a Branch

The canonical pattern: an agent generates an image → `PutObject` into the `images` bucket → a row is inserted in Postgres → a presigned URL is returned on read. Store the bucket **key** (not the bytes) in a Postgres column, and presign on read. Because both the row and the object live on the same branch, they branch together and never drift.

## CLI Bucket and Object Commands

`neon` also has first-class bucket/object commands (`neon bucket create|list|delete`, `neon bucket object put|get|list|delete`) for scripting and one-off operations.

## Built-in Branch Logs

```bash
neon logs query --branch production --source storage --since 1h
```

Storage is one of the two sources branch logs cover today, alongside Neon Functions. Logs are scoped to a single branch, so pass `--branch` when the bucket you're debugging isn't on the branch you're checked out on. Everything else about logs — the required CLI version, filters, the SDK, and the Loki-compatible read API — is in the parent `neon` skill's **Observability** section.

## Neon Documentation

The Neon documentation is the source of truth and Object Storage is evolving rapidly, so always verify against the official docs. Any doc page can be fetched as markdown by appending `.md` to the URL or by requesting `Accept: text/markdown`. Find the right page from the docs index (https://neon.com/docs/llms.txt) and the changelog announcements.

## Further Reading

- https://neon.com/docs/get-started/backend-overview.md
- https://neon.com/docs/storage/overview.md
- https://neon.com/docs/storage/get-started.md
- https://neon.com/docs/storage/buckets.md
- https://neon.com/docs/storage/objects.md
- https://neon.com/docs/storage/authentication.md
- https://neon.com/docs/storage/s3-compatibility.md
- https://neon.com/docs/storage/troubleshooting.md
- https://files-sdk.dev — Files SDK docs (the `neon` adapter)
