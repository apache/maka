---
name: neon-auth
description: >-
  Add authentication to a new app. Use for "add auth", "add login", Neon Auth
  (Managed Better Auth), identity routing, sign-up, sign-in, password reset,
  email OTP, magic links, organizations, phone OTP, OAuth, passkeys, MFA,
  trusted domains, invalid domain, and @neondatabase/auth. No existing identity:
  default to Managed Better Auth. Keep working Better Auth, Clerk, Supabase
  Auth, or another IdP. User asked to migrate from Supabase Auth: Managed
  Better Auth. A required plugin outside Managed support: self-managed Better
  Auth on a Neon Function or the existing app host. Also use for auth APIs in
  @neondatabase/neon-js.
metadata:
  parent: neon
  source: https://github.com/neondatabase/agent-skills/tree/main/skills/neon-auth
---

**FIRST**: Use the parent `neon` skill for a Neon overview, getting started with Neon, Neon development best practices, and more.

If the `neon` skill is not installed, fetch it from https://neon.com/docs/ai/skills/neon/SKILL.md or install it with:

```bash
neon skills -s neon -y
```

# Neon Auth

Neon Auth is Managed Better Auth: users, sessions, and auth config live in the `neon_auth` schema on the branch's Lakebase Postgres, and auth state branches with the database. The client API is the Better Auth method set (`signIn.email`, `signIn.social`, `getSession`) through `@neondatabase/auth`. That wrapper is not a drop-in for bare `better-auth/client`: it pins the plugin list and adds Neon-specific OAuth verifier, iframe popup, and JWT handling. Stay on the wrapper while Auth is managed.

This skill chooses identity, then implements Managed Better Auth. It does not replace a working auth server in order to use Postgres, Functions, Object Storage, or the AI Gateway.

## When to Use

Inspect existing identity and the required login features before provisioning. A supplied `DATABASE_URL` is not a reason to change identity. Adding a Neon Function is not a reason to change identity.

| Situation                                             | What to do                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No existing auth                                      | Default to Managed Better Auth. [Managed setup](#managed-setup), then [references/managed-auth.md](references/managed-auth.md).                                                                                                                                                                                                           |
| Needs a feature Managed does not offer                | Self-managed Better Auth on the existing app host (Vercel or similar) or a Neon Function. Keep Lakebase Postgres. Confirm the **installed** Better Auth version documents that exact flow before recommending the move. If support stays unresolved, keep the current identity. [references/self-managed.md](references/self-managed.md). |
| Already has Better Auth                               | Keep it. It works with the other Neon primitives. Migrate to Managed only if the user asks.                                                                                                                                                                                                                                               |
| User asked to migrate from Supabase Auth              | Managed Better Auth. [Supabase Auth](#supabase-auth). Moving only Postgres or adding a Function keeps Supabase Auth.                                                                                                                                                                                                                      |
| Clerk, Auth.js, Supabase Auth, or another working IdP | Keep it unless the user asks to migrate.                                                                                                                                                                                                                                                                                                  |

Google, GitHub, and Vercel social OAuth are offered on Managed Auth. They are not a reason to leave Managed Auth. Other OAuth providers, generic OAuth, MFA, passkeys, API keys, MCP OAuth, SSO, custom plugins, hooks, and custom JWT claims are the [plugin matrix](#plugin-support) check.

Before enabling Managed Auth, confirm the project is on AWS and does not use IP Allow or Private Networking. Leave those protections in place.

Configure supported Managed plugins through Neon (Console, API, or `neon neon-auth`), not by passing `plugins` into `@neondatabase/auth`. Enabling `auth: true` is not implementing login.

## What It Does

- **Managed identity in Postgres** — users and sessions in `neon_auth`, queryable with SQL, compatible with RLS.
- **Auth emails without an app mailer** — verification, email OTP, magic links, and password reset. Getting started uses shared SMTP (`auth@mail.myneon.app`). You do not add Resend or SendGrid to implement login. Production needs custom SMTP: https://neon.com/docs/auth/production-checklist.md
- **Branches with the database** — each branch has its own Auth URL and isolated auth state.
- **Better Auth client methods via the Neon SDK** — `@neondatabase/auth` (auth only) or `@neondatabase/neon-js/auth` (combined SDK). Optional UI: `@neondatabase/auth-ui`.
- **Fixed plugin set** — the Managed client does not accept a `plugins` option. See [plugin support](#plugin-support).

## Availability

Managed Better Auth is generally available. AWS regions only. It cannot be enabled on a project with IP Allow or Private Networking.

Organization is separately Partial / Beta. Hosting self-managed Better Auth in a Neon Function follows Functions availability and claim rules; use the `neon-functions` skill for that host. An unclaimed project that can enable Auth still cannot use Functions until claim.

## Managed setup

Merge Auth into the existing `neon.ts`. Do not replace other fields:

```typescript
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
});
```

```bash
neon deploy
neon neon-auth status
```

If Function env in that config reads `process.env`, use `neon deploy --env <file>` as the parent skill describes. The manual service command is `neon neon-auth enable`; do not run both enable and deploy as redundant required steps when `neon.ts` already declares `auth: true`.

Then implement login: [references/managed-auth.md](references/managed-auth.md).

Claimable projects: follow the parent Claimable path, then `auth: true` and `neon deploy` when login is requested and no existing provider should be preserved.

## Supabase Auth

When the user asked to migrate login from Supabase Auth, recommend Managed Better Auth and follow https://neon.com/docs/auth/migrate/from-supabase.md. Moving only Postgres or adding a Function is not that request: keep Supabase Auth.

`SupabaseAuthAdapter()` keeps method shapes such as `signInWithPassword` and `signInWithOAuth`. Those calls are not interchangeable with default Better Auth examples (`signIn.email`). Keep an existing adapter caller on that API.

Inventory the auth methods and database calls actually used:

- Password hashes cannot transfer. Users create new accounts or sign in with OAuth.
- Do not promise unchanged user IDs, sessions, or account linking. Plan application foreign keys with the owner.
- `updateUser()` cannot change email or password on Managed Auth. Email verification needs application UI (codes work on shared SMTP; links need custom SMTP).
- The migration guide lists Supabase phone/SMS/WhatsApp, SAML, and Web3 as unsupported on Managed Auth. Confirm the **installed** Better Auth version if the user still needs that exact flow; if support stays unresolved, keep Supabase Auth and stop the auth cutover. That page's "no phone auth" claim is about Supabase phone sign-in, not the constrained Managed Phone Number plugin (existing users link a number).
- `@supabase/supabase-js` used only for Auth does not justify enabling the Data API. Keep Data API only for existing PostgREST / Supabase database-client queries.

## Verification

Managed path: sign-up, sign-in, sign-out, session restoration after reload, and protected access, including error and loading states. Exercise email verification (code on shared SMTP) when it is on. Report any flow that remains unverified.

A required plugin on the self-managed path is verified in that app's Better Auth setup, not as a Managed flow.

## Plugin support

Checked 2026-09-17 against https://neon.com/docs/auth/guides/plugins.md, https://neon.com/docs/auth/roadmap.md, and the `@neondatabase/auth` client plugin list. Re-fetch those pages if this skill may be stale. An unlisted upstream plugin needs a live check; do not treat absence from this table as a dated roadmap item.

"Not exposed" means the Managed SDK/UI contract. It is not a claim that every raw server request was tested.

| Feature                                                 | Managed Auth                  | Boundary                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email/password                                          | Supported                     | `signUp.email`, `signIn.email`                                                                                                                                                                                                                                                                                                                   |
| Social OAuth (Google, GitHub, Vercel)                   | Supported                     | `signIn.social`. Shared Google credentials are for development; production and GitHub/Vercel need your own OAuth apps. https://neon.com/docs/auth/guides/setup-oauth.md                                                                                                                                                                          |
| Admin                                                   | Supported                     | Admin session required. Plugin customization is on the roadmap.                                                                                                                                                                                                                                                                                  |
| Email OTP                                               | Supported                     | Managed delivery. `emailOtp.sendVerificationOtp`, `signIn.emailOtp`.                                                                                                                                                                                                                                                                             |
| Magic Link                                              | Supported                     | Enable on the branch (off by default). `signIn.magicLink`.                                                                                                                                                                                                                                                                                       |
| Organization                                            | Partial, Beta                 | Members, invitations, owner/admin/member. No Teams, server hooks, custom roles/permissions, or dynamic access control. Emailed invitations: [managed-auth.md](references/managed-auth.md#organization-invitations).                                                                                                                              |
| JWT                                                     | Supported                     | EdDSA (Ed25519), 15-minute expiry, no custom claims. Default client: `.token()` then `data.token`. `SupabaseAuthAdapter()`: `getSession()` then `data.session.access_token` (no `.token()`).                                                                                                                                                     |
| Open API                                                | Supported                     | Server routes `/reference` and `/open-api/generate-schema`.                                                                                                                                                                                                                                                                                      |
| Phone Number                                            | Supported with constraints    | Browser client: existing users link a number, then sign in; no phone-first signup; own SMS webhook; custom UI. Next.js `auth.handler()` forwards the catch-all path, including phone OTP. A missing `auth.phoneNumber` server method is a missing typed helper, not a proxy rejection. https://neon.com/docs/auth/guides/plugins/phone-number.md |
| MFA / Two-Factor                                        | Roadmap                       | Unavailable on Managed Auth. If required: [self-managed.md](references/self-managed.md), after confirming the installed Better Auth version.                                                                                                                                                                                                     |
| Passkey, API Key, Generic OAuth, One Tap, Multi Session | Not exposed by Managed SDK/UI | If required: [self-managed.md](references/self-managed.md). Generic OAuth is not Google/GitHub/Vercel social sign-in.                                                                                                                                                                                                                            |
| MCP / OAuth Provider                                    | Not Managed Auth              | Third-party MCP clients self-authorizing against your server. Keep existing login. See `neon-functions` [references/mcp.md](https://neon.com/docs/ai/skills/neon-functions/references/mcp.md).                                                                                                                                                   |
| SSO / SAML                                              | Not listed or exposed         | If required: [self-managed.md](references/self-managed.md), after confirming the installed Better Auth version.                                                                                                                                                                                                                                  |

The default Managed client method is `getAnonymousToken()`. That JWT is a Neon anonymous Data API token. It is not Better Auth's Anonymous-account plugin (`signIn.anonymous`). `anonymousTokenClient()` is the SDK plugin factory, not a method on the public client. Do not call it, and do not call `getAnonymousToken()` on `SupabaseAuthAdapter()`.

Trusted domains and webhooks are Neon settings, not installable Better Auth plugins.

## Trusted domains

Auth redirects only to origins on its allowlist. `invalid domain` means the app origin is missing. Include the scheme, omit a trailing slash, register production and preview origins before pointing users at them, and target the correct branch:

```bash
neon neon-auth domain add https://app.example.com
neon neon-auth domain list
neon neon-auth domain delete https://old.example.com
```

Localhost ports are pre-approved by default. An existing project can have that off: `neon neon-auth domain allow-localhost get|enable|disable`. Docs: https://neon.com/docs/auth/guides/configure-domains.md

OAuth provider redirect is `{NEON_AUTH_BASE_URL}/callback/{provider}` (the Auth URL includes its path). `callbackURL` on `signIn.social` is the later app landing origin and must be trusted.

The Managed SDK handles iframe OAuth popup and `neon_auth_session_verifier`. Keep the wrapper, callback route, and middleware. Do not reimplement that flow, and do not promise third-party cookies in every browser.

## Functions and Data API

A Function authenticates whoever already signs the user in. Do not switch identity to call a Function. Verify the token in the `neon-functions` skill and https://neon.com/docs/compute/functions/authentication.md.

Managed Auth: injected `NEON_AUTH_JWKS_URL`, issuer from `NEON_AUTH_BASE_URL`. Token: default client `.token()` then `data.token`; `SupabaseAuthAdapter()` `getSession()` then `data.session.access_token`. A valid token is not permission to read another user's rows. Sign-out ends the browser session; do not claim it immediately revokes an already-issued JWT.

Data API identity: [references/managed-auth.md](references/managed-auth.md). New apps query Postgres from Functions or existing handlers, not the Data API.
