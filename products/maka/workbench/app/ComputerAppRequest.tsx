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
import {
  computerAppRiskMessage,
  type ComputerAppRequest as Request,
} from './interaction-computer-app';
import { tr } from './locale';
import { renderText } from './text';
import { bodyTextStyle, C, captionTextStyle, codeTextStyle } from './ui';

export function ComputerAppRequest(props: { request: Request }) {
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 8 }}>
        <Text
          style={[{ ...bodyTextStyle, color: C.text, fontWeight: '600' }, { userSelect: 'text' }]}
        >
          {props.request.display.name}
        </Text>
        <Text style={{ ...bodyTextStyle, color: C.secondary }}>
          {tr('Allow the requesting tool to inspect and control this application?')}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Application path')}</Text>
        <Text style={[{ ...codeTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
          {props.request.display.appPath}
        </Text>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Bundle identifier')}</Text>
        <Text style={[{ ...codeTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
          {props.request.target.scope.kind === 'computer_app'
            ? props.request.target.scope.applicationId
            : tr('unavailable')}
        </Text>
      </View>
      <Text
        style={{
          ...bodyTextStyle,
          color: props.request.display.risk === 'low' ? C.secondary : C.warning,
        }}
      >
        {renderText(computerAppRiskMessage(props.request.display.risk))}
      </Text>
      <If when={props.request.display.warning}>
        <Text style={[{ ...bodyTextStyle, color: C.warning }, { userSelect: 'text' }]}>
          {props.request.display.warning}
        </Text>
      </If>
      <If when={props.request.allowAlways}>
        <Text style={{ ...bodyTextStyle, color: C.secondary }}>
          {tr('Always allow applies across sessions in this Maka profile.')}
        </Text>
      </If>
    </View>
  );
}
