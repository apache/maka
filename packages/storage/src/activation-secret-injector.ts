import {
  decodeManagedSecretEnvironmentName,
  decodeManagedSecretReference,
  ManagedSecretError,
  type ManagedSecretActivationContext,
  type ManagedSecretReference,
  type ManagedSecretStore,
} from './managed-secret-store.js';

export interface ActivationSecretEnvironmentBinding {
  readonly reference: ManagedSecretReference;
  readonly target: {
    readonly kind: 'environment';
    readonly name: string;
  };
}

export interface ActivationSecretInjectionLease {
  /** Idempotent for a completed cleanup; failures remain retryable. */
  release(): Promise<void>;
}

/**
 * Implemented by the sandbox/control-plane boundary. The returned lease owns
 * removal of exactly the material injected by this call, including restoration
 * of any previous value when the provider supports overlays.
 */
export interface ActivationSecretSink {
  /** Must either return a lease that owns the effect or reject with no effect. */
  injectEnvironmentVariable(input: {
    readonly name: string;
    readonly value: string;
  }): Promise<ActivationSecretInjectionLease>;
}

/**
 * Concrete V1 sink for an isolated sandbox-launch environment object. Callers
 * should pass a fresh environment overlay, not the host-wide `process.env`, so
 * concurrent Activations cannot observe each other's values.
 */
export class ActivationEnvironmentSecretSink implements ActivationSecretSink {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  async injectEnvironmentVariable(input: {
    readonly name: string;
    readonly value: string;
  }): Promise<ActivationSecretInjectionLease> {
    const name = decodeManagedSecretEnvironmentName(input.name);
    const hadPrevious = Object.hasOwn(this.environment, name);
    const previous = this.environment[name];
    this.environment[name] = input.value;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        if (hadPrevious) this.environment[name] = previous;
        else delete this.environment[name];
        released = true;
      },
    };
  }
}

export interface PrepareActivationSecretInjectionInput {
  readonly context: ManagedSecretActivationContext;
  readonly bindings: readonly ActivationSecretEnvironmentBinding[];
  readonly sink: ActivationSecretSink;
}

export interface PreparedActivationSecretInjection {
  readonly references: readonly ManagedSecretReference[];
  /**
   * Literal-value redaction for runtime events and diagnostics emitted while
   * this lease is active. Callers must drain those surfaces before `release`.
   */
  redact(value: string): string;
  /** Releases injected material in reverse order. */
  release(): Promise<void>;
}

/**
 * Injection failed before a handle could be returned. If sink rollback also
 * failed, this error retains only the failed cleanup leases so the caller can
 * retry cleanup in `finally`; it never exposes resolved secret material.
 */
export class ActivationSecretInjectionError extends ManagedSecretError {
  readonly #leases: ActivationSecretInjectionLease[];
  readonly #values: string[];

  constructor(
    message: string,
    leases: ActivationSecretInjectionLease[],
    values: readonly string[],
  ) {
    super('injection_failed', message);
    this.name = 'ActivationSecretInjectionError';
    this.#leases = leases;
    this.#values = leases.length === 0 ? [] : uniqueLongestFirst(values);
  }

  get cleanupRequired(): boolean {
    return this.#leases.length > 0;
  }

  redact(value: string): string {
    return redactLiteralSecrets(value, this.#values);
  }

  async release(): Promise<void> {
    if (await releaseLeases(this.#leases)) {
      throw new ManagedSecretError('cleanup_failed', 'Managed Secret cleanup failed');
    }
    this.#values.length = 0;
  }
}

/**
 * Resolves every reference before the first injection, then rolls back partial
 * sink effects on failure. No secret value is included in public errors or in
 * the returned handle.
 */
export class ActivationSecretInjector {
  constructor(private readonly store: ManagedSecretStore) {}

  async prepare(
    input: PrepareActivationSecretInjectionInput,
  ): Promise<PreparedActivationSecretInjection> {
    const bindings = normalizeBindings(input.bindings);
    const material = await this.store.resolveForActivation({
      context: input.context,
      references: bindings.map((binding) => binding.reference),
    });
    if (material.length !== bindings.length) {
      throw new ManagedSecretError(
        'integrity_failure',
        'Managed Secret resolution returned an invalid material set',
      );
    }

    const leases: ActivationSecretInjectionLease[] = [];
    try {
      for (let index = 0; index < bindings.length; index += 1) {
        const binding = bindings[index]!;
        const secret = material[index]!;
        leases.push(
          await input.sink.injectEnvironmentVariable({
            name: binding.target.name,
            value: secret.value,
          }),
        );
      }
    } catch {
      const cleanupFailed = await releaseLeases(leases);
      throw new ActivationSecretInjectionError(
        cleanupFailed
          ? 'Managed Secret injection failed and rollback was incomplete'
          : 'Managed Secret injection failed',
        leases,
        cleanupFailed ? material.map((item) => item.value) : [],
      );
    }

    const handle = new PreparedInjectionHandle(
      leases,
      bindings.map((item) => item.reference),
      material.map((item) => item.value),
    );
    return handle;
  }
}

class PreparedInjectionHandle implements PreparedActivationSecretInjection {
  readonly references: readonly ManagedSecretReference[];
  readonly #leases: ActivationSecretInjectionLease[];
  readonly #values: string[];

  constructor(
    leases: ActivationSecretInjectionLease[],
    references: readonly ManagedSecretReference[],
    values: readonly string[],
  ) {
    this.#leases = leases;
    this.references = references.map((reference) => ({ ...reference }));
    this.#values = uniqueLongestFirst(values);
  }

  redact(value: string): string {
    return redactLiteralSecrets(value, this.#values);
  }

  async release(): Promise<void> {
    const failed = await releaseLeases(this.#leases);
    if (failed) {
      throw new ManagedSecretError('cleanup_failed', 'Managed Secret cleanup failed');
    }
    this.#values.length = 0;
  }
}

function normalizeBindings(
  value: readonly ActivationSecretEnvironmentBinding[],
): readonly ActivationSecretEnvironmentBinding[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ManagedSecretError('invalid_input', 'Managed Secret bindings must be bounded');
  }
  const names = new Set<string>();
  return value.map((candidate) => {
    const reference = decodeManagedSecretReference(candidate?.reference);
    if (candidate?.target?.kind !== 'environment') {
      throw new ManagedSecretError('invalid_input', 'Managed Secret injection target is invalid');
    }
    const name = decodeManagedSecretEnvironmentName(candidate.target.name);
    const portableName = name.toUpperCase();
    if (names.has(portableName)) {
      throw new ManagedSecretError(
        'invalid_input',
        'Managed Secret environment targets must be unique',
      );
    }
    names.add(portableName);
    return { reference, target: { kind: 'environment' as const, name } };
  });
}

async function releaseLeases(leases: ActivationSecretInjectionLease[]): Promise<boolean> {
  let failed = false;
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try {
      await leases[index]!.release();
      leases.splice(index, 1);
    } catch {
      failed = true;
    }
  }
  return failed;
}

function uniqueLongestFirst(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function redactLiteralSecrets(value: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return value;
  let marker = '\0';
  while (value.includes(marker) || secrets.some((secret) => secret.includes(marker)))
    marker += '\0';
  let result = value;
  for (const secret of secrets) result = result.split(secret).join(marker);
  return result.split(marker).join('[redacted]');
}
