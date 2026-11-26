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

import { inputAction, Scroll, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { InlineCallout } from './Feedback';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
} from './ui';
import { tr } from './locale';
import type { ComposerProjectMcp as Owner } from '../../../../packages/plugin-sdk/src/composer-view.js';

/**
 * Decision card shown above the composer when a workspace MCP config needs explicit trust.
 * Standalone error/notice states without an active proposal are surfaced via ComposerShelf.
 */
export function ProjectMcp(props: { owner: Owner }) {
  const owner = props.owner;
  return (
    <Each of={owner.proposal() ? [owner.proposal()!] : []} key={(proposal) => proposal.revision}>
      {(proposal) => (
        <View
          style={{
            padding: 12,
            gap: 8,
            marginBottom: 8,
            backgroundColor: C.card,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 12,
          }}
        >
          <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
            {tr('Trust project MCP configuration?')}
          </Text>
          <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}>
            {proposal().path}
          </Text>
          <Text style={{ ...captionTextStyle, color: C.warning }}>
            {tr(
              'These servers run outside the conversation sandbox and can run commands as your user or contact remote services. Once loaded, this session can call their tools.',
            )}
          </Text>
          <Scroll
            accessibilityLabel={tr('MCP server configuration')}
            style={{ maxHeight: 192 }}
            contentStyle={{ gap: 8 }}
          >
            <Each of={proposal().servers} key={(server) => server.name}>
              {(server) => (
                <View style={{ gap: 4 }}>
                  <Text style={[{ ...captionTextStyle, color: C.text }, { userSelect: 'text' }]}>
                    {server().name}: {server().launch}
                  </Text>
                  <If when={server().environment.length > 0}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr('Environment variables')}: {server().environment.join(', ')}
                    </Text>
                  </If>
                  <If when={server().headers.length > 0}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr('HTTP headers')}: {server().headers.join(', ')}
                    </Text>
                  </If>
                  <If when={server().readOnlyTools.length > 0}>
                    <Text style={{ ...captionTextStyle, color: C.warning }}>
                      {tr('Tools declared read-only')}: {server().readOnlyTools.join(', ')}
                    </Text>
                  </If>
                </View>
              )}
            </Each>
            <If when={proposal().disabled.length > 0}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Disabled servers')}: {proposal().disabled.join(', ')}
              </Text>
            </If>
          </Scroll>
          <If when={Boolean(owner.error())}>
            <InlineCallout tone="danger" surface="chrome" message={owner.error()} />
          </If>
          <If when={!owner.error() && Boolean(owner.notice())}>
            <InlineCallout tone="info" surface="chrome" message={owner.notice()} />
          </If>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr(
              'Trust is saved for this workspace and configuration. Changes require confirmation again. Your draft has not been sent.',
            )}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              disabled={owner.pending()}
              accessibilityLabel={tr('Trust configuration')}
              onPress={inputAction(owner.trust, proposal().revision)}
              style={{
                ...controlStyle,
                borderWidth: 1,
                borderColor: C.line,
                backgroundColor: C.raised,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.accent }}>
                {owner.pending() ? tr('Saving trust…') : tr('Trust configuration')}
              </Text>
            </Button>
            <Button
              disabled={owner.pending()}
              accessibilityLabel={tr("Don't load")}
              onPress={inputAction(owner.decline, proposal().revision)}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr("Don't load")}</Text>
            </Button>
          </View>
        </View>
      )}
    </Each>
  );
}
