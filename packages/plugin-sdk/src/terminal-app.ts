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

/** Separate UI factories use pure builders; business callbacks retain Host authority. */
import type { Awaitable, Cancellation, Json, RemoteCaller } from './host.js';
import type { TranscriptResource } from './terminal-transcript.js';
import type {
  TerminalBuilders,
  TerminalReply,
  TerminalRequest,
  TerminalViewTree,
} from './terminal-view.js';

export interface TerminalLocale {
  readonly locale: string;
  /** Picks English, Simplified Chinese, or Traditional Chinese text. */
  t(en: string, zhCN?: string, zhTW?: string): string;
}
/** Available only to the original business activation's private callback. */
export interface TerminalBackendContext extends TerminalLocale {
  readonly caller: RemoteCaller;
}
/** One UI invocation. backend() forwards its exact original request at most once. */
export interface TerminalContext<Result = Json> extends TerminalLocale {
  readonly signal: Cancellation;
  backend(): Promise<Result>;
}
export interface TerminalSubmission {
  readonly route: Json;
  readonly revision: string;
  readonly action: string;
  readonly fields: Readonly<Record<string, boolean | string>>;
  readonly grant: string | null;
}
/** A view without its version; the SDK adds the one it speaks. */
export type TerminalViewBody = Omit<TerminalViewTree, 'version'> & { version?: 7 };
export interface TerminalAppHandlers<Model = Json> {
  read(route: Json, cx: TerminalContext<Model>): Awaitable<TerminalViewBody>;
  submit(
    submission: TerminalSubmission,
    cx: TerminalContext<TerminalReply>,
  ): Awaitable<TerminalReply>;
  /** Only needed when actions declare recovery routes. */
  recover?(route: Json, cx: TerminalContext<TerminalReply>): Awaitable<TerminalReply>;
}
/** Default export of an immutable, prebuilt UI entry; initialized once per document. */
export type TerminalPageFactory<Model = Json> = (
  context: Readonly<{ tui: TerminalBuilders }>,
) => Awaitable<TerminalAppHandlers<Model>>;
export interface TerminalAppRegistration<Model = Json> {
  /** Safe relative path to a bundled ESM default page factory in this package. */
  entry: string;
  /** Private callback; receives the exact original request and Remote caller. */
  backend(request: TerminalRequest, cx: TerminalBackendContext): Awaitable<Model | TerminalReply>;
  /** The exact transcript sources this app may observe. Producers stay in business activation. */
  resources?: readonly TranscriptResource[];
}
