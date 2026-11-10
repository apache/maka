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

import { computed, platform, signal, type JSX } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { QuickRows } from '../../../products/maka/workbench/app/QuickBar';
import { tr } from '../../../products/maka/workbench/app/locale';
import { rank } from '../../shared/quick-search';

const LIMIT = 5;
const applicationName = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.app'.length);

function Applications(props: { input: QuickToolInput; host: ApplicationHost }) {
  const { input, host } = props;
  const installed = signal<readonly string[]>([]);
  host.installedApplications().then(installed.set, input.report);
  const matches = computed(() =>
    rank(installed(), input.query(), (path) => [applicationName(path)], LIMIT),
  );
  return (
    <QuickRows
      input={input}
      items={matches}
      title={applicationName}
      hint={() => tr('Open')}
      activate={(path) => void host.openLocalPath(path).then(input.close, input.report)}
    />
  );
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => ({
  exports: {
    tool: {
      kind: 'view',
      contract: quickToolView.id,
      render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
        platform.os === 'macos' ? (
          <Applications input={input} host={context.application as ApplicationHost} />
        ) : null,
    },
  },
});
