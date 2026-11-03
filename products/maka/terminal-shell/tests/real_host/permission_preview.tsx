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
import { SystemPermissionRequest } from '../../../workbench/app/SystemPermissionRequest';
import { SystemPermissionActions } from '../../../workbench/app/InteractionComposer';
import { C, bodyTextStyle } from '../../../workbench/app/ui';

const mode = signal('local');
const result = signal('No system action requested');
const request = {
  kind: 'system_permission' as const,
  toolUseId: 'fixture-computer',
  grants: ['accessibility' as const, 'screen_recording' as const],
  application: 'Maka Host',
};
const actions = () =>
  mode() === 'local' ? ['accessibility', 'screen_recording', 'reveal_application'] : [];

mount(() => (
  <View style={{ flexGrow: 1, padding: 32, backgroundColor: C.background, gap: 16 }}>
    <Text style={{ ...bodyTextStyle, color: C.text }}>Computer permission preview</Text>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Button accessibilityLabel="Local Host" onPress={() => mode.set('local')}>
        <Text style={{ ...bodyTextStyle, color: C.text }}>Local Host</Text>
      </Button>
      <Button accessibilityLabel="Remote Host" onPress={() => mode.set('remote')}>
        <Text style={{ ...bodyTextStyle, color: C.text }}>Remote Host</Text>
      </Button>
      <Button accessibilityLabel="Older request" onPress={() => mode.set('old')}>
        <Text style={{ ...bodyTextStyle, color: C.text }}>Older request</Text>
      </Button>
    </View>
    <SystemPermissionRequest
      request={request}
      canLocate={actions().includes('reveal_application')}
    />
    <SystemPermissionActions
      request={request}
      actions={actions()}
      onCancel={() => result.set('Request cancelled without granting access')}
      onAction={(action) => result.set('Requested ' + action)}
    />
    <Button accessibilityLabel={result()} onPress={() => {}}>
      <Text style={{ ...bodyTextStyle, color: C.text }}>{result()}</Text>
    </Button>
  </View>
));
