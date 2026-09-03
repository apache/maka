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

import { createServer } from "node:http";
import {
  test,
  expect,
  COMPOSER_INPUT,
  ensureSidebarExpanded,
} from "./fixtures";

test("proxy password drafts save once, reload safely, and authenticate offline", async ({
  window: page,
}) => {
  const username = "proxy-user";
  const password = "complete-secret";
  const replacementPassword = "replacement-secret";
  let acceptAuthorization!: (value: string | undefined) => void;
  const authorization = new Promise<string | undefined>((resolve) => {
    acceptAuthorization = resolve;
  });
  const proxy = createServer((request, response) => {
    acceptAuthorization(request.headers["proxy-authorization"]);
    response.writeHead(200, { "content-length": "0", connection: "close" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("Local proxy did not expose a TCP port");
  }

  try {
    await ensureSidebarExpanded(page);
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("button", { name: "通用", exact: true }).click();
    await page.getByRole("switch", { name: "启用代理服务器" }).click();
    await page.getByRole("textbox", { name: "服务器地址" }).fill("127.0.0.1");
    await page.getByRole("spinbutton", { name: "端口" }).fill(String(address.port));
    await page.getByRole("switch", { name: "启用代理认证" }).click();
    await page.getByRole("textbox", { name: "用户名" }).fill(username);

    const passwordInput = page.getByRole("textbox", {
      name: "密码 凭据值",
      exact: true,
    });
    await passwordInput.pressSequentially(password);
    await expect(passwordInput).toHaveValue(password);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.maka.settings.get()).network.proxy.passwordConfigured,
        ),
      )
      .toBe(false);

    const eye = page.getByRole("button", { name: /显示|隐藏/ });
    await eye.click();
    await expect(passwordInput).toHaveAttribute("type", "text");
    await expect(passwordInput).toHaveValue(password);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.maka.settings.get()).network.proxy.passwordConfigured,
        ),
      )
      .toBe(false);

    await passwordInput.focus();
    await page.keyboard.press("Tab");
    await expect(eye).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.maka.settings.get()).network.proxy.passwordConfigured,
        ),
      )
      .toBe(false);

    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.maka.settings.get()).network.proxy.passwordConfigured,
        ),
      )
      .toBe(true);

    await page.reload();
    await page.waitForSelector(COMPOSER_INPUT);
    await ensureSidebarExpanded(page);
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("button", { name: "通用", exact: true }).click();
    const reloadedPassword = page.getByPlaceholder(
      "密码已保存；输入新密码以替换",
    );
    await expect(reloadedPassword).toHaveValue("");
    await expect(page.getByRole("button", { name: "复制" })).toHaveCount(0);

    await reloadedPassword.pressSequentially("discarded-draft");
    await expect(reloadedPassword).toHaveValue("discarded-draft");
    await reloadedPassword.press("Escape");
    await expect(reloadedPassword).toBeVisible();
    await expect(reloadedPassword).toHaveValue("");

    await reloadedPassword.pressSequentially(replacementPassword);
    await eye.click();
    await expect(reloadedPassword).toHaveAttribute("type", "text");
    await expect(reloadedPassword).toHaveValue(replacementPassword);
    await reloadedPassword.focus();
    await reloadedPassword.press("Enter");
    await expect(reloadedPassword).toHaveValue("");

    await page.reload();
    await page.waitForSelector(COMPOSER_INPUT);
    await ensureSidebarExpanded(page);
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("button", { name: "通用", exact: true }).click();
    await expect(
      page.getByPlaceholder("密码已保存；输入新密码以替换"),
    ).toHaveValue("");

    const tested = await page.evaluate(() =>
      window.maka.settings.testNetworkProxy({ url: "http://example.com" }),
    );
    expect(tested.ok).toBe(true);
    expect(await authorization).toBe(
      `Basic ${Buffer.from(`${username}:${replacementPassword}`).toString("base64")}`,
    );
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
