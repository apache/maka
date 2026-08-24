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

import type { ProviderType } from '@maka/core/llm-connections';
import type {
  ConnectionCatalogProbeModel,
  ConnectionCatalogProbeOutcome,
  ConnectionCatalogProbeRequest,
} from '../../shared/connection-catalog-probe.js';

/**
 * The catalog probe behind the custom-relay add form.
 *
 * The form used to ask a relay for a hand-typed default model id before it
 * could see the catalog the endpoint serves (#3442). This module owns the
 * two decisions that are not layout: what the probe asks for given the form
 * draft, and how a bridge reply reduces onto the chooser's view. Keeping them
 * outside the component means the request shape and the outcome switch are
 * unit-testable without a DOM, in the same spirit as provider-add-submission.
 */

export interface CatalogProbeDraft {
  readonly providerType: ProviderType;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * Build the probe request from the form draft, or null when there is no
 * endpoint to read from yet. The key is optional: a local relay may accept a
 * catalog read without credentials, and the host rejects cleanly when the
 * provider actually demands one (credential_not_configured).
 */
export function catalogProbeRequest(
  draft: CatalogProbeDraft,
): ConnectionCatalogProbeRequest | null {
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl.length === 0) return null;
  const apiKey = draft.apiKey.trim();
  return {
    providerType: draft.providerType,
    baseUrl,
    apiKey: apiKey.length > 0 ? apiKey : null,
  };
}

/** The chooser's view of a probe run: idle and probing are form-local; the
 * rest is the host's verdict verbatim, so a copy change never has to touch
 * this switch. */
export type CatalogProbeView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'probing' }
  | ConnectionCatalogProbeOutcome;

/**
 * Run the probe through the bridge and reduce its promise onto a view.
 * A rejected IPC frame surfaces as a failed outcome rather than an
 * unhandled rejection, so the form always has a message to show.
 */
export async function runCatalogProbe(
  probe: (
    request: ConnectionCatalogProbeRequest,
  ) => Promise<ConnectionCatalogProbeOutcome>,
  request: ConnectionCatalogProbeRequest,
): Promise<ConnectionCatalogProbeOutcome> {
  try {
    return await probe(request);
  } catch {
    return { kind: 'failed', errorClass: 'unknown' };
  }
}

/** The chooser options a ready probe offers: the model id is both the value
 * and the label, because the id is exactly what the default-model field
 * needs — a display name would hide the thing that gets submitted. */
export function catalogProbeChoices(
  models: readonly ConnectionCatalogProbeModel[],
): readonly { readonly value: string; readonly label: string }[] {
  return models.map(({ id }) => ({ value: id, label: id }));
}
