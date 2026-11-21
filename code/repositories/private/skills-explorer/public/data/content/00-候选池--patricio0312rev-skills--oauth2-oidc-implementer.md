---
name: oauth2-oidc-implementer
description: Implements OAuth 2.0 and OpenID Connect authentication flows with secure token handling and provider integration. Use when users request "OAuth setup", "OIDC implementation", "social login", "SSO integration", or "authentication flow".
---

# OAuth 2.0 & OIDC Implementer

Implement secure authentication with OAuth 2.0 and OpenID Connect.

## Core Workflow

1. **Choose flow**: Authorization Code, PKCE, Client Credentials
2. **Configure provider**: Set up OAuth/OIDC provider
3. **Implement flow**: Handle redirects and tokens
4. **Secure tokens**: Storage and refresh
5. **Add providers**: Multiple identity providers
6. **Handle sessions**: Manage authenticated state

## OAuth 2.0 Flows Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      OAuth 2.0 Flows                         │
├─────────────────────────────────────────────────────────────┤
│ Authorization Code + PKCE │ Web/Mobile apps (recommended)   │
│ Client Credentials        │ Machine-to-machine              │
│ Device Code               │ TV/IoT devices                  │
│ Implicit (deprecated)     │ Do not use                      │
└─────────────────────────────────────────────────────────────┘
```

## Authorization Code Flow with PKCE

### Server Implementation (Next.js)

```typescript
// lib/auth/oauth.ts
import { randomBytes, createHash } from "crypto";

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string[];
}

const config: OAuthConfig = {
  clientId: process.env.OAUTH_CLIENT_ID!,
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  authorizationUrl: "https://provider.com/oauth/authorize",
  tokenUrl: "https://provider.com/oauth/token",
  redirectUri: process.env.OAUTH_REDIRECT_URI!,
  scopes: ["openid", "profile", "email"],
};

// Generate PKCE challenge
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// Generate state for CSRF protection
function generateState(): string {
  return randomBytes(16).toString("hex");
}

export function getAuthorizationUrl(): {
  url: string;
  state: string;
  codeVerifier: string;
} {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    url: `${config.authorizationUrl}?${params}`,
    state,
    codeVerifier,
  };
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new OAuthError(error.error_description || "Token exchange failed");
  }

  return response.json();
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}
```

### Login Route

```typescript
// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthorizationUrl } from "@/lib/auth/oauth";

export async function GET() {
  const { url, state, codeVerifier } = getAuthorizationUrl();

  // Store state and verifier in secure, httpOnly cookies
  const cookieStore = cookies();

  cookieStore.set("oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  cookieStore.set("code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(url);
}
```

### Callback Route

```typescript
// app/api/auth/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCodeForTokens } from "@/lib/auth/oauth";
import { createSession } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Handle OAuth errors
  if (error) {
    const errorDescription = searchParams.get("error_description");
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorDescription || error)}`, request.url),
    );
  }

  // Validate state
  const cookieStore = cookies();
  const storedState = cookieStore.get("oauth_state")?.value;
  const codeVerifier = cookieStore.get("code_verifier")?.value;

  if (!state || state !== storedState) {
    return NextResponse.redirect(new URL("/login?error=invalid_state", request.url));
  }

  if (!code || !codeVerifier) {
    return NextResponse.redirect(new URL("/login?error=missing_code", request.url));
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, codeVerifier);

    // Create session with tokens
    await createSession(tokens);

    // Clear OAuth cookies
    cookieStore.delete("oauth_state");
    cookieStore.delete("code_verifier");

    return NextResponse.redirect(new URL("/dashboard", request.url));
  } catch (error) {
    console.error("OAuth callback error:", error);
    return NextResponse.redirect(new URL("/login?error=authentication_failed", request.url));
  }
}
```

## OpenID Connect Integration

### OIDC Discovery

```typescript
// lib/auth/oidc.ts
interface OIDCConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  scopes_supported: string[];
  response_types_supported: string[];
}

let cachedConfig: OIDCConfig | null = null;

export async function discoverOIDCConfig(issuer: string): Promise<OIDCConfig> {
  if (cachedConfig) return cachedConfig;

  const response = await fetch(`${issuer}/.well-known/openid-configuration`);

  if (!response.ok) {
    throw new Error("Failed to fetch OIDC configuration");
  }

  cachedConfig = await response.json();
  return cachedConfig;
}
```

### ID Token Validation

```typescript
// lib/auth/jwt.ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import { discoverOIDCConfig } from "./oidc";

interface IDTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyIdToken(
  idToken: string,
  expectedNonce?: string,
): Promise<IDTokenClaims> {
  const config = await discoverOIDCConfig(process.env.OIDC_ISSUER!);

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.jwks_uri));
  }

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.issuer,
    audience: process.env.OAUTH_CLIENT_ID!,
  });

  // Verify nonce if provided (for implicit/hybrid flows)
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error("Invalid nonce");
  }

  return payload as IDTokenClaims;
}
```

### User Info Endpoint

```typescript
// lib/auth/userinfo.ts
interface UserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const config = await discoverOIDCConfig(process.env.OIDC_ISSUER!);

  const response = await fetch(config.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch user info");
  }

  return response.json();
}
```

## Session Management

```typescript
// lib/auth/session.ts
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SESSION_SECRET = new TextEncoder().encode(process.env.SESSION_SECRET!);

interface Session {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export async function createSession(tokens: TokenResponse): Promise<void> {
  const claims = await verifyIdToken(tokens.id_token!);

  const session: Session = {
    userId: claims.sub,
    email: claims.email!,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };

  const jwt = await new SignJWT(session)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(SESSION_SECRET);

  cookies().set("session", jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  });
}

export async function getSession(): Promise<Session | null> {
  const sessionCookie = cookies().get("session")?.value;
  if (!sessionCookie) return null;

  try {
    const { payload } = await jwtVerify(sessionCookie, SESSION_SECRET);
    return payload as Session;
  } catch {
    return null;
  }
}

export async function refreshSession(): Promise<Session | null> {
  const session = await getSession();
  if (!session?.refreshToken) return null;

  // Check if access token is expired
  if (session.expiresAt > Date.now() + 60000) {
    return session; // Still valid
  }

  // Refresh tokens
  const tokens = await refreshAccessToken(session.refreshToken);
  await createSession(tokens);

  return getSession();
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error("Token refresh failed");
  }

  return response.json();
}
```

## Multiple Providers

```typescript
// lib/auth/providers.ts
interface OAuthProvider {
  id: string;
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  mapUserInfo: (data: any) => UserProfile;
}

export const providers: Record<string, OAuthProvider> = {
  google: {
    id: "google",
    name: "Google",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    scopes: ["openid", "email", "profile"],
    mapUserInfo: (data) => ({
      id: data.sub,
      email: data.email,
      name: data.name,
      image: data.picture,
    }),
  },
  github: {
    id: "github",
    name: "GitHub",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    scopes: ["read:user", "user:email"],
    mapUserInfo: (data) => ({
      id: String(data.id),
      email: data.email,
      name: data.name || data.login,
      image: data.avatar_url,
    }),
  },
  microsoft: {
    id: "microsoft",
    name: "Microsoft",
    authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    clientId: process.env.MICROSOFT_CLIENT_ID!,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
    scopes: ["openid", "email", "profile", "User.Read"],
    mapUserInfo: (data) => ({
      id: data.id,
      email: data.mail || data.userPrincipalName,
      name: data.displayName,
      image: null,
    }),
  },
};
```

## Client Credentials Flow

```typescript
// lib/auth/machine.ts
interface ClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getMachineToken(config: ClientCredentialsConfig): Promise<string> {
  // Check cache
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.token;
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
        "base64",
      )}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: config.scopes.join(" "),
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to get machine token");
  }

  const data = await response.json();

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}
```

## Best Practices

1. **Always use PKCE**: Even for confidential clients
2. **Validate state**: Prevent CSRF attacks
3. **Verify tokens**: Check signature and claims
4. **Secure storage**: HttpOnly cookies for tokens
5. **Refresh proactively**: Before expiration
6. **Handle errors gracefully**: Clear messaging
7. **Use HTTPS**: Always in production
8. **Limit scopes**: Request minimum needed

## Output Checklist

Every OAuth/OIDC implementation should include:

- [ ] PKCE code verifier/challenge
- [ ] State parameter for CSRF
- [ ] Secure token storage
- [ ] Token refresh mechanism
- [ ] ID token validation
- [ ] Session management
- [ ] Logout handling
- [ ] Error handling
- [ ] Multiple provider support
- [ ] HTTPS enforcement
