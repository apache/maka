import { z } from 'zod';
import type { ExtensionActivationContext } from './extension-lifecycle-kernel.js';

export interface ExtensionServiceInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly permissionMode: string;
  readonly origin: 'provider' | 'code_mode' | 'host';
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly signal: AbortSignal;
  readonly callerExtensionId?: string;
  readonly serviceDepth?: number;
}

export interface ExtensionServiceMethodDefinition {
  readonly name: string;
  readonly description: string;
  readonly handler: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface ExtensionServiceContribution {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly methods: readonly ExtensionServiceMethodDefinition[];
  invoke(
    method: string,
    input: unknown,
    context: ExtensionServiceInvocationContext,
  ): Promise<unknown>;
}

export interface ExtensionServiceContributionInspection extends ExtensionServiceContribution {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
}

interface RegisteredService extends ExtensionServiceContributionInspection {
  readonly token: symbol;
  readonly validators: ReadonlyMap<string, { input: z.ZodType; output: z.ZodType }>;
}

export class ExtensionServiceContributionError extends Error {
  readonly name = 'ExtensionServiceContributionError';
  constructor(
    readonly code:
      | 'invalid_service'
      | 'service_conflict'
      | 'service_not_found'
      | 'method_not_found'
      | 'invalid_input'
      | 'invalid_output',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Scope-aware, lifecycle-owned typed Service registry. */
export class ExtensionServiceContributionRegistry {
  readonly #scopes = new Map<string, RegisteredService[]>();

  register(
    context: ExtensionActivationContext,
    contribution: ExtensionServiceContribution,
  ): () => void {
    validateExtensionServiceContribution(context.extensionId, contribution);
    const current = this.#scopes.get(context.scopeId) ?? [];
    const conflict = current.find(
      (entry) => entry.name === contribution.name && entry.bindingId !== context.bindingId,
    );
    if (conflict) {
      throw new ExtensionServiceContributionError(
        'service_conflict',
        `Service "${contribution.name}" is already provided by ${conflict.extensionId}@${conflict.revision}`,
      );
    }
    const validators = new Map<string, { input: z.ZodType; output: z.ZodType }>();
    try {
      for (const method of contribution.methods) {
        validators.set(method.name, {
          input: z.fromJSONSchema(method.inputSchema),
          output: z.fromJSONSchema(method.outputSchema),
        });
      }
    } catch (error) {
      throw new ExtensionServiceContributionError(
        'invalid_service',
        `Service JSON Schema is unsupported: ${contribution.name}`,
        { cause: error },
      );
    }
    const entry: RegisteredService = Object.freeze({
      bindingId: context.bindingId,
      scopeId: context.scopeId,
      extensionId: context.extensionId,
      revision: context.revision,
      ...contribution,
      methods: Object.freeze(contribution.methods.map((method) => Object.freeze({ ...method }))),
      validators,
      token: Symbol(contribution.name),
    });
    this.#scopes.set(context.scopeId, [...current, entry]);
    return () => removeRegistered(this.#scopes, context.scopeId, entry.token);
  }

  inspect(
    scopeIds: readonly string[],
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
  ): readonly ExtensionServiceContributionInspection[] {
    const revisions = new Map(committed.map(({ bindingId, revision }) => [bindingId, revision]));
    const resolved = new Map<string, RegisteredService>();
    for (const scopeId of scopeIds) {
      for (const entry of this.#scopes.get(scopeId) ?? []) {
        if (revisions.get(entry.bindingId) !== entry.revision) continue;
        resolved.set(entry.name, entry);
      }
    }
    return Object.freeze(
      [...resolved.values()]
        .map(({ token: _token, validators: _validators, ...entry }) => Object.freeze(entry))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  async call(
    scopeIds: readonly string[],
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
    service: string,
    method: string,
    input: unknown,
    context: ExtensionServiceInvocationContext,
  ): Promise<unknown> {
    const entry = this.#resolve(scopeIds, committed, service);
    const definition = entry.methods.find((candidate) => candidate.name === method);
    if (!definition) {
      throw new ExtensionServiceContributionError(
        'method_not_found',
        `Service method is not defined: ${service}.${method}`,
      );
    }
    const validators = entry.validators.get(method)!;
    const parsedInput = validators.input.safeParse(input);
    if (!parsedInput.success) {
      throw new ExtensionServiceContributionError(
        'invalid_input',
        `Service input does not match ${service}.${method}: ${z.prettifyError(parsedInput.error)}`,
      );
    }
    const result = await entry.invoke(method, structuredClone(parsedInput.data), context);
    const parsedOutput = validators.output.safeParse(result);
    if (!parsedOutput.success) {
      throw new ExtensionServiceContributionError(
        'invalid_output',
        `Service output does not match ${service}.${method}: ${z.prettifyError(parsedOutput.error)}`,
      );
    }
    return structuredClone(parsedOutput.data);
  }

  #resolve(
    scopeIds: readonly string[],
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
    service: string,
  ): RegisteredService {
    const revisions = new Map(committed.map(({ bindingId, revision }) => [bindingId, revision]));
    let resolved: RegisteredService | undefined;
    for (const scopeId of scopeIds) {
      const candidate = (this.#scopes.get(scopeId) ?? []).find(
        (entry) => entry.name === service && revisions.get(entry.bindingId) === entry.revision,
      );
      if (candidate) resolved = candidate;
    }
    if (!resolved) {
      throw new ExtensionServiceContributionError(
        'service_not_found',
        `Active Extension Service is not defined: ${service}`,
      );
    }
    return resolved;
  }
}

export function contributeExtensionService(
  context: ExtensionActivationContext,
  registry: ExtensionServiceContributionRegistry,
  contribution: ExtensionServiceContribution,
): void {
  const unregister = registry.register(context, contribution);
  try {
    context.ownEffect(`service:${contribution.name}`, unregister);
  } catch (error) {
    unregister();
    throw error;
  }
}

export function validateExtensionServiceContribution(
  extensionId: string,
  contribution: ExtensionServiceContribution,
): void {
  if (!contribution || typeof contribution !== 'object')
    invalid('Service contribution is required');
  if (!canonicalName(contribution.name) || !contribution.name.startsWith(`${extensionId}.`)) {
    invalid(`Service name must be owned by the Extension namespace: ${extensionId}.`);
  }
  if (
    typeof contribution.version !== 'string' ||
    contribution.version.length === 0 ||
    contribution.version.length > 128
  )
    invalid('Service version is invalid');
  if (
    typeof contribution.description !== 'string' ||
    Buffer.byteLength(contribution.description, 'utf8') > 4096
  )
    invalid('Service description is invalid');
  if (
    !Array.isArray(contribution.methods) ||
    contribution.methods.length === 0 ||
    contribution.methods.length > 64
  )
    invalid('Service methods are invalid');
  const methods = new Set<string>();
  for (const method of contribution.methods) {
    if (!canonicalId(method.name) || !canonicalId(method.handler))
      invalid('Service method identity is invalid');
    if (methods.has(method.name)) invalid(`Service method repeats: ${method.name}`);
    methods.add(method.name);
    if (
      typeof method.description !== 'string' ||
      Buffer.byteLength(method.description, 'utf8') > 4096
    )
      invalid('Service method description is invalid');
    if (!jsonSchema(method.inputSchema) || !jsonSchema(method.outputSchema))
      invalid('Service method schemas are invalid');
    if (
      !Number.isSafeInteger(method.timeoutMs) ||
      method.timeoutMs < 10 ||
      method.timeoutMs > 120_000
    )
      invalid('Service method timeout is invalid');
  }
  if (typeof contribution.invoke !== 'function') invalid('Service invoke function is required');
}

function jsonSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const encoded = JSON.stringify(value);
    return Buffer.byteLength(encoded, 'utf8') <= 64 * 1024;
  } catch {
    return false;
  }
}

function canonicalId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function canonicalName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 192 &&
    /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(value)
  );
}

function removeRegistered<T extends { readonly token: symbol }>(
  registry: Map<string, T[]>,
  scopeId: string,
  token: symbol,
): void {
  const current = registry.get(scopeId);
  if (!current) return;
  const next = current.filter((entry) => entry.token !== token);
  if (next.length > 0) registry.set(scopeId, next);
  else registry.delete(scopeId);
}

function invalid(message: string): never {
  throw new ExtensionServiceContributionError('invalid_service', message);
}
