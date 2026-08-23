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
  decodeManagedSecretEnvironmentName,
  decodeManagedSecretReference,
  managedSecretRevision,
  managedSecretValue,
  ManagedSecretError,
  type ManagedSecretActivationContext,
  type ManagedSecretMaterial,
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

export interface ActivationSecretEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * Implemented by the sandbox/control-plane boundary. One call owns the complete
 * environment effect for an Activation: it must either return one lease for the
 * whole batch or reject without applying any entry.
 */
export interface ActivationSecretSink {
  injectEnvironmentVariables(input: {
    readonly entries: readonly ActivationSecretEnvironmentEntry[];
  }): Promise<ActivationSecretInjectionLease>;
}

/**
 * Concrete V1 sink for an isolated sandbox-launch environment object. Callers
 * should pass a fresh environment overlay, not the host-wide `process.env`, so
 * concurrent Activations cannot observe each other's values.
 */
export class ActivationEnvironmentSecretSink implements ActivationSecretSink {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  async injectEnvironmentVariables(input: {
    readonly entries: readonly ActivationSecretEnvironmentEntry[];
  }): Promise<ActivationSecretInjectionLease> {
    const entries = normalizeEnvironmentEntries(input.entries);
    const previous = entries.map(({ name }) => ({
      name,
      hadPrevious: Object.hasOwn(this.environment, name),
      value: this.environment[name],
    }));
    let applied = 0;
    try {
      for (const entry of entries) {
        this.environment[entry.name] = entry.value;
        applied += 1;
      }
    } catch (error) {
      restoreEnvironment(this.environment, previous.slice(0, applied));
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        restoreEnvironment(this.environment, previous);
        released = true;
      },
    };
  }
}

export interface PrepareActivationSecretInjectionInput {
  /** Trusted, owner-checked context supplied out of band by the control plane. */
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
  /** Releases the complete batch effect. */
  release(): Promise<void>;
}

/**
 * Resolves and validates every reference before handing one complete batch to
 * the effect-owning sink. No secret value is included in public errors or in
 * the returned handle.
 */
export class ActivationSecretInjector {
  constructor(private readonly store: ManagedSecretStore) {}

  async prepare(
    input: PrepareActivationSecretInjectionInput,
  ): Promise<PreparedActivationSecretInjection> {
    const bindings = normalizeBindings(input.bindings);
    const material = snapshotMaterial(
      await this.store.resolveForActivation({
        context: input.context,
        references: bindings.map((binding) => binding.reference),
      }),
    );
    if (material.length !== bindings.length) {
      throw new ManagedSecretError(
        'integrity_failure',
        'Managed Secret resolution returned an invalid material set',
      );
    }
    if (
      !material.every((secret, index) =>
        sameReference(secret?.reference, bindings[index]?.reference),
      )
    ) {
      throw new ManagedSecretError(
        'integrity_failure',
        'Managed Secret resolution returned mismatched material references',
      );
    }

    let lease: ActivationSecretInjectionLease | undefined;
    try {
      if (bindings.length > 0) {
        lease = await input.sink.injectEnvironmentVariables({
          entries: Object.freeze(
            bindings.map((binding, index) =>
              Object.freeze({
                name: binding.target.name,
                value: material[index]!.value,
              }),
            ),
          ),
        });
      }
    } catch {
      throw new ManagedSecretError('injection_failed', 'Managed Secret injection failed');
    }

    const handle = new PreparedInjectionHandle(
      lease,
      bindings.map((item) => item.reference),
      material.map((item) => item.value),
    );
    return handle;
  }
}

function snapshotMaterial(value: readonly ManagedSecretMaterial[]): ManagedSecretMaterial[] {
  if (!Array.isArray(value)) {
    throw new ManagedSecretError(
      'integrity_failure',
      'Managed Secret resolution returned an invalid material set',
    );
  }
  try {
    return value.map((secret) => ({
      reference: decodeManagedSecretReference(secret?.reference),
      revision: managedSecretRevision(secret?.revision),
      value: managedSecretValue(secret?.value),
    }));
  } catch {
    throw new ManagedSecretError(
      'integrity_failure',
      'Managed Secret resolution returned an invalid material set',
    );
  }
}

function sameReference(
  actual: ManagedSecretReference | undefined,
  expected: ManagedSecretReference | undefined,
): boolean {
  if (!actual || !expected) return false;
  try {
    const normalized = decodeManagedSecretReference(actual);
    return (
      normalized.schemaVersion === expected.schemaVersion &&
      normalized.secretId === expected.secretId
    );
  } catch {
    return false;
  }
}

class PreparedInjectionHandle implements PreparedActivationSecretInjection {
  readonly references: readonly ManagedSecretReference[];
  #lease: ActivationSecretInjectionLease | undefined;
  readonly #values: string[];

  constructor(
    lease: ActivationSecretInjectionLease | undefined,
    references: readonly ManagedSecretReference[],
    values: readonly string[],
  ) {
    this.#lease = lease;
    this.references = references.map((reference) => ({ ...reference }));
    this.#values = uniqueLongestFirst(values);
  }

  redact(value: string): string {
    return redactLiteralSecrets(value, this.#values);
  }

  async release(): Promise<void> {
    if (!this.#lease) return;
    try {
      await this.#lease.release();
    } catch {
      throw new ManagedSecretError('cleanup_failed', 'Managed Secret cleanup failed');
    }
    this.#lease = undefined;
    this.#values.length = 0;
  }
}

function normalizeEnvironmentEntries(
  value: readonly ActivationSecretEnvironmentEntry[],
): readonly ActivationSecretEnvironmentEntry[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ManagedSecretError('invalid_input', 'Managed Secret environment batch is invalid');
  }
  const names = new Set<string>();
  return value.map((candidate) => {
    const name = decodeManagedSecretEnvironmentName(candidate?.name);
    const portableName = name.toUpperCase();
    if (names.has(portableName)) {
      throw new ManagedSecretError(
        'invalid_input',
        'Managed Secret environment targets must be unique',
      );
    }
    names.add(portableName);
    return { name, value: managedSecretValue(candidate?.value) };
  });
}

function restoreEnvironment(
  environment: NodeJS.ProcessEnv,
  previous: readonly {
    readonly name: string;
    readonly hadPrevious: boolean;
    readonly value?: string;
  }[],
): void {
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const entry = previous[index]!;
    if (entry.hadPrevious) environment[entry.name] = entry.value;
    else delete environment[entry.name];
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
