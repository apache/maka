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

import { connectExistingRuntimeHost, type RuntimeHostConnection } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export interface RuntimeHostPluginCommand {
  readonly rootPath: string;
  readonly action:
    | 'status'
    | 'list'
    | 'inspect'
    | 'failures'
    | 'install'
    | 'uninstall'
    | 'reload'
    | 'export'
    | 'apply'
    | 'reconcile';
  readonly subject?: string;
  readonly targetPath?: string;
  readonly rootId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

interface RuntimeHostPluginCommandDeps {
  readonly connect: (rootPath: string) => Promise<RuntimeHostConnection>;
  readonly readText: (path: string) => Promise<string>;
  readonly write: (value: string) => void;
}

export async function runRuntimeHostPluginCli(
  command: RuntimeHostPluginCommand,
  overrides: Partial<RuntimeHostPluginCommandDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const connection = await deps.connect(command.rootPath);
  try {
    const result = await execute(connection, command, deps.readText);
    deps.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    await connection.close();
  }
}

async function execute(
  connection: RuntimeHostConnection,
  command: RuntimeHostPluginCommand,
  readText: (path: string) => Promise<string>,
): Promise<unknown> {
  const paging = {
    ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
  };
  switch (command.action) {
    case 'status':
      return await connection.request('plugin.platform.query', { view: 'status' });
    case 'list':
      return await connection.request('plugin.platform.query', { view: 'packages', ...paging });
    case 'inspect':
      return await connection.request('plugin.platform.query', {
        view: 'entries',
        ...paging,
        ...(command.rootId ? { rootId: command.rootId } : {}),
      } as never);
    case 'failures':
      return await connection.request('plugin.platform.query', { view: 'failures', ...paging });
    case 'install':
      return await connection.request('plugin.package.install', {
        sourcePath: resolve(requireSubject(command)),
      });
    case 'uninstall':
      return await connection.request('plugin.package.uninstall', {
        extensionId: requireSubject(command),
      });
    case 'reload':
      return await connection.request('plugin.package.reload', {
        extensionId: requireSubject(command),
      });
    case 'export':
      return await connection.request('plugin.package.export', {
        extensionId: requireSubject(command),
        targetPath: resolve(command.targetPath ?? missing('Plugin export target path')),
      });
    case 'apply': {
      const decoded = JSON.parse(await readText(resolve(requireSubject(command)))) as unknown;
      return await connection.request('plugin.composition.apply', decoded as never);
    }
    case 'reconcile':
      return await connection.request('plugin.platform.reconcile', {});
  }
}

function requireSubject(command: RuntimeHostPluginCommand): string {
  return command.subject ?? missing(`Plugin ${command.action} target`);
}

function missing(label: string): never {
  throw new Error(`${label} is missing`);
}

function defaultDeps(): RuntimeHostPluginCommandDeps {
  return {
    connect: connectLocalOwner,
    readText: (path) => readFile(path, 'utf8'),
    write: (value) => process.stdout.write(value),
  };
}

async function connectLocalOwner(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectExistingRuntimeHost({ rootPath, protocol: PROTOCOL });
  if (result.kind !== 'connected') {
    throw new Error(`Runtime Host service is not available (${result.kind})`);
  }
  return result.connection;
}
