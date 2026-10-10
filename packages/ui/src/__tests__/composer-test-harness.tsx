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
import type { ComponentProps } from "react";
import { act } from "react";
import { Composer } from "../composer.js";
import { LocaleProvider } from "../locale-context.js";
import { installDom } from "./mermaid-test-dom.js";

export async function mountComposer(props: ComponentProps<typeof Composer>) {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const container = dom.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  await act(() => root.render(
    <LocaleProvider locale="en">
      <Composer {...props} />
    </LocaleProvider>,
  ));

  return {
    container,
    async submit() {
      const form = container.querySelector("form");
      assert.ok(form);
      await act(async () => {
        form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
    },
    async unmount() {
      await act(() => root.unmount());
      dom.restore();
    },
  };
}
