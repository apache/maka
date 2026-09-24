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

import type { ReactNode } from 'react';
import type { ModelApiProtocol, ProviderType } from '@maka/core/llm-connections';
import { useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from './settings-provider-copy.js';
import { openAiChatUrl, openResponsesUrl } from '@maka/core/openai-urls';
import { normalizeCatalogConnectionBaseUrl } from '@maka/core/runtime-policy';
import { redactSecrets } from '@maka/core/display-redaction';

export function ProviderEndpointField(props: {
  providerType: ProviderType;
  baseUrl: string;
  apiProtocol?: ModelApiProtocol;
  children(description: string | undefined): ReactNode;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).shared;
  const url = providerRequestUrlPreview(props.providerType, props.baseUrl, props.apiProtocol);
  if (props.providerType !== 'custom') return props.children(undefined);
  const description = url ? `${copy.requestUrlLabel} ${url}` : undefined;
  // Astryx's description is above the input (and hidden with its label).
  // This computed output belongs below it; pass it through aria-description
  // on the control as well, without duplicating the field's visible label.
  return (
    <div className="providerEndpointField">
      {props.children(description)}
      {description && <p className="providerRequestUrlPreview" aria-hidden="true">{description}</p>}
    </div>
  );
}

/** Preview the selected protocol when adding, or the default model's protocol when editing. */
export function providerRequestUrlPreview(
  providerType: ProviderType,
  draftBaseUrl: string,
  apiProtocol: ModelApiProtocol = 'openai-chat',
): string | null {
  if (providerType !== 'custom' || apiProtocol === 'anthropic-messages') {
    return null;
  }
  // A draft must be a complete, saveable HTTP(S) address. Do not substitute
  // defaults while it is empty, or expose embedded credentials in a preview.
  if (!/^https?:\/\//i.test(draftBaseUrl.trim())) return null;
  try {
    const baseUrl = normalizeCatalogConnectionBaseUrl(draftBaseUrl);
    if (!baseUrl) return null;
    return redactSecrets(apiProtocol === 'openai-chat'
      ? openAiChatUrl(baseUrl)
      : openResponsesUrl(baseUrl));
  } catch {
    return null;
  }
}
