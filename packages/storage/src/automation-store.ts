import type { AutomationDefinition } from '@maka/core/automation';
import {
  createSqliteAutomationAuthority,
  type AutomationAuthorityRepository,
} from './automation-authority.js';

export interface AutomationStore {
  loadAll(): Promise<AutomationDefinition[]>;
  save(automation: AutomationDefinition): Promise<void>;
  remove(id: string): Promise<void>;
  sync(automations: AutomationDefinition[]): Promise<void>;
}

export function createAutomationStore(workspaceRoot: string): AutomationStore {
  return new SqliteAutomationStore(workspaceRoot);
}

class SqliteAutomationStore implements AutomationStore {
  constructor(private readonly workspaceRoot: string) {}

  async loadAll(): Promise<AutomationDefinition[]> {
    return this.withAuthority((authority) =>
      authority.read().automations.map((automation) => ({ ...automation })),
    );
  }

  async save(automation: AutomationDefinition): Promise<void> {
    await this.mutate((current) => {
      const next = [...current];
      const index = next.findIndex((candidate) => candidate.id === automation.id);
      if (index === -1) next.push(automation);
      else next[index] = automation;
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((current) => current.filter((automation) => automation.id !== id));
  }

  async sync(automations: AutomationDefinition[]): Promise<void> {
    await this.mutate(() => automations);
  }

  private async mutate(
    update: (current: readonly AutomationDefinition[]) => readonly AutomationDefinition[],
  ): Promise<void> {
    this.withAuthority((authority) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const snapshot = authority.read();
        const automations = [...update(snapshot.automations)];
        const retained = new Set(automations.map((automation) => automation.id));
        const result = authority.commit({
          expectedRevision: snapshot.revision,
          automations,
          pendingFires: snapshot.pendingFires.filter((fire) => retained.has(fire.automationId)),
        });
        if (result.kind === 'committed') return;
      }
      throw new Error('Automation authority changed repeatedly while committing');
    });
  }

  private withAuthority<T>(operation: (authority: AutomationAuthorityRepository) => T): T {
    const authority = createSqliteAutomationAuthority(this.workspaceRoot);
    try {
      return operation(authority);
    } finally {
      authority.close();
    }
  }
}
