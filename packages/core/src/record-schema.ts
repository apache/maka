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

type IsOptionalInAnyMember<T extends object, K extends keyof T> = T extends unknown
  ? {} extends Pick<T, K>
    ? true
    : false
  : never;

type RequiredKey<T extends object> = {
  [K in keyof T]-?: true extends IsOptionalInAnyMember<T, K> ? never : K;
}[keyof T] &
  string;

type OptionalKey<T extends object> = Exclude<keyof T & string, RequiredKey<T>>;

type Covers<Expected extends string, Actual extends string> =
  Exclude<Expected, Actual> extends never
    ? unknown
    : { readonly __missingKeys__: Exclude<Expected, Actual> };

export interface ExactObjectShape {
  readonly required: readonly string[];
  readonly allowed: ReadonlySet<string>;
}

/**
 * Defines a JSON object shape while making schema additions a type error until
 * both the required and optional key lists are updated.
 */
export function defineObjectShape<T extends object>() {
  return <
    const Required extends readonly RequiredKey<T>[],
    const Optional extends readonly OptionalKey<T>[],
  >(
    required: Required & Covers<RequiredKey<T>, Required[number]>,
    optional: Optional & Covers<OptionalKey<T>, Optional[number]>,
  ): ExactObjectShape => ({
    required,
    allowed: new Set([...required, ...optional]),
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactShape(value: Record<string, unknown>, shape: ExactObjectShape): boolean {
  return (
    shape.required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => shape.allowed.has(key))
  );
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * An absent value, or one the given domain contains. Taking the domain as an
 * argument rather than spelling its members out at the call site is what lets a
 * value domain be enumerated: a check written as a chain of `!==` comparisons
 * is invisible to anything that wants to know what the field may hold.
 */
export function isOptionalMember<T extends string>(
  value: unknown,
  domain: readonly T[],
): value is T | undefined {
  return value === undefined || (domain as readonly string[]).includes(value as string);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isStringNumberRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}
