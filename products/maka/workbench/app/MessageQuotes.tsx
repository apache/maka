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

import { Text, View } from 'nsh';
import type { QuoteRef, HistoryQuote } from '../../../../packages/plugin-sdk/src/index.js';
import { C, bodyTextStyle, captionTextStyle } from './ui';

export function MessageQuotes(props: { quotes: () => readonly (QuoteRef | HistoryQuote)[] }) {
  const label = (quote: QuoteRef | HistoryQuote) =>
    quote.label || ('source' in quote ? quote.source?.sessionName : undefined);
  return (
    <Each of={props.quotes()}>
      {(quote) => (
        <View style={{ borderLeftWidth: 2, borderColor: C.line, paddingLeft: 12, gap: 4 }}>
          <If when={label(quote())}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{label(quote())}</Text>
          </If>
          <Text style={[{ ...bodyTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
            {quote().text}
            {'truncated' in quote() && (quote() as HistoryQuote).truncated ? '…' : ''}
          </Text>
        </View>
      )}
    </Each>
  );
}
