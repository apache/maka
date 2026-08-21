import { createHash } from 'node:crypto';
import type { SessionHeader } from '@maka/core/session';
import { cleanSessionRecapText } from '@maka/runtime/session-recap';
import { type RuntimeReadModelSessionView } from '@maka/runtime/runtime-read-model';
import {
  authenticateInteractiveArtifactStoreWriter,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  decodeSessionRecapGenerateResult,
  SESSION_RECAP_RAW_MAX_BYTES,
  SESSION_RECAP_TEXT_MAX_BYTES,
  type OperationOutcome,
  type SessionRecapFailureClass,
  type SessionRecapGenerateInput,
  type SessionRecapGenerateResult,
} from '../protocol/index.js';
import type {
  OperationResidency,
  SessionEffectOperationHandlerMap,
} from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionPresenceReader } from './session-presence.js';
import type { HostSessionEffectModel } from './execution-model-authority.js';

const SESSION_EFFECT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_EFFECT_SCHEMA_VERSION = 1;

export interface HostSessionEffectCoordinatorInput {
  readonly model: HostSessionEffectModel;
  readonly readModel: Pick<RuntimeReadModel, 'getSessionView'>;
  readonly artifacts: InteractiveArtifactStoreWriter;
  readonly sessions: SessionPresenceReader;
  readonly readSessionHeader: (sessionId: string) => Promise<SessionHeader>;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly acquireResidency: () => OperationResidency;
  readonly requestDrain: () => void;
}

interface RuntimeReadModel {
  getSessionView(sessionId: string): Promise<RuntimeReadModelSessionView>;
}

interface ActiveRecapEffect {
  readonly sessionId: string;
  readonly effectId: string;
  readonly reason: SessionRecapGenerateInput['reason'];
  readonly task: Promise<OperationOutcome<'session.recap.generate'>>;
}

type RecapAdmission =
  | {
      readonly kind: 'settled';
      readonly outcome: OperationOutcome<'session.recap.generate'>;
    }
  | { readonly kind: 'active'; readonly task: ActiveRecapEffect['task'] };

/** Owns tool-free Session-derived model effects and their retry boundary. */
export class HostSessionEffectCoordinator {
  readonly handlers: SessionEffectOperationHandlerMap = {
    'session.recap.generate': (input, context) => this.#generateRecap(input, context),
  };

  readonly #model: HostSessionEffectModel;
  readonly #readModel: Pick<RuntimeReadModel, 'getSessionView'>;
  readonly #artifacts: InteractiveArtifactStoreWriter;
  readonly #sessions: SessionPresenceReader;
  readonly #readSessionHeader: (sessionId: string) => Promise<SessionHeader>;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #acquireResidency: () => OperationResidency;
  readonly #requestDrain: () => void;
  readonly #active = new Set<Promise<void>>();
  readonly #titleAborts = new Map<AbortController, string>();
  readonly #recapAborts = new Set<AbortController>();
  readonly #recaps = new Map<string, ActiveRecapEffect>();
  #accepting = true;
  #closeTask: Promise<void> | undefined;

  constructor(input: HostSessionEffectCoordinatorInput) {
    this.#model = input.model;
    this.#readModel = input.readModel;
    this.#artifacts = authenticateInteractiveArtifactStoreWriter(input.artifacts);
    this.#sessions = input.sessions;
    this.#readSessionHeader = input.readSessionHeader;
    this.#sessionAdmission = input.sessionAdmission;
    this.#acquireResidency = input.acquireResidency;
    this.#requestDrain = input.requestDrain;
  }

  generateTitle(input: {
    readonly sessionId: string;
    readonly header: SessionHeader;
    readonly sourceText: string;
  }): Promise<string | undefined> {
    if (!this.#accepting) return Promise.resolve(undefined);
    const residency = this.#acquireResidency();
    const abort = new AbortController();
    this.#titleAborts.set(abort, input.sessionId);
    return this.#track(
      this.#model.generateTitle({ ...input, abortSignal: abort.signal }).finally(() => {
        this.#titleAborts.delete(abort);
        residency.release();
      }),
    );
  }

  hasLiveSessionState(sessionId: string): boolean {
    for (const titleSessionId of this.#titleAborts.values()) {
      if (titleSessionId === sessionId) return true;
    }
    for (const effect of this.#recaps.values()) {
      if (effect.sessionId === sessionId) return true;
    }
    return false;
  }

  beginDrain(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    const reason = new DOMException('Runtime Host is draining', 'AbortError');
    for (const abort of this.#titleAborts.keys()) abort.abort(reason);
    for (const abort of this.#recapAborts) abort.abort(reason);
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.beginDrain();
    this.#closeTask = Promise.all([...this.#active]).then(() => undefined);
    return this.#closeTask;
  }

  #generateRecap(
    input: SessionRecapGenerateInput,
    context: { acquireResidency(): OperationResidency },
  ): Promise<OperationOutcome<'session.recap.generate'>> {
    if (!this.#accepting)
      return Promise.resolve(recapFailure('host_draining', 'Runtime Host is draining'));
    const residency = context.acquireResidency();
    const abort = new AbortController();
    this.#recapAborts.add(abort);
    const operation = this.#sessionAdmission
      .run(input.sessionId, () => this.#admitRecap(input, abort))
      .then((admission) => (admission.kind === 'settled' ? admission.outcome : admission.task))
      .finally(() => {
        this.#recapAborts.delete(abort);
        residency.release();
      });
    return this.#track(operation);
  }

  async #admitRecap(
    input: SessionRecapGenerateInput,
    abort: AbortController,
  ): Promise<RecapAdmission> {
    const ids = recapArtifactIds(input.sessionId, input.effectId);
    try {
      if ((await this.#sessions.probeSessionRemoval(input.sessionId)).kind !== 'present') {
        return settledRecap(recapFailure('not_found', 'Session was not found'));
      }

      const terminal = await this.#readTerminal(input, ids.result);
      if (terminal.kind === 'conflict') {
        return settledRecap(
          recapFailure('operation_conflict', 'Recap effect identity is already in use'),
        );
      }
      if (terminal.kind === 'found') return settledRecap(recapSuccess(terminal.result));

      const intent = await this.#readIntent(input, ids.intent);
      if (intent === 'conflict') {
        return settledRecap(
          recapFailure('operation_conflict', 'Recap effect identity is already in use'),
        );
      }
      if (intent === 'found') {
        const active = this.#recaps.get(ids.result);
        return active &&
          active.sessionId === input.sessionId &&
          active.effectId === input.effectId &&
          active.reason === input.reason
          ? { kind: 'active', task: active.task }
          : settledRecap(
              recapFailure(
                'outcome_unknown',
                'Recap provider outcome is unknown; use a new effect identity to retry',
              ),
            );
      }

      if (abort.signal.aborted) {
        return settledRecap(recapFailure('host_draining', 'Runtime Host is draining'));
      }

      const header = await this.#readSessionHeader(input.sessionId);
      if (header.isArchived) {
        return settledRecap(
          recapFailure('session_archived', 'Archived Session cannot generate a recap'),
        );
      }

      const view = await this.#readModel.getSessionView(input.sessionId);
      if (abort.signal.aborted) {
        return settledRecap(recapFailure('host_draining', 'Runtime Host is draining'));
      }
      await this.#artifacts.create({
        id: ids.intent,
        sessionId: input.sessionId,
        turnId: input.effectId,
        name: 'session-recap-intent.json',
        kind: 'file',
        content: encodeJson({
          schemaVersion: SESSION_EFFECT_SCHEMA_VERSION,
          kind: 'session_recap_intent',
          sessionId: input.sessionId,
          effectId: input.effectId,
          reason: input.reason,
        }),
        mimeType: 'application/json; charset=utf-8',
        source: 'session_effect',
        summary: `Session recap ${input.reason} intent`,
      });

      let active!: ActiveRecapEffect;
      const task = this.#runRecapEffect(
        input,
        header,
        view.events,
        ids.result,
        abort.signal,
      ).finally(() => {
        if (this.#recaps.get(ids.result) === active) this.#recaps.delete(ids.result);
      });
      active = {
        sessionId: input.sessionId,
        effectId: input.effectId,
        reason: input.reason,
        task,
      };
      this.#recaps.set(ids.result, active);
      return { kind: 'active', task };
    } catch {
      this.#requestDrain();
      return settledRecap(recapFailure('persistence_failed', 'Session recap persistence failed'));
    }
  }

  async #runRecapEffect(
    input: SessionRecapGenerateInput,
    header: SessionHeader,
    events: RuntimeReadModelSessionView['events'],
    resultArtifactId: string,
    abortSignal: AbortSignal,
  ): Promise<OperationOutcome<'session.recap.generate'>> {
    let model: Awaited<ReturnType<HostSessionEffectModel['generateRecap']>>;
    try {
      model = await this.#model.generateRecap({
        sessionId: input.sessionId,
        effectId: input.effectId,
        header,
        events,
        abortSignal,
      });
    } catch {
      this.#requestDrain();
      return recapFailure('outcome_unknown', 'Recap provider outcome is unknown');
    }
    const result = projectModelResult(input, model);
    if (!result) {
      this.#requestDrain();
      return recapFailure('outcome_unknown', 'Recap accounting outcome is unknown');
    }
    const document = encodeJson({
      schemaVersion: SESSION_EFFECT_SCHEMA_VERSION,
      kind: 'session_recap_result',
      sessionId: input.sessionId,
      effectId: input.effectId,
      reason: input.reason,
      ...(model.modelId ? { model: model.modelId } : {}),
      ...(model.messages ? { messageCount: model.messages.length, messages: model.messages } : {}),
      result,
    });
    try {
      await this.#artifacts.create({
        id: resultArtifactId,
        sessionId: input.sessionId,
        turnId: input.effectId,
        name: 'session-recap-result.json',
        kind: 'file',
        content: document,
        mimeType: 'application/json; charset=utf-8',
        source: 'session_effect',
        summary: result.kind === 'generated' ? result.text.slice(0, 100) : result.errorClass,
      });
    } catch {
      const recovered = await this.#readTerminal(input, resultArtifactId).catch(() => ({
        kind: 'missing' as const,
      }));
      if (recovered.kind === 'found') return recapSuccess(recovered.result);
      this.#requestDrain();
      return recapFailure('outcome_unknown', 'Recap result publication outcome is unknown');
    }
    return recapSuccess(result);
  }

  async #readIntent(
    input: SessionRecapGenerateInput,
    artifactId: string,
  ): Promise<'missing' | 'found' | 'conflict'> {
    const document = await this.#readArtifactDocument(input.sessionId, artifactId);
    if (!document) return 'missing';
    return document.schemaVersion === SESSION_EFFECT_SCHEMA_VERSION &&
      document.kind === 'session_recap_intent' &&
      document.sessionId === input.sessionId &&
      document.effectId === input.effectId &&
      document.reason === input.reason
      ? 'found'
      : 'conflict';
  }

  async #readTerminal(
    input: SessionRecapGenerateInput,
    artifactId: string,
  ): Promise<
    | { readonly kind: 'missing' }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'found'; readonly result: SessionRecapGenerateResult }
  > {
    const document = await this.#readArtifactDocument(input.sessionId, artifactId);
    if (!document) return { kind: 'missing' };
    if (
      document.schemaVersion !== SESSION_EFFECT_SCHEMA_VERSION ||
      document.kind !== 'session_recap_result' ||
      document.sessionId !== input.sessionId ||
      document.effectId !== input.effectId ||
      document.reason !== input.reason
    ) {
      return { kind: 'conflict' };
    }
    try {
      const result = decodeSessionRecapGenerateResult(document.result);
      return result.effectId === input.effectId && result.reason === input.reason
        ? { kind: 'found', result }
        : { kind: 'conflict' };
    } catch {
      return { kind: 'conflict' };
    }
  }

  async #readArtifactDocument(
    sessionId: string,
    artifactId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const entry = await this.#artifacts.getInSession(sessionId, artifactId);
    if (!entry.record || entry.record.status !== 'live') return undefined;
    const read = await this.#artifacts.readTextInSession(sessionId, artifactId, {
      maxBytes: SESSION_EFFECT_ARTIFACT_MAX_BYTES,
    });
    if (!read.ok) throw new Error('Session effect Artifact could not be read');
    const value: unknown = JSON.parse(read.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Session effect Artifact is malformed');
    }
    return value as Record<string, unknown>;
  }

  #track<T>(task: Promise<T>): Promise<T> {
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.#active.add(settled);
    void settled.finally(() => this.#active.delete(settled));
    return task;
  }
}

function projectModelResult(
  input: SessionRecapGenerateInput,
  model: Awaited<ReturnType<HostSessionEffectModel['generateRecap']>>,
): SessionRecapGenerateResult | undefined {
  if (!model.ok) {
    return model.errorClass === 'persistence' ? undefined : failedRecap(input, model.errorClass);
  }
  const rawBytes = Buffer.byteLength(model.raw, 'utf8');
  if (rawBytes === 0) return failedRecap(input, 'empty_response');
  if (rawBytes > SESSION_RECAP_RAW_MAX_BYTES) return failedRecap(input, 'invalid_response');
  const text = cleanSessionRecapText(model.raw);
  if (!text) return failedRecap(input, 'empty_response');
  if (Buffer.byteLength(text, 'utf8') > SESSION_RECAP_TEXT_MAX_BYTES) {
    return failedRecap(input, 'invalid_response');
  }
  return {
    kind: 'generated',
    effectId: input.effectId,
    reason: input.reason,
    text,
    raw: model.raw,
  };
}

function failedRecap(
  input: SessionRecapGenerateInput,
  errorClass: SessionRecapFailureClass,
): SessionRecapGenerateResult {
  return { kind: 'failed', effectId: input.effectId, reason: input.reason, errorClass };
}

function recapArtifactIds(
  sessionId: string,
  effectId: string,
): {
  readonly intent: string;
  readonly result: string;
} {
  const digest = createHash('sha256')
    .update('maka-session-recap-v1\0')
    .update(sessionId)
    .update('\0')
    .update(effectId)
    .digest('hex');
  return {
    intent: `session_recap_intent_${digest}`,
    result: `session_recap_result_${digest}`,
  };
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function recapSuccess(
  result: SessionRecapGenerateResult,
): OperationOutcome<'session.recap.generate'> {
  return { ok: true, result };
}

function settledRecap(outcome: OperationOutcome<'session.recap.generate'>): RecapAdmission {
  return { kind: 'settled', outcome };
}

function recapFailure(
  code: Extract<
    OperationOutcome<'session.recap.generate'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'session.recap.generate'> {
  return { ok: false, error: { code, message } };
}
