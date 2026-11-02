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

import { List, mount, Text, View, type ListRef } from 'nsh';
import { Button } from 'nsh/base';
import { LoadingIndicator } from '../../../workbench/app/Loading';
import { C } from '../../../workbench/app/ui';

function LoadingPreview() {
  let list!: ListRef;
  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <View style={{ flexDirection: 'row', height: 40, gap: 16 }}>
        <Button
          accessibilityLabel="Bottom"
          onPress={() => list.scrollToIndex({ index: 199, animated: false })}
        >
          <Text style={{ color: C.text }}>Bottom</Text>
        </Button>
        <Button
          accessibilityLabel="Top"
          onPress={() => list.scrollToOffset({ offset: 0, animated: false })}
        >
          <Text style={{ color: C.text }}>Top</Text>
        </Button>
      </View>
      <List
        ref={list}
        each={Array.from({ length: 200 }, (_, index) => index)}
        estimatedItemSize={64}
        style={{ flex: 1 }}
      >
        {(index) => (
          <View
            role="button"
            accessibilityLabel={`Row ${index()}`}
            onPress={() => {}}
            style={{ height: 64, flexDirection: 'row', alignItems: 'center', gap: 12 }}
          >
            <LoadingIndicator size={24} label={`Working ${index()}`} />
            <Text style={{ color: C.text }}>{`Row ${index()}`}</Text>
          </View>
        )}
      </List>
    </View>
  );
}

mount(LoadingPreview);
