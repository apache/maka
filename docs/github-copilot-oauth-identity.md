# GitHub Copilot OAuth app identity

Records where the GitHub Copilot device-flow client identity comes from, whose
consent screen a user sees, and what authorization basis Maka has for using it.
This exists because Maka does not own that identity.

## The identity

- Client ID: `Iv1.b507a08c87ecfe98`
- Declared in: `packages/runtime/src/oauth-provider-contracts.ts`
  (`OAUTH_PROVIDER_CONTRACTS['github-copilot'].clientId`)
- Endpoints: `https://github.com/login/device/code`,
  `https://github.com/login/oauth/access_token`
- Requested scope: `read:user`

## Source

The identity is GitHub's own Copilot editor/CLI OAuth app. It is embedded in
GitHub's first-party editor integrations and is widely reused by third-party
Copilot clients; Maka did not obtain it from GitHub through any registration or
grant of its own.

Maka already presents the matching editor compatibility headers
(`GITHUB_COPILOT_COMPAT_HEADERS` in `packages/runtime/src/subscription-credentials.ts`)
when calling the Copilot API, for the same reason: Copilot entitlement is
granted to editor clients, not to arbitrary OAuth apps.

## Consent identity

The user is shown GitHub's device-authorization screen naming **that editor
application**, not Maka. Maka then receives and stores the resulting GitHub
user token in the Workspace vault. The application a user believes they
authorized and the application that holds the credential are therefore not the
same.

## Authorization basis

**Not established.** There is no published GitHub authorization, compatibility
statement, or exemption permitting third-party reuse of this identity, and none
has been requested. Reuse rests only on the observation that other clients do
the same.

Consequences, and what is required before this changes:

- The interactive device flow ships **on**, so the sign-in is present in
  Settings, but it carries a kill switch:
  `MAKA_GITHUB_COPILOT_DEVICE_LOGIN_EXPERIMENTAL=0` refuses the login at the
  Host (`isOAuthEnrollmentProviderEnabled` in
  `packages/runtime/src/oauth-provider-contracts.ts`) without a release. This
  matches how Codex enrollment is gated.
- Importing a credential the user already holds locally (`gh auth token` or a
  fine-grained PAT with Copilot Requests permission) stays available beside it.
  That credential is issued to an identity the user chose, so it raises none of
  the questions above and remains the fallback if the device flow is turned off.
- Resolving this entry requires either a public GitHub authorization or
  compatibility basis for reusing this identity — linked from this file — or an
  OAuth app identity registered to and authorized for Maka, replacing the client
  ID above. Until then the consent identity mismatch described above stands.
