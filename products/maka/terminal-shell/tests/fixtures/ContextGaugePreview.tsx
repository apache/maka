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

import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ContextGauge } from '../../../workbench/app/ContextGauge';
import { C } from '../../../workbench/app/ui';

export function ContextGaugePreview() {
  const usage = signal({
    tokens: 584346,
    window: 500000,
    approximate: true,
    outputTokensPerSecond: 100.5,
  });
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: C.background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ContextGauge usage={usage} />
      <Button
        accessibilityLabel="Update output speed"
        onPress={() => usage.set({ ...usage(), outputTokensPerSecond: 0 })}
        style={{ position: 'absolute', bottom: 24, right: 24 }}
      >
        <Text style={{ color: C.text }}>Update output speed</Text>
      </Button>
    </View>
  );
}
