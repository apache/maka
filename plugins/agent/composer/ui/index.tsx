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

import { effect } from 'nsh';
import type { JSX } from 'nsh';
import type {
  ComposerViewInput,
  UiActivation,
  UiContext,
  UiEmbeddedViewProps,
} from '../../../../packages/plugin-sdk/src/index.js';
import { Composer } from './Composer';
import { currentLocale } from '../../../../products/maka/workbench/app/locale';

export function activate(context: UiContext): UiActivation<JSX.Element> {
  effect(() => currentLocale.set(context.locale()));
  return {
    exports: {
      composer: {
        kind: 'view',
        contract: 'maka.composer',
        render(props: UiEmbeddedViewProps<ComposerViewInput<JSX.Element>, JSX.Element>) {
          return <Composer {...props.input} />;
        },
      },
    },
  };
}
