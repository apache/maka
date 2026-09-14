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

# Maka Web: HTTPS front door + owner passphrase + TOTP

**Date:** 2026-09-14

**Status:** Approved for implementation planning (not yet implemented)

**Audience:** other devices on the operator’s Tailscale tailnet; same-machine Chrome remains supported

## Problem

Today `npm run maka-web` serves the full desktop renderer over **plain HTTP** on loopback and puts the per-launch bridge token in the **URL query**. That is acceptable only for `http://127.0.0.1` on the same box. Opening the app from a phone or another laptop on Tailscale leaks the token into history, logs, and Referer, and there is no person-check in front of the GUI’s capabilities.

The operator wants:

- HTTPS when reaching Maka from other devices
- A login portal on the web path
- Web-only 2FA (passphrase + authenticator app)
- No MFA on the local Electron GUI
- No SQL in the auth path (SQLi is out of scope because there is no query)

## Goals

1. Other devices open `https://maka.<tailnet>.ts.net` (Tailscale Serve) and must pass **passphrase + TOTP** before the app or `/bridge` loads.
2. The local GUI is unchanged: no login page, no TOTP prompt, no cookie.
3. The Electron bridge token never appears in the browser URL, `localStorage`, or JavaScript. It stays on disk (`$TMPDIR/maka-web-bridge.json`) and is attached only on the **loopback** hop from the gateway to the GUI.
4. Maka never holds a TLS private key. Tailscale terminates HTTPS.
5. Auth storage is a mode-0600 JSON file with an Argon2id passphrase hash and a TOTP secret. No SQLite, no string-built SQL.

## Non-goals (v1)

- mkcert, LAN-without-Tailscale, binding `0.0.0.0`, or public internet / Funnel
- Multiple user accounts, SSO, SMS, email codes, WebAuthn
- MFA on the Electron GUI
- Changing how the GUI owns runtime, sessions, and models (closing the GUI still drops browsers)
- Replacing the loopback WebSocket bridge protocol

## Architecture

The GUI and `ws://127.0.0.1:53217` bridge stay as they are. `maka-web` grows a **gateway** that is the only process other devices talk to.

```
Phone / laptop
    │  https://maka.<tailnet>.ts.net     Tailscale Serve (Let’s Encrypt)
    ▼
tailscale serve  →  http://127.0.0.1:5173
                        │
                        ▼
                   maka-web gateway
                   GET/POST /login
                   POST /logout
                   cookie gate on / and /bridge
                        │
          ┌─────────────┴──────────────┐
          ▼                            ▼
    Vite renderer                GUI web-bridge
    (same App)                   ws://127.0.0.1:53217
                                 token from disk, not from the browser
```

Same-machine Chrome may keep using `http://localhost:5173` (Chromium **secure context**, so a `Secure` cookie works). Prefer `localhost` over `127.0.0.1` in printed URLs for that reason.

The GUI still owns the backend. If it is not running, the gateway does not invent a runtime; `/login` explains how to start `maka-gui`.

## Components

### 1. Web-access credential file

Path: under Electron `userData` (not `/tmp`), e.g. `web-access.json`, mode `0600`, owner-only.

Contents (illustrative):

- `passphrase`: Argon2id hash (id, memory/time/parallelism, salt, hash) — never the passphrase
- `totp`: RFC 6238 secret (SHA1, 6 digits, 30s). Stored in this same mode-0600 file; do not add a wrapping key that lives next to the secret.
- `recovery`: Argon2id hashes of one-time recovery codes
- `lockout`: failure timestamps (optional; may live in-memory plus this file)
- `sessions`: SHA-256 of session ids → expiry (so a stolen file does not yield a live cookie value)

No SQL. Reads/writes are `JSON.parse` / `JSON.stringify` of this object. There is no query language to inject into.

Enrollment happens **only in the GUI**, Settings → **Web access**:

- Set or change passphrase (min length 12; confirm field)
- Show TOTP QR **once** (`otpauth://totp/Maka:<hostname>?secret=…&period=30&digits=6`)
- Print recovery codes once; re-print invalidates old unused codes
- Enable/disable web login (disable refuses `/login` POST even if the file exists)

The Electron GUI never prompts for these factors at startup.

### 2. Gateway routes (`maka-web`)

| Route | Behavior |
| --- | --- |
| `GET /login` | Passphrase + 6-digit authenticator (or recovery code) form. No token in the page. If GUI/bridge is down, show “start `maka-gui`” and do not link into the app. |
| `POST /login` | Body: `passphrase`, `otp`. Constant-time Argon2id verify + TOTP (1-step skew). Same generic error on any failure. Success: `Set-Cookie` session, `303` to `/`. |
| `POST /logout` | Clear cookie, `303` to `/login`. |
| `/` and static/Vite | Require valid session cookie; otherwise `303` to `/login`. |
| `/bridge` WebSocket | Require valid session cookie **before** upgrade. On success, the gateway opens `ws://127.0.0.1:53217` and sends the **disk** token (query or first-message, existing protocol). The browser never sees that token. |

`?token=` on the browser URL is **ignored**. Existing bookmarks with a token must still hit `/login`.

### 3. Session cookie

- Name: `maka_web_session` (or `__Host-maka_web_session` on HTTPS)
- Value: 32-byte CSPRNG, hex or base64url
- Flags: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`
- Lifetime: 12 hours, sliding on activity (refresh expiry server-side)
- Server stores only `SHA-256(value)` + expiry

Cookie is not readable by the renderer. The electron-shim stops putting the bridge token in `sessionStorage` / the URL.

### 4. Origin allowlist (bridge + gateway)

Allow:

- `http://localhost:<port>` and `http://127.0.0.1:<port>` (same machine)
- `https://*.ts.net` (Tailscale Serve / MagicDNS)

Deny everything else, including missing Origin on browser WebSocket upgrades. The loopback bridge continues to bind `127.0.0.1` only.

### 5. Tailscale Serve

`maka-web` does **not** bind a public interface. After the gateway is listening on `127.0.0.1:5173`, it prints (and docs show) the exact command, for example:

```sh
tailscale serve --bg http://127.0.0.1:5173
```

The operator opens the `https://…ts.net` URL Tailscale prints. Maka never reads Tailscale’s cert files.

If Serve is not running, other devices cannot connect; that is intended. The login page on loopback still works for same-machine use.

## Login, passphrase, TOTP

**Passphrase** is a secret the operator invents in GUI Settings. Stored as Argon2id. Typed on the web login page. Something you know.

**Authenticator code** is RFC 6238 TOTP: 6 digits, 30-second step, from Aegis / 1Password / Google Authenticator / Authy after scanning the GUI QR. Maka and the app share the secret and compute the same code. No SMS, no email, no Maka cloud account. Something you have.

Web login requires **both**. GUI requires **neither**.

Recovery codes: 8 single-use codes, hashed like the passphrase. Using one logs in and does not disable TOTP; the used hash is deleted.

### Abuse controls (web only)

- Constant-time comparison on hashes. Always run a TOTP check (dummy secret on passphrase failure) so which factor failed does not leak via timing.
- Lockout: 5 failures per client address and 20 failures global in 15 minutes → `429` with `Retry-After`
- TOTP replay: reject a code already accepted for this secret in the current and previous step
- No username field (single owner) — no user enumeration
- POST `/login` CSRF: same-origin form + `SameSite=Strict` cookie (unauthenticated POST has no cookie yet; require `Origin` allowlist on POST)

## Error handling

| Condition | Operator sees |
| --- | --- |
| GUI / bridge down | Login copy: start `maka-gui`. App shell does not load. |
| Wrong passphrase or TOTP | One generic “Could not sign in”. |
| Lockout | “Try again in N minutes.” |
| Replayed TOTP | Same generic sign-in error. |
| Missing / expired cookie | Redirect to `/login`. |
| Serve not running | Terminal tip with `tailscale serve …`. No `0.0.0.0` bind. |
| Web access not enrolled | Login: “Set a passphrase and authenticator in the GUI under Settings → Web access.” |

## Testing

Must exist before calling the work done:

1. `POST /login` without TOTP → reject; passphrase + valid TOTP → `Set-Cookie` HttpOnly, no token in body.
2. `/bridge` upgrade without cookie → 401; with cookie → proxy to loopback using the **disk** token.
3. Browser URL `?token=` is ignored; a stolen old token in the query does not authenticate.
4. Argon2id verify; lockout after N failures; TOTP replay rejected; recovery code works once.
5. Auth path contains no SQL driver usage (unit test or architecture check).
6. Origin: `https://foo.ts.net` allowed; `https://evil.example` 403; loopback http allowed.
7. GUI boot / settings paths never prompt for TOTP.
8. Renderer `connect-src 'self'` still holds (gateway is same origin).

Manual: enroll QR in an authenticator, `tailscale serve`, sign in from another device, confirm chat/settings load, sign out, confirm `/bridge` drops.

## Key decisions

| Decision | Rationale |
| --- | --- |
| Loopback Maka + HTTPS front door, not TLS inside Vite | Tailscale already terminates TLS; Maka must not hold the key. |
| Tailscale Serve only for remote HTTPS; no mkcert in v1 | Operator reaches other devices via the tailnet. mkcert is extra CA install. |
| Single owner passphrase + TOTP, not account SQL | Maka is a single-user local app. No query language ⇒ no SQLi. |
| MFA web-only | GUI already has OS session + physical access. Extra prompts there are noise. |
| Cookie, not `?token=` | Tokens in URLs leak to history, logs, Referer. |
| Gateway holds the bridge token | Browser XSS cannot steal the Electron IPC capability token. |
| Generic login errors + lockout + TOTP replay cache | Stops factor-oracle and code reuse. |
| No `0.0.0.0` bind | If Serve is down, the app is not accidentally on the LAN. |

## PR plan

1. **Web-access credential store + GUI Settings** — file format, Argon2id, TOTP enroll QR, recovery codes, enable flag. GUI only. Tests for hash/verify/replay. No gateway yet.
2. **Gateway login + session cookie** — `/login`, `/logout`, cookie gate on `/` and `/bridge`, strip URL token, proxy disk token to the bridge. Tests 1–5, 8 above.
3. **Origin allowlist + Tailscale Serve docs** — `https://*.ts.net`, printed `tailscale serve` command, `docs/web-client.md` update. Tests 6–7.
4. **Lockout / abuse polish** — per-IP + global counters, dummy TOTP on passphrase failure, `Retry-After`. Tests for lockout.

Each PR is independently reviewable; 2 is usable on localhost without Tailscale; 3 is what makes other devices work.

## Operator flow (v1)

```sh
# Terminal 1
xvfb-run -a npm run maka-gui   # or a normal GUI

# In the GUI: Settings → Web access → passphrase, scan QR, save recovery codes

# Terminal 2
npm run maka-web -- --no-open
# prints http://localhost:5173/login  and the tailscale serve command

tailscale serve --bg http://127.0.0.1:5173
# open https://maka.<tailnet>.ts.net  → passphrase + 6-digit code
```
