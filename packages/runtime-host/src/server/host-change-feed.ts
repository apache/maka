/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type {
  ConfigurationChangedFrame,
  ConnectionCatalogChangedFrame,
  ProjectCatalogChangedFrame,
  ScheduledTaskChangedFrame,
  ScheduledTaskChangedReason,
  SessionCatalogChangedFrame,
} from '../protocol/index.js';

export type HostChangeFrame =
  | ConfigurationChangedFrame
  | ConnectionCatalogChangedFrame
  | ProjectCatalogChangedFrame
  | SessionCatalogChangedFrame
  | ScheduledTaskChangedFrame;

export interface HostChangeSubscription {
  close(): void;
}

export interface HostChangeSubscriptionMask {
  readonly configuration?: boolean;
  readonly connectionCatalog?: boolean;
  readonly projectCatalog?: boolean;
  readonly sessionCatalog?: true | { readonly sessionId: string; readonly principalId: string };
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
  #connectionCatalogRevision = 0;
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
    this.#publish({
      kind: 'configuration.changed',
      revision: this.#configurationRevision,
    });
  }

  /** The Host now resolves connection catalogs differently; clients re-read. */
  publishConnectionCatalog(): void {
    this.#connectionCatalogRevision += 1;
    this.#publish({
      kind: 'connection.catalog.changed',
      revision: this.#connectionCatalogRevision,
    });
  }

  publishProjectCatalog(): void {
    this.#projectCatalogRevision += 1;
    this.#publish({
      kind: 'project.catalog.changed',
      revision: this.#projectCatalogRevision,
    });
  }

  publishSessionCatalog(sessionId: string): void {
    this.#publishSessionCatalog(sessionId);
  }

  /** Publish the final scoped invalidation, then stop that resource-scoped feed. */
  publishSessionCatalogAndCloseScope(sessionId: string, principalId: string): void {
    this.#publishSessionCatalog(sessionId, principalId);
  }

  #publishSessionCatalog(sessionId: string, closeScopeFor?: string): void {
    this.#sessionCatalogRevision += 1;
    const frame: SessionCatalogChangedFrame = {
      kind: 'session.catalog.changed',
      revision: this.#sessionCatalogRevision,
      sessionId,
    };
    for (const [connectionId, subscription] of this.#subscriptions) {
      if (!isSubscribed(subscription.mask, frame)) continue;
      void subscription.sink.send(frame).catch(() => {
        if (this.#subscriptions.get(connectionId) === subscription) {
          this.#subscriptions.delete(connectionId);
        }
      });
      if (
        closeScopeFor !== undefined &&
        subscription.mask.sessionCatalog !== true &&
        subscription.mask.sessionCatalog?.sessionId === sessionId &&
        subscription.mask.sessionCatalog.principalId === closeScopeFor &&
        this.#subscriptions.get(connectionId) === subscription
      ) {
        this.#subscriptions.delete(connectionId);
      }
    }
  }

  publishScheduledTask(revision: number, reason: ScheduledTaskChangedReason, taskId: string): void {
    this.#publish({
      kind: 'scheduled-task.changed',
      revision,
      reason,
      taskId,
    });
  }

  #publish(frame: HostChangeFrame): void {
    for (const [connectionId, subscription] of this.#subscriptions) {
      if (!isSubscribed(subscription.mask, frame)) continue;
      void subscription.sink.send(frame).catch(() => {
        if (this.#subscriptions.get(connectionId) === subscription) {
          this.#subscriptions.delete(connectionId);
        }
      });
    }
  }
}

function isSubscribed(mask: HostChangeSubscriptionMask, frame: HostChangeFrame): boolean {
  switch (frame.kind) {
    case 'configuration.changed':
      return mask.configuration === true;
    case 'connection.catalog.changed':
      return mask.connectionCatalog === true;
    case 'project.catalog.changed':
      return mask.projectCatalog === true;
    case 'session.catalog.changed':
      return (
        mask.sessionCatalog === true ||
        (mask.sessionCatalog !== undefined && frame.sessionId === mask.sessionCatalog.sessionId)
      );
    case 'scheduled-task.changed':
      return mask.scheduledTask === true;
  }
}
