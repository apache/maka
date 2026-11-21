---
name: aws-auth
description: >
  Adds user authentication to web and mobile apps with Amazon Cognito (user pools and identity
  pools) and the AWS Amplify client auth libraries. Covers sign-up/sign-in flows and the login
  page (Cognito-hosted UI / managed login), MFA, password policies, OAuth 2.0 / OIDC flows
  (auth-code + PKCE, client credentials), social/SAML federation, tokens (ID/access/refresh,
  rotation, revocation, storage), Cognito Lambda triggers, identity pools (temp AWS creds), and
  gating API Gateway (or ALB) routes to signed-in users via Cognito/JWT authorizers. Applies when
  adding a login or sign-up page, configuring a user pool or app client, choosing user pool vs
  identity pool, wiring social/SAML, refreshing tokens, requiring sign-in on an API Gateway or
  ALB, or debugging redirect_uri/token/MFA/CORS/federation errors. Does NOT cover Amplify Gen2
  backend definitions (defineAuth, npx ampx → aws-amplify), IAM/STS/Identity Center (→ aws-iam),
  or API Gateway/Lambda resource config beyond the authorizer (→ aws-serverless).
metadata:
  version: "1"
---

# AWS Auth (Amazon Cognito)

Application-level user authentication and authorization with Amazon Cognito and the Amplify
client auth libraries. Verify specific limits, quotas, and exact API shapes against official AWS
documentation when precision matters; trust the docs over memory when they conflict.

**Recommended:** The AWS MCP server provides streamlined access to the AWS APIs used in this skill (Cognito user pool/app client/identity pool setup, API Gateway authorizers). If it is unavailable, the AWS CLI commands shown throughout work directly — the skill has no hard dependency on MCP.

**When NOT to use:** Amplify Gen2 backend code (`defineAuth`, `amplify/auth.ts`, `npx ampx`); IAM
policy/role/trust-policy authoring, STS, or IAM Identity Center console SSO; API Gateway
route/integration setup or Lambda function implementation (this skill covers only the Cognito/JWT
authorizer configuration and the purpose of Cognito Lambda triggers).

## User Pool vs Identity Pool — pick first

These are different services that are frequently confused. Most apps need a **user pool**; add an
**identity pool only if** the client must call AWS services directly.

| You need...                                                                 | Use                       | Why                                                        |
| --------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| Sign-up / sign-in, user directory, issue JWTs                               | **User pool**             | It authenticates users and is an OIDC IdP                  |
| The signed-in client to call S3/DynamoDB/etc. directly with AWS credentials | **Identity pool**         | It exchanges a token for temporary AWS credentials via STS |
| Both (sign in, then hit AWS resources from the browser/app)                 | User pool → identity pool | Identity pool trusts the user pool as its IdP              |

If your app only calls your own backend/API, you do **not** need an identity pool — send the user
pool token to your API. See [identity-pools.md](references/identity-pools.md).

## Critical Warnings

**`update-user-pool-client` and `set-identity-pool-roles` are FULL REPLACE, not partial updates**: Any field you omit is reset to its default — calling `update-user-pool-client` with only the fields you want to change silently wipes `ExplicitAuthFlows`, token validity, `EnableTokenRevocation`, refresh-token rotation, and read/write attributes; `set-identity-pool-roles` likewise replaces the whole roles + `RoleMappings` structure. **Always read-modify-write**: `describe-user-pool-client` (or `get-identity-pool-roles`) first, then re-send every existing field plus your change. In an agent context the wipe is invisible — the call succeeds and only breaks later when a user hits the missing flow. See [managed-login-oauth.md](references/managed-login-oauth.md) and [identity-pools.md](references/identity-pools.md).

**Don't use the implicit grant for new apps**: The implicit grant (`response_type=token`) is legacy and returns tokens in the URL fragment. Use the **authorization code grant with PKCE** (`response_type=code` + `code_challenge`) for SPAs and mobile — public clients, no client secret. See [managed-login-oauth.md](references/managed-login-oauth.md).

**Don't store refresh tokens in localStorage for high-value apps**: `localStorage` is readable by any injected script (XSS). The Amplify client library defaults to `localStorage`; switch to `cookieStorage`, keep refresh-token lifetime short, and enable **refresh token rotation** + **token revocation** on the app client. See [tokens-and-sessions.md](references/tokens-and-sessions.md).

**Access-token claim customization needs a paid feature plan**: The pre token generation trigger customizes the **ID token** on the entry-level plan (V1), but customizing the **access token** (V2/V3) requires a **paid feature plan** — check the [Cognito feature plans documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html) for which plan currently includes this, as plan names and inclusions can change. Don't assume access-token claims work on the entry-level plan. See [lambda-triggers.md](references/lambda-triggers.md).

**App client secret + SPA = broken auth**: A public client (browser/mobile) must have **no client secret**. If a secret is set, token calls fail unless a `SECRET_HASH` is sent, which a browser cannot protect. Generate a secret only for confidential (server-side) clients.

**Don't bulk `admin-confirm-sign-up` UNCONFIRMED users**: When users are stuck `UNCONFIRMED`, prefer `resend-confirmation-code` so each user re-verifies via `confirm-sign-up` and proves email ownership (the code likely expired or went to spam). `admin-confirm-sign-up` flips the status instantly but confirms the account **without verifying the email** — the attribute stays unverified, which is dangerous when email drives password reset or account linking. Reserve it for trusted/migrated accounts. See [troubleshooting.md](references/troubleshooting.md).

## Quick Navigation

| You want to...                                                                                                              | Go to                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Create a user pool, sign-up/sign-in, MFA, password policy, app clients                                                      | [user-pools.md](references/user-pools.md)                   |
| Add hosted UI / managed login, OAuth flows, social or SAML login, callback URLs, **custom domain (ACM in us-east-1)**       | [managed-login-oauth.md](references/managed-login-oauth.md) |
| Handle ID/access/refresh tokens, rotation, revocation, **session termination (global sign-out vs revoke vs disable)**       | [tokens-and-sessions.md](references/tokens-and-sessions.md) |
| Give the client temporary AWS credentials, guest access, role mapping                                                       | [identity-pools.md](references/identity-pools.md)           |
| Protect an API Gateway API with Cognito tokens (**and enforce custom claims in the backend**)                               | [api-authorization.md](references/api-authorization.md)     |
| Add Cognito login in front of an Application Load Balancer (ALB `authenticate-cognito`)                                     | [api-authorization.md](references/api-authorization.md)     |
| Machine-to-machine (client credentials) auth, resource servers, custom scopes                                               | [managed-login-oauth.md](references/managed-login-oauth.md) |
| Create user pool groups and add users to them (`cognito:groups`, `Precedence`)                                              | [user-pools.md](references/user-pools.md)                   |
| Customize claims, custom auth challenge flows, migrate users, validate sign-up                                              | [lambda-triggers.md](references/lambda-triggers.md)         |
| Add **passkey / WebAuthn** sign-in (`USER_AUTH` flow, `AllowedFirstAuthFactors`, WebAuthn enrollment)                       | [passkeys.md](references/passkeys.md)                       |
| Configure **threat protection** — compromised-credentials block, adaptive auth (risk-based MFA), log delivery to CloudWatch | [threat-protection.md](references/threat-protection.md)     |
| Something is broken (redirect, token, MFA, CORS, social login)                                                              | [troubleshooting.md](references/troubleshooting.md)         |

## Common Workflows

**"Add sign-up and login to my React app"** → Create a user pool + a public app client (no secret), enable the hosted UI / managed login with the authorization code grant with PKCE, wire the Amplify client library. See [user-pools.md](references/user-pools.md) and [managed-login-oauth.md](references/managed-login-oauth.md).

**"Add Google / social login"** → Register the social IdP on the user pool, map attributes, add the provider to the app client and hosted UI. See [managed-login-oauth.md](references/managed-login-oauth.md).

**"Only authenticated users should call my API"** → HTTP API → JWT authorizer; REST API → Cognito user pools authorizer. See [api-authorization.md](references/api-authorization.md).

**"Let the browser upload to S3 after login"** → User pool for sign-in, then an identity pool to vend scoped temporary credentials. See [identity-pools.md](references/identity-pools.md).

## Troubleshooting

| Error/Symptom                                           | Likely Cause                                                              | Quick Fix                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `redirect_mismatch` / redirect to wrong URL after login | Callback URL not registered, or scheme/trailing-slash/case differs        | Add the exact callback URL (incl. scheme and path) to the app client's Allowed callback URLs                                                           |
| Token calls fail with "unable to verify secret hash"    | Client secret set on a public (SPA/mobile) client                         | Recreate the app client with no secret, or send `SECRET_HASH` from a confidential client                                                               |
| Users get 401 from API Gateway with a valid token       | Wrong token type or audience/issuer mismatch                              | HTTP JWT authorizer: issuer `https://cognito-idp.{region}.amazonaws.com/{userPoolId}`, audience = app client id; send the token the authorizer expects |
| CORS errors calling the hosted UI / token endpoint      | Browser calling `/oauth2/token` cross-origin, or missing CORS on your API | Do the code exchange with PKCE; don't proxy the token endpoint from the browser                                                                        |
| Social login user "already exists" / attribute conflict | Same email across providers creates separate users                        | Enable attribute mapping + account linking; treat email as non-unique across IdPs                                                                      |

Full tables in [troubleshooting.md](references/troubleshooting.md).

## Security Considerations

- Public clients (SPA/mobile): **no client secret**, authorization code grant **with PKCE**, request least-privilege scopes.
- Enable **MFA** (TOTP or SMS), a strong password policy, and **advanced security / threat protection** where available.
- Short access-token lifetime; enable **refresh token rotation** and **token revocation**; prefer `cookieStorage` over `localStorage`.
- Identity pools: scope the authenticated IAM role tightly; disable unauthenticated (guest) access unless required.
- Validate JWTs against the user pool JWKS (`iss`, `aud`/`client_id`, `token_use`, `exp`) on every protected request. Use a maintained library such as [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify) rather than hand-rolling verification.
- Set security headers on the app's web pages: `Content-Security-Policy` (restrict script sources to mitigate token-stealing XSS), `Strict-Transport-Security` (HSTS), `X-Frame-Options`/`frame-ancestors` (clickjacking on login pages), and `X-Content-Type-Options: nosniff`.
- Enable logging and monitoring: CloudTrail for Cognito API events (sign-up/sign-in/admin), user pool threat protection (adaptive auth + event logging), CloudWatch alarms on failed/throttled auth, and API Gateway access logging for authorizer decisions.
- All Cognito and API endpoints are HTTPS/TLS only; enable encryption at rest with a customer-managed KMS key (and restricted key access) on CloudWatch Log groups, SNS topics used for MFA/notifications, and any identity-pool-fronted upload buckets.
- If using SNS for MFA/notification delivery, enable server-side encryption (KMS) on the topic, and keep SMS/email message content limited to what the recipient needs — don't include more PII than the message requires.
- References: [Amazon Cognito security features (user pools)](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-security.html), [Amazon Cognito security (top-level, incl. identity pools)](https://docs.aws.amazon.com/cognito/latest/developerguide/security.html), and [IAM/STS best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html).

## Where to Look When This Skill Is Silent

When you need depth beyond this skill — exact parameter shapes, current limits, edge behaviors — fall back to the authoritative AWS sources rather than guessing. Pointers age much slower than content, so this map stays useful without the skill having to grow.

- **API reference (exact params, defaults, errors):** [Cognito User Pools API](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/) and [Cognito Identity API](https://docs.aws.amazon.com/cognitoidentity/latest/APIReference/)
- **Developer Guide (concepts, workflows):** [Amazon Cognito Developer Guide](https://docs.aws.amazon.com/cognito/latest/developerguide/)
- **Quotas, rate limits, session-cookie lifetime:** [Cognito quotas](https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html)
- **Feature plans / tier gating:** [Cognito feature plans](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html)
- **Pricing:** [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/)
- **CLI reference:** [aws cognito-idp](https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/) and [aws cognito-identity](https://docs.aws.amazon.com/cli/latest/reference/cognito-identity/)

## Not Covered By This Skill

- **Amplify Gen2 backend** (`defineAuth`, `amplify/auth.ts`, `npx ampx sandbox`).
- **IAM policy/role/trust-policy authoring, STS, IAM Identity Center console SSO.**
- **API Gateway route/integration setup and Lambda function implementation** (this skill covers only the Cognito/JWT authorizer configuration and the purpose of Cognito Lambda triggers).
