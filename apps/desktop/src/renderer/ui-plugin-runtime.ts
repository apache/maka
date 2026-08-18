import { Context, Service, type Fiber } from '@maka/runtime/plugin-kernel';
import type { ExtensionUiContributionProjection } from '@maka/runtime-host/protocol';

declare module '@maka/runtime/plugin-kernel' {
  interface Context {
    clientUi: ClientUiRegistry;
  }
}

interface ClientEntry {
  readonly signature: string;
  readonly fiber: Fiber;
}

class ClientUiRegistry extends Service {
  readonly entries: Array<
    ExtensionUiContributionProjection & { readonly token: symbol }
  > = [];

  constructor(ctx: Context) {
    super(ctx, 'clientUi');
  }

  register(contribution: ExtensionUiContributionProjection): void {
    const entry = Object.freeze({ ...contribution, token: Symbol(contribution.id) });
    this.entries.push(entry);
    this.ctx.effect(
      () => () => {
        const index = this.entries.findIndex(({ token }) => token === entry.token);
        if (index >= 0) this.entries.splice(index, 1);
      },
      `ui:${contribution.id}`,
    );
  }

  inspect(): readonly ExtensionUiContributionProjection[] {
    return Object.freeze(
      this.entries
        .map(({ token: _token, ...entry }) => Object.freeze(entry))
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            left.extensionId.localeCompare(right.extensionId) ||
            left.id.localeCompare(right.id),
        ),
    );
  }
}

/** Client-side Cordis tree mirroring committed Host UI entries. */
export class UiPluginRuntime {
  readonly #root = new Context();
  readonly #registry = new ClientUiRegistry(this.#root);
  readonly #entries = new Map<string, ClientEntry>();

  async reconcile(
    contributions: readonly ExtensionUiContributionProjection[],
  ): Promise<readonly ExtensionUiContributionProjection[]> {
    const grouped = new Map<string, ExtensionUiContributionProjection[]>();
    for (const contribution of contributions) {
      const entries = grouped.get(contribution.bindingId) ?? [];
      entries.push(contribution);
      grouped.set(contribution.bindingId, entries);
    }
    for (const [bindingId, items] of grouped) {
      const signature = JSON.stringify(
        items.map(({ revision, id, documentSha256, priority, surface, slot }) => ({
          revision,
          id,
          documentSha256,
          priority,
          surface,
          slot,
        })),
      );
      const current = this.#entries.get(bindingId);
      if (current?.signature === signature) continue;
      const context = this.#root.extend({ clientEntryId: bindingId });
      const candidate = context.plugin(
        Object.assign(
          (ctx: Context) => {
            for (const item of items) ctx.clientUi.register(item);
          },
          { inject: ['clientUi'] },
        ),
      );
      try {
        await candidate.await();
      } catch (error) {
        await candidate.dispose().catch(() => undefined);
        throw error;
      }
      this.#entries.set(bindingId, { signature, fiber: candidate });
      await current?.fiber.dispose();
    }
    for (const [bindingId, entry] of [...this.#entries]) {
      if (grouped.has(bindingId)) continue;
      this.#entries.delete(bindingId);
      await entry.fiber.dispose();
    }
    return this.#registry.inspect();
  }

  inspect(): readonly ExtensionUiContributionProjection[] {
    return this.#registry.inspect();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#entries.values()].map(({ fiber }) => fiber.dispose()));
    this.#entries.clear();
    await this.#root.fiber.dispose();
  }
}
