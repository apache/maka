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

import type { JsonSchemaValidator, Tool } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

export interface McpToolCallPreparation {
  readonly definitionForSdk: Tool;
  readonly validateOutput?: JsonSchemaValidator<unknown>;
}

export type McpToolCallPreparationState =
  | { readonly ok: true; readonly value: McpToolCallPreparation }
  | { readonly ok: false; readonly cause: unknown };

/**
 * Keep the SDK's SEP-2243 input-definition view while moving output validation
 * behind Maka's deferred-result classification. Preparation is cached by the
 * manager's immutable Tool snapshot and always happens before the wire call.
 */
export class McpToolCallPreparer {
  prepare(definition: Tool): McpToolCallPreparationState {
    try {
      const definitionForSdk = structuredClone(definition);
      delete definitionForSdk.outputSchema;
      if (definition.outputSchema === undefined) {
        return { ok: true, value: { definitionForSdk } };
      }
      // `$id` is schema-local identity. Reusing one SDK validator cache would
      // let two independently advertised Tools share the first schema
      // registered under the same `$id`, whichever server connected first.
      // Compile per preparation so each published Tool owns its validator.
      const validateOutput = new AjvJsonSchemaValidator().getValidator<unknown>(
        structuredClone(definition.outputSchema),
      );
      return { ok: true, value: { definitionForSdk, validateOutput } };
    } catch (cause) {
      return { ok: false, cause };
    }
  }
}
