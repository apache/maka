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
import { MermaidView } from '../../app/MermaidView';

const valid = 'flowchart LR\n A[User] --> B[Maka]';
const source = signal(valid);
mount(() => (
  <View style={{ width: '100%', gap: 8 }}>
    <View
      testID="break"
      style={{ height: 32 }}
      onPress={() => source.set('flowchart LR\n A[unfinished')}
    >
      <Text>Break diagram</Text>
    </View>
    <View testID="repair" style={{ height: 32 }} onPress={() => source.set(valid)}>
      <Text>Repair diagram</Text>
    </View>
    <View
      testID="update"
      style={{ height: 32 }}
      onPress={() => source.set(valid.replace('User', 'LATEST'))}
    >
      <Text>Update diagram</Text>
    </View>
    <Text>{source().includes('LATEST') ? 'Latest requested' : 'Initial requested'}</Text>
    <MermaidView source={source} />
  </View>
));
