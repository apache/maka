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

export type OperationMode = 'command' | 'query' | 'control';
export type OperationAvailability = 'bootstrap' | 'ready';

export type HostOperationErrorCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'unauthorized'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'capability_unavailable'
  | 'invalid_request'
  | 'projection_incomplete'
  | 'persistence_failed'
  | 'commit_outcome_unknown'
  | 'already_resolved'
  | 'outcome_unknown'
  | 'internal_failure';

export interface HostOperationError<C extends HostOperationErrorCode = HostOperationErrorCode> {
  code: C;
  message: string;
}

export interface OperationSpec<Input, Output, ErrorCode extends HostOperationErrorCode> {
  mode: OperationMode;
  availability: OperationAvailability;
  errors: readonly ErrorCode[];
  usesHostPaths?(input: Input): boolean;
  decodeInput(value: unknown): Input;
  decodeOutput(value: unknown): Output;
  assertOutputForInput?(input: Input, output: Output): void;
}

type AnyOperationSpec = OperationSpec<unknown, unknown, HostOperationErrorCode>;
export type OperationSpecMap = Readonly<Record<string, AnyOperationSpec>>;
type OperationSpecMaps = readonly [OperationSpecMap, ...OperationSpecMap[]];
type OperationSpecMapIntersection<Maps extends OperationSpecMaps> = UnionToIntersection<
  Maps[number]
>;
type DuplicateOperationKeys<
  Maps extends readonly OperationSpecMap[],
  Seen = never,
> = Maps extends readonly [
  infer Head extends OperationSpecMap,
  ...infer Tail extends OperationSpecMap[],
]
  ? Extract<keyof Head, Seen> | DuplicateOperationKeys<Tail, Seen | keyof Head>
  : never;
type RequireDisjointOperationKeys<Maps extends OperationSpecMaps> = [
  DuplicateOperationKeys<Maps>,
] extends [never]
  ? unknown
  : { readonly duplicateOperationKeys: DuplicateOperationKeys<Maps> };
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

export function defineOperation<Input, Output, ErrorCode extends HostOperationErrorCode>(
  spec: OperationSpec<Input, Output, ErrorCode>,
): OperationSpec<Input, Output, ErrorCode> {
  if (!(spec.errors as readonly HostOperationErrorCode[]).includes('internal_failure')) {
    throw new Error('Every Runtime Host operation must declare internal_failure');
  }
  return spec;
}

export function defineHostPathOperation<Input, Output, ErrorCode extends HostOperationErrorCode>(
  spec: Omit<OperationSpec<Input, Output, ErrorCode>, 'usesHostPaths'>,
  usesHostPaths: (input: Input) => boolean = () => true,
): OperationSpec<Input, Output, ErrorCode> {
  return defineOperation({ ...spec, usesHostPaths });
}

export function composeOperationSpecMaps<const Maps extends OperationSpecMaps>(
  ...maps: Maps & RequireDisjointOperationKeys<Maps>
): OperationSpecMapIntersection<Maps> {
  const combined: Record<string, AnyOperationSpec> = {};
  for (const map of maps) {
    for (const [key, spec] of Object.entries(map)) {
      if (Object.hasOwn(combined, key)) {
        throw new Error(`Duplicate Runtime Host operation key: ${key}`);
      }
      combined[key] = spec;
    }
  }
  return combined as OperationSpecMapIntersection<Maps>;
}
