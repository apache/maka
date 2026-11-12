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

import { registerHooks } from 'node:module';
import { transformSync } from 'esbuild';
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
        // Not node:module stripTypeScriptTypes: its 'transform' mode (needed for
        // parameter properties, which the sources use) was removed in Node 26.
        // Match the production build's ES2022 target and class-field semantics.
        source: transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
          loader: 'ts',
          format: 'esm',
          target: 'es2022',
          sourcefile: fileURLToPath(url),
          sourcemap: 'inline',
          tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } },
        }).code,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
