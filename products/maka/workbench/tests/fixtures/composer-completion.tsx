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

import { mount, signal, Text, View } from 'nsh';
import {
  ComposerCompletion,
  type ComposerCompletionRow,
  type ComposerCompletionView,
} from '../../../../../plugins/agent/composer/ui/ComposerCompletion';

const skills = Array.from({ length: 16 }, (_, index) => `skill-${String(index).padStart(2, '0')}`);
const makeRows = (read: number): ComposerCompletionRow[] =>
  skills.map((name) => ({
    id: `skill:${name}`,
    title: name,
    detail: `Description of ${name}`,
    icon: 'code',
    action: { read, id: `skill:${name}` },
  }));

mount(() => {
  const generation = signal(1);
  const rows = signal(makeRows(1));
  const query = signal('');
  const accepted = signal('idle');
  const state: ComposerCompletionView = {
    rows,
    opened: () => ({ serial: generation(), source: 'skills', explicit: false }),
    anchor: () => ({ origin: { x: 20, y: 180 }, size: { width: 1, height: 20 } }),
    title: () => 'Skills',
    loading: () => false,
    error: () => '',
    empty: () => 'No matching skills.',
    query,
    queryPlaceholder: () => 'Search skills…',
    queryComposing: () => false,
    queryInput: () => {},
    querySelection: () => {},
    queryComposition: () => {},
    acceptSelected: () => {},
    index: () => 0,
    list: () => {},
    close: () => {},
    dismiss: () => {},
    accept: (action) => accepted.set(`${action.read}:${action.id}`),
  };
  return (
    <View style={{ flex: 1 }}>
      <View
        testID="refresh"
        style={{ height: 24 }}
        onPress={() => {
          generation.set(2);
          rows.set(makeRows(2));
        }}
      >
        <Text>Refresh lookup</Text>
      </View>
      <Text>{accepted()}</Text>
      <ComposerCompletion state={state} />
    </View>
  );
});
