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

import { mount, View, Text, signal } from 'nsh';
import { Button } from 'nsh/base';
import { ComputerPermissionSetup } from '../../../workbench/app/ComputerPermissionSetup';
import type {
  ComputerPermissionClient,
  SystemPermissionRequest,
} from '../../../workbench/app/computerPermissionSetupState';
import { C, bodyTextStyle } from '../../../workbench/app/ui';

type Mode = 'local' | 'remote' | 'old';

const mode = signal<Mode>('local');
const result = signal('Loading local');
const request: SystemPermissionRequest = {
  kind: 'system_permission',
  toolUseId: 'fixture-computer',
  grants: ['accessibility', 'screen_recording'],
  application: 'Maka Host',
};
const selectMode = (next: Mode) => {
  result.set('Loading ' + next);
  mode.set(next);
};
const clientFor = (current: Mode): ComputerPermissionClient => {
  let cancelled = false;
  const status = () => ({
    outcome: cancelled
      ? ({ kind: 'closure', reason: 'producer_cancelled', committedAt: 1 } as const)
      : null,
    requestable: !cancelled && current !== 'old',
    grants: request.grants.map((grant) => ({ grant, effective: false })),
  });
  return {
    status: async () => {
      if (result() === 'Loading ' + current) result.set('Ready ' + current);
      return status();
    },
    actions: async () =>
      !cancelled && current === 'local'
        ? ['accessibility', 'screen_recording', 'reveal_application']
        : [],
    request: async (grant) => {
      result.set('Prompted ' + grant);
      return status();
    },
    action: async (action) => {
      result.set('Requested ' + action);
    },
    cancel: async () => {
      cancelled = true;
      result.set('Request cancelled without granting access');
    },
  };
};

mount(() => (
  <View style={{ flexGrow: 1, padding: 24, backgroundColor: C.background, gap: 12 }}>
    <Text style={{ ...bodyTextStyle, color: C.text }}>Computer permission preview</Text>
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button accessibilityLabel="Local Host" onPress={() => selectMode('local')}>
        <Text style={{ ...bodyTextStyle, color: C.text }}>Local Host</Text>
      </Button>
      <Button accessibilityLabel="Remote Host" onPress={() => selectMode('remote')}>
        <Text style={{ ...bodyTextStyle, color: C.text }}>Remote Host</Text>
      </Button>
      <Button accessibilityLabel="Older request" onPress={() => selectMode('old')}>
        <Text style={{ ...bodyTextStyle, color: C.text }}>Older request</Text>
      </Button>
      <Button accessibilityLabel={result()} onPress={() => {}}>
        <Text style={{ ...bodyTextStyle, color: C.text }}>{result()}</Text>
      </Button>
    </View>
    <Each of={[mode()]} key={(current) => current}>
      {(current) => (
        <ComputerPermissionSetup
          request={request}
          client={clientFor(current())}
          presentation="inline"
        />
      )}
    </Each>
  </View>
));
