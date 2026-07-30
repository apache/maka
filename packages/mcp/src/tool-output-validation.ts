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
  private readonly outputSchemas = new AjvJsonSchemaValidator();

  prepare(definition: Tool): McpToolCallPreparationState {
    try {
      const definitionForSdk = structuredClone(definition);
      delete definitionForSdk.outputSchema;
      if (definition.outputSchema === undefined) {
        return { ok: true, value: { definitionForSdk } };
      }
      const validateOutput = this.outputSchemas.getValidator<unknown>(
        structuredClone(definition.outputSchema),
      );
      return { ok: true, value: { definitionForSdk, validateOutput } };
    } catch (cause) {
      return { ok: false, cause };
    }
  }
}
