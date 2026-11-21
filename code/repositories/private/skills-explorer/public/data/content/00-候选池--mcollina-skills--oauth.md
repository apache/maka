---
name: oauth
description: Implements OAuth 2.0/2.1 authorization flows in Fastify applications — configures authorization code with PKCE, client credentials, device flow, refresh token rotation, JWT validation, and token introspection/revocation endpoints. Use when setting up authentication, authorization, login flows, access tokens, API security, or securing Fastify routes with OAuth; also applies when troubleshooting token validation errors, mismatched redirect URIs, CSRF issues, scope problems, or RFC 6749/6750/7636/8252/8628 compliance questions.
metadata:
  tags: oauth, oauth2, security, authentication, authorization, jwt, fastify
---

## When to use

Use this skill when you need to:

- Implement or debug an OAuth 2.0/2.1 flow in a Fastify application
- Validate tokens, configure PKCE, or set up refresh token rotation
- Secure Fastify routes and plugins with access-control middleware
- Resolve RFC compliance questions or identify security anti-patterns

---

## Step-by-step: Authorization Code + PKCE in Fastify

### 1. Install dependencies

```bash
npm install @fastify/oauth2 @fastify/cookie @fastify/session fastify-plugin
```

### 2. Register the OAuth plugin

```typescript
// plugins/oauth.ts
import fp from "fastify-plugin";
import oauth2, { OAuth2Namespace } from "@fastify/oauth2";
import { FastifyInstance } from "fastify";

export default fp(async function (fastify: FastifyInstance) {
  fastify.register(oauth2, {
    name: "oauth2",
    scope: ["openid", "profile", "email"],
    credentials: {
      client: {
        id: process.env.CLIENT_ID!,
        secret: process.env.CLIENT_SECRET!,
      },
      auth: {
        authorizeHost: process.env.AUTH_SERVER!,
        authorizePath: "/authorize",
        tokenHost: process.env.AUTH_SERVER!,
        tokenPath: "/token",
      },
    },
    startRedirectPath: "/login",
    callbackUri: process.env.CALLBACK_URI!,
    pkce: "S256", // RFC 7636 — always use for public clients
    generateStateFunction: (req) => (req.session.state = crypto.randomUUID()),
    checkStateFunction: (req, callback) =>
      req.query.state === req.session.state ? callback() : callback(new Error("State mismatch")),
  });
});
```

**Validation checkpoint:** Confirm `callbackUri` exactly matches a registered redirect URI at the authorization server before proceeding (RFC 6749 §3.1.2).

### 3. Handle the callback and exchange the code

```typescript
// routes/auth.ts
import { FastifyInstance } from "fastify";

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.get("/login/callback", async (request, reply) => {
    // @fastify/oauth2 verifies state and exchanges code automatically
    const tokenResponse = await fastify.oauth2.getAccessTokenFromAuthorizationCodeFlow(request);

    // Store only what you need; never log the raw token
    request.session.set("accessToken", tokenResponse.token.access_token);
    request.session.set("refreshToken", tokenResponse.token.refresh_token);

    return reply.redirect("/");
  });

  fastify.get("/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.redirect("/");
  });
}
```

### 4. JWT validation middleware (token introspection hook)

```typescript
// hooks/verifyToken.ts
import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "@fastify/jwt";

export async function verifyToken(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    // Validate required claims (RFC 7519)
    const payload = request.user as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp === "number" && payload.exp < now)
      return reply.code(401).send({ error: "token_expired" });

    if (payload.iss !== process.env.EXPECTED_ISSUER)
      return reply.code(401).send({ error: "invalid_issuer" });

    if (payload.aud !== process.env.EXPECTED_AUDIENCE)
      return reply.code(401).send({ error: "invalid_audience" });
  } catch (err) {
    return reply
      .code(401)
      .send({ error: "invalid_token", error_description: (err as Error).message });
  }
}
```

**Validation checkpoints:**

- Verify `exp`, `iss`, `aud`, and `sub` on every request — never skip (RFC 7519 §4)
- Use `fastify.jwt.verify` (asymmetric RS256/ES256) rather than HS256 for tokens issued by a third-party server

### 5. Protecting routes

```typescript
// routes/api.ts
import { FastifyInstance } from "fastify";
import { verifyToken } from "../hooks/verifyToken";

export default async function apiRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", verifyToken); // applies to all routes in this scope

  fastify.get(
    "/me",
    {
      schema: {
        response: { 200: { type: "object", properties: { sub: { type: "string" } } } },
      },
    },
    async (request) => {
      const user = request.user as { sub: string };
      return { sub: user.sub };
    },
  );
}
```

### 6. Refresh token rotation

```typescript
async function refreshAccessToken(fastify: FastifyInstance, refreshToken: string) {
  const newToken = await fastify.oauth2.getNewAccessTokenUsingRefreshTokenFlow({
    refresh_token: refreshToken,
  });

  // Always replace the stored refresh token if rotation is in use (RFC 6749 §10.4)
  return {
    accessToken: newToken.token.access_token,
    refreshToken: newToken.token.refresh_token ?? refreshToken,
  };
}
```

---

## Security checklist

| Requirement                                     | RFC reference     |
| ----------------------------------------------- | ----------------- |
| Validate redirect URI against allowlist         | RFC 6749 §3.1.2   |
| PKCE (S256) for all public clients              | RFC 7636 §4.2     |
| Validate `state` to prevent CSRF                | RFC 6749 §10.12   |
| Validate `iss`, `aud`, `exp` on every JWT       | RFC 7519 §4       |
| Rotate refresh tokens on every use              | RFC 6749 §10.4    |
| Use HTTPS everywhere; reject HTTP redirect URIs | RFC 6749 §3.1.2.1 |
| Rate-limit token endpoints                      | OAuth 2.1 §7      |

---

## Common anti-patterns

- **Storing tokens in localStorage** — use `HttpOnly`, `Secure`, `SameSite=Strict` cookies instead
- **Skipping audience validation** — allows token reuse across services
- **Using implicit flow** — deprecated in OAuth 2.1; use authorization code + PKCE
- **Accepting `response_type=token` in browser apps** — tokens in URL fragments leak in logs/referrers
- **Symmetric signing (HS256) for third-party tokens** — use RS256/ES256 with JWKS endpoint

---

## Further implementation references

- See `DEVICE_FLOW.md` for device authorization flow (RFC 8628) implementation
- See `TOKEN_VALIDATION.md` for JWKS rotation, caching strategies, and opaque token introspection
- See `CLIENT_CREDENTIALS.md` for machine-to-machine service authentication patterns
- See `MOBILE_OAUTH.md` for native/mobile app flows (RFC 8252) and custom URI schemes
