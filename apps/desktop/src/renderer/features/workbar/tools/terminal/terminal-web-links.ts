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

import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal } from '@xterm/xterm';

import { terminalWebUrl } from './terminal-interaction-policy';

/**
 * Wires clickable HTTP(S) links into an xterm instance. Renderer-side URL
 * filtering stays in terminalWebUrl; the main-process external-link guard
 * remains the final boundary behind window.open. Kept in the feature zone so
 * legacy terminals can adopt link handling without taking on new debt.
 */
export function loadTerminalWebLinks(terminal: Terminal) {
  const webLinks = new WebLinksAddon((event, value) => {
    const url = terminalWebUrl(value);
    if (!url) return;
    event.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
  });
  terminal.loadAddon(webLinks);
}
