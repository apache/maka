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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';

export const EXTENSION_PACKAGE_MANIFEST_FILE = 'maka.extension.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export type ExtensionConfigurationScalar = string | number | boolean;

export interface ExtensionPackageDependency {
  readonly id: string;
}

export interface ExtensionConfigurationProperty {
  readonly type: 'string' | 'number' | 'boolean';
  readonly title?: string;
  readonly description?: string;
  readonly default?: ExtensionConfigurationScalar;
  readonly enum?: readonly ExtensionConfigurationScalar[];
}

export interface ExtensionConfigurationSchema {
  readonly properties: Readonly<Record<string, ExtensionConfigurationProperty>>;
  readonly required: readonly string[];
}

export interface ExtensionPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly dependencies: readonly ExtensionPackageDependency[];
  readonly configuration: ExtensionConfigurationSchema;
  readonly runtime?: ExtensionPackageRuntime;
  readonly composition?: ExtensionPackageComposition;
}

export interface ExtensionPackageRuntime {
  readonly entry: string;
}

export interface ExtensionPackageComposition {
  readonly patch: string;
  readonly structuralDependencies: readonly string[];
}

export class ExtensionPackageManifestError extends Error {
  readonly name = 'ExtensionPackageManifestError';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export async function loadExtensionPackageManifest(
  root: string,
): Promise<ExtensionPackageManifest | undefined> {
  let encoded: Buffer;
  try {
    encoded = await readFile(join(root, EXTENSION_PACKAGE_MANIFEST_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid('Unable to read unified Extension manifest', error);
  }
  if (encoded.byteLength > MAX_MANIFEST_BYTES) {
    throw invalid('Unified Extension manifest exceeds its size limit');
  }
  try {
    return decodeExtensionPackageManifest(JSON.parse(encoded.toString('utf8')));
  } catch (error) {
    if (error instanceof ExtensionPackageManifestError) throw error;
    throw invalid('Unified Extension manifest is invalid JSON', error);
  }
}

export function decodeExtensionPackageManifest(value: unknown): ExtensionPackageManifest {
  const source = record(value, 'Extension manifest');
  exactOptional(
    source,
    ['schemaVersion', 'id'],
    ['displayName', 'description', 'dependencies', 'configuration', 'runtime', 'composition'],
  );
  if (source.schemaVersion !== 1) throw invalid('Extension manifest schemaVersion must be 1');
  const id = extensionId(source.id);
  const displayName =
    source.displayName === undefined ? id : text(source.displayName, 'displayName', 128);
  const description =
    source.description === undefined ? '' : boundedDescription(source.description);
  const dependencies = decodeDependencies(source.dependencies);
  const configuration = decodeConfigurationSchema(source.configuration);
  const runtime = decodeRuntime(source.runtime);
  const composition = decodeComposition(source.composition);
  return Object.freeze({
    schemaVersion: 1,
    id,
    displayName,
    description,
    dependencies,
    configuration,
    ...(runtime === undefined ? {} : { runtime }),
    ...(composition === undefined ? {} : { composition }),
  });
}

function decodeComposition(value: unknown): ExtensionPackageComposition | undefined {
  if (value === undefined) return undefined;
  const composition = record(value, 'composition');
  exactOptional(composition, ['patch'], ['structuralDependencies']);
  const structuralDependencies = decodeExtensionIds(
    composition.structuralDependencies,
    'composition.structuralDependencies',
  );
  return Object.freeze({
    patch: packagePath(composition.patch, 'composition.patch'),
    structuralDependencies,
  });
}

function decodeRuntime(value: unknown): ExtensionPackageRuntime | undefined {
  if (value === undefined) return undefined;
  const runtime = record(value, 'runtime');
  if (runtime.entry === undefined) return undefined;
  return Object.freeze({ entry: packagePath(runtime.entry, 'runtime.entry') });
}

function packagePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw invalid(`Extension manifest ${label} is invalid`);
  }
  return value;
}

export function validateExtensionConfiguration(
  schema: ExtensionConfigurationSchema,
  value: unknown,
): Readonly<Record<string, ExtensionConfigurationScalar>> {
  const input = value === undefined ? {} : record(value, 'Extension configuration');
  const unknown = Object.keys(input).find((key) => !Object.hasOwn(schema.properties, key));
  if (unknown) throw invalid(`Extension configuration key is not declared: ${unknown}`);
  const result: Record<string, ExtensionConfigurationScalar> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const configured = Object.hasOwn(input, key) ? input[key] : property.default;
    if (configured === undefined) {
      if (schema.required.includes(key)) {
        throw invalid(`Extension configuration is missing required key: ${key}`);
      }
      continue;
    }
    if (typeof configured !== property.type || !isScalar(configured)) {
      throw invalid(`Extension configuration type is invalid for key: ${key}`);
    }
    if (property.enum && !property.enum.some((candidate) => candidate === configured)) {
      throw invalid(`Extension configuration value is not allowed for key: ${key}`);
    }
    result[key] = configured;
  }
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) {
    throw invalid('Extension configuration exceeds its size limit');
  }
  return Object.freeze(result);
}

function decodeDependencies(value: unknown): readonly ExtensionPackageDependency[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64)
    throw invalid('Extension dependencies are invalid');
  const ids = new Set<string>();
  const dependencies = value.map((item, index) => {
    const dependency = record(item, `dependencies[${index}]`);
    exactOptional(dependency, ['id'], []);
    const id = extensionId(dependency.id);
    if (ids.has(id)) throw invalid(`Extension dependency repeats: ${id}`);
    ids.add(id);
    return Object.freeze({ id });
  });
  return Object.freeze(dependencies.sort((left, right) => left.id.localeCompare(right.id)));
}

function decodeExtensionIds(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) throw invalid(`${label} is invalid`);
  const ids = value.map((item) => extensionId(item));
  if (new Set(ids).size !== ids.length) throw invalid(`${label} repeats an identity`);
  return Object.freeze(ids.sort((left, right) => left.localeCompare(right)));
}

function decodeConfigurationSchema(value: unknown): ExtensionConfigurationSchema {
  if (value === undefined)
    return Object.freeze({ properties: Object.freeze({}), required: Object.freeze([]) });
  const schema = record(value, 'configuration');
  exactOptional(schema, ['properties'], ['required']);
  const propertiesSource = record(schema.properties, 'configuration properties');
  if (Object.keys(propertiesSource).length > 128)
    throw invalid('Too many Extension configuration properties');
  const properties: Record<string, ExtensionConfigurationProperty> = {};
  for (const [key, value] of Object.entries(propertiesSource)) {
    if (!KEY_PATTERN.test(key)) throw invalid(`Extension configuration key is invalid: ${key}`);
    const property = record(value, `configuration.properties.${key}`);
    exactOptional(property, ['type'], ['title', 'description', 'default', 'enum']);
    if (property.type !== 'string' && property.type !== 'number' && property.type !== 'boolean') {
      throw invalid(`Extension configuration property type is invalid: ${key}`);
    }
    const type = property.type;
    const defaultValue = property.default;
    if (defaultValue !== undefined && (typeof defaultValue !== type || !isScalar(defaultValue))) {
      throw invalid(`Extension configuration default is invalid: ${key}`);
    }
    let values: readonly ExtensionConfigurationScalar[] | undefined;
    if (property.enum !== undefined) {
      if (
        !Array.isArray(property.enum) ||
        property.enum.length === 0 ||
        property.enum.length > 64 ||
        property.enum.some((item) => typeof item !== type || !isScalar(item))
      )
        throw invalid(`Extension configuration enum is invalid: ${key}`);
      values = Object.freeze([...new Set(property.enum as ExtensionConfigurationScalar[])]);
      if (
        defaultValue !== undefined &&
        !values.includes(defaultValue as ExtensionConfigurationScalar)
      ) {
        throw invalid(`Extension configuration default is outside enum: ${key}`);
      }
    }
    properties[key] = Object.freeze({
      type,
      ...(property.title === undefined
        ? {}
        : { title: text(property.title, 'configuration title', 128) }),
      ...(property.description === undefined
        ? {}
        : { description: text(property.description, 'configuration description', 1024) }),
      ...(defaultValue === undefined
        ? {}
        : { default: defaultValue as ExtensionConfigurationScalar }),
      ...(values ? { enum: values } : {}),
    });
  }
  const required = schema.required === undefined ? [] : schema.required;
  if (
    !Array.isArray(required) ||
    required.length > Object.keys(properties).length ||
    required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key)) ||
    new Set(required).size !== required.length
  )
    throw invalid('Extension configuration required keys are invalid');
  return Object.freeze({
    properties: Object.freeze(properties),
    required: Object.freeze(required as string[]),
  });
}

function exactOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalid('Extension manifest fields are invalid');
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function extensionId(value: unknown): string {
  if (!isCanonicalExtensionId(value)) throw invalid('Extension manifest id is invalid');
  return value;
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    throw invalid(`Extension manifest ${label} is invalid`);
  }
  return value;
}

function boundedDescription(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    value.includes('\0')
  ) {
    throw invalid('Extension manifest description is invalid');
  }
  return value;
}

function isScalar(value: unknown): value is ExtensionConfigurationScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function invalid(message: string, cause?: unknown): ExtensionPackageManifestError {
  return new ExtensionPackageManifestError(message, { cause });
}
