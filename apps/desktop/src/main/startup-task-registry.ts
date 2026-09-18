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

export type StartupTaskExecution = 'foreground' | 'detached';
type StartupTaskRun = () => unknown | Promise<unknown>;

export interface StartupTaskDefinition<Name extends string = string> {
  name: Name;
  phase: string;
  dependencies: readonly Name[];
  execution?: StartupTaskExecution;
}

export function createStartupTaskRegistry<Name extends string>(
  definitions: readonly StartupTaskDefinition<Name>[],
  implementations?: Readonly<Partial<Record<Name, StartupTaskRun>>>,
) {
  const definitionsByName = new Map<Name, StartupTaskDefinition<Name>>();
  for (const definition of definitions) {
    if (definitionsByName.has(definition.name)) {
      throw new Error(`duplicate startup task: ${definition.name}`);
    }
    definitionsByName.set(definition.name, definition);
  }
  for (const definition of definitions) {
    for (const dependency of definition.dependencies) {
      if (!definitionsByName.has(dependency)) {
        throw new Error(
          `unknown startup task dependency: ${dependency} (required by ${definition.name})`,
        );
      }
    }
  }

  const tasks = new Map<Name, StartupTaskRun>();
  for (const definition of definitions) {
    const run = implementations?.[definition.name];
    if (!run) {
      throw new Error(`startup task is not implemented: ${definition.name}`);
    }
    tasks.set(definition.name, run);
  }

  const orderedNames = (() => {
    const definitionOrder = new Map(
      definitions.map((definition, index) => [definition.name, index]),
    );
    const dependencyCounts = new Map<Name, number>();
    const dependents = new Map<Name, Name[]>();
    for (const definition of definitions) {
      dependencyCounts.set(definition.name, definition.dependencies.length);
      for (const dependency of definition.dependencies) {
        const registeredDependents = dependents.get(dependency) ?? [];
        registeredDependents.push(definition.name);
        dependents.set(dependency, registeredDependents);
      }
    }

    const byDefinitionOrder = (left: Name, right: Name): number =>
      definitionOrder.get(left)! - definitionOrder.get(right)!;
    const ready = definitions
      .filter((definition) => definition.dependencies.length === 0)
      .map((definition) => definition.name)
      .sort(byDefinitionOrder);
    const ordered: Name[] = [];

    while (ready.length > 0) {
      const name = ready.shift()!;
      ordered.push(name);
      for (const dependent of dependents.get(name) ?? []) {
        const remaining = dependencyCounts.get(dependent)! - 1;
        dependencyCounts.set(dependent, remaining);
        if (remaining === 0) {
          ready.push(dependent);
          ready.sort(byDefinitionOrder);
        }
      }
    }

    if (ordered.length !== definitions.length) {
      const unresolved = definitions
        .map((definition) => definition.name)
        .filter((name) => !ordered.includes(name));
      throw new Error(`startup task dependency cycle: ${unresolved.join(' -> ')}`);
    }
    return ordered;
  })();

  const completed = new Set<Name>();

  const execute = (name: Name): Promise<void> => {
    const definition = definitionsByName.get(name)!;
    const run = tasks.get(name)!;
    if (definition.execution === 'detached') {
      try {
        void Promise.resolve(run()).catch(() => undefined);
      } catch {
        // Detached tasks must not prevent later independent tasks from starting.
      }
      return Promise.resolve();
    }
    return Promise.resolve().then(run).then(() => undefined);
  };

  const runNames = async (names: readonly Name[]): Promise<void> => {
    for (const name of names) {
      const definition = definitionsByName.get(name)!;
      if (definition.dependencies.some((dependency) => !completed.has(dependency))) {
        throw new Error(`startup task phase dependency not ready: ${name}`);
      }
      await execute(name);
      completed.add(name);
    }
  };

  return {
    async runPhase(phase: string): Promise<void> {
      await runNames(
        orderedNames.filter((name) => definitionsByName.get(name)!.phase === phase),
      );
    },
    async runAll(): Promise<void> {
      await runNames(orderedNames);
    },
  };
}
