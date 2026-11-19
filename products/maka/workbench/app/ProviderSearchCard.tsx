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

import { computed, Text, View } from 'nsh';
import { AnswerSourceList } from './AnswerSources';
import { useHost } from './host';
import { tr } from './locale';
import { LoadingIndicator } from './Loading';
import { providerSearch } from './providerSearch';
import { createToolSource, OriginalToolSource, type ToolSourceRef } from './ToolSource';
import { C, secondaryTextStyle } from './ui';

export function ProviderSearchCard(props: {
  args: ToolSourceRef;
  output: ToolSourceRef | null;
  sessionId: string;
  through: number;
  original(): boolean;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  isError: boolean;
}) {
  const host = useHost();
  const args = createToolSource(host, props.args, props.sessionId, props.through);
  const output =
    props.output && createToolSource(host, props.output, props.sessionId, props.through);
  const search = computed(() => providerSearch(args.json(), output?.json()));
  const error = () => args.error() || output?.error() || search().error;
  return (
    <If
      when={props.original()}
      else={
        <View style={{ gap: 8 }}>
          <Each of={search().queries} key={(query) => query}>
            {(query) => (
              <Text style={{ ...secondaryTextStyle, color: C.text, userSelect: 'text' }}>
                {query()}
              </Text>
            )}
          </Each>
          <If when={search().sources.length > 0}>
            <AnswerSourceList sources={() => search().sources} openLink={props.openLink} />
          </If>
          <If when={error() || props.isError}>
            <Text style={{ ...secondaryTextStyle, color: C.danger }}>
              {error() || tr('Search failed')}
            </Text>
          </If>
          <If when={!error() && (!args.complete() || (output && !output.complete()))}>
            <LoadingIndicator label={tr('Reading details…')} color={C.muted} />
          </If>
          <If
            when={
              !error() &&
              !props.isError &&
              args.complete() &&
              (!output || output.complete()) &&
              !search().queries.length &&
              !search().sources.length
            }
          >
            <Text style={{ ...secondaryTextStyle, color: C.muted }}>
              {output ? tr('No additional details') : tr('Waiting for tool result')}
            </Text>
          </If>
        </View>
      }
    >
      <If when={output}>
        <OriginalToolSource source={output!} label={tr('Original result')} />
      </If>
      <OriginalToolSource source={args} label={tr('Original arguments')} />
    </If>
  );
}
