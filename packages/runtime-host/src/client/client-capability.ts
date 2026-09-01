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
  ClientCapabilityCallFrame,
  ClientCapabilityCallResult,
  ClientCapabilityAdmissionEvidence,
  ClientCapabilityOffer,
  ClientCapabilityServiceCallFrame,
  ClientCapabilityServiceOffer,
} from '../protocol/index.js';

/** A Client-owned open-world capability provider registered on one Host connection. */
export interface ClientCapabilityProvider {
  offers(): readonly ClientCapabilityOffer[];
  services?(): readonly ClientCapabilityServiceOffer[];
  call?(
    frame: ClientCapabilityCallFrame,
    options: {
      readonly signal: AbortSignal;
      /** Await immediately before crossing the provider's irreversible admission cut. */
      accept(evidence: ClientCapabilityAdmissionEvidence): Promise<void>;
      /** Publish bounded live progress after admission. */
      progress?(current: number, total: number): void;
    },
  ): Promise<ClientCapabilityCallResult>;
  callService?(
    frame: ClientCapabilityServiceCallFrame,
    options: {
      readonly signal: AbortSignal;
      /** Await immediately before crossing the provider's irreversible admission cut. */
      accept(evidence: ClientCapabilityAdmissionEvidence): Promise<void>;
    },
  ): Promise<Record<string, unknown>>;
  /** Release provider-owned resources after its final registration is retired. */
  close?(): void | Promise<void>;
}
