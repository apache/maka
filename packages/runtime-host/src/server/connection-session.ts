import {
  decodeClientFrame,
  isClientCapabilityClientFrameKind,
  RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS,
  type ClientCapabilityClientFrame,
  type HostOperationErrorCode,
  type RequestFrame,
} from '../protocol/index.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';
import {
  dispatchOperation,
  operationFailureResponse,
  type ConnectionContext,
  type OperationHandlerMap,
  type OperationResidency,
} from './operation-dispatcher.js';
import { BoundedSerialOutboundWriter } from './serial-outbound-writer.js';
import { RuntimeHostTransportError } from '../transport/framed-transport.js';
import type {
  SessionContinuityConnection,
  SessionContinuityService,
} from './session-continuity-service.js';
import type {
  ClientCapabilityConnection,
  ClientCapabilityService,
} from './client-capability-service.js';
import type {
  ConfigurationChangeConnection,
  HostConfigurationChangeService,
} from './configuration-change-service.js';
import type {
  HostSessionCatalogChangeService,
  SessionCatalogChangeConnection,
} from './session-catalog-change-service.js';
import type {
  HostProjectCatalogChangeService,
  ProjectCatalogChangeConnection,
} from './project-catalog-change-service.js';
import type {
  HostScheduledTaskChangeService,
  ScheduledTaskChangeConnection,
} from './scheduled-task-change-service.js';
import type { RuntimeHostConnectionAuthority } from './connection-authority.js';
import {
  authorizeClientCapabilityFrame,
  authorizeRuntimeHostOperation,
  hasRuntimeHostOperationGrant,
} from './connection-authority.js';

type AcceptedConnectionContext = Omit<ConnectionContext, 'acquireResidency' | 'principal'> & {
  readonly clientInstanceId: string;
  readonly authority: RuntimeHostConnectionAuthority;
};

export interface ConnectionOperationLease {
  acquireResidency(): OperationResidency;
  seal(): void;
  finish(): void;
}

export interface RuntimeHostConnectionSessionOptions {
  transport: RuntimeHostMessageTransport;
  connection: AcceptedConnectionContext;
  resolveHandlers(): OperationHandlerMap;
  resolveContinuity(): SessionContinuityService | undefined;
  resolveClientCapabilities?(): ClientCapabilityService | undefined;
  resolveConfigurationChanges?(): HostConfigurationChangeService | undefined;
  resolveProjectCatalogChanges?(): HostProjectCatalogChangeService | undefined;
  resolveSessionCatalogChanges?(): HostSessionCatalogChangeService | undefined;
  resolveScheduledTaskChanges?(): HostScheduledTaskChangeService | undefined;
  beginOperation(frame: RequestFrame): Promise<ConnectionOperationLease | HostOperationErrorCode>;
  onTeardown(): void;
}

export class RuntimeHostConnectionSession {
  readonly #options: RuntimeHostConnectionSessionOptions;
  readonly #writer: BoundedSerialOutboundWriter;
  readonly #requests = new Map<string, Promise<void>>();
  #transcriptPageTail: Promise<void> = Promise.resolve();
  #inFlightStatusRequests = 0;
  #continuityService: SessionContinuityService | undefined;
  #continuity: SessionContinuityConnection | undefined;
  #clientCapabilityService: ClientCapabilityService | undefined;
  #clientCapabilities: ClientCapabilityConnection | undefined;
  #clientCapabilityCloseTask: Promise<void> | undefined;
  #configurationChanges: ConfigurationChangeConnection | undefined;
  #projectCatalogChanges: ProjectCatalogChangeConnection | undefined;
  #sessionCatalogChanges: SessionCatalogChangeConnection | undefined;
  #scheduledTaskChanges: ScheduledTaskChangeConnection | undefined;
  #inputClosed = false;
  #closed = false;

  constructor(options: RuntimeHostConnectionSessionOptions) {
    this.#options = options;
    this.#writer = new BoundedSerialOutboundWriter(options.transport, () => this.#teardown());
  }

  async run(): Promise<void> {
    this.attachGlobalChanges();
    try {
      try {
        await this.#pumpInbound();
      } catch (error) {
        if (!isReadEof(error)) throw error;
        await this.#closeAfterDispatchedReplies();
      }
    } catch {
      this.#teardown();
    } finally {
      this.#teardown();
      await Promise.allSettled(this.#requests.values());
      await Promise.all([
        this.#writer.settled(),
        this.#options.transport.closed,
        this.#clientCapabilityCloseTask?.catch(() => undefined),
      ]);
    }
  }

  async #closeAfterDispatchedReplies(): Promise<void> {
    this.#inputClosed = true;
    this.#detachContinuity();
    this.#detachClientCapabilities();
    this.#detachConfigurationChanges();
    this.#detachProjectCatalogChanges();
    this.#detachSessionCatalogChanges();
    this.#detachScheduledTaskChanges();
    const outcome = await Promise.race([
      Promise.allSettled([...this.#requests.values()]).then(() => 'drained' as const),
      this.#options.transport.closed.then(() => 'closed' as const),
    ]);
    if (outcome === 'closed') {
      this.#teardown();
      return;
    }
    if (this.#closed) return;
    await this.#writer.settled();
    if (this.#closed) return;
    this.#closed = true;
    this.#writer.close();
    this.#options.transport.closeAfterFlush();
    this.#options.onTeardown();
  }

  async #pumpInbound(): Promise<void> {
    while (!this.#closed) {
      const frame = decodeClientFrame(await this.#options.transport.read(0));
      if ('kind' in frame) {
        if (isClientCapabilityClientFrameKind(frame.kind)) {
          const capabilityFrame = frame as ClientCapabilityClientFrame;
          if (
            !authorizeClientCapabilityFrame(this.#options.connection.authority, capabilityFrame)
          ) {
            this.#teardown();
            return;
          }
          this.#ensureClientCapabilities()?.accept(capabilityFrame);
          continue;
        }
        throw new Error('Unexpected handshake frame after acceptance');
      }
      const usesLivenessReserve =
        this.#requests.size === RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS &&
        (frame.operation === 'host.status' || this.#inFlightStatusRequests > 0);
      if (
        this.#requests.has(frame.requestId) ||
        (this.#requests.size >= RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS && !usesLivenessReserve)
      ) {
        this.#teardown();
        return;
      }
      this.#dispatch(frame);
    }
  }

  #dispatch(frame: RequestFrame): void {
    if (frame.operation === 'host.status') this.#inFlightStatusRequests += 1;
    const handling =
      frame.operation === 'session.transcript.page'
        ? this.#transcriptPageTail.then(() => this.#handleRequest(frame))
        : this.#handleRequest(frame);
    const task = handling
      .catch(() => this.#teardown())
      .finally(() => {
        if (this.#requests.get(frame.requestId) === task) {
          this.#requests.delete(frame.requestId);
          if (frame.operation === 'host.status') this.#inFlightStatusRequests -= 1;
        }
      });
    this.#requests.set(frame.requestId, task);
    if (frame.operation === 'session.transcript.page') {
      this.#transcriptPageTail = task.catch(() => undefined);
    }
  }

  async #handleRequest(frame: RequestFrame): Promise<void> {
    if (this.#closed) return;
    if (!authorizeRuntimeHostOperation(this.#options.connection.authority, frame)) {
      if (this.#closed) return;
      await this.#writer.enqueue(
        operationFailureResponse(frame, 'unauthorized', 'Runtime Host operation is not authorized'),
      ).flushed;
      return;
    }
    const admission = await this.#options.beginOperation(frame);
    if (typeof admission === 'string') {
      if (this.#closed) return;
      await this.#writer.enqueue(
        operationFailureResponse(
          frame,
          admission,
          admission === 'host_draining' ? 'Runtime Host is draining' : 'Runtime Host is not ready',
        ),
      ).flushed;
      return;
    }

    try {
      if (this.#closed) return;
      this.#ensureClientCapabilities();
      const continuity =
        frame.operation === 'subscription.open' ||
        frame.operation === 'subscription.close' ||
        frame.operation === 'session.transcript.page'
          ? this.#ensureContinuity()
          : undefined;
      const response = await dispatchOperation(frame, this.#options.resolveHandlers(), {
        ...this.#options.connection,
        principal: this.#options.connection.authority.principalId,
        acquireResidency: () => admission.acquireResidency(),
      });
      admission.seal();
      const receipt = this.#writer.enqueue(response);
      const openedSubscriptionId =
        response.ok && response.operation === 'subscription.open'
          ? response.result.subscriptionId
          : undefined;
      if (openedSubscriptionId) continuity?.activate(openedSubscriptionId);
      try {
        await receipt.flushed;
      } catch (error) {
        if (openedSubscriptionId) continuity?.abort(openedSubscriptionId);
        throw error;
      }
    } finally {
      admission.finish();
    }
  }

  #ensureContinuity(): SessionContinuityConnection | undefined {
    if (this.#closed || this.#inputClosed) return;
    const service = this.#options.resolveContinuity();
    if (!service) return;
    if (this.#continuityService && this.#continuityService !== service) {
      throw new Error('Runtime Host continuity service changed within one connection');
    }
    if (!this.#continuity) {
      this.#continuityService = service;
      this.#continuity = service.attachConnection(this.#options.connection.connectionId, {
        send: (frame) => {
          try {
            return this.#writer.enqueue(frame).flushed;
          } catch (error) {
            return Promise.reject(error);
          }
        },
      });
    }
    return this.#continuity;
  }

  #detachContinuity(): void {
    this.#continuity?.close();
    this.#continuity = undefined;
    this.#continuityService = undefined;
  }

  #ensureClientCapabilities(): ClientCapabilityConnection | undefined {
    if (this.#closed || this.#inputClosed) return;
    const service = this.#options.resolveClientCapabilities?.();
    if (!service) return;
    if (this.#clientCapabilityService && this.#clientCapabilityService !== service) {
      throw new Error('Runtime Host Client Capability service changed within one connection');
    }
    if (!this.#clientCapabilities) {
      this.#clientCapabilityService = service;
      this.#clientCapabilities = service.attachConnection(
        {
          connectionId: this.#options.connection.connectionId,
          principalId: this.#options.connection.authority.principalId,
          clientInstanceId: this.#options.connection.clientInstanceId,
          principalKind: this.#options.connection.authority.principalKind,
        },
        {
          send: (frame) => {
            try {
              return this.#writer.enqueue(frame).flushed;
            } catch (error) {
              return Promise.reject(error);
            }
          },
        },
      );
    }
    return this.#clientCapabilities;
  }

  #detachClientCapabilities(): void {
    const connection = this.#clientCapabilities;
    this.#clientCapabilities = undefined;
    this.#clientCapabilityService = undefined;
    if (!connection || this.#clientCapabilityCloseTask) return;
    this.#clientCapabilityCloseTask = Promise.resolve().then(() => connection.close());
    void this.#clientCapabilityCloseTask.catch(() => undefined);
  }

  #attachConfigurationChanges(): void {
    if (!hasRuntimeHostOperationGrant(this.#options.connection.authority, 'runtime.policy.query')) {
      return;
    }
    const service = this.#options.resolveConfigurationChanges?.();
    if (!service || this.#configurationChanges) return;
    this.#configurationChanges = service.attachConnection(this.#options.connection.connectionId, {
      send: (frame) => {
        try {
          return this.#writer.enqueue(frame).flushed;
        } catch (error) {
          return Promise.reject(error);
        }
      },
    });
  }

  attachGlobalChanges(): void {
    if (this.#closed || this.#inputClosed) return;
    this.#attachConfigurationChanges();
    this.#attachProjectCatalogChanges();
    this.#attachSessionCatalogChanges();
    this.#attachScheduledTaskChanges();
  }

  #detachConfigurationChanges(): void {
    this.#configurationChanges?.close();
    this.#configurationChanges = undefined;
  }

  #attachProjectCatalogChanges(): void {
    if (
      !hasRuntimeHostOperationGrant(this.#options.connection.authority, 'project.catalog.query')
    ) {
      return;
    }
    const service = this.#options.resolveProjectCatalogChanges?.();
    if (!service || this.#projectCatalogChanges) return;
    this.#projectCatalogChanges = service.attachConnection(this.#options.connection.connectionId, {
      send: (frame) => {
        try {
          return this.#writer.enqueue(frame).flushed;
        } catch (error) {
          return Promise.reject(error);
        }
      },
    });
  }

  #detachProjectCatalogChanges(): void {
    this.#projectCatalogChanges?.close();
    this.#projectCatalogChanges = undefined;
  }

  #attachSessionCatalogChanges(): void {
    if (
      !hasRuntimeHostOperationGrant(this.#options.connection.authority, 'session.catalog.query')
    ) {
      return;
    }
    const service = this.#options.resolveSessionCatalogChanges?.();
    if (!service || this.#sessionCatalogChanges) return;
    this.#sessionCatalogChanges = service.attachConnection(this.#options.connection.connectionId, {
      send: (frame) => {
        try {
          return this.#writer.enqueue(frame).flushed;
        } catch (error) {
          return Promise.reject(error);
        }
      },
    });
  }

  #detachSessionCatalogChanges(): void {
    this.#sessionCatalogChanges?.close();
    this.#sessionCatalogChanges = undefined;
  }

  #attachScheduledTaskChanges(): void {
    if (!hasRuntimeHostOperationGrant(this.#options.connection.authority, 'scheduled-task.query')) {
      return;
    }
    const service = this.#options.resolveScheduledTaskChanges?.();
    if (!service || this.#scheduledTaskChanges) return;
    this.#scheduledTaskChanges = service.attachConnection(this.#options.connection.connectionId, {
      send: (frame) => {
        try {
          return this.#writer.enqueue(frame).flushed;
        } catch (error) {
          return Promise.reject(error);
        }
      },
    });
  }

  #detachScheduledTaskChanges(): void {
    this.#scheduledTaskChanges?.close();
    this.#scheduledTaskChanges = undefined;
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#inputClosed = true;
    this.#detachContinuity();
    this.#detachClientCapabilities();
    this.#detachConfigurationChanges();
    this.#detachProjectCatalogChanges();
    this.#detachSessionCatalogChanges();
    this.#detachScheduledTaskChanges();
    this.#writer.close();
    this.#options.transport.abort();
    this.#options.onTeardown();
  }
}

function isReadEof(error: unknown): boolean {
  return error instanceof RuntimeHostTransportError && error.code === 'read_eof';
}
