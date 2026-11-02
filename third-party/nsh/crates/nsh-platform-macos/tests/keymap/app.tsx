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

import { effect, keymap, mount, signal, Text, View, type ViewRef } from "nsh";
import { Input, type InputRef } from "nsh/base";

function App() {
  const card = signal<ViewRef | null>(null);
  const escapes = signal(0);
  const moves = signal(0);
  const text = signal("");
  const vault = signal<ViewRef | null>(null);
  const interrupts = signal(0);
  const limit = signal<ViewRef | null>(null);
  let limited: InputRef | null = null;
  let field: InputRef | null = null;
  const clip = () =>
    limited?.replaceRange({
      start: 0,
      end: 2,
      text: "WXYZ",
      expectedText: "abcdef",
      expectedSelection: { start: 6, end: 6 },
    });
  effect(() => {
    const within = vault();
    if (within)
      return keymap.bind("ctrl+c", () => interrupts.set(interrupts() + 1), {
        when: "always",
        within,
        fallback: true,
      });
  });
  effect(() => {
    const within = limit();
    if (within) return keymap.bind("ctrl+g", clip, { when: "always", within });
  });
  const clear = () => {
    const end = text().length;
    field?.replaceRange({
      start: 0,
      end,
      text: "",
      expectedText: text(),
      expectedSelection: { start: end, end },
    });
  };
  effect(() => {
    const within = card();
    if (!within) return;
    const stops = [
      keymap.bind("ctrl+c", clear, { when: "always", within, fallback: true }),
      keymap.bind("ctrl+a", () => moves.set(moves() + 1), { when: "always", within, fallback: true }),
      keymap.bind("escape", () => escapes.set(escapes() + 1), { when: "always", within }),
    ];
    return () => stops.forEach((stop) => stop());
  });
  return <View style={{ flex: 1, paddingTop: 80 }}>
    <View ref={(node) => card.set(node)}>
      <Input
        testID="inside"
        ref={(node) => { field = node; }}
        style={{ height: 40 }}
        onChange={({ value }) => text.set(value)}
      />
    </View>
    <Input testID="outside" style={{ height: 40 }} />
    <View ref={(node) => vault.set(node)}>
      <Input testID="masked" masked style={{ height: 40 }} />
    </View>
    <View ref={(node) => limit.set(node)}>
      <Input
        testID="limited"
        maxLength={6}
        ref={(node) => { limited = node; }}
        style={{ height: 40 }}
      />
    </View>
    <Text>{`escapes: ${escapes()}, moves: ${moves()}`}</Text>
    <Text>{`interrupts: ${interrupts()}`}</Text>
  </View>;
}

mount(App);
