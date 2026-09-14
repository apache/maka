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

/**
 * Shared address constants for the `maka-web` bridge.
 *
 * The port is FIXED (not ephemeral) on purpose: the renderer's entry CSP
 * pins `connect-src 'self'`, so browsers cannot dial a loopback port
 * directly. Instead the vite dev server proxies same-origin `/bridge` to
 * this port over WebSocket — and a static proxy needs a static target.
 * A second Maka profile that finds the port busy disables its bridge with a
 * warning (last-writer-wins would silently steal the first profile's
 * clients); the browser then falls back to the picker tier.
 */

export const WEB_BRIDGE_PORT = 53217;
export const WEB_BRIDGE_PATH = '/bridge';
export const WEB_BRIDGE_HOST = '127.0.0.1';
