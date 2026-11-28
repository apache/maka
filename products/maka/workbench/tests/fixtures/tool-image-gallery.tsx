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

import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { HistoryTool } from '../../../../../packages/plugin-sdk/src/index.js';
import { HostProvider, type Host } from '../../app/host';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { toolImages, ToolImageStrip } from '../../app/ToolImage';

mount(() => {
  installWorkbenchLocaleCatalog();
  const count = signal(6);
  const tools = () =>
    Array.from(
      { length: count() },
      (_, index): HistoryTool => ({
        toolUseId: `shot-${index}`,
        call: null,
        result: {
          position: { kind: 'live', sequence: index + 1, fact: `fact-${index}`, itemIndex: 0 },
          settlement: 'returned',
          isError: false,
          image: true,
          images: 0,
        },
      }),
    );
  let failed = false;
  return (
    <HostProvider value={{ assetUri: (uri: string) => uri } as Host}>
      <View>
        <Button accessibilityLabel="New screenshot" onPress={() => count.set(count() + 1)}>
          <Text>Add</Text>
        </Button>
        <ToolImageStrip
          sessionId="session"
          through={count}
          images={() => tools().slice(1).flatMap(toolImages)}
          all={async () => {
            if (!failed) {
              failed = true;
              return [];
            }
            const page = tools();
            // One live image arrives after this read's cut, but before its reply.
            if (page.length === 6) {
              await Promise.resolve();
              count.set(7);
            }
            return page;
          }}
        />
        <ToolImageStrip
          sessionId="imported"
          through={() => 1}
          images={() =>
            Array.from({ length: 9 }, (_, partOrdinal) => ({
              key: String(partOrdinal),
              position: {
                kind: 'imported',
                path: [],
                snapshot: 'prior',
                messageOrdinal: 0,
                partOrdinal,
              },
            }))
          }
          all={async () => []}
        />
      </View>
    </HostProvider>
  );
});
