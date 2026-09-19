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

import { useRef, useState, type ReactNode } from 'react';
import { TRAE_ACCOUNTS, type TraeAccount } from '@maka/core/llm-connections';
import { Selector, useUiLocale } from '@maka/ui';
import type { ConnectionOAuthLoginTarget } from './ports.js';
import { getProviderSettingsCopy } from './settings-provider-copy.js';

export interface TraeAccountSelection {
  readonly shortName: string;
  readonly loginTarget: () => ConnectionOAuthLoginTarget;
  readonly renderSelector: (isDisabled: boolean) => ReactNode;
}

/** Owns the account variant for one enrollment, inside the Host generation boundary. */
export function TraeAccountSetup(props: {
  readonly children: (selection: TraeAccountSelection) => ReactNode;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).oauthSection;
  const [account, setAccount] = useState<TraeAccount>('cn');
  const accountRef = useRef(account);
  accountRef.current = account;
  const accountLabel = (value: TraeAccount): string => value === 'employee'
    ? copy.traeEmployeeAccount
    : `${value.slice(0, 2).toUpperCase()} · ${value.endsWith('-solo') ? 'SOLO' : 'IDE'}`;

  return props.children({
    shortName: `Trae ${accountLabel(account)}`,
    loginTarget: () => ({ kind: 'create', traeAccount: accountRef.current }),
    renderSelector: (isDisabled) => (
      <Selector
        label={copy.traeAccountField}
        value={account}
        options={TRAE_ACCOUNTS.map((value) => ({ value, label: accountLabel(value) }))}
        onChange={(value) => setAccount(value as TraeAccount)}
        isDisabled={isDisabled}
      />
    ),
  });
}
