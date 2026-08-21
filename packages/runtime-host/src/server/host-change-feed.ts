import type {
  ConfigurationChangedFrame,
  ProjectCatalogChangedFrame,
  ScheduledTaskChangedFrame,
  ScheduledTaskChangedReason,
  SessionCatalogChangedFrame,
} from '../protocol/index.js';

export type HostChangeFrame =
  | ConfigurationChangedFrame
  | ProjectCatalogChangedFrame
  | SessionCatalogChangedFrame
  | ScheduledTaskChangedFrame;

export type HostChangeKind =
  | 'configuration'
  | 'project_catalog'
  | 'session_catalog'
  | 'scheduled_task';

export interface HostChangeSubscription {
  close(): void;
}

export interface HostChangeSubscriptionMask {
  readonly configuration?: boolean;
  readonly projectCatalog?: boolean;
  readonly sessionCatalog?: boolean;
  readonly scheduledTask?: boolean;
}

interface HostChangeSink {
  send(frame: HostChangeFrame): Promise<void>;
}

interface Subscription {
  readonly sink: HostChangeSink;
  readonly mask: HostChangeSubscriptionMask;
}

export class HostChangeFeed {
  readonly #subscriptions = new Map<string, Subscription>();
  #configurationRevision = 0;
  #projectCatalogRevision = 0;
  #sessionCatalogRevision = 0;

  attachConnection(
    connectionId: string,
    mask: HostChangeSubscriptionMask,
    sink: HostChangeSink,
  ): HostChangeSubscription {
    const subscription = { sink, mask } satisfies Subscription;
    this.#subscriptions.set(connectionId, subscription);
    return {
      close: () => {
        if (this.#subscriptions.get(connectionId) === subscription) {
          this.#subscriptions.delete(connectionId);
        }
      },
    };
  }

  publishConfiguration(): void {
    this.#configurationRevision += 1;
    this.#publish('configuration', {
      kind: 'configuration.changed',
      revision: this.#configurationRevision,
    });
  }

  publishProjectCatalog(): void {
    this.#projectCatalogRevision += 1;
    this.#publish('project_catalog', {
      kind: 'project.catalog.changed',
      revision: this.#projectCatalogRevision,
    });
  }

  publishSessionCatalog(sessionId: string): void {
    this.#sessionCatalogRevision += 1;
    this.#publish('session_catalog', {
      kind: 'session.catalog.changed',
      revision: this.#sessionCatalogRevision,
      sessionId,
    });
  }

  publishScheduledTask(revision: number, reason: ScheduledTaskChangedReason, taskId: string): void {
    this.#publish('scheduled_task', {
      kind: 'scheduled-task.changed',
      revision,
      reason,
      taskId,
    });
  }

  #publish(kind: HostChangeKind, frame: HostChangeFrame): void {
    for (const [connectionId, subscription] of this.#subscriptions) {
      if (!isSubscribed(subscription.mask, kind)) continue;
      void subscription.sink.send(frame).catch(() => {
        if (this.#subscriptions.get(connectionId) === subscription) {
          this.#subscriptions.delete(connectionId);
        }
      });
    }
  }
}

function isSubscribed(mask: HostChangeSubscriptionMask, kind: HostChangeKind): boolean {
  switch (kind) {
    case 'configuration':
      return mask.configuration === true;
    case 'project_catalog':
      return mask.projectCatalog === true;
    case 'session_catalog':
      return mask.sessionCatalog === true;
    case 'scheduled_task':
      return mask.scheduledTask === true;
  }
}
