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

import type {
  Contract,
  EntryDeclaration,
  Export,
  Import,
} from '../../packages/plugin-sdk/src/index.js';
export const required = (contract: Contract): Export => ({ contract, availability: 'required' });
export const one = (contract: Contract): Import => ({ contract, cardinality: { kind: 'one' } });
export const empty = { type: 'object', properties: {}, required: [], additionalProperties: false };
export function native(definition: {
  implementation: string;
  configuration: unknown;
  exports: Record<string, Contract>;
}): EntryDeclaration {
  return {
    implementation: { kind: 'native', implementation: definition.implementation },
    configuration: definition.configuration,
    imports: {},
    exports: Object.fromEntries(
      Object.entries(definition.exports).map(([name, contract]) => [name, required(contract)]),
    ),
  };
}
