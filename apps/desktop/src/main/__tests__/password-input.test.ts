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
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { build } from "esbuild";
import type { WebContents } from "electron";
import { WorkHubSurface } from "../workhub-surface.js";
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from "@maka/ui";
import type * as PasswordInputModule from "../../renderer/settings/password-input.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  Event: globalThis.Event,
  IS_REACT_ACT_ENVIRONMENT: (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test("mouse focus moving from the password draft to Eye does not commit and Eye reveals it", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;
  const show = harness.document.querySelector(
    'button[aria-label="Show"]',
  ) as HTMLButtonElement;
  assert.ok(input);
  assert.ok(show);

  harness.focusExit(input, show);
  assert.equal(harness.exits, 0);
  await act(async () => show.click());
  assert.equal(input.type, "text");
  assert.equal(input.value, "complete-secret");
});

test("assistant observations exclude credentials and their controls before and after reveal", async (t) => {
  const { document } = await renderPasswordInputs();
  t.mock.method(HTMLElement.prototype, "getBoundingClientRect", () => ({
    x: 10,
    y: 10,
    top: 10,
    left: 10,
    right: 210,
    bottom: 50,
    width: 200,
    height: 40,
  }));
  const wc = {
    executeJavaScript: async (script: string) =>
      new Function(
        "document",
        "getComputedStyle",
        "innerHeight",
        "innerWidth",
        `return ${script}`,
      )(document, () => ({ visibility: "visible", opacity: "1" }), 720, 1158),
  } as unknown as WebContents;
  const surface = new WorkHubSurface();
  const inputs = [...document.querySelectorAll("input")];
  const showButtons = [
    ...document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Show"]',
    ),
  ];
  for (const reveal of [false, true]) {
    if (reveal)
      await act(async () => {
        for (const button of showButtons) button.click();
      });
    assert.ok(
      inputs.every((input) => input.type === (reveal ? "text" : "password")),
    );
    await surface.prepare(wc);
    const nodes: {
      nodeId: string;
      backendDOMNodeId: number;
      role: { value: string };
      name: { value: string };
      value: { value: string };
    }[] = [];
    const dom = (element: Element): Parameters<WorkHubSurface["filter"]>[0] => {
      const id = nodes.length + 1;
      nodes.push({
        nodeId: String(id),
        backendDOMNodeId: id,
        role: { value: element.tagName === "INPUT" ? "textbox" : "button" },
        name: {
          value:
            element.getAttribute("aria-label") ?? element.textContent ?? "",
        },
        value: { value: (element as HTMLInputElement).value ?? "" },
      });
      return {
        nodeName: element.tagName,
        backendNodeId: id,
        attributes: [...element.attributes].flatMap(({ name, value }) => [
          name,
          value,
        ]),
        children: [...element.children].map(dom),
      };
    };
    const root = {
      nodeName: "HTML",
      backendNodeId: 0,
      children: [...document.children].map(dom),
    };
    const observation = surface.filter(root, { nodes });
    assert.ok(
      inputs.every((input) => !input.hasAttribute("data-maka-assistant-ref")),
    );
    assert.equal(JSON.stringify(observation).includes("secret"), false);
    assert.deepEqual(
      surface.list().map(({ name }) => name),
      ["outside"],
    );
  }
});

test("keyboard focus stays inside through Eye and commits once when Tab leaves the group", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;
  const show = harness.document.querySelector(
    'button[aria-label="Show"]',
  ) as HTMLButtonElement;
  const outside = harness.document.querySelector(
    "#outside",
  ) as HTMLButtonElement;

  harness.focusExit(input, show);
  assert.equal(harness.exits, 0);
  harness.focusExit(show, outside);
  assert.equal(harness.exits, 1);
});

test("window blur does not commit a partially typed password draft", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;

  harness.setDocumentFocused(false);
  harness.focusExit(input, null);

  assert.equal(harness.exits, 0);
});

test("focus exit with no destination still commits while the document is focused", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;

  harness.setDocumentFocused(true);
  harness.focusExit(input, null);

  assert.equal(harness.exits, 1);
});

test("proxy password can hide Copy while ordinary password inputs keep it by default", async () => {
  const harness = await renderPasswordInputs();
  const copyButtons = harness.document.querySelectorAll(
    'button[aria-label="Copy"]',
  );

  assert.equal(copyButtons.length, 1);
});

test("IME confirmation keys do not submit or cancel the password draft", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;
  const onKeyDown = reactProps(input).onKeyDown as (event: {
    key: string;
    nativeEvent: { isComposing?: boolean };
  }) => void;

  onKeyDown({ key: "Enter", nativeEvent: { isComposing: true } });
  onKeyDown({ key: "Escape", nativeEvent: { isComposing: true } });
  onKeyDown({ key: "Process", nativeEvent: {} });

  assert.deepEqual(harness.keyEvents, { enters: 0, keys: [] });
});

test("non-composing Enter submits once and remains observable by the caller", async () => {
  const harness = await renderPasswordInputs();
  const input = harness.document.querySelector("input") as HTMLInputElement;
  const onKeyDown = reactProps(input).onKeyDown as (event: {
    key: string;
    nativeEvent: { isComposing?: boolean };
  }) => void;

  onKeyDown({ key: "Enter", nativeEvent: { isComposing: false } });

  assert.deepEqual(harness.keyEvents, { enters: 1, keys: ["Enter"] });
});

async function renderPasswordInputs(): Promise<{
  document: Document;
  readonly exits: number;
  readonly keyEvents: { enters: number; keys: string[] };
  focusExit(from: Element, to: Element | null): void;
  setDocumentFocused(focused: boolean): void;
}> {
  const { PasswordInput } = await importPasswordInput();
  const { document, window } = parseHTML(
    '<div id="root"></div><button id="outside">outside</button>',
  );
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  let exits = 0;
  let enters = 0;
  let documentFocused = true;
  const keys: string[] = [];
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => documentFocused,
  });
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: "en",
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(
              "div",
              {},
              createElement(PasswordInput, {
                value: "complete-secret",
                onChange() {},
                onFocusExit: () => {
                  exits += 1;
                },
                onEnter: () => {
                  enters += 1;
                },
                onKeyDown: (event) => {
                  keys.push(event.key);
                },
                hasCopyAction: false,
                label: "Proxy password",
              }),
              createElement(PasswordInput, {
                value: "ordinary-secret",
                onChange() {},
                label: "Ordinary password",
              }),
            ),
          }),
        }),
      }),
    );
  });

  const group = [...container.querySelectorAll("*")].find((element) => {
    const props = reactProps(element);
    return typeof props.onBlurCapture === "function";
  });
  assert.ok(group, "missing InputGroup focus boundary");
  return {
    document: document as unknown as Document,
    get exits() {
      return exits;
    },
    get keyEvents() {
      return { enters, keys: [...keys] };
    },
    focusExit(_from, to) {
      const handler = reactProps(group).onBlurCapture as (event: {
        currentTarget: Element;
        relatedTarget: Element | null;
      }) => void;
      handler({ currentTarget: group, relatedTarget: to });
    },
    setDocumentFocused(focused) {
      documentFocused = focused;
    },
  };
}

async function importPasswordInput(): Promise<typeof PasswordInputModule> {
  const outdir = await mkdtemp(
    resolve(REPO_ROOT, "apps/desktop/dist/main/__tests__/password-input-"),
  );
  const outfile = resolve(outdir, "password-input.mjs");
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [
      resolve(
        REPO_ROOT,
        "apps/desktop/src/renderer/settings/password-input.tsx",
      ),
    ],
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    jsx: "automatic",
    target: "node20",
    logLevel: "silent",
  });
  return (await import(
    `${pathToFileURL(outfile).href}?t=${Date.now()}`
  )) as typeof PasswordInputModule;
}

function reactProps(element: Element): Record<string, unknown> {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  return key
    ? ((element as unknown as Record<string, unknown>)[key] as Record<
        string,
        unknown
      >)
    : {};
}
