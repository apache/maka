/**
 * Static-analysis gate: cloak module isolation.
 *
 * xuan `2c5aa125` G-X4: the cloak header logic MUST live in
 * runtime request construction, not in the desktop OAuth service.
 *
 * This test scans source files; it does not execute the cloak path.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVICE_SOURCE = resolve(
  DESKTOP_ROOT,
  'src',
  'main',
  'oauth',
  'claude-subscription-service.ts',
);
const SUBSCRIPTION_MODEL_FETCH_SOURCE = resolve(
  DESKTOP_ROOT,
  'src',
  'main',
  'subscription-model-fetch.ts',
);
describe('cloaked request module isolation (xuan G-X4)', () => {
  it('subscription service does NOT statically import cloak request construction', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.doesNotMatch(
      src,
      /^\s*import\s+[^;]+from\s+['"].*cloaked-request[^'"]*['"]/m,
      'claude-subscription-service.ts must NOT statically import cloak request construction',
    );
  });

  it('getAuthorizationUrl clears prior pending so only one authRequestId is ever valid (PR-CLAUDE-OAUTH-SINGLE-PENDING-0)', async () => {
    // WAWQAQ msg b481e9db: user clicked 登录 multiple times; each
    // click stashed a new pending under a fresh authRequestId, but
    // older pendings stayed valid for 10 min and the modal only
    // remembered the LATEST stateHint. If the user pasted from a
    // browser tab tied to an older Anthropic redirect, the parsed
    // state would not match the latest pending and validation
    // would fail forever. Pinning that getAuthorizationUrl
    // explicitly clears prior pendings keeps this from regressing.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    const region = src.match(/async getAuthorizationUrl\(\)[\s\S]*?const verifier/);
    assert.ok(region, 'getAuthorizationUrl must exist');
    assert.match(
      region[0],
      /this\.pending\.clear\(\)/,
      'getAuthorizationUrl must clear prior pending so only one authRequestId is valid at a time',
    );
  });

  it('subscription service keeps the MAKA_CLAUDE_SUBSCRIPTION_CLOAK emergency opt-out', async () => {
    // The service should expose `isCloakEnabled()` (or otherwise
    // check the env var) so the send-path can decide whether to
    // delegate to the runtime cloak request builder.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /MAKA_CLAUDE_SUBSCRIPTION_CLOAK[\s\S]*!==\s*'0'/,
      'service must reference MAKA_CLAUDE_SUBSCRIPTION_CLOAK env flag (xuan G-X4 isolation)',
    );
  });

  it('main wires Claude OAuth sends through the dynamic cloak fetch wrapper by default', async () => {
    const src = await readMainProcessCombinedSource();
    assert.match(src, /buildSubscriptionModelFetch\(connection,\s*ctx\.sessionId,\s*model\)/);
    assert.match(src, /isCloakEnabled\(\)[\s\S]*buildClaudeSubscriptionCloakedFetch\([\s\S]*sessionId,\s*modelId\)/);
    assert.match(src, /modelFactory:\s*\(input\)\s*=>\s*getAIModel\(\{\s*\.\.\.input,\s*fetch:\s*modelFetch\s*\}\)/);
    assert.match(src, /buildRuntimeSubscriptionModelFetch\(\{[\s\S]*connection[\s\S]*sessionId[\s\S]*modelId/);
    assert.match(src, /claudeSubscription\.getOrCreateDeviceId\(\)/);
    assert.match(src, /claude:\s*\{[\s\S]*cloakEnabled:\s*true[\s\S]*deviceId[\s\S]*accountUuid/);
    assert.doesNotMatch(src, /buildCloakedRequest\(/, 'desktop must delegate Claude request construction to runtime');
    assert.doesNotMatch(src, /headers\.delete\(['"]x-api-key['"]\)/, 'x-api-key stripping belongs in runtime request construction');
  });

  it('main delegates Codex OAuth request construction to runtime', async () => {
    const src = await readFile(SUBSCRIPTION_MODEL_FETCH_SOURCE, 'utf8');
    assert.match(src, /providerType === 'openai-codex'[\s\S]*buildRuntimeSubscriptionModelFetch\(\{[\s\S]*connection[\s\S]*sessionId[\s\S]*modelId/);
    assert.doesNotMatch(src, /function buildOpenAiCodexFetch/, 'desktop must not duplicate the Codex fetch adapter');
    assert.doesNotMatch(src, /codexInstructionsFromBody/, 'Codex instruction mapping belongs in runtime');
    assert.doesNotMatch(src, /OpenAI-Beta/, 'Codex subscription headers belong in runtime');
  });

  it('main delegates GitHub Copilot subscription headers to the runtime adapter', async () => {
    const src = await readFile(SUBSCRIPTION_MODEL_FETCH_SOURCE, 'utf8');
    assert.match(
      src,
      /providerType === 'github-copilot'[\s\S]*buildRuntimeSubscriptionModelFetch\(\{[\s\S]*connection[\s\S]*sessionId[\s\S]*modelId/,
    );
    assert.doesNotMatch(src, /Openai-Intent/, 'GitHub Copilot compatibility headers belong in runtime');
    assert.doesNotMatch(src, /Copilot-Vision-Request/, 'GitHub Copilot vision headers belong in runtime');
  });

  it('token exchange uses the pasted OAuth state and can recover the verifier from Claude Code state', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /const parsed = parsePastedAuthorization\(rawPasted\);[\s\S]*?const pending = this\.pending\.get\(authRequestId\)/,
      'completeAuthorization must parse the pasted code#state before treating missing pending state as fatal',
    );
    assert.match(
      src,
      /const recoverFromPastedState = !pending \|\| pendingExpired;/,
      'Claude Code state is the PKCE verifier, so Maka must recover from a lost in-memory pending map',
    );
    assert.match(
      src,
      /const verifier = recoverFromPastedState \? parsed\.state : pending!\.verifier;/,
      'recovered Claude OAuth attempts must use pasted state as code_verifier',
    );
    assert.match(
      src,
      /exchangeCodeForTokens\(parsed\.code,\s*verifier,\s*parsed\.state\)/,
      'completeAuthorization must pass the user-pasted state into token exchange after validating it',
    );
    assert.doesNotMatch(
      src,
      /state:\s*verifier/,
      'token exchange body must not send the PKCE verifier as OAuth state when state and verifier are distinct',
    );
  });

  it('OAuth authorize flow tracks current Claude Code subscription endpoints and scopes', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /CLAUDE_AUTHORIZE_ENDPOINT\s*=\s*'https:\/\/claude\.com\/cai\/oauth\/authorize'/,
      'Claude subscription auth must use Claude Code subscription authorize route, not the stale claude.ai endpoint',
    );
    assert.match(
      src,
      /CLAUDE_REDIRECT_URI\s*=\s*'https:\/\/platform\.claude\.com\/oauth\/code\/callback'/,
      'Claude subscription auth must use the current platform callback route',
    );
    assert.match(
      src,
      /CLAUDE_TOKEN_ENDPOINT\s*=\s*'https:\/\/platform\.claude\.com\/v1\/oauth\/token'/,
      'Claude subscription token exchange must use the current platform token endpoint',
    );
    assert.match(
      src,
      /CLAUDE_SCOPE\s*=\s*'user:sessions:claude_code user:mcp_servers user:file_upload'/,
      'Claude subscription auth must request the current Claude Code account scopes',
    );
    assert.doesNotMatch(
      src,
      /https:\/\/console\.anthropic\.com\/(?:oauth\/code\/callback|v1\/oauth\/token)|org:create_api_key user:profile user:inference/,
      'Claude subscription auth must not regress to the stale console Anthropic OAuth route',
    );
  });

  it('token exchange failures do not consume pending authorization or collapse into generic auth copy', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    const completeStart = src.indexOf('async completeAuthorization(');
    assert.ok(completeStart > 0, 'completeAuthorization must exist');
    const completeRegion = src.slice(completeStart, completeStart + 2600);
    const exchangeIdx = completeRegion.indexOf('exchangeCodeForTokens(parsed.code, verifier, parsed.state)');
    const deleteIdx = completeRegion.indexOf('this.pending.delete(authRequestId)', exchangeIdx);
    assert.ok(exchangeIdx > 0 && deleteIdx > exchangeIdx, 'pending authorization should be consumed only after token exchange succeeds');
    assert.match(
      completeRegion,
      /failureFromError\('token_exchange_failed', err, '授权码已过期、已使用或与本次登录不匹配，请重新点击“登录订阅”获取新的授权码。'\)/,
      'token exchange failures should tell the user to get a fresh authorization code, not surface generic 鉴权失败',
    );
    assert.match(
      src,
      /class ClaudeTokenExchangeError extends Error[\s\S]*readonly status: number/,
      'token endpoint non-2xx responses should be typed before mapping to user copy',
    );
  });

  it('OAuth token endpoint UA matches the claude-cli/X.Y.Z shape Anthropic accepts (PR-CLAUDE-CARD-MOVE-0)', async () => {
    // WAWQAQ msg a62a4c1c reported "Authorization failed / Invalid
    // request format" after login. Root cause was that the OAuth
    // token endpoint (https://platform.claude.com/v1/oauth/token)
    // rejected our `maka-desktop/0.1.0 (oauth-subscription)` UA. The
    // The upstream Claude Code OAuth path sends
    // `claude-cli/X.Y.Z (external, cli)`. This is distinct from the
    // SEND-PATH cloak UA tested above; OAuth must use this UA
    // unconditionally for the endpoint to accept the request.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /OAUTH_USER_AGENT\s*=\s*`claude-cli\/\$\{CLAUDE_SUBSCRIPTION_PRODUCT_VERSION\}\s+\(external,\s*cli\)`/,
      'OAuth UA constant must match claude-cli/X.Y.Z (external, cli) shape',
    );
    assert.match(
      src,
      /CLAUDE_SUBSCRIPTION_PRODUCT_VERSION\s*=\s*'2\.1\.153'/,
      'OAuth UA product version should track the current installed Claude Code OAuth contract',
    );
    assert.doesNotMatch(
      src,
      /'maka-desktop\/[^']*\(oauth-subscription\)'/,
      'OAuth UA must NOT advertise maka-desktop — Anthropic rejects non-claude-cli UAs',
    );
    // Every OAuth-related fetch (token exchange, usage, profile)
    // must reference the OAUTH_USER_AGENT constant, not any inline
    // literal. Refresh lives in the runtime's shared refresher
    // (subscription-credentials.ts), which pins the same UA.
    const uaUses = src.match(/'User-Agent':\s*\w+/g) ?? [];
    assert.ok(uaUses.length >= 3,
      `expected at least 3 OAuth fetches to set User-Agent (token / usage / profile), got ${uaUses.length}`);
    for (const u of uaUses) {
      assert.match(u, /OAUTH_USER_AGENT/, `${u} must reference the OAUTH_USER_AGENT constant`);
    }
  });
});
