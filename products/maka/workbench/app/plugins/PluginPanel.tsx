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

import { inputAction, Text, View, type YNode } from 'nsh';
import { Button } from 'nsh/base';
import { displayText, tr } from '../locale';
import { Icon } from '../Icon';
import { C, controlStyle, captionTextStyle } from '../ui';
import { controlsRight, windowDrag } from '../chrome';
import { PluginView } from './PluginView';
import { pluginContext } from './context';

export function PluginPanel(props: { docked: boolean; attach?(node: YNode): void }) {
  const plugins = pluginContext()!;
  return (
    <Each
      of={plugins.panel() ? [plugins.panel()!] : []}
      key={(panel) => `${panel.instance}/${plugins.sessionId()}`}
    >
      {(panel) => {
        const current = panel();
        const declaration = current.contribution.declaration;
        return (
          <View
            ref={props.attach}
            style={{ flex: 1, minHeight: 0, backgroundColor: C.background, gap: 8, padding: 8 }}
          >
            <View
              desktop={props.docked ? windowDrag : undefined}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexShrink: 0,
                paddingRight: controlsRight(props.docked),
              }}
            >
              <Text style={{ ...captionTextStyle, flex: 1, color: C.text }}>
                {declaration.kind === 'panel' ? displayText(declaration.title) : ''}
              </Text>
              <Button
                accessibilityLabel={tr('Close panel')}
                onPress={inputAction(plugins.closePanel, current.instance)}
                style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
              >
                <Icon name="close" color={C.secondary} />
              </Button>
            </View>
            <PluginView
              contribution={current.contribution}
              sessionId={plugins.sessionId}
              input={() => current.input}
            />
          </View>
        );
      }}
    </Each>
  );
}
