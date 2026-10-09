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

// The Maka modules the sidecar runs, imported from a built Maka checkout: the
// checkout the client launches its Runtime Host from ($MAKA_REPO, default
// ~/code/maka-pin). Nothing here is copied from Maka. Each module resolves
// through the checkout's own workspace links, so its dependencies are the
// ones Maka Desktop runs with.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** A module the checkout does not provide (not built, or a different layout). */
export class MakaCheckoutError extends Error {
  constructor(checkout, specifier, cause) {
    super(`${specifier} is not built in the Maka checkout at ${checkout}`, { cause });
    this.name = 'MakaCheckoutError';
  }
}

/**
 * Imports everything the sidecar needs from `checkout`:
 *
 * - `@maka/runtime/bots`: the platform bridges and `BotRegistry` Desktop runs
 *   in its main process;
 * - `@maka/core/bot-events`, `@maka/core/bot-chat-settings`,
 *   `@maka/core/redaction`: the helpers `bot-incoming-main.ts` and the
 *   settings store use;
 * - `@maka/runtime-host/client`, `/protocol`, `/adapter`: the Host client;
 * - `undici`, from `@maka/runtime`'s own dependencies: the HTTP client the
 *   bridges fetch with (`proxied-fetch.ts`), for `telegram-api.mjs`;
 * - `productVersion`, Maka Desktop's version in the checkout, which the
 *   Feishu onboarding sends as Desktop sends its own.
 */
export async function loadMaka(checkout) {
  const fromRoot = createRequire(path.join(checkout, 'package.json'));
  const fromRuntime = createRequire(path.join(checkout, 'packages', 'runtime', 'package.json'));
  const load = async (require, specifier) => {
    let resolved;
    try {
      resolved = require.resolve(specifier);
    } catch (error) {
      throw new MakaCheckoutError(checkout, specifier, error);
    }
    return import(pathToFileURL(resolved).href);
  };
  const [bots, botEvents, botChatSettings, redaction, client, protocol, adapter, undici] =
    await Promise.all([
      load(fromRoot, '@maka/runtime/bots'),
      load(fromRoot, '@maka/core/bot-events'),
      load(fromRoot, '@maka/core/bot-chat-settings'),
      load(fromRoot, '@maka/core/redaction'),
      load(fromRoot, '@maka/runtime-host/client'),
      load(fromRoot, '@maka/runtime-host/protocol'),
      load(fromRoot, '@maka/runtime-host/adapter'),
      load(fromRuntime, 'undici'),
    ]);
  const productVersion = await readFile(path.join(checkout, 'apps', 'desktop', 'package.json'), 'utf8')
    .then((text) => JSON.parse(text).version)
    .catch(() => undefined);
  return {
    bots,
    botEvents,
    botChatSettings,
    redaction,
    client,
    protocol,
    adapter,
    // A CommonJS package: its exports arrive as the default export.
    undici: undici.default ?? undici,
    productVersion: typeof productVersion === 'string' ? productVersion : undefined,
  };
}
