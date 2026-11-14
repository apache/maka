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

import { computed, keymap, mount, Scroll, signal, Text, View } from 'nsh';
import { TextView } from 'nsh/base';
import { markdownExtensions, SpecView } from '../../app/SpecView';
import { splitSpecMarkdown } from '../../app/spec/session.ts';

const block1BaseLines = [
  '{"op":"add","path":"/root","value":"main"}',
  '{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Release Readiness","description":"Interactive status"},"children":["summary-row","filter-row","release-accordion","tabs"]}}',
  '{"op":"add","path":"/elements/summary-row","value":{"type":"Stack","props":{"direction":"horizontal","gap":"md","align":"center"},"children":["latency-metric","boost-btn"]}}',
  '{"op":"add","path":"/elements/latency-metric","value":{"type":"Metric","props":{"label":"P99 Latency","value":{"$template":"${/latency} ms"}},"children":[]}}',
  '{"op":"add","path":"/elements/boost-btn","value":{"type":"Button","props":{"label":"Boost Cache"},"on":{"press":{"action":"setState","params":{"statePath":"/latency","value":42}}},"children":[]}}',
  '{"op":"add","path":"/elements/filter-row","value":{"type":"Stack","props":{"direction":"horizontal","gap":"sm","align":"center"},"children":["filter-input","filter-readout"]}}',
  '{"op":"add","path":"/elements/filter-input","value":{"type":"Input","props":{"label":"Filter","placeholder":"Filter services","value":{"$bindState":"/filter"}},"children":[]}}',
  '{"op":"add","path":"/elements/filter-readout","value":{"type":"Text","props":{"text":{"$template":"Filter: ${/filter}"}},"children":[]}}',
  '{"op":"add","path":"/elements/release-accordion","value":{"type":"Accordion","props":{"items":[{"title":"Release Notes","content":"Zero WebView runtime"}]},"children":[]}}',
  '{"op":"add","path":"/elements/tabs","value":{"type":"Tabs","props":{"value":{"$bindState":"/tab"},"tabs":[{"value":"overview","label":"Overview"},{"value":"controls","label":"Controls"},{"value":"default","label":"DefaultSlot"},{"value":"charts","label":"Charts"},{"value":"tasks","label":"Tasks"}]},"children":["tab-overview","tab-controls","tab-default","tab-charts","tab-tasks"]}}',
  '{"op":"add","path":"/elements/tab-overview","value":{"type":"TabContent","props":{"value":"overview"},"children":["service-table"]}}',
  '{"op":"add","path":"/elements/service-table","value":{"type":"Table","props":{"columns":[{"key":"service","header":"Service"},{"key":"node","header":"Node"},{"key":"notes","header":"Notes","sortable":false}],"rows":[{"service":"worker","node":"node-10","notes":"pinned"},{"service":"gateway","node":"node-1","notes":"edge"},{"service":"api","node":"node-2","notes":"core"}],"sortable":true},"children":[]}}',
  '{"op":"add","path":"/elements/tab-controls","value":{"type":"TabContent","props":{"value":"controls"},"children":["replicas-input","replicas-readout","cycle-btn","ping-watcher","pong-watcher","runbook-link"]}}',
  '{"op":"add","path":"/elements/replicas-input","value":{"type":"NumberInput","props":{"label":"Min Replicas","min":10,"max":50,"value":{"$bindState":"/replicas"}},"children":[]}}',
  '{"op":"add","path":"/elements/replicas-readout","value":{"type":"Text","props":{"text":{"$template":"Replicas: ${/replicas}"}},"children":[]}}',
  '{"op":"add","path":"/elements/cycle-btn","value":{"type":"Button","props":{"label":"Trigger Cycle","variant":"secondary"},"on":{"press":{"action":"setState","params":{"statePath":"/ping","value":1}}},"children":[]}}',
  '{"op":"add","path":"/elements/ping-watcher","value":{"type":"Text","props":{"text":{"$template":"Cycle: ${/ping}"}},"watch":{"/ping":{"action":"setState","params":{"statePath":"/pong","value":{"$math":"add","a":{"$state":"/ping"},"b":1}}}},"children":[]}}',
  '{"op":"add","path":"/elements/pong-watcher","value":{"type":"Badge","props":{"text":"Watch Guarded","variant":"outline"},"watch":{"/pong":{"action":"setState","params":{"statePath":"/ping","value":{"$math":"add","a":{"$state":"/pong"},"b":1}}}},"children":[]}}',
  '{"op":"add","path":"/elements/runbook-link","value":{"type":"Link","props":{"label":"Runbook","href":"https://example.com/runbook"},"children":[]}}',
  '{"op":"add","path":"/elements/tab-default","value":{"type":"TabContent","props":{"value":"default"},"children":["default-panel-text"]}}',
  '{"op":"add","path":"/elements/default-panel-text","value":{"type":"Text","props":{"text":"Single Default Panel"},"children":[]}}',
  '{"op":"add","path":"/elements/tab-charts","value":{"type":"TabContent","props":{"value":"charts"},"children":["line-chart","pie-chart"]}}',
  '{"op":"add","path":"/elements/line-chart","value":{"type":"LineChart","props":{"title":"Throughput","data":[{"step":"T1","rps":120},{"step":"T2","rps":180},{"step":"T3","rps":240}],"xKey":"step","series":[{"key":"rps","label":"RPS"}],"height":140},"children":[]}}',
  '{"op":"add","path":"/elements/pie-chart","value":{"type":"PieChart","props":{"title":"Traffic Mix","data":[{"label":"Desktop","value":65},{"label":"Terminal","value":35}],"height":140},"children":[]}}',
  '{"op":"add","path":"/elements/tab-tasks","value":{"type":"TabContent","props":{"value":"tasks"},"children":["add-task-btn","task-list","validate-btn","valid-status"]}}',
  '{"op":"add","path":"/elements/add-task-btn","value":{"type":"Button","props":{"label":"Add Task","variant":"secondary"},"on":{"press":{"action":"pushState","params":{"statePath":"/tasks","value":{"id":"t-1","title":"Verify TUI"}}}},"children":[]}}',
  '{"op":"add","path":"/elements/task-list","value":{"type":"Stack","props":{"direction":"vertical","gap":"xs"},"repeat":{"statePath":"/tasks","key":"id"},"children":["task-item"]}}',
  '{"op":"add","path":"/elements/task-item","value":{"type":"Text","props":{"text":{"$item":"title"}},"children":[]}}',
  '{"op":"add","path":"/elements/validate-btn","value":{"type":"Button","props":{"label":"Validate Form","variant":"outline"},"on":{"press":{"action":"validateForm","params":{"statePath":"/formValid"}}},"children":[]}}',
  '{"op":"add","path":"/elements/valid-status","value":{"type":"Badge","props":{"text":"Form Checked","variant":"info"},"visible":{"$state":"/formValid/valid","eq":true},"children":[]}}',
  '{"op":"add","path":"/state/latency","value":120}',
  '{"op":"add","path":"/state/filter","value":""}',
  '{"op":"add","path":"/state/replicas","value":12}',
  '{"op":"add","path":"/state/ping","value":0}',
  '{"op":"add","path":"/state/pong","value":0}',
  '{"op":"add","path":"/state/tab","value":"overview"}',
  '{"op":"add","path":"/state/tasks","value":[{"id":"t-1","title":"Ship Core"}]}',
];

const initialStreamingMarkdown = [
  'Here is the release dashboard:',
  '',
  '```spec',
  ...block1BaseLines,
].join('\n');

const midStreamChunkLines = [
  ...block1BaseLines,
  '{"op":"add","path":"/elements/rps-sparkline","value":{"type":"Sparkline","props":{"data":[12,18,15,29],"label":"RPS Trend"},"children":[]}}',
  '{"op":"add","path":"/elements/live-badge","value":{"type":"Badge","props":{"text":"Sparkline Ready","variant":"success"},"children":[]}}',
  '{"op":"add","path":"/elements/main/children/0","value":"live-badge"}',
  '{"op":"add","path":"/elements/main/children/1","value":"rps-sparkline"}',
  '{"op":"replace","path":"/state/latency","value":999}',
];

const midStreamMarkdown = [
  'Here is the release dashboard:',
  '',
  '```spec',
  ...midStreamChunkLines,
].join('\n');

// Second ```spec block in the SAME message intentionally starts with the exact same
// prefix as Block 1 before patching its title and latency, exercising sibling isolation.
const block2Lines = [
  ...midStreamChunkLines,
  '{"op":"replace","path":"/elements/main/props/title","value":"Canary Rollout"}',
  '{"op":"replace","path":"/state/latency","value":77}',
];

const completedTwoBlockMarkdown = [
  'Here is the release dashboard:',
  '',
  '```spec',
  ...midStreamChunkLines,
  '```',
  '',
  'All checks ready. Canary comparison:',
  '',
  '```spec',
  ...block2Lines,
  '```',
].join('\n');

const brokenMarkdown = ['```spec', '{"invalid": true}', '```'].join('\n');

const markdown = signal(initialStreamingMarkdown);
const streaming = signal(true);
const openedLinks = signal<string[]>([]);

mount(() => {
  // Fires mid-stream markdown growth without pointer clicks so active Input focus stays untouched.
  keymap.bind(
    'mod+n',
    () => {
      markdown.set(midStreamMarkdown);
      streaming.set(true);
    },
    { when: 'always' },
  );

  const segments = computed(() => splitSpecMarkdown(markdown()));

  return (
    <Scroll style={{ flex: 1, width: '100%' }}>
      <View style={{ width: '100%', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
          <View
            testID="finish-stream"
            style={{ height: 28 }}
            onPress={() => {
              markdown.set(completedTwoBlockMarkdown);
              streaming.set(false);
            }}
          >
            <Text>Finish stream</Text>
          </View>
          <View
            testID="break-spec"
            style={{ height: 28 }}
            onPress={() => {
              markdown.set(brokenMarkdown);
              streaming.set(false);
            }}
          >
            <Text>Break spec</Text>
          </View>
          <View
            testID="repair-spec"
            style={{ height: 28 }}
            onPress={() => {
              markdown.set(completedTwoBlockMarkdown);
              streaming.set(false);
            }}
          >
            <Text>Repair spec</Text>
          </View>
        </View>
        <If when={openedLinks().length > 0}>
          <Text>{`Opened: ${openedLinks().join(', ')}`}</Text>
        </If>
        <View style={{ width: '100%', gap: 16 }}>
          <Each of={segments()} key={(seg) => `msg-1\0${seg.key}`}>
            {(seg) => (
              <If
                when={seg().kind === 'spec'}
                else={
                  <TextView
                    markdown={(() => {
                      const s = seg();
                      return s.kind === 'markdown' ? s.text : '';
                    })()}
                    extensions={markdownExtensions}
                    options={{ streaming: true, preserveLineBreaks: true }}
                  />
                }
              >
                <SpecView
                  source={() => {
                    const current = seg();
                    return current.kind === 'spec' ? current.source : '';
                  }}
                  streaming={() => {
                    const current = seg();
                    return streaming() && current.kind === 'spec' && !current.closed;
                  }}
                  openLink={async (url) => {
                    openedLinks.set([...openedLinks(), url]);
                  }}
                />
              </If>
            )}
          </Each>
        </View>
      </View>
    </Scroll>
  );
});
