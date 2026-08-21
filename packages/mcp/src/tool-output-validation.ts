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
