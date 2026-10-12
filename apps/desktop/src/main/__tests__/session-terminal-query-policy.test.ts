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

import assert from "node:assert/strict";
import test from "node:test";
import type { IDisposable, IParser } from "@xterm/xterm";
import {
  isColorQuery,
  isDeviceAttributesQuery,
  isDeviceStatusQuery,
  isWindowReportQuery,
  isXtVersionQuery,
  suppressTerminalQueryReplies,
} from "../../renderer/features/workbar/testing.js";

test("classifies terminal capability queries without swallowing setters", () => {
  for (const [params, expected] of [
    [[10, "?"], true], [[11, "?"], true], [[12, "?"], true],
    [[10, "?;?;?"], true], [[10, "?;#fff"], true],
    [[4, "0;?"], true], [[4, "0;?;15;?"], true], [[4, "0;?;1;#fff"], true],
    [[10, "rgb:0f0f/0f0f/1212"], false], [[11, "#ffffff"], false],
    [[4, "0;rgb:0000/0000/0000"], false], [[4, "256;?"], false],
    [[4, ""], false], [[3, "?"], false],
  ] as const) {
    assert.equal(isColorQuery(params[0], params[1]), expected);
  }

  assert.deepEqual(
    [0, 0].map((value, index, values) => isDeviceAttributesQuery(values.slice(0, index + 1))),
    [true, true],
  );
  assert.equal(isDeviceAttributesQuery([1, 0]), false);
  assert.equal(isDeviceStatusQuery([5]), true);
  assert.equal(isDeviceStatusQuery([5, 0]), true);
  assert.equal(isDeviceStatusQuery([6]), false);
  assert.equal(isDeviceStatusQuery([4, 0]), false);
  assert.equal(isXtVersionQuery([0]), true);
  assert.equal(isXtVersionQuery([0, 1]), true);
  assert.equal(isXtVersionQuery([1]), false);
});

test("recognizes only the window reports xterm should answer", () => {
  for (const operation of [11, 13, 14, 15, 16, 18, 19, 20, 21]) {
    assert.equal(isWindowReportQuery([operation]), true);
  }
  for (const params of [[14, 2], [8, 24, 80], [22, 0], [23, 0], [[14]]]) {
    assert.equal(isWindowReportQuery(params as never), false);
  }
});

interface ParserHarness {
  readonly registered: Array<{ kind: string; id: unknown; callback: unknown }>;
  readonly writes: string[];
  readonly disposed: { value: number };
  readonly terminal: { parser: IParser; write(data: string): void };
}

function parserHarness(): ParserHarness {
  const registered: ParserHarness["registered"] = [];
  const writes: string[] = [];
  const disposed = { value: 0 };
  const disposable = (): IDisposable => ({ dispose: () => { disposed.value += 1; } });
  const parser = {
    registerOscHandler(id: number, callback: unknown) {
      registered.push({ kind: "osc", id, callback });
      return disposable();
    },
    registerCsiHandler(id: unknown, callback: unknown) {
      registered.push({ kind: "csi", id, callback });
      return disposable();
    },
    registerDcsHandler(id: unknown, callback: unknown) {
      registered.push({ kind: "dcs", id, callback });
      return disposable();
    },
  } as unknown as IParser;
  return { registered, writes, disposed, terminal: { parser, write: (data) => writes.push(data) } };
}

function oscHandler(harness: ParserHarness, id: number): (data: string) => boolean {
  const callback = harness.registered.find((handler) => handler.kind === "osc" && handler.id === id)?.callback;
  assert.equal(typeof callback, "function");
  return callback as (data: string) => boolean;
}

test("replays setters while suppressing mixed OSC color queries", () => {
  const harness = parserHarness();
  const registration = suppressTerminalQueryReplies(harness.terminal);
  assert.equal(oscHandler(harness, 4)("0;?;1;#fff"), true);
  assert.deepEqual(harness.writes, ["\x1b]4;1;#fff\x1b\\"]);
  harness.writes.length = 0;
  assert.equal(oscHandler(harness, 10)("?;#fff"), true);
  assert.deepEqual(harness.writes, ["\x1b]11;#fff\x1b\\"]);
  harness.writes.length = 0;
  assert.equal(oscHandler(harness, 10)("#000;?;#fff"), true);
  assert.deepEqual(harness.writes, ["\x1b]10;#000\x1b\\", "\x1b]12;#fff\x1b\\"]);
  harness.writes.length = 0;
  assert.equal(oscHandler(harness, 4)("0;#000;1;#fff"), false);
  assert.deepEqual(harness.writes, []);
  registration.dispose();
});

test("registers the response handlers and leaves cursor reports to xterm", () => {
  const harness = parserHarness();
  const registration = suppressTerminalQueryReplies(harness.terminal);
  assert.equal(harness.registered.length, 12);
  assert.deepEqual(
    harness.registered.filter(({ kind }) => kind === "osc").map(({ id }) => id),
    [4, 10, 11, 12],
  );
  assert.equal(
    harness.registered.some(({ kind, id }) => kind === "csi" && JSON.stringify(id) === JSON.stringify({ final: "n" })),
    true,
  );
  const handlers = new Map<string, (params: (number | number[])[]) => boolean>();
  const parser = {
    registerOscHandler: () => ({ dispose() {} }),
    registerCsiHandler: (id: unknown, callback: (params: (number | number[])[]) => boolean) => {
      handlers.set(JSON.stringify(id), callback);
      return { dispose() {} };
    },
    registerDcsHandler: () => ({ dispose() {} }),
  } as unknown as IParser;
  const cursorRegistration = suppressTerminalQueryReplies({ parser, write() {} });
  assert.equal(handlers.get(JSON.stringify({ final: "n" }))?.([5]), true);
  assert.equal(handlers.get(JSON.stringify({ final: "n" }))?.([6]), false);
  assert.equal(handlers.get(JSON.stringify({ prefix: ">", final: "q" }))?.([0]), true);
  assert.equal(handlers.get(JSON.stringify({ prefix: ">", final: "q" }))?.([1]), false);
  cursorRegistration.dispose();
  registration.dispose();
  assert.equal(harness.disposed.value, harness.registered.length);
});
