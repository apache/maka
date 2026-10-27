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
import { C, controlStyle } from './ui';
import { tr } from './locale';
import type { ProjectMcp as Owner } from './projectMcp';

export function ProjectMcp(props: { owner: Owner }) {
  const owner = props.owner;
  return (
    <View>
      <If when={owner.error()}>
        <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>{owner.error()}</Text>
      </If>
      <If when={owner.notice()}>
        <Text style={{ color: C.muted }}>{owner.notice()}</Text>
      </If>
      <Each of={owner.proposal() ? [owner.proposal()!] : []} key={(proposal) => proposal.revision}>
        {(proposal) => (
          <View style={{ padding: 12, gap: 8, backgroundColor: C.surface }}>
            <Text style={{ color: C.text, fontWeight: '600' }}>
              {tr('Trust project MCP configuration?')}
            </Text>
            <Text style={[{ color: C.muted }, { userSelect: 'text' }]}>{proposal().path}</Text>
            <Text style={{ color: C.warning }}>
              {tr(
                'These servers can run commands as your user or contact remote services. They start outside the conversation sandbox. Trust only servers you recognize.',
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
                    <Text style={[{ color: C.text }, { userSelect: 'text' }]}>
                      {server().name}: {server().launch}
                    </Text>
                    <If when={server().environment.length > 0}>
                      <Text style={{ color: C.muted }}>
                        {tr('Environment variables')}: {server().environment.join(', ')}
                      </Text>
                    </If>
                    <If when={server().headers.length > 0}>
                      <Text style={{ color: C.muted }}>
                        {tr('HTTP headers')}: {server().headers.join(', ')}
                      </Text>
                    </If>
                    <If when={server().preapproved}>
                      <Text style={{ color: C.warning }}>
                        {tr('Calls run without individual confirmation.')}
                      </Text>
                    </If>
                    <If when={server().readOnlyTools.length > 0}>
                      <Text style={{ color: C.warning }}>
                        {tr('Allowed in read-only sessions and plans')}:{' '}
                        {server().readOnlyTools.join(', ')}
                      </Text>
                    </If>
                  </View>
                )}
              </Each>
              <If when={proposal().disabled.length > 0}>
                <Text style={{ color: C.muted }}>
                  {tr('Disabled servers')}: {proposal().disabled.join(', ')}
                </Text>
              </If>
            </Scroll>
            <Text style={{ color: C.muted }}>
              {tr(
                'Trust is saved for this workspace and configuration. Changes require confirmation again. Your draft has not been sent.',
              )}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                disabled={owner.pending()}
                accessibilityLabel={tr('Trust configuration')}
                onPress={inputAction(owner.trust, proposal().revision)}
                style={controlStyle}
              >
                <Text style={{ color: C.text }}>
                  {owner.pending() ? tr('Saving trust…') : tr('Trust configuration')}
                </Text>
              </Button>
              <Button disabled={owner.pending()} onPress={owner.dismiss} style={controlStyle}>
                <Text style={{ color: C.muted }}>{tr('Cancel')}</Text>
              </Button>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}
