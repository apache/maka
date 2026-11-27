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
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { QuoteRef } from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from '../../../../products/maka/workbench/app/locale';
import { C, captionTextStyle, IconButton } from '../../../../products/maka/workbench/app/ui';

const quoteLabel = (quote: QuoteRef) => quote.label || quote.source?.sessionName || '';

export function DraftQuotes(props: {
  owner: Pick<ComposerSession, 'quotes' | 'editable' | 'removeQuote'>;
  focusEditor(): void;
}) {
  return (
    <If when={props.owner.quotes().length > 0}>
      <View style={{ gap: 6 }}>
        <Each of={props.owner.quotes()}>
          {(quote, index) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingLeft: 10,
                paddingVertical: 2,
                borderLeftWidth: 2,
                borderLeftColor: C.accent,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <If when={quoteLabel(quote()) !== ''}>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>{quoteLabel(quote())}</Text>
                </If>
                <Text
                  style={[
                    { ...captionTextStyle, color: C.secondary },
                    { numberOfLines: 3, textOverflow: 'ellipsis' },
                  ]}
                >
                  {quote().text}
                </Text>
              </View>
              <IconButton
                compact
                label={tr('Remove quote')}
                icon="close"
                disabled={!props.owner.editable()}
                onPress={() => {
                  props.owner.removeQuote(index());
                  props.focusEditor();
                }}
              />
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
