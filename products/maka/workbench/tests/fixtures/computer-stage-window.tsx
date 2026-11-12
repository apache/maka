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

import { cleanup, effect, host, mount, signal, Text } from 'nsh';
import {
  createComputerStageWindow,
  type ComputerStageSize,
} from '../../../../../plugins/agent/conversations/ui/ComputerStageWindow';

mount(() => {
  const owner = signal<{ sessionId: string } | null>({ sessionId: 'source-1' });
  const binding = signal('binding-1');
  const visible = signal(true);
  const natural = signal<ComputerStageSize>({ width: 160, height: 72 });
  const disposed = signal(0);
  // Exercise a late frame from a retired source.
  let retired: ((size: ComputerStageSize) => void) | undefined;
  host.on('size', (value) => natural.set(value));
  host.on('owner', (value) => owner.set(value));
  host.on('binding', (value) => binding.set(value));
  host.on('late-size', (value) => retired!(value));
  createComputerStageWindow({
    owner,
    bindingId: binding,
    visible,
    hide: () => visible.set(false),
    report: (reason) => {
      throw reason;
    },
    render(contentSize) {
      cleanup(() => {
        retired = contentSize;
        disposed.set(disposed() + 1);
      });
      effect(() => contentSize(natural()));
      return <Text>Stage content</Text>;
    },
  });
  return <Text>{'disposed:' + disposed() + ';visible:' + visible()}</Text>;
});
