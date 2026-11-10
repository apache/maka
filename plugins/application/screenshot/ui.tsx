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

import { computed, platform, type JSX } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { QuickRows } from '../../../products/maka/workbench/app/QuickBar';
import { tr } from '../../../products/maka/workbench/app/locale';
import { rank } from '../../shared/quick-search';

const TERMS = ['screenshot', 'capture', '截图', '截圖'];

function Screenshot(props: { input: QuickToolInput; host: ApplicationHost }) {
  const { input, host } = props;
  const rows = computed(() => rank(['screenshot'], input.query(), () => TERMS, 1));
  const capture = () => {
    // The popup floats above everything, so it has to be gone before the selection starts.
    input.close();
    host.captureScreenRegion().catch(input.report);
  };
  return (
    <QuickRows
      input={input}
      items={rows}
      title={() => tr('Capture a screen region')}
      hint={() => tr('Copy')}
      activate={capture}
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
          <Screenshot input={input} host={context.application as ApplicationHost} />
        ) : null,
    },
  },
});
