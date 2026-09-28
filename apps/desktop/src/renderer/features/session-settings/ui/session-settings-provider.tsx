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

import { useLayoutEffect, type ReactNode } from 'react';
import { useSessionSettingsController } from '../controller/use-session-settings-controller.js';
import type { SessionSettingsBridge } from '../controller/session-settings-bridge.js';
import type { SessionSettingsInput } from '../model/session-settings-contract.js';

/** Sole controller owner. Its updates reuse children built by the shell. */
export function SessionSettingsProvider<Owner extends { sessionId?: string }>(props: {
  readonly bridge: SessionSettingsBridge;
  readonly input: SessionSettingsInput<Owner>;
  readonly children?: ReactNode;
}) {
  const controller = useSessionSettingsController(props.input);
  useLayoutEffect(() => props.bridge.publish(controller), [props.bridge, controller]);
  useLayoutEffect(() => () => props.bridge.disconnect(), [props.bridge]);
  return props.children;
}
