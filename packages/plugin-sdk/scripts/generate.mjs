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

// Schemas and built-in contracts come from the actual Rust application ABI.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const mode = process.argv[2];
if (!['generate', 'check'].includes(mode) || process.argv.length !== 3)
  throw new Error('Usage: generate.mjs <generate|check>');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalog = JSON.parse(
  execFileSync('cargo', ['run', '--locked', '--quiet', '-p', 'maka-schema'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: Infinity,
  }),
);
const header = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').split(
  '\n\n',
  1,
)[0];
const banner =
  header +
  '\n\n// Generated from Rust runtime schemas. Run npm run schema:generate -w @maka-agent/plugin-sdk.\n';
// A $ref with annotation siblings makes the dereferencer clone its definition.
// Put annotations on an equivalent allOf wrapper so named Rust DTOs retain one
// TypeScript declaration, including their per-property documentation. Literal
// JSON data is never traversed as a schema.
function declarationSchema(value) {
  if (Array.isArray(value)) return value.map(declarationSchema);
  if (value === null || typeof value !== 'object') return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      ['default', 'const', 'enum', 'examples'].includes(key) ? child : declarationSchema(child),
    ]),
  );
  if (
    typeof result.$ref === 'string' &&
    Object.keys(result).length > 1 &&
    Object.keys(result).every((key) =>
      ['$ref', 'description', 'default', 'title', 'deprecated', '$comment', 'examples'].includes(
        key,
      ),
    )
  ) {
    const { $ref, ...annotations } = result;
    return { ...annotations, allOf: [{ $ref }] };
  }
  return result;
}
const outputs = new Map();
const typeOptions = {
  bannerComment: banner.trimEnd(),
  unknownAny: true,
  strictIndexSignatures: true,
  format: false,
};
const runtimeTypes = await compile(
  declarationSchema(catalog.schema),
  catalog.schema.title,
  typeOptions,
);
outputs.set(new URL('../src/generated/runtime.ts', import.meta.url), runtimeTypes);

// Types for the services used by the first-party client. These describe the
// original contracts, not endpoint aliases, live availability or authorization.
const runtimeNames = new Set(
  [...runtimeTypes.matchAll(/^export (?:type|interface|enum) (\w+)/gm)].map((match) => match[1]),
);
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, ordered(value[key])]),
        )
      : value;
const shape = (value) => {
  if (typeof value === 'boolean') return JSON.stringify(value);
  const { $schema, title, ...schema } = value;
  return JSON.stringify(ordered(schema));
};
const methodDefinitions = {};
function methodSchema(document, prefix) {
  if (typeof document === 'boolean') return document;
  const { $defs = {}, $schema, title, ...schema } = document;
  const canonical = (name, value) =>
    runtimeNames.has(name) &&
    catalog.schema.$defs[name] !== undefined &&
    shape(value) === shape(catalog.schema.$defs[name]);
  // A matching root alone is insufficient: its references must mean the same
  // types in both documents, including recursive definitions.
  const shared = Object.entries($defs).every(([name, value]) => canonical(name, value));
  if (shared && canonical(title, schema)) return { tsType: `Runtime.${title}` };
  const relocate = (value) => {
    if (Array.isArray(value)) return value.map(relocate);
    if (value === null || typeof value !== 'object') return value;
    if (
      shared &&
      Object.keys(value).length === 1 &&
      typeof value.$ref === 'string' &&
      value.$ref.startsWith('#/$defs/')
    ) {
      const name = value.$ref.slice('#/$defs/'.length);
      if (Object.hasOwn($defs, name)) return { tsType: `Runtime.${name}` };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === '$ref' && typeof child === 'string'
          ? child.replace(/^#\/\$defs\//, `#/$defs/${prefix}`)
          : ['default', 'const', 'enum', 'examples'].includes(key)
            ? child
            : relocate(child),
      ]),
    );
  };
  for (const [name, value] of Object.entries($defs)) {
    methodDefinitions[`${prefix}${name}`] = shared
      ? { tsType: `Runtime.${name}` }
      : relocate(value);
  }
  return relocate(schema);
}
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const services = Object.fromEntries(
  [
    'agent',
    'settings',
    'settingsAuthentication',
    'settingsSetup',
    'deploymentManager',
    'terminal',
    'skillLibrary',
  ].map((service) => [
    service,
    object(
      Object.fromEntries(
        Object.entries(catalog.contracts[service].interface.methods).map(([name, method]) => [
          name,
          object({
            mode: { const: method.mode },
            input: methodSchema(method.input, `${service}_${name}_input_`),
            output: methodSchema(method.output, `${service}_${name}_output_`),
          }),
        ]),
      ),
    ),
  ]),
);
outputs.set(
  new URL('../src/generated/methods.ts', import.meta.url),
  banner +
    "import type * as Runtime from './runtime.js';\n\n" +
    (await compile(
      declarationSchema({ ...object(services), $defs: methodDefinitions }),
      'ServiceMethods',
      { ...typeOptions, bannerComment: '' },
    )),
);
outputs.set(
  new URL('../src/contracts.ts', import.meta.url),
  banner +
    "import type { Contract } from './generated/runtime.js';\n\n" +
    'export const contracts = ' +
    JSON.stringify(catalog.contracts, null, 2) +
    ' satisfies Record<string, Contract>;\n',
);
outputs.set(
  new URL('../src/configurations.ts', import.meta.url),
  banner +
    'export const configurations = ' +
    JSON.stringify(catalog.configurations, null, 2) +
    ' as const;\n',
);
function reference(value, values, prefix) {
  const encoded = JSON.stringify(value);
  const match = Object.entries(values).find(
    ([, candidate]) => JSON.stringify(candidate) === encoded,
  );
  return match ? `${prefix}.${match[0]}` : encoded;
}
function referenceType(value, values, prefix) {
  const source = reference(value, values, prefix);
  return source.startsWith(`${prefix}.`) ? `typeof ${source}` : source;
}
const definitions = Object.entries(catalog.native).map(
  ([name, definition]) =>
    `${JSON.stringify(name)}: { implementation: ${JSON.stringify(definition.implementation)}, ` +
    `configuration: ${reference(definition.configuration, catalog.configurations, 'configurations')}, ` +
    `exports: { ${Object.entries(definition.exports)
      .map(
        ([name, contract]) =>
          `${JSON.stringify(name)}: ${reference(contract, catalog.contracts, 'contracts')}`,
      )
      .join(', ')} } }`,
);
const definitionTypes = Object.entries(catalog.native).map(
  ([name, definition]) =>
    `${JSON.stringify(name)}: { implementation: string; ` +
    `configuration: ${referenceType(definition.configuration, catalog.configurations, 'configurations')}; ` +
    `exports: { ${Object.entries(definition.exports)
      .map(
        ([name, contract]) =>
          `${JSON.stringify(name)}: ${referenceType(contract, catalog.contracts, 'contracts')}`,
      )
      .join('; ')} } }`,
);
outputs.set(
  new URL('../src/native.ts', import.meta.url),
  banner +
    "import { contracts } from './contracts.js';\nimport { configurations } from './configurations.js';\n\n" +
    'export const nativeImplementations = /* @__PURE__ */ ((): {\n' +
    definitionTypes.join(';\n') +
    '\n} => ({\n' +
    definitions.join(',\n') +
    '\n}))();\n',
);
for (const [url, source] of outputs) {
  const content = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../../node_modules/@biomejs/biome/bin/biome', import.meta.url)),
      'format',
      '--stdin-file-path',
      fileURLToPath(url),
    ],
    { cwd: root, input: source, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  if (mode === 'generate') {
    mkdirSync(new URL('./', url), { recursive: true });
    writeFileSync(url, content);
  } else if (readFileSync(url, 'utf8') !== content) {
    throw new Error(`Runtime declarations are stale: ${fileURLToPath(url)}`);
  }
}
console.log(
  `${outputs.size} runtime declaration files ${mode === 'check' ? 'verified' : 'generated'}`,
);
