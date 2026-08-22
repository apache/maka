import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';

const jsonSchemaOptions = {
  allErrors: true,
  strict: false,
  validateFormats: false,
} as const;
const draft7Validator = new Ajv(jsonSchemaOptions);
const draft2019Validator = new Ajv2019(jsonSchemaOptions);
const draft2020Validator = new Ajv2020(jsonSchemaOptions);
const compiledSchemas = new WeakMap<object, ValidateFunction>();

/** Validate an input against a provider JSON Schema when the schema is compilable. */
export function validateJsonSchemaInput(schema: unknown, input: unknown): unknown {
  const validator = compileJsonSchema(schema);
  if (!validator || validator(input)) return input;
  throw validator.errors;
}

function compileJsonSchema(schema: unknown): ValidateFunction | undefined {
  if (typeof schema === 'boolean') return draft2020Validator.compile(schema);
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
  const cached = compiledSchemas.get(schema);
  if (cached) return cached;
  const declaredDialect = (schema as { readonly $schema?: unknown }).$schema;
  const dialect = typeof declaredDialect === 'string' ? declaredDialect : '';
  const validator = dialect.includes('draft-07')
    ? draft7Validator
    : dialect.includes('2019-09')
      ? draft2019Validator
      : draft2020Validator;
  const schemaForCompile = dialect.startsWith('https://json-schema.org/draft-07/schema')
    ? { ...schema, $schema: dialect.replace('https://', 'http://') }
    : schema;
  const compiled = validator.compile(schemaForCompile as AnySchema);
  compiledSchemas.set(schema, compiled);
  return compiled;
}

export function jsonSchemaErrorSummary(error: unknown): string {
  if (!Array.isArray(error)) return 'input does not match the declared schema';
  return (error as ErrorObject[])
    .slice(0, 5)
    .map((issue) => {
      const path = issue.instancePath || issue.schemaPath;
      return `${path || 'input'} ${issue.message ?? 'is invalid'}`;
    })
    .join('; ')
    .slice(0, 1000);
}
