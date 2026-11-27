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
import { Button } from 'nsh/base';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { tr } from '../../../../products/maka/workbench/app/locale';
import { C, captionTextStyle, radius } from '../../../../products/maka/workbench/app/ui';

export function DraftQuotes(props: {
  owner: Pick<ComposerSession, 'quotes' | 'editable' | 'removeQuote'>;
}) {
  return (
    <If when={props.owner.quotes().length > 0}>
      <View style={{ gap: 6 }}>
        <Each of={props.owner.quotes()}>
          {(quote, index) => (
            <View
              style={{
                flexDirection: 'row',
                gap: 8,
                padding: 8,
                borderLeftWidth: 2,
                borderColor: C.line,
                backgroundColor: C.card,
                borderRadius: radius(6),
              }}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {quote().label ?? quote().source?.sessionName ?? ''}
                </Text>
                <Text style={[{ ...captionTextStyle, color: C.secondary }, { numberOfLines: 3 }]}>
                  {quote().text}
                </Text>
              </View>
              <Button
                accessibilityLabel={tr('Remove quote')}
                disabled={!props.owner.editable()}
                onPress={() => props.owner.removeQuote(index())}
              >
                <Icon name="close" color={C.muted} />
              </Button>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
