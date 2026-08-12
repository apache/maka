import {
  isConnectionReady,
  normalizeOpenAiCodexConnection,
  type ChatConfigurationReason,
} from '@maka/core/connection-readiness';
import { NO_REAL_CONNECTION_CODE } from '@maka/core/connection-error-copy';
import {
  projectSessionSendOutcome,
  sessionOwnConnectionBlockReason,
  shouldRebindSessionToDefault,
} from '@maka/core/session-send-projection';
import { type LlmConnection } from '@maka/core/llm-connections';
import { type SessionHeader } from '@maka/core/session';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';

// The rebind-eligibility taxonomy moved to `@maka/core/session-send-projection`
// (#1038) so the send gate and the renderer health notice share one
// decision source. Re-exported here for back-compat.
export { NO_REAL_CONNECTION_CODE } from '@maka/core/connection-error-copy';

// The rebind-eligibility taxonomy moved to `@maka/core/session-send-projection`
// (#1038) so the send gate and the renderer health notice share one
// decision source. Re-exported here for back-compat.
export { shouldRebindSessionToDefault } from '@maka/core/session-send-projection';

// `ChatConfigurationReason` moved to `@maka/core/connection-readiness`
// (PR110a) so the same taxonomy is shared between the send path and
// onboarding. Re-exported here for back-compat — any
// future addition belongs in core, not here.
export type { ChatConfigurationReason };

export interface ReadyConnectionDeps {
  getConnection(slug: string): Promise<LlmConnection | null>;
  getApiKey(slug: string): Promise<string | null | undefined>;
}

export interface ReadyConnection {
  connection: LlmConnection;
  apiKey: string;
  model: string;
}

export interface SessionRebindDeps {
  readyConnectionDeps: ReadyConnectionDeps;
  getDefaultSlug(): Promise<string | null>;
  listConnectionSlugs(): Promise<string[]>;
  updateSession(
    sessionId: string,
    patch: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model' | 'connectionLocked'>,
  ): Promise<unknown>;
}

export interface SessionRebindResult {
  rebound: boolean;
  connectionSlug?: string;
  modelId?: string;
}

export async function requireReadyConnection(
  slug: string | null | undefined,
  deps: ReadyConnectionDeps,
  requestedModel?: string,
): Promise<ReadyConnection> {
  // Slug missing / explicit 'fake' shortcut is checked before reaching
  // the core helper because we lack a connection object to evaluate.
  if (!slug || slug === 'fake') {
    throw chatConfigurationError(
      '等待配置默认模型。请到 设置 · 模型 添加 Anthropic / OpenAI / GLM 等 API key。',
      'missing_default_connection',
    );
  }

  const connection = await deps.getConnection(slug);
  if (!connection) {
    throw chatConfigurationError(
      `找不到模型连接 "${slug}"。请到 设置 · 模型 重新选择默认模型。`,
      'connection_missing',
    );
  }

  // PR110a: delegate the actual ready judgment to the pure core helper
  // so onboarding and the send path share a single source of truth. The
  // desktop side only owns: (1) async secret lookup, (2) Chinese error
  // copy, (3) the throw-error API the rest of main.ts expects.
  const normalizedConnection = normalizeOpenAiCodexConnection(connection);
  const apiKey = await deps.getApiKey(normalizedConnection.slug);
  const verdict = isConnectionReady({
    connection: normalizedConnection,
    hasSecret: typeof apiKey === 'string' && apiKey.length > 0,
    requestedModel,
  });

  if (verdict.ready === false) {
    throw chatConfigurationError(
      messageForReason(verdict.reason, normalizedConnection, requestedModel),
      verdict.reason,
    );
  }

  return { connection: normalizedConnection, apiKey: apiKey ?? '', model: verdict.model };
}

/**
 * Map a core readiness reason to the Chinese error copy that
 * `requireReadyConnection` has historically thrown. Centralized here
 * so the copy stays close to its existing semantics (PR110a refactor
 * is behavior-preserving — only the judgment moved to core).
 */
function messageForReason(
  reason: ChatConfigurationReason,
  connection: LlmConnection,
  requestedModel: string | undefined,
): string {
  switch (reason) {
    case 'connection_disabled':
      return `模型连接 "${connection.name}" 已禁用。请到 设置 · 模型 启用或选择其他默认模型。`;
    case 'missing_api_key':
      if (PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token') {
        return `模型连接 "${connection.name}" 等待完成 OAuth 登录。请到 设置 · 模型 重新登录后再聊天。`;
      }
      return `模型连接 "${connection.name}" 等待填写 API key。请到 设置 · 模型 补齐密钥后再聊天。`;
    case 'missing_model':
      return `模型连接 "${connection.name}" 没有可用模型。请到 设置 · 模型 选择一个默认模型。`;
    case 'empty_model_list':
      return `模型连接 "${connection.name}" 没有启用任何模型。请到 设置 · 模型 先添加模型。`;
    case 'model_not_enabled': {
      const model = requestedModel || connection.defaultModel;
      return `模型 "${model}" 不在连接 "${connection.name}" 的启用模型列表中。请到 设置 · 模型 重新选择。`;
    }
    case 'model_not_chat_capable': {
      const model = requestedModel || connection.defaultModel;
      return `模型 "${model}" 不能用于聊天。请到 设置 · 模型 选择支持聊天的模型。`;
    }
    case 'oauth_subscription_not_wired':
      return `订阅连接 "${connection.name}" 只用于账号状态查看，当前不能作为聊天模型。请先选择 API key 模型连接。`;
    case 'fake_backend':
      return '当前会话来自旧的本地模拟连接，不能直接发送。请到 设置 · 模型 添加真实模型后新建会话。';
    case 'missing_default_connection':
    case 'connection_missing':
      // These reasons are handled before we reach isConnectionReady,
      // but kept here for exhaustive switch.
      return '等待配置默认模型。请到 设置 · 模型 添加 Anthropic / OpenAI / GLM 等 API key。';
  }
}

export async function assertSessionCanSend(
  header: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model'>,
  deps: ReadyConnectionDeps,
): Promise<void> {
  if (header.backend === 'fake') {
    throw chatConfigurationError(
      '当前会话来自旧的本地模拟连接，不能直接发送。请到 设置 · 模型 添加真实模型后新建会话。',
      'fake_backend',
    );
  }
  await requireReadyConnection(header.llmConnectionSlug, deps, header.model);
}

export async function ensureSessionCanSendOrRebind(
  sessionId: string,
  header: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model' | 'connectionLocked'>,
  deps: SessionRebindDeps,
): Promise<SessionRebindResult> {
  // #1038: the send/rebind DECISION lives in the core projection so the
  // renderer health notice answers "will the next send fail?" from the
  // same facts and the same code. Main resolves the async facts,
  // delegates the decision, then owns the side effects: the rebind
  // mutation and the canonical error copy.
  //
  // Fact resolution stays staged exactly like the pre-projection send
  // path (#1038 review): phase 1 resolves only the session's OWN
  // connection, so a healthy session never waits on — and is never
  // failed by — unrelated connections, the default store, or the
  // connection list. Phase 2 gathers rebind candidates only when an
  // unlocked session actually needs the walk.
  const ownSlug = header.llmConnectionSlug;
  const ownResolvable = header.backend !== 'fake' && Boolean(ownSlug) && ownSlug !== 'fake';
  const ownConnection = ownResolvable ? await deps.readyConnectionDeps.getConnection(ownSlug) : null;
  const ownHasSecret = ownConnection
    ? await hasUsableSecret(deps.readyConnectionDeps, ownConnection.slug)
    : false;
  const ownReason = sessionOwnConnectionBlockReason(header, ownConnection, () => ownHasSecret);

  if (ownReason === undefined) return { rebound: false };

  if (header.connectionLocked || !shouldRebindSessionToDefault(ownReason)) {
    // Blocked with no rebind walk. Re-run the throwing authority so the
    // exact historical error copy surfaces unchanged; if the facts
    // shifted underneath us (e.g. a key was just saved), the send may
    // proceed after all.
    await assertSessionCanSend(header, deps.readyConnectionDeps);
    return { rebound: false };
  }

  // Phase 2: rebind candidates, resolved in deterministic order
  // (default first, then persisted order) with the historical
  // short-circuit: candidates are probed one at a time and the walk
  // stops as soon as the projection can decide, so the recovery path
  // never waits on — nor even probes — later candidates once a ready
  // one is found (a slow or hanging OAuth refresh on an unrelated
  // connection cannot stall the send). getDefaultSlug stays
  // fail-closed (a default-store read error rejects the send rather
  // than risking a rebind picked from incomplete facts), while the
  // list read fails open to [] — the default alone can still serve.
  const [defaultSlug, connectionSlugs] = await Promise.all([
    deps.getDefaultSlug(),
    deps.listConnectionSlugs().catch(() => []),
  ]);
  const candidateSlugs = [...new Set([defaultSlug, ...connectionSlugs])]
    .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
  const connections: LlmConnection[] = [];
  const secretPresence = new Map<string, boolean>();
  for (const slug of candidateSlugs) {
    try {
      const connection = await deps.readyConnectionDeps.getConnection(slug);
      if (connection) {
        connections.push(connection);
        secretPresence.set(connection.slug, await hasUsableSecret(deps.readyConnectionDeps, connection.slug));
      }
    } catch {
      // Unreadable candidate: skipped, exactly like the historical
      // walk's per-candidate catch.
    }
    // Re-run the projection over the resolved prefix. The winner is
    // identical to a full assembly (the projection picks the FIRST
    // ready candidate in this same order), but `blocked` here only
    // means "not yet" — a later candidate may still serve, so only
    // ready/rebind stop the walk.
    const outcome = projectSessionSendOutcome({
      session: header,
      connections,
      defaultSlug,
      hasSecret: (candidateSlug) => secretPresence.get(candidateSlug) === true,
    });

    if (outcome.kind === 'ready') return { rebound: false }; // facts shifted mid-flight

    if (outcome.kind === 'rebind') {
      await deps.updateSession(sessionId, {
        backend: 'ai-sdk',
        llmConnectionSlug: outcome.connectionSlug,
        model: outcome.model,
        connectionLocked: true,
      });
      return {
        rebound: true,
        connectionSlug: outcome.connectionSlug,
        modelId: outcome.model,
      };
    }
  }

  // Blocked after the full walk: same canonical-error re-run as above.
  await assertSessionCanSend(header, deps.readyConnectionDeps);
  return { rebound: false };
}

async function hasUsableSecret(deps: ReadyConnectionDeps, slug: string): Promise<boolean> {
  const apiKey = await deps.getApiKey(slug);
  return typeof apiKey === 'string' && apiKey.length > 0;
}

export function chatConfigurationError(message: string, reason: ChatConfigurationReason): Error {
  const error = new Error(`${NO_REAL_CONNECTION_CODE}:${reason}: ${message}`);
  (error as Error & { code: string; reason: ChatConfigurationReason }).code = NO_REAL_CONNECTION_CODE;
  (error as Error & { code: string; reason: ChatConfigurationReason }).reason = reason;
  return error;
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorReason(error: unknown): string | undefined {
  if (error instanceof Error && 'reason' in error) {
    return String((error as { reason?: unknown }).reason);
  }
  return undefined;
}
