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

import { View, Image } from 'nsh';
import { Icon } from './Icon';
import { C } from './ui';
const pluginGlyph = (id = '', icon = ''): Parameters<typeof Icon>[0]['name'] => {
  const kind = `${id} ${icon}`;
  if (/assistant|suggestions/.test(kind)) return 'thinking';
  if (/quicklink|link/.test(kind)) return 'paperclip';
  if (/clipboard/.test(kind)) return 'copy';
  if (/notes|snippet/.test(kind)) return 'file';
  if (/files/.test(kind)) return 'folder';
  if (/calculator/.test(kind)) return 'code';
  if (/chrome|browser/.test(kind)) return 'sidebar';
  if (/screenshot/.test(kind)) return 'image';
  if (/bilibili/.test(kind)) return 'play';
  if (/symbols/.test(kind)) return 'plus';
  if (/application/.test(kind)) return 'split';
  return 'command';
};
export const toolIcon = (icon?: string, id?: string, compact = false) => (
  <View
    style={{
      width: compact ? 20 : 32,
      height: compact ? 20 : 32,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}
  >
    <If
      when={icon?.startsWith('data:image/png;base64,')}
      else={
        <Icon size={compact ? 18 : undefined} name={pluginGlyph(id, icon)} color={C.secondary} />
      }
    >
      <Image src={icon ?? ''} style={{ width: compact ? 18 : 26, height: compact ? 18 : 26 }} />
    </If>
  </View>
);
