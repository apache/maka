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

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Banner, Divider, HStack, Link, Text, VStack } from '@astryxdesign/core';
import { Button, useUiLocale } from '@maka/ui';
import type {
  CommandCodeBrowserLoginBridge,
  CommandCodeBrowserLoginCredentials,
} from './ports.js';
import { CommandCodeBrowserLoginFlow } from './commandcode-browser-login-flow.js';
import { getProviderSettingsCopy } from './settings-provider-copy.js';

/**
 * The "or sign in with your account" block under the Command Code key field:
 * an "or" divider, then a small titled area with one secondary button. Pasting
 * a key stays the primary path; a successful sign-in only fills that field.
 */
export function CommandCodeBrowserLoginSection(props: {
  readonly bridge: CommandCodeBrowserLoginBridge;
  readonly baseUrl?: string;
  readonly isDisabled?: boolean;
  readonly onCredentials: (credentials: CommandCodeBrowserLoginCredentials) => void;
}) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).add.browserLogin;
  const onCredentialsRef = useRef(props.onCredentials);
  onCredentialsRef.current = props.onCredentials;
  const flow = useMemo(
    () =>
      new CommandCodeBrowserLoginFlow(props.bridge, (credentials) =>
        onCredentialsRef.current(credentials),
      ),
    [props.bridge],
  );
  // Cancel, not dispose: the memoised flow survives StrictMode's mount →
  // unmount → mount rehearsal, and a disposed instance would ignore every
  // later click. cancel() abandons the live attempt and leaves the instance
  // usable; a late result is dropped by the generation check.
  useEffect(() => () => flow.cancel(), [flow]);
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  const start = () => void flow.start(props.baseUrl === undefined ? {} : { baseUrl: props.baseUrl });
  const inFlight = state.phase === 'starting' || state.phase === 'waiting';

  return (
    <VStack gap={3}>
      <Divider label={copy.or} />
      <VStack gap={1}>
        <Text type="label">{copy.title}</Text>
        <Text type="supporting" color="secondary">
          {copy.description}
        </Text>
      </VStack>
      {state.phase === 'failed' && <Banner status="error" title={copy.failed[state.reason]} />}
      <HStack gap={3} align="center" wrap="wrap">
        {inFlight ? (
          <>
            <Text type="supporting" role="status" aria-live="polite">
              {copy.waiting}
            </Text>
            {state.phase === 'waiting' && (
              <Link href={state.authUrl} target="_blank" rel="noreferrer noopener">
                {copy.openAgain}
              </Link>
            )}
            <Button variant="ghost" label={copy.cancel} onClick={() => flow.cancel()} />
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              label={state.phase === 'failed' ? copy.retry : copy.action}
              onClick={start}
              isDisabled={props.isDisabled}
            />
            {state.phase === 'filled' && (
              <Text type="supporting" role="status">
                {copy.filled(state.userName)}
              </Text>
            )}
          </>
        )}
      </HStack>
    </VStack>
  );
}
