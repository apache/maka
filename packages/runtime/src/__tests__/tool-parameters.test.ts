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

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToolParameters, ToolParameterValidationError } from '../tool-parameters.js';

test('validates complete asynchronous JSON Schemas without converting them to Zod', async () => {
  const parameters = {
    jsonSchema: Promise.resolve({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        card: { type: 'string' },
        billingAddress: { type: 'string' },
      },
      dependentRequired: { card: ['billingAddress'] },
      unevaluatedProperties: false,
    }),
  };

  assert.deepEqual(
    await parseToolParameters(parameters, { card: '1234', billingAddress: 'home' }),
    { card: '1234', billingAddress: 'home' },
  );
  await assert.rejects(
    () => parseToolParameters(parameters, { card: '1234' }),
    (error: unknown) => error instanceof ToolParameterValidationError,
  );
  await assert.rejects(
    () => parseToolParameters(parameters, { unexpected: true }),
    (error: unknown) => error instanceof ToolParameterValidationError,
  );
});
