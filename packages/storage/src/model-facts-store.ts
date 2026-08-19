import { createHash } from 'node:crypto';
import {
  decodeModelFactsDocument,
  MODEL_FACTS_MAX_OVERRIDES,
  MODEL_FACTS_SCHEMA_VERSION,
  normalizeModelFactOverride,
  type ModelFactOverrides,
  type ModelFactsDocument,
} from '@maka/core/model-facts';
import { RuntimePolicyStoreError } from './runtime-policy/errors.js';
import {
  readBoundedDocumentBytes,
  serializeJsonDocument,
  writeJsonDocument,
} from './runtime-policy/document-io.js';

export const MODEL_FACTS_DOCUMENT_MAX_BYTES = 256 * 1024;
const FILE = 'model-facts.json';

export interface ModelFactsReadResult {
  readonly document: ModelFactsDocument;
  readonly diagnostic?: 'malformed' | 'oversized' | 'io_failed';
  readonly fingerprint: string;
}

export class ModelFactsDocumentOwner {
  async read(root: string): Promise<ModelFactsDocument> {
    return (await this.readWithDiagnostics(root)).document;
  }

  async readWithDiagnostics(root: string): Promise<ModelFactsReadResult> {
    let bytes: Buffer | undefined;
    try {
      bytes = await readBoundedDocumentBytes(root, FILE, MODEL_FACTS_DOCUMENT_MAX_BYTES);
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError && error.code === 'invalid_document') {
        return {
          document: emptyDocument(),
          diagnostic: error.message.includes('exceeds') ? 'oversized' : 'malformed',
          fingerprint: `invalid:${error.message}`,
        };
      }
      throw error;
    }
    if (bytes === undefined) return { document: emptyDocument(), fingerprint: 'missing' };
    const fingerprint = fingerprintBytes(bytes);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      return { document: decodeModelFactsDocument(value), fingerprint };
    } catch {
      return { document: emptyDocument(), diagnostic: 'malformed', fingerprint };
    }
  }

  async replace(root: string, overrides: ModelFactOverrides): Promise<ModelFactsDocument> {
    const validated = this.prepareReplacement(overrides);
    return this.writeReplacement(root, validated);
  }

  prepareReplacement(overrides: ModelFactOverrides): ModelFactsDocument {
    const entries = Object.entries(overrides);
    if (entries.length > MODEL_FACTS_MAX_OVERRIDES) {
      throw new RuntimePolicyStoreError('invalid_policy_input', 'Too many model fact overrides');
    }
    let validated: ModelFactsDocument;
    try {
      const normalized: Record<
        string,
        ReturnType<typeof normalizeModelFactOverride>
      > = Object.create(null);
      for (const [key, value] of entries) normalized[key] = normalizeModelFactOverride(value);
      const document: ModelFactsDocument = {
        schemaVersion: MODEL_FACTS_SCHEMA_VERSION,
        overrides: normalized,
      };
      // Reuse the canonical decoder for key grammar and exact bounded shape.
      validated = decodeModelFactsDocument(document);
      if (serializeJsonDocument(validated).length > MODEL_FACTS_DOCUMENT_MAX_BYTES) {
        throw new RuntimePolicyStoreError(
          'invalid_policy_input',
          `model-facts.json exceeds its ${MODEL_FACTS_DOCUMENT_MAX_BYTES} byte limit`,
        );
      }
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError) throw error;
      throw new RuntimePolicyStoreError(
        'invalid_policy_input',
        error instanceof Error ? error.message : 'Invalid model fact overrides',
        { cause: error },
      );
    }
    return validated;
  }

  async writeReplacement(root: string, document: ModelFactsDocument): Promise<ModelFactsDocument> {
    await writeJsonDocument(root, FILE, document, MODEL_FACTS_DOCUMENT_MAX_BYTES);
    return document;
  }

  fingerprint(document: ModelFactsDocument): string {
    return fingerprintBytes(serializeJsonDocument(document));
  }
}

function emptyDocument(): ModelFactsDocument {
  return { schemaVersion: MODEL_FACTS_SCHEMA_VERSION, overrides: {} };
}

function fingerprintBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
