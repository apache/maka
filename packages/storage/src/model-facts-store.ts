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

import {
  decodeModelFactsDocument,
  MODEL_FACTS_SCHEMA_VERSION,
  UnsupportedModelFactsSchemaError,
  type ModelFactsDocument,
} from '@maka/core/model-facts';
import { readBoundedDocumentBytes } from './runtime-policy/document-io.js';
import { RuntimePolicyStoreError } from './runtime-policy/errors.js';

export const MODEL_FACTS_DOCUMENT_MAX_BYTES = 256 * 1024;
const FILE = 'model-facts.json';

export interface ModelFactsReadResult {
  readonly document: ModelFactsDocument;
  readonly diagnostic?: 'malformed' | 'oversized' | 'unsupported_schema';
}

export class LegacyModelFactsReader {
  async readWithDiagnostics(root: string): Promise<ModelFactsReadResult> {
    let bytes: Buffer | undefined;
    try {
      bytes = await readBoundedDocumentBytes(root, FILE, MODEL_FACTS_DOCUMENT_MAX_BYTES);
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError && error.code === 'invalid_document') {
        return {
          document: emptyDocument(),
          diagnostic: error.message.includes('exceeds') ? 'oversized' : 'malformed',
        };
      }
      throw error;
    }
    if (bytes === undefined) return { document: emptyDocument() };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      return { document: decodeModelFactsDocument(value) };
    } catch (error) {
      if (error instanceof UnsupportedModelFactsSchemaError) {
        return { document: emptyDocument(), diagnostic: 'unsupported_schema' };
      }
      return { document: emptyDocument(), diagnostic: 'malformed' };
    }
  }
}

function emptyDocument(): ModelFactsDocument {
  return { schemaVersion: MODEL_FACTS_SCHEMA_VERSION, overrides: {} };
}
