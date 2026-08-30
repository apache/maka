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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRendererEntryHtml } from './vite-renderer-entry-contract.ts';

export function checkRendererEntryOutput(desktopRoot = resolve(import.meta.dirname, '..')) {
  const outputRoot = resolve(desktopRoot, 'dist-renderer');
  const attestation = JSON.parse(
    readFileSync(resolve(outputRoot, 'renderer-entry-attestation.json'), 'utf8'),
  );
  if (
    attestation?.htmlFile !== 'index.html' ||
    attestation?.sourceFile !== 'src/renderer/main.tsx' ||
    typeof attestation?.entryFile !== 'string' ||
    !/^assets\/[a-z0-9._-]+\.js$/iu.test(attestation.entryFile)
  ) {
    throw new Error('renderer entry build attestation is invalid');
  }
  const html = readFileSync(resolve(outputRoot, attestation.htmlFile), 'utf8');
  assertRendererEntryHtml(html, `./${attestation.entryFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkRendererEntryOutput();
    console.log('Renderer entry output check passed.');
  } catch (error) {
    console.error(
      `Renderer entry output check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
