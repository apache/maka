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

import type { JSX } from 'nsh';
import type {
  UiCommandContext,
  UiExports,
  UiModule,
  UiEmbeddedViewProps,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  conversationNavigationView,
  conversationSessionView,
  conversationPreviewView,
  type ConversationNavigationInput,
  type ConversationSessionInput,
  type ConversationPreviewInput,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { createConversationUi } from './SessionSurface';
import { createHost, HostProvider } from '../../../../products/maka/workbench/app/host';

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  const host = createHost(context.application);
  const views = createConversationUi(context, host);
  const Navigation = (props: { input: ConversationNavigationInput }) =>
    views.navigation(props.input);
  const Session = (props: { input: ConversationSessionInput }) => views.session(props.input);
  const Preview = (props: { input: ConversationPreviewInput }) => views.preview(props.input);
  const commands: UiExports<JSX.Element> = Object.fromEntries(
    [
      'commands',
      'browse',
      'sessions',
      'new',
      'workspace',
      'models',
      'settings',
      'files',
      'compact',
      'latest',
      'history-focus',
      'activity-focus',
      'stop',
    ].map((id) => [
      id,
      {
        kind: 'command' as const,
        enabled: (input: UiCommandContext) =>
          input.sessionId === views.sessionId() && views.enabled(id),
        run: (input: UiCommandContext) => views.run(id, input.argument),
      },
    ]),
  );
  return {
    exports: {
      ...commands,
      navigation: {
        kind: 'view',
        contract: conversationNavigationView.id,
        render({ input }: UiEmbeddedViewProps<ConversationNavigationInput, JSX.Element>) {
          return (
            <HostProvider value={host}>
              <Navigation input={input} />
            </HostProvider>
          );
        },
      },
      session: {
        kind: 'view',
        contract: conversationSessionView.id,
        render({ input }: UiEmbeddedViewProps<ConversationSessionInput, JSX.Element>) {
          return (
            <HostProvider value={host}>
              <Session input={input} />
            </HostProvider>
          );
        },
      },
      preview: {
        kind: 'view',
        contract: conversationPreviewView.id,
        render({ input }: UiEmbeddedViewProps<ConversationPreviewInput, JSX.Element>) {
          return (
            <HostProvider value={host}>
              <Preview input={input} />
            </HostProvider>
          );
        },
      },
    },
    prepareReload: views.prepareReload,
  };
};
