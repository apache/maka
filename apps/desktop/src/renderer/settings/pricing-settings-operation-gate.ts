export type PricingSettingsOperationKind = 'read' | 'write';

export interface PricingSettingsOperationToken {
  readonly generation: number;
  readonly id: number;
  readonly kind: PricingSettingsOperationKind;
}

/**
 * Serializes Pricing Settings reads and writes and invalidates completions from
 * a replaced semantic port. React state mirrors this gate for presentation;
 * the token remains the authority at every async completion boundary.
 */
export class PricingSettingsOperationGate {
  #generation = 0;
  #nextId = 0;
  #active: PricingSettingsOperationToken | null = null;

  get activeKind(): PricingSettingsOperationKind | null {
    return this.#active?.kind ?? null;
  }

  begin(kind: PricingSettingsOperationKind): PricingSettingsOperationToken | null {
    if (this.#active) return null;
    const token = {
      generation: this.#generation,
      id: this.#nextId,
      kind,
    } satisfies PricingSettingsOperationToken;
    this.#nextId += 1;
    this.#active = token;
    return token;
  }

  isCurrent(token: PricingSettingsOperationToken): boolean {
    return this.#active?.generation === token.generation
      && this.#active.id === token.id
      && this.#active.kind === token.kind;
  }

  finish(token: PricingSettingsOperationToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.#active = null;
    return true;
  }

  replacePort(): void {
    this.#generation += 1;
    this.#active = null;
  }
}
