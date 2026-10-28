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

import type { UiToolProps, UiRuntime } from '../../../../../packages/plugin-sdk/src/workbench.js';
import type { Contribution } from './context';
import type { JSX } from 'nsh';

export function PluginView(props: {
  runtime: UiRuntime<JSX.Element>;
  contribution: Contribution;
  sessionId(): string | null;
  input?: () => unknown;
  tool?: () => Omit<UiToolProps, 'context'>;
}) {
  return props.runtime.render(props.contribution, {
    get sessionId() {
      return props.sessionId();
    },
    get input() {
      return props.input?.();
    },
    get tool() {
      return props.tool?.();
    },
  });
}
