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

import { cleanup, Input, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { tr } from './locale';
import { uiScale } from './uiScale';
import {
  bodyTextStyle,
  captionTextStyle,
  C,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  inputTextStyle,
} from './ui';

export function UiScaleSettings() {
  cleanup(uiScale.cancel);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
        {tr('Interface scale')}
      </Text>
      <If when={uiScale.supported}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Choose a preset or press Enter to preview. Ctrl+Alt+0 restores 100%.')}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Input
            value={uiScale.text()}
            onChange={uiScale.change}
            onSubmit={() => uiScale.preview(uiScale.text())}
            accessibilityLabel={tr('Interface scale percentage')}
            readonly={!uiScale.ready() || uiScale.saving()}
            style={{
              ...controlStyle,
              ...inputTextStyle,
              width: 96,
              borderWidth: 1,
              borderColor: C.line,
              backgroundColor: C.background,
              color: C.text,
            }}
            focusStyle={{ borderColor: C.accent }}
          />
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>%</Text>
          <Each of={[75, 90, 100, 110, 125, 150, 200]} key={(percent) => percent}>
            {(percent) => (
              <Button
                disabled={!uiScale.ready() || uiScale.saving()}
                accessibilityLabel={tr('Preview interface scale {percent}%', {
                  percent: percent(),
                })}
                onPress={() => uiScale.preview(String(percent()))}
                style={controlStyle}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>{percent()}%</Text>
              </Button>
            )}
          </Each>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button
            disabled={!uiScale.ready() || uiScale.saving() || !uiScale.dirty() || !!uiScale.error()}
            accessibilityLabel={tr('Save interface scale')}
            onPress={() => void uiScale.save()}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Save')}</Text>
          </Button>
          <Button
            disabled={!uiScale.ready() || uiScale.saving()}
            accessibilityLabel={tr('Reset interface scale to 100%')}
            onPress={uiScale.reset}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Reset to 100%')}</Text>
          </Button>
          <Button
            disabled={!uiScale.ready() || uiScale.saving()}
            accessibilityLabel={tr('Cancel interface scale preview')}
            onPress={uiScale.cancel}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Cancel')}</Text>
          </Button>
        </View>
        <If when={uiScale.error()}>
          <Text style={{ ...captionTextStyle, color: C.danger }}>{uiScale.error()}</Text>
        </If>
      </If>
      <If when={!uiScale.supported}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Use your terminal’s font size to scale the Unicode interface.')}
        </Text>
      </If>
    </View>
  );
}
