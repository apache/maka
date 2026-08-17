import {
  decodeModelFactsDocument,
  MODEL_FACTS_MAX_OVERRIDES,
  MODEL_FACTS_SCHEMA_VERSION,
  normalizeModelFactOverride,
  type ModelFactOverrides,
  type ModelFactsDocument,
} from '@maka/core/model-facts';
import { RuntimePolicyStoreError } from './runtime-policy/errors.js';
import { readBoundedJsonDocument, writeJsonDocument } from './runtime-policy/document-io.js';

export const MODEL_FACTS_DOCUMENT_MAX_BYTES = 256 * 1024;
const FILE = 'model-facts.json';

export interface ModelFactsReadResult {
  readonly document: ModelFactsDocument;
  readonly diagnostic?: 'malformed' | 'oversized' | 'io_failed';
}

export class ModelFactsDocumentOwner {
  async read(root: string): Promise<ModelFactsDocument> {
    return (await this.readWithDiagnostics(root)).document;
  }

  async readWithDiagnostics(root: string): Promise<ModelFactsReadResult> {
    let value: unknown | undefined;
    try {
      value = await readBoundedJsonDocument(root, FILE, MODEL_FACTS_DOCUMENT_MAX_BYTES);
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError && error.code === 'invalid_document') {
        const diagnostic = error.message.includes('exceeds') ? 'oversized' : 'malformed';
        return { document: emptyDocument(), diagnostic };
      }
      throw error;
    }
    if (value === undefined) return { document: emptyDocument() };
    try {
      return { document: decodeModelFactsDocument(value) };
    } catch {
      return { document: emptyDocument(), diagnostic: 'malformed' };
    }
  }

  async replace(root: string, overrides: ModelFactOverrides): Promise<ModelFactsDocument> {
    const entries = Object.entries(overrides);
    if (entries.length > MODEL_FACTS_MAX_OVERRIDES) {
      throw new RuntimePolicyStoreError('invalid_policy_input', 'Too many model fact overrides');
    }
    let validated: ModelFactsDocument;
    try {
      const normalized: Record<string, ReturnType<typeof normalizeModelFactOverride>> = {};
      for (const [key, value] of entries) normalized[key] = normalizeModelFactOverride(value);
      const document: ModelFactsDocument = {
        schemaVersion: MODEL_FACTS_SCHEMA_VERSION,
        overrides: normalized,
      };
      // Reuse the canonical decoder for key grammar and exact bounded shape.
      validated = decodeModelFactsDocument(document);
    } catch (error) {
      throw new RuntimePolicyStoreError(
        'invalid_policy_input',
        error instanceof Error ? error.message : 'Invalid model fact overrides',
        { cause: error },
      );
    }
    await writeJsonDocument(root, FILE, validated, MODEL_FACTS_DOCUMENT_MAX_BYTES);
    return validated;
  }
}

function emptyDocument(): ModelFactsDocument {
  return { schemaVersion: MODEL_FACTS_SCHEMA_VERSION, overrides: {} };
}
