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

import { expect, open, test } from "nsh/test";

test("a binding within a node fires while the focus is inside it", async () => {
  const app = await open("./app.tsx");
  await app.type("id:outside", "x");
  await app.keyboard.press("escape");
  await app.waitFor("text:escapes: 0, moves: 0");
  await app.type("id:inside", "y");
  await app.keyboard.press("escape");
  await app.waitFor("text:escapes: 1, moves: 0");
});

test("a fallback binding fires on the keys the field leaves, and edits it", async () => {
  const app = await open("./app.tsx");
  await app.type("id:outside", "kept");
  await app.keyboard.press("ctrl+c");
  await app.wait(100);
  expect(app.value("id:outside")).toBe("kept");
  await app.type("id:inside", "draft");
  await app.keyboard.press("ctrl+c");
  await app.wait(100);
  expect(app.value("id:inside")).toBe("");
  await app.type("id:inside", "again");
  await app.keyboard.press("ctrl+a");
  await app.wait(100);
  await app.waitFor("text:escapes: 0, moves: 0");
});

test("a fallback binding fires in a masked field", async () => {
  const app = await open("./app.tsx");
  await app.type("id:masked", "secret");
  await app.keyboard.press("ctrl+c");
  await app.waitFor("text:interrupts: 1");
});

test("a replacement clipped to maxLength leaves the caret after what it inserted", async () => {
  const app = await open("./app.tsx");
  await app.type("id:limited", "abcdef");
  await app.keyboard.press("ctrl+g");
  await app.wait(100);
  expect(app.value("id:limited")).toBe("WXcdef");
  await app.keyboard.press("backspace");
  await app.wait(100);
  expect(app.value("id:limited")).toBe("Wcdef");
});
