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

import { mount, signal, View, Text } from 'nsh';
import { Button } from 'nsh/base';
import { createMessagesDock } from '../../app/MessagesDock';

mount(() => {
  const messages = signal(['first', 'second']);
  let reject: (() => void) | undefined;
  const unused = () => {
    throw new Error('Unexpected messages action');
  };
  const dock = createMessagesDock(
    {
      connected: () => true,
      sends: () => [],
      retrySend: unused,
      editSend: unused,
      checkSend: unused,
      dismissSend: unused,
      queue: {
        sessionId: 'session',
        running: () => true,
        read: unused,
        snapshot: () => ({
          revision: 3 - messages().length,
          entries: messages().map((messageId) => ({
            messageId,
            kind: 'followup',
            preview: messageId,
          })),
        }),
        change: () =>
          new Promise((resolve) => {
            reject = () => resolve({ kind: 'rejected', reason: 'execution_changed' });
          }),
      },
    },
    () => 400,
  );
  return (
    <View>
      <Button accessibilityLabel="Deliver first" onPress={() => messages.set(messages().slice(1))}>
        <Text>Deliver</Text>
      </Button>
      <Button accessibilityLabel="Release receipt" onPress={() => reject?.()}>
        <Text>Release</Text>
      </Button>
      <If when={dock.shown()} else={<Text>Empty dock</Text>}>
        {dock.content()}
      </If>
    </View>
  );
});
