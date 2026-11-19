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

import { host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { Window } from 'nsh/desktop';
import { nativeDesktop } from '../../app/nativeDesktop';
import { applicationMenu } from '../../app/chrome';
import { appearance } from '../../app/appearance';
import { currentLocale } from '../../app/locale';

function Residency() {
  nativeDesktop();
  return null;
}

mount(() => {
  const resident = signal(true);
  const page = signal(true);
  const session = signal('conversation-1');
  const draft = signal('unfinished 原文😀');
  const turns = signal(0);
  host.on('resident', (value) => resident.set(value));
  host.on('page', (value) => page.set(value));
  host.on('locale', (value) => currentLocale.set(value));
  host.on('icon', (value) => appearance.chooseTrayIcon(value));
  host.on('turn', () => turns.set(turns() + 1));
  host.on('session', (value) => session.set(value));
  host.on('secondary', () =>
    Window.open(() => <Text>Other window</Text>, { id: 'other', title: 'Other' }),
  );
  const noop = () => {};
  applicationMenu({
    newConversation: noop,
    chooseWorkspace: noop,
    sessions: noop,
    search: noop,
    find: noop,
    commands: noop,
    models: noop,
    latest: noop,
    nextSession: noop,
    previousSession: noop,
    settings: noop,
    sidebarShown: () => false,
    toggleSidebar: noop,
    textSize: noop,
  });
  return (
    <View>
      <If when={resident()}>
        <Residency />
      </If>
      <If when={page()}>
        <View>
          <Text>{session()}</Text>
          <Input
            accessibilityLabel="Draft"
            defaultValue={draft()}
            onChange={({ value }) => draft.set(value)}
          />
        </View>
      </If>
      <Text>{`Draft: ${draft()}; turns: ${turns()}`}</Text>
    </View>
  );
});
