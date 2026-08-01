import {
  HOST_OPERATION_SPECS,
  type ClientSurface,
  decodeOperationOutcome,
  type HostOperationErrorCode,
  type OperationInput,
  type OperationKey,
  type OperationOutcome,
  type RequestFrame,
  type RequestFrameFor,
  type ResponseFrame,
  type ResponseFrameFor,
} from '../protocol/index.js';

export interface ConnectionContext {
  hostEpoch: string;
  connectionId: string;
  surface: ClientSurface;
  principal: 'local_os_user';
  acquireResidency(): OperationResidency;
}

export interface OperationResidency {
  release(): void;
}

export type OperationHandler<K extends OperationKey> = (
  input: OperationInput<K>,
  context: ConnectionContext,
) => Promise<OperationOutcome<K>>;

export type OperationHandlerMap = {
  [K in OperationKey]: OperationHandler<K>;
};

export type DomainOperationKey = Exclude<OperationKey, 'host.status'>;
export type TurnOperationKey = Extract<OperationKey, 'turn.start' | 'turn.query' | 'turn.stop'>;
export type RuntimePolicyOperationKey = Extract<
  OperationKey,
  `runtime.policy.${string}` | `connection.catalog.${string}` | `credential.vault.${string}`
>;
export type ConnectionEffectOperationKey = Extract<
  OperationKey,
  'connection.models.fetch' | 'connection.test.run'
>;
export type MessageOperationKey = Extract<
  OperationKey,
  'turn.message.submit' | 'queue.retract' | 'turn.interrupt'
>;
export type InteractionOperationKey = Extract<OperationKey, `interaction.${string}`>;
export type SessionContinuityOperationKey = Extract<
  OperationKey,
  'subscription.open' | 'subscription.close'
>;
export type SessionRevisionOperationKey = Extract<
  OperationKey,
  'session.branch.create' | 'session.revision.create'
>;
export type SessionCatalogOperationKey = Exclude<
  Extract<OperationKey, `session.${string}`>,
  SessionRevisionOperationKey
>;
export type TaskLedgerOperationKey = Extract<OperationKey, 'task.ledger.query'>;
export type ArtifactOperationKey = Extract<OperationKey, `artifact.${string}`>;
export type SkillCatalogOperationKey = Extract<OperationKey, `skill.catalog.${string}`>;
export type UsagePricingOperationKey = Extract<OperationKey, 'usage.query' | `pricing.${string}`>;
export type MemoryOperationKey = Extract<OperationKey, `memory.${string}`>;
export type RuntimeResourceOperationKey = Extract<OperationKey, `runtime.resource.${string}`>;
export type ClientCapabilityOperationKey = Extract<OperationKey, `client.capability.${string}`>;
export type AutomationOperationKey = Extract<OperationKey, `automation.${string}`>;
export type DomainOperationHandlerMap = Pick<OperationHandlerMap, DomainOperationKey>;
export type TurnOperationHandlerMap = Pick<OperationHandlerMap, TurnOperationKey>;
export type RuntimePolicyOperationHandlerMap = Pick<OperationHandlerMap, RuntimePolicyOperationKey>;
export type ConnectionEffectOperationHandlerMap = Pick<
  OperationHandlerMap,
  ConnectionEffectOperationKey
>;
export type MessageOperationHandlerMap = Pick<OperationHandlerMap, MessageOperationKey>;
export type InteractionOperationHandlerMap = Pick<OperationHandlerMap, InteractionOperationKey>;
export type SessionContinuityOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionContinuityOperationKey
>;
export type SessionCatalogOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionCatalogOperationKey
>;
export type SessionRevisionOperationHandlerMap = Pick<
  OperationHandlerMap,
  SessionRevisionOperationKey
>;
export type TaskLedgerOperationHandlerMap = Pick<OperationHandlerMap, TaskLedgerOperationKey>;
export type ArtifactOperationHandlerMap = Pick<OperationHandlerMap, ArtifactOperationKey>;
export type SkillCatalogOperationHandlerMap = Pick<OperationHandlerMap, SkillCatalogOperationKey>;
export type UsagePricingOperationHandlerMap = Pick<OperationHandlerMap, UsagePricingOperationKey>;
export type MemoryOperationHandlerMap = Pick<OperationHandlerMap, MemoryOperationKey>;
export type RuntimeResourceOperationHandlerMap = Pick<
  OperationHandlerMap,
  RuntimeResourceOperationKey
>;
export type ClientCapabilityOperationHandlerMap = Pick<
  OperationHandlerMap,
  ClientCapabilityOperationKey
>;
export type AutomationOperationHandlerMap = Pick<OperationHandlerMap, AutomationOperationKey>;

export function composeOperationHandlers(
  ...handlerMaps: readonly Partial<OperationHandlerMap>[]
): OperationHandlerMap {
  const combined: Partial<OperationHandlerMap> = {};
  for (const handlers of handlerMaps) {
    for (const key of Object.keys(handlers)) {
      if (!Object.hasOwn(HOST_OPERATION_SPECS, key)) {
        throw new Error(`Unknown Runtime Host operation handler: ${key}`);
      }
      if (Object.hasOwn(combined, key)) {
        throw new Error(`Duplicate Runtime Host operation handler: ${key}`);
      }
      const handler = handlers[key as OperationKey];
      if (typeof handler !== 'function') {
        throw new Error(`Invalid Runtime Host operation handler: ${key}`);
      }
      Object.assign(combined, { [key]: handler });
    }
  }
  const missing = Object.keys(HOST_OPERATION_SPECS).filter((key) => !Object.hasOwn(combined, key));
  if (missing.length > 0) {
    throw new Error(`Missing Runtime Host operation handlers: ${missing.join(', ')}`);
  }
  return combined as OperationHandlerMap;
}

export function createUnavailableDomainOperationHandlers(): DomainOperationHandlerMap {
  const handlers: Partial<DomainOperationHandlerMap> = {};
  for (const operation of Object.keys(HOST_OPERATION_SPECS) as OperationKey[]) {
    if (operation === 'host.status') continue;
    const errors = HOST_OPERATION_SPECS[operation].errors as readonly HostOperationErrorCode[];
    if (!errors.includes('operation_unavailable')) {
      throw new Error(`${operation} does not declare operation_unavailable`);
    }
    Object.assign(handlers, {
      [operation]: async () => ({
        ok: false,
        error: {
          code: 'operation_unavailable',
          message: 'Runtime Host operation is unavailable in this composition',
        },
      }),
    });
  }
  return handlers as DomainOperationHandlerMap;
}

export async function dispatchOperation(
  request: RequestFrame,
  handlers: OperationHandlerMap,
  context: ConnectionContext,
): Promise<ResponseFrame> {
  return dispatchTypedOperation(
    request as RequestFrameFor<OperationKey>,
    handlers,
    context,
  ) as Promise<ResponseFrame>;
}

export function operationFailureResponse(
  request: RequestFrame,
  code: HostOperationErrorCode,
  message: string,
): ResponseFrame {
  const declaredErrors = HOST_OPERATION_SPECS[request.operation]
    .errors as readonly HostOperationErrorCode[];
  if (!declaredErrors.includes(code)) {
    throw new Error(`${request.operation} does not declare ${code}`);
  }
  return {
    requestId: request.requestId,
    operation: request.operation,
    ok: false,
    error: { code, message },
  } as ResponseFrame;
}

async function dispatchTypedOperation<K extends OperationKey>(
  request: RequestFrameFor<K>,
  handlers: OperationHandlerMap,
  context: ConnectionContext,
): Promise<ResponseFrameFor<K>> {
  const handler = handlers[request.operation] as OperationHandler<K>;
  let outcome: OperationOutcome<K>;
  try {
    outcome = decodeOperationOutcome(request.operation, await handler(request.input, context));
  } catch {
    return operationFailureResponse(
      request as RequestFrame,
      'internal_failure',
      'Runtime Host operation failed',
    ) as ResponseFrameFor<K>;
  }
  return outcome.ok
    ? {
        requestId: request.requestId,
        operation: request.operation,
        ok: true,
        result: outcome.result,
      }
    : {
        requestId: request.requestId,
        operation: request.operation,
        ok: false,
        error: outcome.error,
      };
}
