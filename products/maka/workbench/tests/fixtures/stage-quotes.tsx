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
import type { ComposerSession } from '../../../../../packages/plugin-sdk/src/composer-view.js';
import { StageFloatingComposer } from '../../app/StageFloatingComposer';

mount(() => {
  const quotes = signal([{ text: 'First selected passage' }, { text: 'Second selected passage' }]);
  const sent = signal('');
  const session = {
    draft: () => '',
    editable: () => true,
    run: () => null,
    blockedReason: () => '',
    attachments: { files: () => [] },
    quotes,
    removeQuote: (index: number) => quotes.set(quotes().filter((_, i) => i !== index)),
    submit: ({ text }: { text: string }) => {
      sent.set(
        text +
          quotes()
            .map((quote) => quote.text)
            .join(', '),
      );
      quotes.set([]);
    },
  };
  return (
    <View>
      <StageFloatingComposer
        title={() => 'Investigation'}
        session={() => session as unknown as ComposerSession}
        stop={() => {}}
        exitFullscreen={() => {}}
        transcript={() => null}
      />
      <Text>Sent {sent()}</Text>
    </View>
  );
});
