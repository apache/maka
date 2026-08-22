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

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  OPENCODE_FREE_DEFAULT_MODEL,
  type ProviderType,
} from '@maka/core/llm-connections';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';

const JOURNAL_FILE = '.runtime-host-bootstrap.json';
interface BootstrapEnvironment {
  readonly ANTHROPIC_API_KEY?: string;
  readonly DEEPSEEK_API_KEY?: string;
  readonly DEEPSEEK_BASE_URL?: string;
  readonly OPENAI_API_KEY?: string;
}

interface BootstrapSeed {
  readonly slug: string;
  readonly name: string;
  readonly providerType: ProviderType;
  readonly enabledModelIds: readonly string[];
  readonly baseUrl?: string;
  readonly secret?: string;
}

interface BootstrapJournal {
  readonly version: 1;
  readonly state: 'initializing';
}

/** Establishes a usable first target before Runtime Host accepts clients. */
export async function ensureBootstrapRuntimePolicy(input: {
  readonly workspaceRoot: string;
  readonly stores: RuntimePolicyStoresWriter;
  readonly environment?: BootstrapEnvironment;
  readonly onDeferredError?: (error: unknown) => void;
}): Promise<void> {
  const journalPath = join(input.workspaceRoot, JOURNAL_FILE);
  const resuming = await readJournal(journalPath);
  const initialCatalog = await input.stores.connectionCatalog.getSnapshot();
  if (initialCatalog.connections.length > 0) {
    // One atomic catalog mutation: enabled ids, static inventory, and a
    // retarget of a system default the migration removes all land in the same
    // document write, so no restart can observe a half-migrated row.
    try {
      await input.stores.connectionCatalog.migrateSystemSeed({
        slug: 'opencode-free',
        providerType: 'opencode-free',
        legacyEnabledModelIds: LEGACY_OPENCODE_FREE_SEEDS,
        enabledModelIds: OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
        defaultModelId: OPENCODE_FREE_DEFAULT_MODEL,
      });
    } catch (error) {
      input.onDeferredError?.(error);
    }
  }
  if (!resuming) {
    if (initialCatalog.connections.length > 0) return;
    await writeJournal(journalPath);
  }

  const seeds = bootstrapSeeds(input.environment ?? process.env);
  const { connection: free } = await ensureConnection(input.stores, seeds[0]!);
  await setDefaultIfMissing(input.stores, free);
  await rm(journalPath, { force: true });

  try {
    let preferred = free;
    for (const seed of seeds.slice(1)) {
      const ensured = await ensureConnection(input.stores, seed);
      const connection = ensured.connection;
      if (seed.secret) {
        try {
          await ensureCredential(input.stores, connection, seed.secret);
        } catch (error) {
          if (ensured.created) await removeFailedBootstrapConnection(input.stores, connection);
          throw error;
        }
      }
      preferred = connection;
    }
    await replaceBootstrapDefault(input.stores, free, preferred);
  } catch (error) {
    input.onDeferredError?.(error);
  }
}

function bootstrapSeeds(environment: BootstrapEnvironment): readonly BootstrapSeed[] {
  const seeds: BootstrapSeed[] = [
    {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      enabledModelIds: OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
    },
  ];
  const deepseek = environment.DEEPSEEK_API_KEY?.trim();
  const anthropic = environment.ANTHROPIC_API_KEY?.trim();
  const openai = environment.OPENAI_API_KEY?.trim();
  if (deepseek) {
    seeds.push({
      slug: 'env-deepseek',
      name: 'DeepSeek (env)',
      providerType: 'deepseek',
      enabledModelIds: ['deepseek-v4-flash'],
      baseUrl: environment.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
      secret: deepseek,
    });
  } else if (anthropic) {
    seeds.push({
      slug: 'env-anthropic',
      name: 'Anthropic (env)',
      providerType: 'anthropic',
      enabledModelIds: ['claude-sonnet-4-5-20250929'],
      secret: anthropic,
    });
  } else if (openai) {
    seeds.push({
      slug: 'env-openai',
      name: 'OpenAI (env)',
      providerType: 'openai',
      enabledModelIds: ['gpt-4o-mini'],
      secret: openai,
    });
  }
  return seeds;
}

async function ensureConnection(
  stores: RuntimePolicyStoresWriter,
  seed: BootstrapSeed,
): Promise<{ readonly connection: ConnectionCatalogEntry; readonly created: boolean }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const catalog = await stores.connectionCatalog.getSnapshot();
    const existing = catalog.connections.find(({ slug }) => slug === seed.slug);
    if (existing) {
      if (existing.providerType !== seed.providerType) {
        throw new Error(`Bootstrap Connection slug conflict: ${seed.slug}`);
      }
      return { connection: existing, created: false };
    }
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: seed.slug,
        name: seed.name,
        providerType: seed.providerType,
        ...(seed.baseUrl === undefined ? {} : { baseUrl: seed.baseUrl }),
        enabled: true,
        enabledModelIds: seed.enabledModelIds,
      },
    });
    if (created.kind === 'committed') {
      const connection = created.snapshot.connections.find(({ slug }) => slug === seed.slug);
      if (!connection) throw new Error('Bootstrap commit omitted its Connection');
      return { connection, created: true };
    }
  }
  throw new Error(`Bootstrap Connection could not be created: ${seed.slug}`);
}

/**
 * Every opencode-free inventory a past release seeded, verbatim. A row still
 * equal to one of these is provably system-owned and may follow the current
 * seed; any other value is a user selection and is never touched. Every
 * release that changes the derived seed must append the previous value here,
 * or rows it planted read as user selections forever. (This exact-match
 * enumeration is deliberately lossy; the versioned seed policy discussed in
 * #3354 is the durable replacement.)
 */
const LEGACY_OPENCODE_FREE_SEEDS: readonly (readonly string[])[] = [
  ['big-pickle'],
  ['nemotron-3-ultra-free'],
  ['nemotron-3-ultra-free', 'mimo-v2.5-free', 'deepseek-v4-flash-free'],
];

async function removeFailedBootstrapConnection(
  stores: RuntimePolicyStoresWriter,
  connection: ConnectionCatalogEntry,
): Promise<void> {
  const removed = await stores.connectionCatalog.remove({
    expected: { connectionId: connection.connectionId, revision: connection.revision },
  });
  if (removed.kind !== 'committed') {
    throw new Error(`Failed Bootstrap Connection could not be removed: ${removed.kind}`);
  }
}

async function ensureCredential(
  stores: RuntimePolicyStoresWriter,
  connection: ConnectionCatalogEntry,
  secret: string,
): Promise<void> {
  const locator = {
    scope: 'connection' as const,
    connectionId: connection.connectionId,
    kind: 'api_key' as const,
  };
  const current = await stores.credentialVault.getStatus(locator);
  if (current.kind === 'connection_not_found') {
    throw new Error('Bootstrap credential refers to a missing Connection');
  }
  if (current.status.configured) return;
  const committed = await stores.credentialVault.set({ locator, expected: null, secret });
  if (committed.kind !== 'committed') {
    throw new Error(`Bootstrap credential could not be stored: ${committed.kind}`);
  }
}

async function setDefaultIfMissing(
  stores: RuntimePolicyStoresWriter,
  connection: ConnectionCatalogEntry,
): Promise<void> {
  const catalog = await stores.connectionCatalog.getSnapshot();
  if (catalog.defaultTarget !== null) return;
  const committed = await stores.connectionCatalog.setDefaultTarget({
    expectedCatalogRevision: catalog.revision,
    target: {
      connectionId: connection.connectionId,
      modelId: OPENCODE_FREE_DEFAULT_MODEL,
    },
  });
  if (committed.kind !== 'committed') {
    throw new Error(`Bootstrap default target could not be stored: ${committed.kind}`);
  }
}

async function replaceBootstrapDefault(
  stores: RuntimePolicyStoresWriter,
  free: ConnectionCatalogEntry,
  preferred: ConnectionCatalogEntry,
): Promise<void> {
  if (preferred.connectionId === free.connectionId || !preferred.enabled) return;
  const catalog = await stores.connectionCatalog.getSnapshot();
  const current = catalog.defaultTarget;
  if (
    current !== null &&
    (current.connectionId !== free.connectionId || current.modelId !== OPENCODE_FREE_DEFAULT_MODEL)
  ) {
    return;
  }
  const modelId = preferred.enabledModelIds[0];
  if (!modelId) return;
  const committed = await stores.connectionCatalog.setDefaultTarget({
    expectedCatalogRevision: catalog.revision,
    target: { connectionId: preferred.connectionId, modelId },
  });
  if (committed.kind !== 'committed') {
    throw new Error(`Bootstrap preferred target could not be stored: ${committed.kind}`);
  }
}

async function readJournal(path: string): Promise<BootstrapJournal | null> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(contents) as Partial<BootstrapJournal>;
  if (value.version !== 1 || value.state !== 'initializing') {
    throw new Error('Invalid Runtime Host bootstrap journal');
  }
  return { version: 1, state: 'initializing' };
}

async function writeJournal(path: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, state: 'initializing' } satisfies BootstrapJournal)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
