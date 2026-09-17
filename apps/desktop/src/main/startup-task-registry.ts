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

export interface StartupTaskDefinition<Name extends string = string> {
  name: Name;
  phase: string;
  dependencies: readonly Name[];
  execution?: StartupTaskExecution;
}

interface StartupTaskEventBase<Name extends string> {
  readonly name: Name;
  readonly phase: string;
  readonly execution: StartupTaskExecution;
}

export type StartupTaskEvent<Name extends string = string> =
  | (StartupTaskEventBase<Name> & {
      readonly status: 'started';
      readonly at: number;
    })
  | (StartupTaskEventBase<Name> & {
      readonly status: 'completed';
      readonly startedAt: number;
      readonly completedAt: number;
      readonly durationMs: number;
    })
  | (StartupTaskEventBase<Name> & {
      readonly status: 'failed';
      readonly startedAt: number;
      readonly completedAt: number;
      readonly durationMs: number;
      readonly error: unknown;
    });

export interface StartupTaskRegistryOptions<Name extends string = string> {
  readonly now?: () => number;
  readonly observe?: (event: StartupTaskEvent<Name>) => void;
}

export function createStartupTaskRegistry<Name extends string>(
  definitions: readonly StartupTaskDefinition<Name>[],
  options: StartupTaskRegistryOptions<Name> = {},
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

  const tasks = new Map<Name, () => unknown | Promise<unknown>>();
  const registrationOrder = new Map<Name, number>();
  const executions = new Map<Name, Promise<unknown>>();
  const completed = new Set<Name>();
  const now = options.now ?? Date.now;
  const observe = (event: StartupTaskEvent<Name>): void => {
    try {
      options.observe?.(event);
    } catch {
      // Startup measurement must never change task behavior.
    }
  };

  const register = <Result>(name: Name, run: () => Result | Promise<Result>): void => {
    if (!definitionsByName.has(name)) throw new Error(`unknown startup task: ${name}`);
    if (tasks.has(name)) {
      throw new Error(`duplicate startup task registration: ${name}`);
    }
    registrationOrder.set(name, registrationOrder.size);
    tasks.set(name, run as () => unknown | Promise<unknown>);
  };

  const orderedNames = (): readonly Name[] => {
    for (const definition of definitions) {
      if (!tasks.has(definition.name)) {
        throw new Error(`startup task is not registered: ${definition.name}`);
      }
    }

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

    const byRegistrationOrder = (left: Name, right: Name): number =>
      registrationOrder.get(left)! - registrationOrder.get(right)!;
    const ready = definitions
      .filter((definition) => definition.dependencies.length === 0)
      .map((definition) => definition.name)
      .sort(byRegistrationOrder);
    const ordered: Name[] = [];

    while (ready.length > 0) {
      const name = ready.shift()!;
      ordered.push(name);
      for (const dependent of dependents.get(name) ?? []) {
        const remaining = dependencyCounts.get(dependent)! - 1;
        dependencyCounts.set(dependent, remaining);
        if (remaining === 0) {
          ready.push(dependent);
          ready.sort(byRegistrationOrder);
        }
      }
    }

    if (ordered.length !== definitions.length) {
      const visiting = new Set<Name>();
      const visited = new Set<Name>();
      const path: Name[] = [];
      const findCycle = (name: Name): readonly Name[] | undefined => {
        if (visiting.has(name)) {
          return [...path.slice(path.indexOf(name)), name];
        }
        if (visited.has(name)) return undefined;
        visiting.add(name);
        path.push(name);
        for (const dependency of definitionsByName.get(name)!.dependencies) {
          const cycle = findCycle(dependency);
          if (cycle) return cycle;
        }
        path.pop();
        visiting.delete(name);
        visited.add(name);
        return undefined;
      };
      for (const definition of definitions) {
        const cycle = findCycle(definition.name);
        if (cycle) throw new Error(`startup task dependency cycle: ${cycle.join(' -> ')}`);
      }
      throw new Error('startup task dependency cycle');
    }
    return ordered;
  };

  const observeCompletion = (
    definition: StartupTaskDefinition<Name>,
    execution: StartupTaskExecution,
    startedAt: number,
    status: 'completed' | 'failed',
    error?: unknown,
  ): void => {
    const completedAt = now();
    const timing = {
      name: definition.name,
      phase: definition.phase,
      execution,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
    };
    observe(
      status === 'completed'
        ? { status, ...timing }
        : { status, ...timing, error },
    );
  };

  const execute = async (name: Name, ancestry: readonly Name[] = []): Promise<unknown> => {
    if (ancestry.includes(name)) {
      throw new Error(`startup task dependency cycle: ${[...ancestry, name].join(' -> ')}`);
    }
    if (completed.has(name)) return;
    const pending = executions.get(name);
    if (pending) return pending;

    const definition = definitionsByName.get(name)!;
    const run = tasks.get(name);
    if (!run) throw new Error(`startup task is not registered: ${name}`);

    const executionPromise = (async () => {
      for (const dependency of definition.dependencies) {
        await execute(dependency, [...ancestry, name]);
      }

    const execution = definition.execution ?? 'foreground';
    const startedAt = now();
    observe({
      status: 'started',
      name,
      phase: definition.phase,
      execution,
      at: startedAt,
    });

    try {
      const result = run();
      if (execution === 'detached') {
        void Promise.resolve(result).then(
          () => {
            completed.add(name);
            observeCompletion(definition, execution, startedAt, 'completed');
          },
          (error: unknown) => {
            observeCompletion(definition, execution, startedAt, 'failed', error);
          },
        );
        completed.add(name);
        return undefined;
      }
      await result;
      completed.add(name);
      observeCompletion(definition, execution, startedAt, 'completed');
      return result;
    } catch (error) {
      observeCompletion(definition, execution, startedAt, 'failed', error);
      throw error;
    }
    })();
    executions.set(name, executionPromise);
    try {
      return await executionPromise;
    } catch (error) {
      executions.delete(name);
      throw error;
    }
  };

  const runTaskSync = <Result>(name: Name, run: () => Result): Result => {
    register(name, run);
    const definition = definitionsByName.get(name)!;
    for (const dependency of definition.dependencies) {
      if (!completed.has(dependency)) {
        throw new Error(
          `startup task dependency has not completed: ${dependency} (required by ${name})`,
        );
      }
    }
    const startedAt = now();
    const execution = definition.execution ?? 'foreground';
    observe({ status: 'started', name, phase: definition.phase, execution, at: startedAt });
    try {
      const result = run();
      completed.add(name);
      observeCompletion(definition, execution, startedAt, 'completed');
      return result;
    } catch (error) {
      observeCompletion(definition, execution, startedAt, 'failed', error);
      throw error;
    }
  };

  return {
    register,
    runTask<Result>(name: Name, run: () => Result | Promise<Result>): Promise<Result> {
      register(name, run);
      return execute(name) as Promise<Result>;
    },
    runTaskSync,
    async runAll(): Promise<void> {
      for (const name of orderedNames()) await execute(name);
    },
  };
}
