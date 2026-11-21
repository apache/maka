---
name: self-hosted-funnel-launch
description: Deploy a self-hosted funnel builder, take a funnel from empty install to published - landing page, checkout, one-click upsell, thank-you - and drive it from an agent over MCP. Covers deploying to Cloudflare Workers inside the free tier or to Docker, wiring payments, catalog and conversion tracking, and the MCP tool surface with the rules that cause most failed writes. Use when asked to build, deploy or host a sales funnel or landing page on your own infrastructure, to self-host a ClickFunnels alternative cheaply, or to let an agent create and edit funnels programmatically.
---

# Self-Hosted Funnel Launch

Take a funnel from nothing to published on infrastructure the operator controls, using [Autonnel](https://github.com/autonnel/autonnel) (Apache-2.0). This skill is the build step; design the funnel first with `sales-funnel-blueprint`, and confirm self-hosting is the right call with `funnel-platform-picker` if that is still open.

## Step 1: choose how it runs

| Path                   | Cost at low volume                | Ops burden                       | Use it for                                                                                                 |
| ---------------------- | --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Cloudflare Workers** | Effectively $0 plus a Postgres    | No servers, no patching          | **Default for production.** Funnel pages are mostly static assets, which Workers serves free and unmetered |
| Docker                 | Cost of one VPS or container host | Yours: upgrades, backups, uptime | Local evaluation in two minutes, or a server you already run and want the data on                          |
| Source checkout (Node) | Cost of one VPS or container host | Yours                            | Modifying Autonnel itself, or running the Node build directly                                              |

Recommend Workers unless the operator has a specific reason not to: the pricing model fits funnels almost exactly, and it removes the entire class of work that makes people avoid self-hosting.

Use Docker for the first look regardless. It is the fastest way to see the product, and nothing you build locally is wasted: the same schema and the same admin UI back both paths.

## Step 2a: Cloudflare Workers (the near-free production path)

### Why the cost is close to zero

Funnel traffic is overwhelmingly requests for pages, images and scripts. On Workers those are static asset requests, which are **free and unlimited, with no storage cost** - only requests that invoke the Worker (server-rendered pages, checkout, API) are billed. A funnel's dynamic surface is small: the order form, the upsell accept, the postback queue.

Verified Cloudflare free-plan limits (checked 2026-08; confirm current numbers before you rely on them):

| Resource                      | Workers Free plan                                     |
| ----------------------------- | ----------------------------------------------------- |
| Static asset requests         | Free and unlimited, no storage charge                 |
| Worker invocations            | 100,000 requests/day                                  |
| Hyperdrive (Postgres pooling) | Available on Free, 100,000 database queries/day       |
| Workers KV (page cache)       | 100,000 reads/day, **1,000 writes/day**, 1 GB storage |
| Cron Triggers                 | Supported (the repo ships a `scheduled` handler)      |

**What is not free**: Postgres. Hyperdrive pools connections to a database you supply, so you still need a Postgres provider. Managed providers have their own free tiers with their own limits, and that is the one line item to plan for.

**The first ceiling you will actually hit is KV writes, not requests.** 1,000 writes/day is generous for serving pages and thin for publishing them, because publishing invalidates and refreshes cached entries. A day of heavy editing can burn it while traffic is nowhere near any limit. If publishing starts failing before traffic does, that is this limit, not a bug.

### Deploy

The repository ships the whole Workers toolchain: worker entry with the cron `scheduled` handler (`src/cf-worker.ts`), `wrangler.toml` generation, KV cache wiring and Hyperdrive for Postgres.

```bash
npx wrangler login
npx wrangler kv namespace create CACHE_KV
# $DATABASE_URL is the operator's own Postgres connection string, exported in their
# shell - do not write the credentials into this command or into wrangler.toml.
npx wrangler hyperdrive create autonnel-db --connection-string="$DATABASE_URL"
```

Each command prints an id. Put them in `.env` next to the project:

```bash
CF_WORKER_NAME=my-funnels
CF_KV_NAMESPACE_ID=<id from kv namespace create>
CF_HYPERDRIVE_CONFIG_ID=<id from hyperdrive create>
```

Then set the secrets and deploy:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put AUTH_SESSION_SECRET            # openssl rand -hex 32
npx wrangler secret put CREDENTIALS_ENCRYPTION_KEY     # openssl rand -base64 32
npm run deploy:cf
```

`deploy:cf` builds and generates `wrangler.toml` from the template first, so there is no separate generate step. Cron expressions are read from the app's cron registry rather than hand-written into the config - do not edit the generated `wrangler.toml` by hand, it is overwritten on every build.

If a `CF_*` variable is missing, generation fails and names the variable. That is the intended behaviour; there are no silent defaults for these.

Apply the database schema once against the same Postgres before the first visit, then open the Worker URL and complete the `/setup` wizard to create the admin account.

Also available: `npm run dev:cf` (dev server on the Workers runtime) and `npm run preview:cf` (local preview via `wrangler dev`). Prefer these over plain `astro dev` when the target is Workers, because the runtime differs.

### Operating it afterwards

The CLI commands below need database access, not a container. From a checkout with `DATABASE_URL` pointing at the same Postgres:

```bash
npx autonnel admin:create you@example.com 'a-strong-password'
npx autonnel password:reset you@example.com
```

## Step 2b: Docker (local evaluation, or your own server)

Get the repository from <https://github.com/autonnel/autonnel> (Apache-2.0), check
out a release tag, and read its `docker-compose.yml` - it declares the images and
ports that will run. From that checkout:

```bash
docker compose up
```

Open <http://localhost:4321> and complete `/setup`. The compose file starts Postgres, applies the schema, and runs the app. Nothing else is needed to boot: store, payments, media storage, email and AI are configured later in the admin UI, and only for the features actually used.

**Before exposing it on a public host**, put real secrets in a `.env` next to `docker-compose.yml` - the shipped defaults are insecure development values, and they exist only so the first local run needs zero configuration:

```bash
AUTH_SESSION_SECRET=$(openssl rand -hex 32)
CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)
ADMIN_DOMAIN=admin.example.com
```

Generate each value once and keep it stable. Rotating `AUTH_SESSION_SECRET` invalidates sessions; rotating `CREDENTIALS_ENCRYPTION_KEY` makes stored provider credentials unreadable, which means re-entering every payment and platform credential.

Multi-arch images are published to GHCR for a plain `docker run` against an existing database:

```bash
# DATABASE_URL, AUTH_SESSION_SECRET and CREDENTIALS_ENCRYPTION_KEY come from the
# operator's own environment - never write their values into a command or a file.
docker run -p 4321:4321 \
  -e DATABASE_URL \
  -e AUTH_SESSION_SECRET \
  -e CREDENTIALS_ENCRYPTION_KEY \
  -e ADMIN_DOMAIN="admin.example.com" \
  ghcr.io/autonnel/autonnel:v1.5.0
```

Keep an exact tag pinned rather than `:latest`, and re-apply the schema after pulling a newer tag - the compose file's one-shot schema service re-runs on every `docker compose up`. Health endpoint for orchestrators: `/api/health` (covers database and cache connectivity).

Admin CLI inside a container:

```bash
docker compose exec app node dist/cli/index.js admin:create you@example.com 'a-strong-password'
```

## Step 2c: source checkout (Node)

For modifying Autonnel itself, or running the Node build on a host you already own. Requires Node 22+ and a Postgres:

```bash
npm create autonnel@latest my-funnel
cd my-funnel
cp .env.example .env   # set DATABASE_URL and ADMIN_DOMAIN
pnpm install           # pnpm 10+; the repo pins overrides npm would ignore
npm run db:push
npm run dev            # or: npm run build && npm run start
```

This clones the repository and drops its git history. The schema lives at `prisma/schema.prisma` in the checkout; `db:push` syncs it. Admin CLI: `npx autonnel admin:create you@example.com 'a-strong-password'` from the project directory.

## Step 3: configure only what the funnel needs

In the admin UI under **Settings**:

| Setting      | Needed for                                                                                             | Options                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Ecommerce    | Product and order data                                                                                 | Shopify, WooCommerce, Picocart           |
| Payments     | Taking money                                                                                           | Stripe, PayPal                           |
| Storage      | Image/video uploads                                                                                    | Any S3-compatible bucket (R2, S3, MinIO) |
| Email        | Receipts, recall campaigns                                                                             | SMTP, Resend, AWS SES                    |
| LLM          | AI page generation                                                                                     | Any OpenAI-compatible endpoint           |
| Ad platforms | Server-side conversions (all four); ad-level spend/click reporting (Facebook, Google Ads, TikTok only) | Facebook, TikTok, Google Ads, Bing       |

Order of operations that avoids rework: catalog first (it constrains what the checkout can sell), then payments, then storage, then email, then ad platforms last - tracking is verified against real orders, so it needs the rest working first. Connecting an ad platform for spend reporting is a separate step from binding it to a funnel for postback (see `server-side-conversion-tracking`); do both if you want both.

On Workers, R2 is the obvious storage choice: it is S3-compatible and keeps media egress inside Cloudflare.

## Step 4: build the pages

Funnel roles map onto the funnel spec directly:

| Role in funnel | Purpose                                    | Multiple per funnel? |
| -------------- | ------------------------------------------ | -------------------- |
| `LANDING`      | Entry page(s), one per traffic angle       | Yes                  |
| `CHECKOUT`     | Order form                                 | No - one per funnel  |
| `UPSELL`       | Post-purchase offers, ordered into a chain | Yes                  |
| `THANKYOU`     | Confirmation                               | No                   |
| `ERROR`        | Payment failure / fallback                 | No                   |

These are the roles a page takes _inside a funnel_. Over the API a page's own type is `CHECKOUT | THANKYOU | ERROR | UPSELL | CUSTOM` - landing pages are created as `CUSTOM` and become landing pages by being bound into a funnel as `LANDING`.

Two editors are available: a component-based visual editor whose output is diffable JSON, and raw HTML for imported pages. Prefer the component editor for anything that will be A/B tested or edited by an agent later - JSON diffs review cleanly, HTML blobs do not.

Build the checkout before the landing page. The checkout determines what can actually be sold and at what price, and a landing page written first will promise something the checkout cannot deliver.

## Step 5: wire the funnel

- Create the funnel, then attach pages with their role and order.
- The same page may be referenced by several funnels. The only uniqueness rule the domain enforces is that a `stepSlug` is unique within one funnel (and a page appears at most once per funnel) - there is no cross-funnel rejection to design around. Clone a landing page only when you want the two funnels to diverge, because an edit to a shared page lands on every funnel referencing it.
- `THANKYOU` and `ERROR` are auto-bound from existing pages at creation if any exist; if the tenant has none, create them before going live. A funnel with no error page fails silently on declined payments.
- The URL that goes into ad campaigns is the landing page's own slug on a storefront host - `https://shop.example.com/{page.slug}` - never a `/n/` step URL. `/n/{funnelId}/{stepSlug}` redirects _forward_ to the next step, so it belongs in a page's CTA link, not in an ad. Writing the CTA that way keeps the buyer's path stable when a step is swapped for another page.
- Publish is explicit and versioned per page and per funnel - publishing a page does not publish the funnel binding.

## Step 6: instrument before sending traffic

Non-negotiable pre-launch checks:

1. **One real end-to-end purchase**, on a real payment provider, including: base order, one accepted upsell, one declined upsell, the thank-you page, the receipt email, and the order appearing in the connected store.
2. **One refund** on that order, to confirm the refund path works per charge.
3. **Click id coverage** - confirm `fbclid` / `ttclid` / `gclid` / `msclkid` reach the order record. See `server-side-conversion-tracking`.
4. **Server-side conversion arriving** in each ad platform's event debugger, with the click id attached and no duplicate against the browser event.
5. **Error page reachable** by forcing a declined card.

On Workers, add one more: confirm the cron `scheduled` handler is firing (queued postbacks and recall campaigns depend on it). A deploy that silently lost its cron triggers looks healthy while background work quietly stops.

Only then increase spend. A funnel that has not had a real transaction pushed through it has an unknown, not a low, failure rate.

## Step 7: operate it from an agent over MCP

The instance exposes its admin API as MCP tools at `/api/mcp`, so an agent can build and change funnels without the UI.

```json
{
  "mcpServers": {
    "autonnel": {
      "transport": "http",
      "url": "https://<your-autonnel-host>/api/mcp",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

Calling `/api/mcp` with raw HTTP rather than an MCP client has two transport requirements the SDK normally hides. The endpoint speaks Streamable HTTP: the request must carry `Accept: application/json, text/event-stream` - anything less is rejected with `406` before the tool layer is reached - and a success comes back as an SSE frame (`event: message` / `data: {...}`), so the JSON-RPC envelope has to be unwrapped from `data: ` before parsing.

One more trap in front of the app entirely: an instance behind Cloudflare with the default managed bot rules **rejects the Python standard library's user agent**. A `urllib` client sends `Python-urllib/3.x` and gets `403` with the plain-text body `error code: 1010` on _every_ path including `/api/health`, which reads exactly like an auth or permission failure and is not JSON, so a client that parses the body throws before it can see the status. Only that agent string is blocked - `curl`, `python-requests`, `httpx`, `axios`, `node` and an empty UA all pass. If you script this in Python, set an explicit `User-Agent` or use `requests`/`httpx`; if every call including unauthenticated ones returns `403`, this is why, and no API key will fix it.

`.mcp.json` at the project root for Claude Code; `claude_desktop_config.json` for Claude Desktop. Generate the key in admin → **Settings → API Keys**. Every call is scoped to that key's tenant. Read tools work with any key; mutating tools need `writeAccess` toggled on. Treat a write key as production credentials: one per agent, read-only keys for reporting, revoke rather than share.

Tools are self-describing - the client reads names, descriptions and input schemas on connect, so this skill does not repeat them. What follows is only what introspection cannot tell you.

### A failed call still returns HTTP 200

This is the single thing most likely to make a client read a failure as a success.

| Condition                                                                                    | What you actually get                                                                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocked at the CDN edge (see the `Python-urllib` note above)                                 | HTTP 403 with a plain-text `error code: 1010` body and no JSON at all - the request never reached the app                                           |
| Missing or partial `Accept` header                                                           | HTTP 406 with a JSON-RPC `error` object (`-32000`) - a transport rejection shaped exactly like a tool error, see above                              |
| Auth failure                                                                                 | HTTP 401, no JSON-RPC frame at all                                                                                                                  |
| Unknown tool name                                                                            | HTTP 200 with a real JSON-RPC `error` object carrying a numeric code - the only in-band failure shaped that way, because it happens before dispatch |
| Everything else: missing write access, validation failure, not found, conflict, server error | HTTP 200 with `result.isError === true` and the message in `result.content[0].text`, and **no** JSON-RPC `error` object                             |

So: if `error` is present, read the HTTP status before concluding anything - `406` is the transport rejecting your headers, `200` is an unknown tool name. Otherwise check `result.isError` before trusting `result.content`. Read the message rather than retrying blindly - a validation failure names the exact field path, and a conflict names the rule that was hit.

### Rules that cause most failed writes

- **A funnel step is `{ stepSlug, pageId }` and nothing else.** Order is array order. A step's role in the flow is the referenced page's own `type`; there is no `pageType`, `order` or `subOrder` field. `stepSlug` is required on `add_funnel_page`, must be unique within the funnel, and forms `/n/{funnelId}/{stepSlug}` - which is a forward redirect, not the step's own URL (see Build order). The schemas are `.strict()`, so an extra field is rejected rather than ignored.
- **Steps are keyed by the page they reference**, so a page appears at most once per funnel, but the same page may be referenced by several funnels. There is no "belongs to one funnel only" rule.
- **There is no `LANDING` page type.** Page `type` is `CHECKOUT | THANKYOU | UPSELL | ERROR | CUSTOM`, stored uppercase. A landing page is a `CUSTOM` page that a funnel references.
- **Thank-you and error steps are live references, not snapshots.** `create_funnel` adds steps for the tenant's existing thank-you and error pages, creating them from templates if none exist. Editing that page later changes every funnel referencing it - clone it if one funnel should diverge.
- **Draft and published are separate.** Writes land in `draftData`; `publish: true` promotes it and invalidates the render cache. Write, verify with `get_page`, publish in a second call.
- **`draftData` is not structurally validated.** Nothing checks `root` / `content` / `zones`, required props, or component type names before saving. A malformed document is accepted and only breaks at render time.
- **Component types must come from `get_template({ key })`**, never from a remembered list. The component set is renamed and extended over releases, and because `draftData` is unvalidated, a stale component name saves cleanly and renders blank. A template's JSON is the authoritative shape.
- **Content must match the page's `editorType`.** `editorType` is optional on `create_page` and **defaults to `PUCK`**, so an HTML page created without it is silently a Puck page. `create_page` accepts only `draftData`; `update_page` accepts `draftData` on `PUCK` pages and `htmlContent` on `HTML` / `GRAPESJS` pages, and rejects the mismatch (`page <id> has editorType HTML; use htmlContent, not draftData`) rather than writing to a column the renderer never reads. Set `editorType` explicitly at create time - a page's editor type cannot be changed afterwards through these tools.
- **Media before pages.** `upload_media` fetches a URL server-side and returns a CDN URL for component props. A local file has no URL to give it, so it goes over REST instead: `POST /api/v1.1/media/upload`, `multipart/form-data` with a `file` part, `201` with `{ assetId, url }`. Only `image/jpeg|png|webp|gif` and `video/mp4|webm` are accepted, and a key without `writeAccess` gets the same `403` write-denied envelope as every other write endpoint. If storage was never configured this returns `412` naming Settings -> Storage, not a generic `500`.
- **There is no way to delete a page over the API.** No `delete_page` tool, and no `DELETE` on `/api/v1.1/pages/{pageId}` - only `GET` and `PUT`. Funnels can be deleted (`delete_funnel`), pages cannot, so every abandoned or misnamed page is permanent until someone removes it in the admin UI. Pick slugs deliberately on the first try, and do trial runs on a throwaway instance rather than the tenant you are building.
- **`get_stats` counts unique users, not views.** Five visits by one visitor is 1.
- **`list_orders` cannot filter by funnel**, and its amounts divide minor units by 100 - correct for USD/EUR, wrong for JPY or BHD.
- **Ad spend is not available over MCP or REST.** The admin UI has built-in ad-level spend, click and conversion reporting for Facebook, Google Ads and TikTok (connect under Settings → Ads, view under Analytics → Ads or a funnel's own Analytics tab), reconciled against your own orders - but none of it is an MCP tool or a `/api/v1.1/` endpoint. An agent driving this instance over MCP has no campaign or spend query available at all; a human has to open the admin UI for that. Bing has no spend/click reporting anywhere, UI included - it stays token-mode conversion postback only.

### Build order

```
list_products → list_templates → get_template
  → media first:  remote URL → upload_media (MCP)
                  local file → POST /api/v1.1/media/upload (REST, multipart)
                  then swap the returned CDN url into the content you are about to write
  → create_page × N (name, slug, type, editorType) → update_page (draftData or htmlContent)
  → get_page (verify) → update_page({ publish: true })
  → create_funnel → add_funnel_page × N (pageId + unique stepSlug) → get_funnel
  → GET /storefront/{page.slug} → expect 200
```

**A `/n/` URL never renders the step it names.** `/n/{funnelId}/{stepSlug}` is a forward redirect: it finds that step, `302`s to the **next** step's bare page slug with `?funnelId=` appended, and answers `404 No next step in funnel` on the last step. Point it at your landing step and you get the checkout, or a 404 if nothing follows - either way, not the landing page.

**`entryStepSlug` is not the URL to advertise either.** It is literally `steps[0]`, and `create_funnel` appends the thank-you and error steps before you add anything, so on a funnel built this way `steps[0]` is the thank-you page.

**The page is served at its own bare slug on a storefront host**: `https://{storefront-host}/{page.slug}`. Read `steps` from `get_funnel`, pick the step whose `page.type` is `CUSTOM`, and advertise that step's `page.slug`. Append `?funnelId={id}` only when the page is bound to more than one funnel; with a single binding the funnel context resolves on its own.

**Bare slugs work only on a non-admin host.** The middleware rewrites `/{slug}` to the storefront renderer when the host does _not_ match `ADMIN_DOMAIN`; on the admin host itself that path falls through to the admin app and 404s, which reads exactly like an unpublished page. A Workers deployment reachable only at its `*.workers.dev` admin hostname therefore has no clean landing-page URL until a storefront domain is attached - attach one before buying traffic.

**To verify with nothing but an API key, request `/storefront/{slug}`.** That prefix is public on every host including the admin one, and renders what a shopper gets. It serves PUBLISHED pages only - a draft 404s there while `get_page` still happily returns its `draftData`. `/preview/{slug}` does render drafts, but requires a logged-in session, so an API key cannot use it. Confirm a `200` and that the expected copy is in the body before spending money on it.

To change a live page: `get_page` → edit only the props you mean to change → `update_page` without publish → `get_page` to diff → publish. Never regenerate a whole `draftData` blob for one headline; `update_page` replaces the document wholesale, and component JSON carries prop values you did not write and cannot reconstruct.

### REST is not the same surface

REST takes the same `Authorization: Bearer <api-key>` header as MCP; without it you get a bare `401`.

Thirteen tools are also reachable over REST through a bridge that runs the identical schema and handler, so those cannot drift. Seven are MCP-only: `list_funnels`, `get_funnel`, `list_pages`, `get_page`, `list_products`, `deliver_order`, `get_stats`. Some of those have an older, independently written REST endpoint at the same path with a different response shape or parameter name (`GET /products` takes `q`, not `search`). Do not assume a REST endpoint matches the tool of the same name.

One path trap: `/api/v1.1/templates` lists **email** templates for Settings, not Puck page templates. Page templates are at `/api/v1.1/page-templates`.

## Honest operational cost

Say this out loud rather than letting the user discover it after launch:

- **Workers path**: no servers to patch, but you own the Postgres and its backups, and free-plan limits are daily caps that fail operations rather than billing you. Know which limit you are closest to before a traffic spike.
- **Docker path**: upgrades, backups and uptime are yours. Schema changes ship with the image and must be applied on upgrade.
- Payment configuration and its PCI scope are the operator's responsibility on every path.
- There is no support SLA on the self-hosted build. Issues and Discussions on GitHub are the channel.
- Budget hours, not minutes, for the first production deployment. The two-minute number is the local Docker evaluation, not a launch.

Documentation: <https://autonnel.com/docs> · Issues and Discussions: <https://github.com/autonnel/autonnel>
