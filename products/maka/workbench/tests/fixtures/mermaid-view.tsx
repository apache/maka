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
import { MarkdownBody } from '../../app/MarkdownBody';

const valid = '```mermaid\nflowchart LR\n A[User] --> B[Maka]\n```';
const source = signal(valid);
mount(() => (
  <View style={{ width: '100%', gap: 8 }}>
    <View
      testID="break"
      style={{ height: 32 }}
      onPress={() => source.set('```mermaid\nflowchart LR\n A[unfinished\n```')}
    >
      <Text>Break diagram</Text>
    </View>
    <View testID="repair" style={{ height: 32 }} onPress={() => source.set(valid)}>
      <Text>Repair diagram</Text>
    </View>
    <MarkdownBody
      row={() => ({
        key: 'diagram',
        messageId: 'diagram',
        field: 'body',
        role: 'assistant',
        prefix: true,
        text: source(),
      })}
      sourceId="diagram"
      sessionId="diagram-test"
      openLink={async () => {}}
      userScroll={() => {}}
    />
  </View>
));
