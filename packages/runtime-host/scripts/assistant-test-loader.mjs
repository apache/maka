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

import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Resolve source-level .js specifiers exactly as TypeScript does in the production build.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
        const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
        if (existsSync(fileURLToPath(url))) return { url, shortCircuit: true };
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts'))
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
          mode: 'transform',
          sourceUrl: url,
        }),
        shortCircuit: true,
      };
    return next(url, context);
  },
});
