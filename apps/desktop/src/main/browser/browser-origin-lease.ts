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

import type { BrowserOriginLease, BrowserOriginLeaseSnapshot } from './browser-host.js';
import type { BrowserActionKind } from './logic.js';

type ActiveLease = {
  readonly approvedOrigin: string;
  monitoring: boolean;
  violatedUrl?: string;
};

/** Monotonic, page-host-owned evidence for Browser Origin admission. */
export class BrowserOriginLeaseTracker {
  #epoch = 0;
  readonly #active = new Set<ActiveLease>();

  constructor(private readonly currentUrl: () => string) {}

  recordNavigation(url = this.currentUrl()): void {
    this.#epoch += 1;
    for (const lease of this.#active) {
      if (lease.monitoring && !lease.violatedUrl && webOrigin(url) !== lease.approvedOrigin) {
        lease.violatedUrl = url;
      }
    }
  }

  open(approvedUrl: string, kind: BrowserActionKind): BrowserOriginLease {
    const approvedOrigin = webOrigin(approvedUrl);
    if (!approvedOrigin) throw new Error('Browser admission requires an HTTP origin');
    const state: ActiveLease = {
      approvedOrigin,
      // Navigate may start on another site. It becomes monitored immediately
      // before the approved goto; every other action must start on its grant.
      monitoring: kind !== 'navigate',
    };
    this.#active.add(state);

    const snapshot = (): BrowserOriginLeaseSnapshot => {
      const url = this.currentUrl();
      if (state.monitoring && !state.violatedUrl && webOrigin(url) !== approvedOrigin) {
        state.violatedUrl = url;
      }
      return {
        epoch: this.#epoch,
        url,
        ...(state.violatedUrl === undefined ? {} : { violatedUrl: state.violatedUrl }),
      };
    };

    if (state.monitoring) snapshot();
    let released = false;
    return {
      approvedOrigin,
      startNavigation: (targetUrl) => {
        if (released) throw new Error('Browser Origin lease is no longer active');
        if (webOrigin(targetUrl) !== approvedOrigin) {
          throw new Error('Browser navigation target is outside the approved Origin');
        }
        state.monitoring = true;
      },
      snapshot,
      release: () => {
        if (released) return;
        released = true;
        this.#active.delete(state);
      },
    };
  }
}

function webOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
