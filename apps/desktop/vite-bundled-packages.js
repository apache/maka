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

// Records which npm packages the renderer bundle actually contains.
//
// The module graph sees direct and deep JS imports; the emitted assets carry
// the rest of the chain, which is how a package reached only through CSS
// (Fontsource, via its `.woff2` files) still lands here. What neither sees is
// a stylesheet that imports a package of pure rules: Vite inlines a CSS
// `@import` at transform time, so the imported file never becomes a module,
// and a package whose CSS emits no `url()` asset leaves no trace in this
// record. `validateFirstPartyCssImports` in the notice generator covers that
// case by reading the stylesheets themselves — stated here because the gap is
// invisible from this file, and the check that closes it lives elsewhere.
//
// The JSON ships inside `dist-renderer`, which lets the release verifier judge
// the packaged artifact by the artifact's own record.
export function bundledNpmPackagesPlugin() {
  return {
    name: 'maka-bundled-npm-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const packages = new Set();
      const collect = (id) => {
        // Virtual modules (\0-prefixed) are build-tool internals, not packages.
        if (typeof id !== 'string' || id.startsWith('\0')) return;
        // The last node_modules segment names the package that owns the file,
        // even for nested installs (node_modules/a/node_modules/b/...).
        const matches = [...id.matchAll(/[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)(?=[\\/])/g)];
        if (matches.length === 0) return;
        const name = matches[matches.length - 1][1].replaceAll('\\', '/');
        if (name === '.vite') return;
        packages.add(name);
      };
      for (const id of this.getModuleIds()) collect(id);
      // CSS `@import` chains are inlined by the CSS pipeline and never become
      // rollup modules, but the files they pull in (fonts, images) are emitted
      // as assets that remember their source paths — that is how a package
      // reachable only through CSS (Fontsource) still lands in this record.
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset') continue;
        for (const original of output.originalFileNames ?? []) collect(original);
      }
      this.emitFile({
        type: 'asset',
        fileName: 'bundled-npm-packages.json',
        source: `${JSON.stringify([...packages].sort(), null, 2)}\n`,
      });
    },
  };
}
