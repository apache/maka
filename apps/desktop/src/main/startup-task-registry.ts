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

export interface StartupTaskDefinition<Name extends string = string> {
  name: Name;
  phase: string;
  dependencies: readonly Name[];
}

export function createStartupTaskRegistry<Name extends string>(
  definitions: readonly StartupTaskDefinition<Name>[],
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
  const executions = new Map<Name, Promise<unknown>>();
  const completed = new Set<Name>();

  const register = <Result>(name: Name, run: () => Result | Promise<Result>): void => {
    if (!definitionsByName.has(name)) throw new Error(`unknown startup task: ${name}`);
    if (tasks.has(name)) {
      throw new Error(`duplicate startup task registration: ${name}`);
    }
    tasks.set(name, run as () => unknown | Promise<unknown>);
  };

  const execute = async (name: Name, ancestry: readonly Name[]): Promise<unknown> => {
    if (ancestry.includes(name)) {
      throw new Error(`startup task dependency cycle: ${[...ancestry, name].join(' -> ')}`);
    }
    if (completed.has(name)) return;

    const pending = executions.get(name);
    if (pending) return pending;

    const definition = definitionsByName.get(name);
    const run = tasks.get(name);
    if (!definition || !run) throw new Error(`startup task is not registered: ${name}`);

    const execution = (async () => {
      for (const dependency of definition.dependencies) {
        if (!completed.has(dependency)) {
          await execute(dependency, [...ancestry, name]);
        }
      }
      const result = await run();
      completed.add(name);
      return result;
    })();
    executions.set(name, execution);
    try {
      return await execution;
    } catch (error) {
      executions.delete(name);
      throw error;
    }
  };

  return {
    register,
    runTask<Result>(name: Name, run: () => Result | Promise<Result>) {
      register(name, run);
      return execute(name, []) as Promise<Result>;
    },
    runTaskSync<Result>(name: Name, run: () => Result) {
      register(name, run);
      const definition = definitionsByName.get(name)!;
      for (const dependency of definition.dependencies) {
        if (!completed.has(dependency)) {
          throw new Error(
            `startup task dependency has not completed: ${dependency} (required by ${name})`,
          );
        }
      }
      const result = run();
      completed.add(name);
      return result;
    },
    async runAll() {
      for (const definition of definitions) await execute(definition.name, []);
    },
  };
}
