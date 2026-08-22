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

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  BUNDLED_SKILL_CATALOG,
  buildStarterSkillTemplate,
  clearResolvedSkillPreferenceReviews,
  createBundledSkillLock,
  createManagedSkillLock,
  encodeSkillRuntimePreferences,
  getSkillRuntimePreference,
  getBundledSkillSource,
  gateSkillsByHostCapabilities,
  invalidSkillLockStatus,
  isSkillPreferenceReviewPending,
  MANAGED_SKILL_BASELINE_RELATIVE_PATH,
  migrateSkillRuntimePreferences,
  missingSkillLockStatus,
  patchSkillRuntimePreference,
  readManagedSkillSource,
  readManagedSkillSources,
  resolveManagedSkillSourcesRoot,
  resolveSkillPreferenceTarget,
  resolveSkillDiscoveryPaths,
  scanSkillsWithDiagnostics,
  toManagedSkillSourceEntry,
  validateSkillLock,
  validateSkillMetadata,
  type BundledSkillSource,
  type ManagedSkillSourceRecord,
  type HostCapabilities,
  type ScannedSkill,
  type SkillDiscoveryDiagnostic,
  type SkillGovernanceStatus,
  type SkillRuntimePreference,
  type SkillScanDiagnostic,
  type SkillScanResult,
  type SkillManifest,
  type SkillPreferenceMigration,
} from '@maka/runtime/skills';
import {
  isPathInside,
  isSafeSkillId,
  readContainedRegularFile,
} from '@maka/runtime/path-containment';
import {
  SKILL_CATALOG_PAGE_MAX_BYTES,
  SKILL_CATALOG_PAGE_MAX_ITEMS,
  SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES,
  SKILL_CATALOG_CATEGORY_MAX_BYTES,
  SKILL_CATALOG_DESCRIPTION_MAX_BYTES,
  SKILL_CATALOG_DISPLAY_ID_MAX_BYTES,
  SKILL_CATALOG_NAME_MAX_BYTES,
  SKILL_CATALOG_REF_MAX_BYTES,
  SKILL_CATALOG_STRING_ARRAY_ITEM_MAX_BYTES,
  SKILL_CATALOG_STRING_ARRAY_MAX_ITEMS,
  isSkillCatalogProjectRootLexicallyAbsolute,
  type SkillCatalogBundledItem,
  type SkillCatalogGovernanceItem,
  type SkillCatalogInvocableItem,
  type SkillCatalogInvocableQueryResult,
  type SkillCatalogManagedSourceItem,
  type SkillCatalogMutateInput,
  type SkillCatalogMutationOutcome,
  type SkillCatalogMutation,
  type SkillCatalogMutationRejectedReason,
  type SkillCatalogPageItem,
  type SkillCatalogPreviewUpdateInput,
  type SkillCatalogPreviewUpdateOutcome,
  type SkillCatalogQueryProjection,
  type SkillCatalogRevision,
  type SkillCatalogValidationCode,
  type SkillCatalogView,
} from '../protocol/index.js';

export interface SkillCatalogLocalContext {
  readonly projectRoot: string;
}

export type SkillCatalogRepositoryQueryInput =
  | { readonly kind: 'start'; readonly view: SkillCatalogView }
  | {
      readonly kind: 'continue';
      readonly view: SkillCatalogView;
      readonly revision: SkillCatalogRevision;
      readonly cursor: string;
    };

export type SkillCatalogRepositoryInvocableQueryInput =
  | { readonly kind: 'start' }
  | {
      readonly kind: 'continue';
      readonly revision: SkillCatalogRevision;
      readonly cursor: string;
    };

export type SkillCatalogRepositoryMutateInput = Omit<SkillCatalogMutateInput, 'context'>;
export type SkillCatalogRepositoryPreviewUpdateInput = Omit<
  SkillCatalogPreviewUpdateInput,
  'context'
>;
import {
  SkillCatalogTransactionError,
  SkillCatalogTransactionWriter,
  type ManagedSkillTransactionArtifacts,
  type SkillDeletionManifest,
  type SkillCatalogRunWithRoot,
  type SkillCatalogTransactionOptions,
  snapshotWorkspaceSkillTree,
} from './skill-catalog-transaction.js';

const SKILL_FILE = 'SKILL.md';
const LOCK_FILE = 'skill.lock.json';
const BASELINE_FILE = MANAGED_SKILL_BASELINE_RELATIVE_PATH;
const STATE_DIRECTORY = '.maka';
const STATE_FILE = 'skills-state.json';
const PREVIEW_MAX_LINES = 80;
const PREVIEW_SNIPPET_MAX_BYTES = 24 * 1024;
const STARTER_ID_PATTERN = /^starter-skill(?:-(\d+))?$/;
const STARTER_MAX_ORDINAL = 99;

export type SkillCatalogRepositoryErrorCode =
  | 'invalid_request'
  | 'persistence_failed'
  | 'commit_outcome_unknown';

export class SkillCatalogRepositoryError extends Error {
  constructor(
    readonly code: SkillCatalogRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SkillCatalogRepositoryError';
  }
}

export interface CanonicalSkillInventorySnapshot {
  readonly revision: SkillCatalogRevision;
  readonly projectRoot: string;
  readonly inventory: readonly ScannedSkill[];
  readonly diagnostics: readonly SkillScanDiagnostic[];
  readonly discoveryDiagnostics: readonly SkillDiscoveryDiagnostic[];
}

export interface SkillCatalogRepositoryOptions {
  readonly runWithRoot: SkillCatalogRunWithRoot;
  readonly homeDirectory?: string;
  readonly managedSourcesRoot?: string;
  readonly transactionOptions?: SkillCatalogTransactionOptions;
  /** Deterministic external-source race injection for repository filesystem tests only. */
  readonly testHooks?: {
    readonly beforeManagedSourceMutationRead?: () => Promise<void>;
    readonly beforeManagedInstalledArtifactsRead?: () => Promise<void>;
  };
}

interface RepositorySnapshot {
  readonly revision: SkillCatalogRevision;
  readonly projectRoot: string;
  readonly scan: SkillScanResult;
  readonly governance: readonly SkillCatalogGovernanceItem[];
  readonly bundled: readonly SkillCatalogBundledItem[];
  readonly managedSources: readonly SkillCatalogManagedSourceItem[];
  readonly governanceByRef: ReadonlyMap<string, SkillCatalogGovernanceItem>;
  readonly model: CanonicalSkillInventorySnapshot;
  readonly installedFacts: ReadonlyMap<string, InstalledFact>;
  readonly managedSourceHashes: ReadonlyMap<string, string>;
  readonly publicationNamespace: PublicationNamespace;
  readonly deletionFacts: ReadonlyMap<string, DeletionFact>;
}

interface PublicationNamespace {
  readonly status: 'available' | 'missing' | 'blocked_path' | 'read_failed';
  readonly occupiedIds: readonly string[];
  readonly deletionFacts: ReadonlyMap<string, WorkspaceDeletionFact>;
}

interface WorkspaceDeletionFact {
  readonly kind: 'workspace';
  readonly skillId: string;
  readonly manifest: SkillDeletionManifest;
}

interface UserDeletionFact {
  readonly kind: 'user';
  readonly skillId: string;
  readonly path: string;
  readonly discoveryDirectory: string;
  readonly containmentRoot: string;
}

type DeletionFact = WorkspaceDeletionFact | UserDeletionFact;

interface InstalledFact {
  readonly skill: ScannedSkill;
  readonly governance: SkillGovernanceStatus;
  readonly lockContent?: string;
  readonly lockSha256?: string;
  readonly baselineAvailable: boolean;
  readonly baselineSha256?: string;
}

interface MutationExecution {
  readonly changed: boolean;
  readonly ref: string | null;
}

type MutationDecision =
  | { readonly ok: true; readonly execution: MutationExecution }
  | { readonly ok: false; readonly reason: SkillCatalogMutationRejectedReason };

/** Lease-bound persistence and projection boundary for the Runtime Host Skill catalog. */
export class SkillCatalogRepository {
  readonly #runWithRoot: SkillCatalogRunWithRoot;
  readonly #homeDirectory: string | undefined;
  readonly #managedSourcesRoot: string;
  readonly #transactions: SkillCatalogTransactionWriter;
  readonly #beforeManagedSourceMutationRead: (() => Promise<void>) | undefined;
  readonly #beforeManagedInstalledArtifactsRead: (() => Promise<void>) | undefined;

  constructor(options: SkillCatalogRepositoryOptions) {
    this.#runWithRoot = options.runWithRoot;
    this.#homeDirectory =
      options.homeDirectory === undefined ? undefined : resolve(options.homeDirectory);
    this.#managedSourcesRoot = resolve(
      options.managedSourcesRoot ?? resolveManagedSkillSourcesRoot(this.#homeDirectory),
    );
    this.#transactions = new SkillCatalogTransactionWriter(
      options.runWithRoot,
      options.transactionOptions,
    );
    this.#beforeManagedSourceMutationRead = options.testHooks?.beforeManagedSourceMutationRead;
    this.#beforeManagedInstalledArtifactsRead =
      options.testHooks?.beforeManagedInstalledArtifactsRead;
  }

  async recover(): Promise<void> {
    try {
      await this.#transactions.recover();
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async query(
    input: SkillCatalogRepositoryQueryInput,
    context: SkillCatalogLocalContext,
  ): Promise<SkillCatalogQueryProjection> {
    const snapshot = await this.#freshSnapshot(context);
    if (input.kind === 'continue' && input.revision !== snapshot.revision) {
      return {
        kind: 'revision_changed',
        expectedRevision: input.revision,
        actualRevision: snapshot.revision,
      };
    }
    const items = itemsForView(snapshot, input.view);
    const offset = input.kind === 'start' ? 0 : decodeCursor(input.cursor, input.view);
    if (
      offset === null ||
      offset > items.length ||
      (input.kind === 'continue' && offset === items.length)
    ) {
      throw invalidRequest('Skill catalog cursor is invalid');
    }
    return createPage(snapshot.revision, input.view, items, offset);
  }

  async queryInvocable(
    input: SkillCatalogRepositoryInvocableQueryInput,
    context: SkillCatalogLocalContext,
    host: HostCapabilities,
  ): Promise<SkillCatalogInvocableQueryResult> {
    const snapshot = await this.#freshSnapshot(context);
    const revision = invocableRevision(snapshot.revision, host);
    if (input.kind === 'continue' && input.revision !== revision) {
      return {
        kind: 'revision_changed',
        expectedRevision: input.revision,
        actualRevision: revision,
      };
    }
    const items = gateSkillsByHostCapabilities(
      snapshot.model.inventory.filter((skill) => skill.enabled),
      host,
    ).flatMap((skill): SkillCatalogInvocableItem[] =>
      skill.eligible
        ? [{ ref: skill.ref, id: skill.id, name: skill.name, description: skill.description }]
        : [],
    );
    const offset = input.kind === 'start' ? 0 : decodeInvocableCursor(input.cursor);
    if (
      offset === null ||
      offset > items.length ||
      (input.kind === 'continue' && offset === items.length)
    ) {
      throw invalidRequest('Invocable Skill catalog cursor is invalid');
    }
    return createInvocablePage(revision, items, offset);
  }

  async mutate(
    input: SkillCatalogRepositoryMutateInput,
    context: SkillCatalogLocalContext,
  ): Promise<SkillCatalogMutationOutcome> {
    const current = await this.#freshSnapshot(context);
    if (current.revision !== input.expectedRevision) {
      return revisionConflict(input.expectedRevision, current.revision);
    }

    let decision: MutationDecision;
    try {
      decision = await this.#executeMutation(current, input.mutation);
    } catch (error) {
      throw mapPersistenceError(error);
    }
    if (!decision.ok) return { kind: 'rejected', reason: decision.reason };
    if (!decision.execution.changed) {
      return {
        kind: 'unchanged',
        revision: current.revision,
        entry:
          decision.execution.ref === null
            ? null
            : (current.governanceByRef.get(decision.execution.ref) ?? null),
      };
    }

    let committed: RepositorySnapshot;
    try {
      committed = await this.#freshSnapshot(context);
    } catch (error) {
      throw commitOutcomeUnknown(
        'Skill catalog committed but its new projection is unavailable',
        error,
      );
    }
    return {
      kind: 'committed',
      revision: committed.revision,
      entry:
        decision.execution.ref === null
          ? null
          : (committed.governanceByRef.get(decision.execution.ref) ?? null),
    };
  }

  async previewUpdate(
    input: SkillCatalogRepositoryPreviewUpdateInput,
    context: SkillCatalogLocalContext,
  ): Promise<SkillCatalogPreviewUpdateOutcome> {
    const snapshot = await this.#freshSnapshot(context);
    if (snapshot.revision !== input.expectedRevision) {
      return revisionConflict(input.expectedRevision, snapshot.revision);
    }
    const fact = snapshot.installedFacts.get(input.ref);
    if (!fact) return { kind: 'rejected', reason: 'not_found' };
    if (fact.governance.validationStatus === 'metadata_error') {
      return { kind: 'rejected', reason: 'metadata_error' };
    }
    if (fact.governance.sourceType !== 'managed' || !fact.governance.managedSourceId) {
      return { kind: 'rejected', reason: 'not_managed' };
    }
    const source = await readManagedSkillSource(
      this.#managedSourcesRoot,
      fact.governance.managedSourceId,
    );
    if (!source.ok) {
      if (source.reason !== 'not_found') {
        throw new SkillCatalogRepositoryError(
          'persistence_failed',
          'Managed Skill source could not be inspected safely',
        );
      }
      return {
        kind: 'rejected',
        reason: 'source_missing',
      };
    }
    if (!hasLosslessUtf8Content(source.content, source.contentSha256)) {
      return { kind: 'rejected', reason: 'source_invalid' };
    }
    if (!validateSkillMetadata(source.content).valid) {
      return { kind: 'rejected', reason: 'source_invalid' };
    }
    const current = await readContainedArtifact(fact.skill.path, join(fact.skill.path, SKILL_FILE));
    if (current.status !== 'available') {
      return { kind: 'rejected', reason: 'metadata_error' };
    }

    const currentSnippet = boundedSnippet(current.content);
    const sourceSnippet = boundedSnippet(source.content);
    const result: SkillCatalogPreviewUpdateOutcome = {
      kind: 'preview',
      revision: snapshot.revision,
      currentSnippet: currentSnippet.text,
      sourceSnippet: sourceSnippet.text,
      currentTruncated: currentSnippet.truncated,
      sourceTruncated: sourceSnippet.truncated,
      hasManagedBaseline: fact.baselineAvailable,
      summary: {
        currentLineCount: lineCount(current.content),
        sourceLineCount: lineCount(source.content),
        changedLineCount: changedLineCount(current.content, source.content),
      },
      expectedCurrentSha256: current.sha256 as SkillCatalogRevision,
      expectedSourceSha256: source.contentSha256 as SkillCatalogRevision,
    };
    if (jsonBytes(result) > SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES) {
      return shrinkPreview(result);
    }
    return result;
  }

  readCanonicalModelInventory(
    context: SkillCatalogLocalContext,
  ): Promise<CanonicalSkillInventorySnapshot> {
    return this.#freshSnapshot(context).then((snapshot) => snapshot.model);
  }

  async #freshSnapshot(context: SkillCatalogLocalContext): Promise<RepositorySnapshot> {
    let projectRoot: string;
    try {
      projectRoot = await canonicalProjectRoot(context.projectRoot);
    } catch (error) {
      throw invalidRequest('Project root is not a canonical local directory', error);
    }
    try {
      await this.recover();
      return await this.#runWithRoot(async (rootInput) => {
        const root = await canonicalDataRoot(rootInput);
        const discovery = resolveSkillDiscoveryPaths(projectRoot, root, this.#homeDirectory);
        const scan = await scanSkillsWithDiagnostics({
          stateRoot: root,
          dirs: discovery.dirs,
          entries: discovery.entries,
        });
        const publicationNamespace = await readPublicationNamespace(root);
        return buildSnapshot({
          projectRoot,
          scan,
          managedSourcesRoot: this.#managedSourcesRoot,
          publicationNamespace,
        });
      });
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async #executeMutation(
    snapshot: RepositorySnapshot,
    mutation: SkillCatalogMutation,
  ): Promise<MutationDecision> {
    switch (mutation.kind) {
      case 'create_starter':
        return this.#createStarter(snapshot);
      case 'install':
        return this.#install(snapshot, mutation);
      case 'update_managed':
        return this.#updateManaged(snapshot, mutation);
      case 'delete':
        return this.#delete(snapshot, mutation.ref);
      case 'set_enabled':
        return this.#setPreference(snapshot, mutation.ref, { enabled: mutation.enabled });
      case 'set_pinned':
        return this.#setPreference(snapshot, mutation.ref, { pinned: mutation.pinned });
    }
  }

  async #createStarter(snapshot: RepositorySnapshot): Promise<MutationDecision> {
    const existing = snapshot.scan.inventory
      .flatMap((skill) => {
        if (skill.scope !== 'workspace' || skill.source !== 'legacy') return [];
        const ordinal = starterOrdinal(skill.id);
        return ordinal === null ? [] : [{ skill, ordinal }];
      })
      .sort((left, right) => left.ordinal - right.ordinal)[0];
    if (existing) {
      return {
        ok: true,
        execution: { changed: false, ref: existing.skill.ref },
      };
    }

    if (snapshot.publicationNamespace.status === 'blocked_path') {
      return { ok: false, reason: 'blocked_path' };
    }
    if (snapshot.publicationNamespace.status === 'read_failed') {
      return { ok: false, reason: 'blocked_path' };
    }
    const occupiedIds = publicationOccupancy(snapshot.publicationNamespace);
    for (let ordinal = 1; ordinal <= STARTER_MAX_ORDINAL; ordinal += 1) {
      const id = starterId(ordinal);
      if (occupiedIds.has(id.toLowerCase())) continue;
      const name = ordinal === 1 ? '示例技能' : `示例技能 ${ordinal}`;
      const content = buildStarterSkillTemplate(id, name);
      requireProjectableSkillContent(content);
      await this.#transactions.publishSkill(id, {
        skill: content,
      });
      return {
        ok: true,
        execution: { changed: true, ref: `workspace:legacy:${id}` },
      };
    }
    return { ok: false, reason: 'already_exists' };
  }

  async #install(
    snapshot: RepositorySnapshot,
    mutation: Extract<SkillCatalogMutation, { kind: 'install' }>,
  ): Promise<MutationDecision> {
    if (snapshot.publicationNamespace.status === 'blocked_path') {
      return { ok: false, reason: 'blocked_path' };
    }
    if (snapshot.publicationNamespace.status === 'read_failed') {
      return { ok: false, reason: 'blocked_path' };
    }
    if (publicationOccupancy(snapshot.publicationNamespace).has(publicationId(mutation.sourceId))) {
      return { ok: false, reason: 'already_exists' };
    }
    if (mutation.sourceType === 'bundled') {
      const source = getBundledSkillSource(mutation.sourceId);
      if (!source) return { ok: false, reason: 'not_found' };
      requireProjectableSkillContent(source.body);
      await this.#transactions.publishSkill(source.id, bundledArtifacts(source));
      return {
        ok: true,
        execution: { changed: true, ref: `workspace:legacy:${source.id}` },
      };
    }
    await this.#beforeManagedSourceMutationRead?.();
    const source = await readManagedSkillSource(this.#managedSourcesRoot, mutation.sourceId);
    if (!source.ok) {
      if (source.reason === 'read_failed') {
        throw new SkillCatalogRepositoryError(
          'persistence_failed',
          'Managed Skill source could not be read',
        );
      }
      return {
        ok: false,
        reason:
          source.reason === 'not_found'
            ? 'source_missing'
            : source.reason === 'blocked_path'
              ? 'blocked_path'
              : 'source_invalid',
      };
    }
    if (!hasLosslessUtf8Content(source.content, source.contentSha256)) {
      return { ok: false, reason: 'source_invalid' };
    }
    const sourceValidation = validateSkillMetadata(source.content);
    if (!sourceValidation.valid) {
      return { ok: false, reason: 'source_invalid' };
    }
    if (snapshot.managedSourceHashes.get(mutation.sourceId) !== source.contentSha256) {
      return { ok: false, reason: 'source_changed' };
    }
    requireProjectableMetadata(sourceValidation.manifest);
    await this.#transactions.publishSkill(
      source.source.id,
      managedArtifacts(source.source.id, source.content, source.contentSha256),
    );
    return {
      ok: true,
      execution: { changed: true, ref: `workspace:legacy:${source.source.id}` },
    };
  }

  async #updateManaged(
    snapshot: RepositorySnapshot,
    mutation: Extract<SkillCatalogMutation, { kind: 'update_managed' }>,
  ): Promise<MutationDecision> {
    const fact = snapshot.installedFacts.get(mutation.ref);
    if (!fact) return { ok: false, reason: 'not_found' };
    if (fact.skill.scope !== 'workspace' || fact.skill.source !== 'legacy') {
      return { ok: false, reason: 'blocked_scope' };
    }
    const governance = fact.governance;
    if (governance.validationStatus === 'metadata_error' || !fact.lockContent) {
      return { ok: false, reason: 'metadata_error' };
    }
    if (governance.sourceType !== 'managed' || !governance.managedSourceId) {
      return { ok: false, reason: 'not_managed' };
    }
    await this.#beforeManagedSourceMutationRead?.();
    const source = await readManagedSkillSource(
      this.#managedSourcesRoot,
      governance.managedSourceId,
    );
    if (!source.ok) {
      if (source.reason === 'read_failed') {
        throw new SkillCatalogRepositoryError(
          'persistence_failed',
          'Managed Skill source could not be read',
        );
      }
      return {
        ok: false,
        reason: source.reason === 'not_found' ? 'source_missing' : 'blocked_path',
      };
    }
    if (!hasLosslessUtf8Content(source.content, source.contentSha256)) {
      return { ok: false, reason: 'source_invalid' };
    }
    const sourceValidation = validateSkillMetadata(source.content);
    if (!sourceValidation.valid) {
      return { ok: false, reason: 'source_invalid' };
    }
    if (snapshot.managedSourceHashes.get(governance.managedSourceId) !== source.contentSha256) {
      return { ok: false, reason: 'source_changed' };
    }
    requireProjectableMetadata(sourceValidation.manifest);
    await this.#beforeManagedInstalledArtifactsRead?.();
    const current = await readManagedArtifacts(fact.skill);
    if (!current) return { ok: false, reason: 'metadata_error' };
    const snapshotArtifactsChanged =
      current.skillSha256 !== fact.skill.contentSha256 ||
      current.lockSha256 !== fact.lockSha256 ||
      current.baselineSha256 !== fact.baselineSha256;
    if (mutation.force) {
      if (
        snapshotArtifactsChanged ||
        current.skillSha256 !== mutation.expectedCurrentSha256 ||
        source.contentSha256 !== mutation.expectedSourceSha256
      ) {
        return { ok: false, reason: 'source_changed' };
      }
    } else {
      const freshGovernance = validateFreshManagedArtifacts(
        fact.skill.id,
        current,
        source.contentSha256,
      );
      if (freshGovernance === 'metadata_error') {
        return { ok: false, reason: 'metadata_error' };
      }
      if (snapshotArtifactsChanged || freshGovernance === 'local_modified') {
        return { ok: false, reason: 'local_modified' };
      }
    }
    if (
      current.skillSha256 === source.contentSha256 &&
      governance.sourceContentSha256 === source.contentSha256
    ) {
      return { ok: true, execution: { changed: false, ref: fact.skill.ref } };
    }
    await this.#transactions.replaceManagedSkill(
      fact.skill.id,
      current.artifacts,
      managedArtifacts(fact.skill.id, source.content, source.contentSha256),
    );
    return { ok: true, execution: { changed: true, ref: fact.skill.ref } };
  }

  async #delete(snapshot: RepositorySnapshot, ref: string): Promise<MutationDecision> {
    const deletion = snapshot.deletionFacts.get(ref);
    if (!deletion) {
      const item = snapshot.governanceByRef.get(ref);
      if (!item) return { ok: false, reason: 'not_found' };
      return {
        ok: false,
        reason:
          item.scope === 'workspace' && item.source === 'legacy' ? 'blocked_path' : 'blocked_scope',
      };
    }
    if (deletion.kind === 'workspace') {
      await this.#transactions.deleteWorkspaceSkill(deletion.skillId, deletion.manifest);
    } else {
      const rejected = await deleteUserSkill(deletion);
      if (rejected) return { ok: false, reason: rejected };
    }
    return { ok: true, execution: { changed: true, ref: null } };
  }

  async #setPreference(
    snapshot: RepositorySnapshot,
    ref: string,
    patch: { enabled?: boolean; pinned?: boolean },
  ): Promise<MutationDecision> {
    if (!snapshot.scan.runtimeState.ok) {
      return { ok: false, reason: 'state_error' };
    }
    const projected = snapshot.governanceByRef.get(ref);
    if (!projected || projected.kind !== 'skill') {
      return { ok: false, reason: 'not_found' };
    }
    const target = resolveSkillPreferenceTarget(snapshot.scan.inventory, ref);
    if (!target.ok) return { ok: false, reason: target.reason };
    let migration = migrateSkillRuntimePreferences(
      snapshot.scan.runtimeState,
      snapshot.scan.inventory,
    );
    const prior = getSkillRuntimePreference(migration, target.target);
    const explicitPrior = migration.preferences.get(target.target.ref);
    const nextEnabled = patch.enabled ?? prior.enabled;
    const nextPinned = patch.pinned ?? prior.pinned;
    if (
      explicitPrior &&
      nextEnabled === explicitPrior.enabled &&
      nextPinned === explicitPrior.pinned &&
      snapshot.scan.runtimeState.schemaVersion === 2
    ) {
      return { ok: true, execution: { changed: false, ref: target.target.ref } };
    }
    migration = patchSkillRuntimePreference(migration, target.target, patch);
    migration = clearResolvedSkillPreferenceReviews(migration, snapshot.scan.inventory);
    await this.#runWithRoot(async (rootInput) => {
      const root = await canonicalDataRoot(rootInput);
      await durableWriteState(root, migration.preferences, migration.needsReview);
    });
    return { ok: true, execution: { changed: true, ref: target.target.ref } };
  }
}

async function buildSnapshot(input: {
  projectRoot: string;
  scan: SkillScanResult;
  managedSourcesRoot: string;
  publicationNamespace: PublicationNamespace;
}): Promise<RepositorySnapshot> {
  const managedSourceRead = await readManagedSkillSources(input.managedSourcesRoot);
  let managedSources: ManagedSkillSourceRecord[];
  if (managedSourceRead.ok) {
    managedSources = managedSourceRead.sources;
  } else if (managedSourceRead.reason === 'not_found') {
    managedSources = [];
  } else {
    throw new SkillCatalogRepositoryError(
      'persistence_failed',
      'Managed Skill source root could not be inspected safely',
    );
  }
  const managedById = new Map(managedSources.map((source) => [source.id, source]));
  const deletionFacts = collectDeletionFacts(input.scan, input.publicationNamespace.deletionFacts);
  const diagnosticsByPath = new Map(input.scan.diagnostics.map((entry) => [entry.path, entry]));
  const installedFacts = new Map<string, InstalledFact>();
  const governance: SkillCatalogGovernanceItem[] = [];
  const effectiveMigration = input.scan.runtimeState.ok
    ? migrateSkillRuntimePreferences(input.scan.runtimeState, input.scan.inventory)
    : null;

  for (const skill of input.scan.inventory) {
    if (!hasDurableSkillIdentity(skill)) {
      governance.push(identityDiagnosticGovernance(skill));
      continue;
    }
    const status = await governanceForSkill(skill, managedById);
    const diagnostic = diagnosticsByPath.get(skill.path);
    const fact: InstalledFact = {
      skill,
      governance: status.governance,
      ...(status.lockContent === undefined ? {} : { lockContent: status.lockContent }),
      ...(status.lockSha256 === undefined ? {} : { lockSha256: status.lockSha256 }),
      baselineAvailable: status.baselineAvailable,
      ...(status.baselineSha256 === undefined ? {} : { baselineSha256: status.baselineSha256 }),
    };
    installedFacts.set(skill.ref, fact);
    const metadata = projectMetadata({
      name: skill.name,
      description: skill.description,
      category: '',
      declaredTools: skill.declaredTools,
    });
    const preference =
      effectiveMigration === null
        ? undefined
        : getSkillRuntimePreference(effectiveMigration, skill);
    const enabled = preference?.enabled ?? skill.enabled;
    governance.push(
      freezeGovernanceItem({
        kind: 'skill',
        ref: projectWireIdentity(
          skill.ref,
          diagnosticIdentity(`diagnostic:${skill.scope}:${skill.precedence}`, skill.ref),
          SKILL_CATALOG_REF_MAX_BYTES,
        ),
        id: projectWireIdentity(skill.id, 'invalid-skill-id', SKILL_CATALOG_DISPLAY_ID_MAX_BYTES),
        name: metadata.name,
        description: metadata.description,
        declaredTools: metadata.declaredTools,
        metadataTruncated: metadata.truncated,
        sourceType: status.governance.sourceType,
        userModified: status.governance.userModified,
        validationStatus: status.governance.validationStatus,
        validationCodes: [
          ...status.governance.validationCodes,
          ...(diagnostic?.issues.map((issue) => issue.code) ?? []),
          ...(metadata.truncated ? (['projection_truncated'] as const) : []),
        ] as SkillCatalogValidationCode[],
        managedUpdateStatus: status.governance.managedUpdateStatus,
        enabled,
        pinned: preference?.pinned ?? skill.pinned,
        runtimeStatus:
          skill.runtimeStatus === 'state_error' ? 'state_error' : enabled ? 'enabled' : 'disabled',
        scope: skill.scope,
        source: skill.source,
        contextStatus: governanceContextStatus(skill, enabled),
        contextRank: null,
        shadowedBy:
          skill.shadowedBy === undefined
            ? null
            : projectWireIdentity(
                skill.shadowedBy,
                diagnosticIdentity(`diagnostic:shadow:${skill.precedence}`, skill.shadowedBy),
                SKILL_CATALOG_REF_MAX_BYTES,
              ),
        needsReview:
          effectiveMigration === null
            ? false
            : isSkillPreferenceReviewPending(effectiveMigration, skill.id),
        manageable: deletionFacts.has(skill.ref),
      }),
    );
  }
  governance.push(...rejectedGovernance(input.scan, deletionFacts, effectiveMigration));
  const representedRefs = new Set(governance.map((item) => item.ref));
  for (const [ref, fact] of input.publicationNamespace.deletionFacts) {
    if (representedRefs.has(ref)) continue;
    governance.push(emptyRootGovernance(ref, fact.skillId));
  }
  governance.push(...discoveryGovernance(input.scan.discoveryDiagnostics));
  governance.sort(compareGovernance);

  const installedIds = publicationOccupancy(input.publicationNamespace);
  const bundled = BUNDLED_SKILL_CATALOG.map((source) => {
    const metadata = validateSkillMetadata(source.body).manifest;
    const projected = projectMetadata({
      name: metadata.name ?? source.id,
      description: metadata.description ?? '',
      category: metadata.category ?? '',
      declaredTools: metadata.allowedTools,
    });
    return Object.freeze({
      kind: 'bundled' as const,
      id: source.id,
      name: projected.name,
      description: projected.description,
      category: projected.category,
      declaredTools: projected.declaredTools,
      metadataTruncated: projected.truncated,
      installed: installedIds.has(publicationId(source.id)),
    });
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const managedSourceItems = managedSources
    .map((source) => {
      const projected = projectMetadata({
        name: source.name,
        description: source.description,
        category: source.category,
        declaredTools: [],
      });
      return Object.freeze({
        kind: 'managed_source' as const,
        ...toManagedSkillSourceEntry(source),
        name: projected.name,
        description: projected.description,
        category: projected.category,
        metadataTruncated: projected.truncated,
        installed:
          installedIds.has(publicationId(source.id)) ||
          [...installedFacts.values()].some(
            (fact) =>
              fact.governance.sourceType === 'managed' &&
              fact.governance.managedSourceId !== undefined &&
              publicationId(fact.governance.managedSourceId) === publicationId(source.id),
          ),
      });
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const revision = digestRevision(
    canonicalRevisionFacts({
      projectRoot: input.projectRoot,
      scan: input.scan,
      governance,
      bundled,
      managedSources,
      installedFacts,
      publicationNamespace: input.publicationNamespace,
      effectiveMigration,
    }),
  );
  const model = freezeModelSnapshot(revision, input.projectRoot, input.scan, effectiveMigration);
  return Object.freeze({
    revision,
    projectRoot: input.projectRoot,
    scan: input.scan,
    governance: Object.freeze(governance),
    bundled: Object.freeze(bundled),
    managedSources: Object.freeze(managedSourceItems),
    governanceByRef: new Map(governance.map((item) => [item.ref, item])),
    model,
    installedFacts,
    managedSourceHashes: new Map(managedSources.map((source) => [source.id, source.contentSha256])),
    publicationNamespace: input.publicationNamespace,
    deletionFacts,
  });
}

function collectDeletionFacts(
  scan: SkillScanResult,
  workspaceFacts: ReadonlyMap<string, WorkspaceDeletionFact>,
): ReadonlyMap<string, DeletionFact> {
  const facts = new Map<string, DeletionFact>(workspaceFacts);
  for (const skill of [...scan.inventory, ...scan.rejected]) {
    const fact = userDeletionFact(skill);
    if (fact) facts.set(skill.ref, fact);
  }
  return facts;
}

function userDeletionFact(
  skill: Pick<ScannedSkill, 'discoveryRoot' | 'id' | 'path' | 'scope' | 'source'>,
): UserDeletionFact | undefined {
  if (
    skill.scope !== 'user' ||
    (skill.source !== 'maka' && skill.source !== 'agents') ||
    !isSafeSkillId(skill.id)
  ) {
    return undefined;
  }
  const containmentRoot = resolve(skill.discoveryRoot);
  const discoveryDirectory = join(containmentRoot, `.${skill.source}`, 'skills');
  const path = join(discoveryDirectory, skill.id);
  if (resolve(skill.path) !== path) return undefined;
  return { kind: 'user', skillId: skill.id, path, discoveryDirectory, containmentRoot };
}

async function deleteUserSkill(
  fact: UserDeletionFact,
): Promise<'not_found' | 'blocked_path' | undefined> {
  try {
    const [directoryStat, skillStat] = await Promise.all([
      lstat(fact.discoveryDirectory),
      lstat(fact.path),
    ]);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      !skillStat.isDirectory() ||
      skillStat.isSymbolicLink()
    ) {
      return 'blocked_path';
    }
    const [rootReal, directoryReal, skillReal] = await Promise.all([
      realpath(fact.containmentRoot),
      realpath(fact.discoveryDirectory),
      realpath(fact.path),
    ]);
    if (
      !isPathInside(rootReal, directoryReal) ||
      dirname(skillReal) !== directoryReal ||
      skillReal !== join(directoryReal, fact.skillId)
    ) {
      return 'blocked_path';
    }
    await rm(fact.path, { recursive: true });
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not_found';
    throw new SkillCatalogRepositoryError('persistence_failed', 'User Skill could not be deleted', {
      cause: error,
    });
  }
}

function governanceContextStatus(
  skill: ScannedSkill,
  enabled: boolean,
): SkillCatalogGovernanceItem['contextStatus'] {
  if (skill.shadowedBy) return 'shadowed';
  if (skill.runtimeStatus === 'state_error') return 'invalid';
  if (!enabled) return 'disabled';
  return 'unknown';
}

async function governanceForSkill(
  skill: ScannedSkill,
  managedSources: ReadonlyMap<string, ManagedSkillSourceRecord>,
): Promise<{
  governance: SkillGovernanceStatus;
  lockContent?: string;
  lockSha256?: string;
  baselineAvailable: boolean;
  baselineSha256?: string;
}> {
  if (skill.scope !== 'workspace' || skill.source !== 'legacy') {
    return { governance: missingSkillLockStatus(), baselineAvailable: false };
  }
  const lockPath = join(skill.path, LOCK_FILE);
  const baselineRead = await readContainedArtifact(skill.path, join(skill.path, BASELINE_FILE));
  const baselineAvailable = baselineRead.status === 'available';
  const baselineSha256 = baselineRead.status === 'unavailable' ? undefined : baselineRead.sha256;
  const lockStat = await lstat(lockPath).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? null : false,
  );
  if (lockStat === null) {
    return {
      governance: missingSkillLockStatus(),
      baselineAvailable,
      ...(baselineSha256 === undefined ? {} : { baselineSha256 }),
    };
  }
  if (lockStat === false) {
    return {
      governance: invalidSkillLockStatus('invalid_json', 'Skill lock could not be inspected.'),
      baselineAvailable,
      ...(baselineSha256 === undefined ? {} : { baselineSha256 }),
    };
  }
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    return {
      governance: invalidSkillLockStatus('lock_symlink', 'Skill lock path is unsafe.'),
      baselineAvailable,
      ...(baselineSha256 === undefined ? {} : { baselineSha256 }),
    };
  }
  const lockRead = await readContainedArtifact(skill.path, lockPath);
  if (lockRead.status === 'unavailable') {
    return {
      governance: invalidSkillLockStatus('invalid_json', 'Skill lock could not be read safely.'),
      baselineAvailable,
      ...(baselineSha256 === undefined ? {} : { baselineSha256 }),
    };
  }
  if (lockRead.status === 'invalid_encoding') {
    return {
      governance: invalidSkillLockStatus('invalid_json', 'Skill lock is not valid UTF-8.'),
      lockSha256: lockRead.sha256,
      baselineAvailable,
      ...(baselineSha256 === undefined ? {} : { baselineSha256 }),
    };
  }
  let lock: unknown;
  try {
    lock = JSON.parse(lockRead.content);
  } catch {
    lock = null;
  }
  const sourceId =
    typeof lock === 'object' &&
    lock !== null &&
    'sourceId' in lock &&
    typeof lock.sourceId === 'string'
      ? lock.sourceId
      : undefined;
  const source = sourceId ? managedSources.get(sourceId) : undefined;
  return {
    governance: validateSkillLock({
      lock,
      skillId: skill.id,
      currentContentSha256: skill.contentSha256,
      ...(source
        ? { managedSource: { status: 'available', contentSha256: source.contentSha256 } }
        : sourceId
          ? { managedSource: { status: 'missing' } }
          : {}),
    }),
    lockContent: lockRead.content,
    lockSha256: lockRead.sha256,
    baselineAvailable,
    ...(baselineSha256 === undefined ? {} : { baselineSha256 }),
  };
}

function rejectedGovernance(
  scan: SkillScanResult,
  deletionFacts: ReadonlyMap<string, DeletionFact>,
  migration: SkillPreferenceMigration | null,
): SkillCatalogGovernanceItem[] {
  return scan.rejected.map((skill) => {
    if (!hasDurableSkillIdentity(skill)) return identityDiagnosticGovernance(skill);
    const metadata = projectMetadata({
      name: skill.name,
      description: skill.description,
      category: '',
      declaredTools: skill.declaredTools,
    });
    return freezeGovernanceItem({
      kind: 'skill',
      ref: projectWireIdentity(
        skill.ref,
        diagnosticIdentity(`diagnostic:${skill.scope}:${skill.precedence}`, skill.ref),
        SKILL_CATALOG_REF_MAX_BYTES,
      ),
      id: projectWireIdentity(skill.id, 'invalid-skill-id', SKILL_CATALOG_DISPLAY_ID_MAX_BYTES),
      name: metadata.name,
      description: metadata.description,
      declaredTools: metadata.declaredTools,
      metadataTruncated: metadata.truncated,
      sourceType: 'unknown',
      userModified: false,
      validationStatus: 'metadata_error',
      validationCodes: [
        ...skill.issues.map((issue) => issue.code),
        ...(metadata.truncated ? (['projection_truncated'] as const) : []),
      ] as SkillCatalogValidationCode[],
      managedUpdateStatus: 'metadata_error',
      enabled: false,
      pinned: false,
      runtimeStatus: scan.runtimeState.ok ? 'disabled' : 'state_error',
      scope: skill.scope,
      source: skill.source,
      contextStatus: 'invalid',
      contextRank: null,
      shadowedBy: null,
      needsReview: migration === null ? false : isSkillPreferenceReviewPending(migration, skill.id),
      manageable: deletionFacts.has(skill.ref),
    });
  });
}

function identityDiagnosticGovernance(skill: {
  readonly ref: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly declaredTools: readonly string[];
  readonly scope: ScannedSkill['scope'];
  readonly source: ScannedSkill['source'];
  readonly precedence: number;
}): SkillCatalogGovernanceItem {
  const metadata = projectMetadata({
    name: skill.name,
    description: skill.description,
    category: '',
    declaredTools: skill.declaredTools,
  });
  return freezeGovernanceItem({
    kind: 'discovery_diagnostic',
    ref: diagnosticIdentity(`diagnostic:identity:${skill.scope}:${skill.precedence}`, skill.ref),
    id: 'invalid-skill-id',
    name: metadata.name,
    description: metadata.description,
    declaredTools: metadata.declaredTools,
    metadataTruncated: metadata.truncated,
    sourceType: 'unknown',
    userModified: false,
    validationStatus: 'metadata_error',
    validationCodes: ['blocked_path'],
    managedUpdateStatus: null,
    enabled: false,
    pinned: false,
    runtimeStatus: 'disabled',
    scope: skill.scope,
    source: skill.source,
    contextStatus: 'invalid',
    contextRank: null,
    shadowedBy: null,
    needsReview: false,
    manageable: false,
  });
}

function emptyRootGovernance(ref: string, id: string): SkillCatalogGovernanceItem {
  return freezeGovernanceItem({
    kind: 'skill',
    ref,
    id,
    name: id,
    description: '',
    declaredTools: [],
    metadataTruncated: false,
    sourceType: 'workspace',
    userModified: false,
    validationStatus: 'metadata_error',
    validationCodes: ['missing_frontmatter'],
    managedUpdateStatus: 'metadata_error',
    enabled: false,
    pinned: false,
    runtimeStatus: 'disabled',
    scope: 'workspace',
    source: 'legacy',
    contextStatus: 'invalid',
    contextRank: null,
    shadowedBy: null,
    needsReview: false,
    manageable: true,
  });
}

function discoveryGovernance(
  diagnostics: readonly SkillDiscoveryDiagnostic[],
): SkillCatalogGovernanceItem[] {
  return diagnostics.map((diagnostic, index) =>
    freezeGovernanceItem({
      kind: 'discovery_diagnostic',
      ref: `diagnostic:${diagnostic.scope}:${diagnostic.source}:${diagnostic.precedence}:${index}`,
      id: `source-${diagnostic.precedence}`,
      name: '',
      description: '',
      declaredTools: [],
      metadataTruncated: false,
      sourceType: 'unknown',
      userModified: false,
      validationStatus: 'metadata_error',
      validationCodes: [diagnostic.reason],
      managedUpdateStatus: null,
      enabled: false,
      pinned: false,
      runtimeStatus: 'disabled',
      scope: diagnostic.scope,
      source: diagnostic.source,
      contextStatus: 'invalid',
      contextRank: null,
      shadowedBy: null,
      needsReview: false,
      manageable: false,
    }),
  );
}

function canonicalRevisionFacts(input: {
  projectRoot: string;
  scan: SkillScanResult;
  governance: readonly SkillCatalogGovernanceItem[];
  bundled: readonly SkillCatalogBundledItem[];
  managedSources: readonly ManagedSkillSourceRecord[];
  installedFacts: ReadonlyMap<string, InstalledFact>;
  publicationNamespace: PublicationNamespace;
  effectiveMigration: SkillPreferenceMigration | null;
}): unknown {
  const state = input.scan.runtimeState.ok
    ? {
        status: 'ok',
        schemaVersion: 2,
        preferences: [...(input.effectiveMigration?.preferences ?? new Map()).entries()]
          .map(([ref, preference]) => [
            ref,
            { enabled: preference.enabled, pinned: preference.pinned },
          ])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
        needsReview: [...(input.effectiveMigration?.needsReview ?? new Set())].sort(),
      }
    : { status: input.scan.runtimeState.reason };
  return {
    schemaVersion: 1,
    projectRoot: input.projectRoot,
    inventory: input.governance.map((item) => ({
      ...item,
      contextStatus: undefined,
      contextRank: undefined,
    })),
    content: input.scan.inventory
      .map((skill) => ({ ref: skill.ref, contentSha256: skill.contentSha256 }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
    state,
    publicationNamespace: {
      status: input.publicationNamespace.status,
      occupiedIds: input.publicationNamespace.occupiedIds,
      deletionFacts: [...input.publicationNamespace.deletionFacts.entries()]
        .map(([ref, fact]) => ({ ref, skillId: fact.skillId, manifest: fact.manifest }))
        .sort((left, right) => left.ref.localeCompare(right.ref)),
    },
    locks: [...input.installedFacts.entries()]
      .map(([ref, fact]) => ({
        ref,
        sourceType: fact.governance.sourceType,
        sourceName: fact.governance.sourceName ?? null,
        sourceVersion: fact.governance.sourceVersion ?? null,
        managedSourceId: fact.governance.managedSourceId ?? null,
        sourceContentSha256: fact.governance.sourceContentSha256 ?? null,
        validationStatus: fact.governance.validationStatus,
        validationCodes: [...fact.governance.validationCodes].sort(),
        baselineAvailable: fact.baselineAvailable,
        lockSha256: fact.lockSha256 ?? null,
        baselineSha256: fact.baselineSha256 ?? null,
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
    bundled: input.bundled.map((source) => ({
      id: source.id,
      installed: source.installed,
      contentSha256: getBundledSkillSource(source.id)?.contentSha256 ?? null,
    })),
    managedSources: input.managedSources
      .map((source) => ({
        id: source.id,
        name: source.name,
        description: source.description,
        category: source.category,
        contentSha256: source.contentSha256,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: {
      skill: input.scan.diagnostics
        .map((diagnostic) => ({
          ref:
            input.scan.inventory.find((skill) => skill.path === diagnostic.path)?.ref ??
            input.scan.rejected.find((skill) => skill.path === diagnostic.path)?.ref ??
            diagnostic.id,
          codes: diagnostic.issues.map((issue) => issue.code).sort(),
        }))
        .sort((left, right) => left.ref.localeCompare(right.ref)),
      discovery: input.scan.discoveryDiagnostics
        .map((diagnostic) => ({
          scope: diagnostic.scope,
          source: diagnostic.source,
          precedence: diagnostic.precedence,
          reason: diagnostic.reason,
        }))
        .sort(
          (left, right) =>
            left.precedence - right.precedence ||
            left.scope.localeCompare(right.scope) ||
            left.source.localeCompare(right.source),
        ),
    },
  };
}

function freezeModelSnapshot(
  revision: SkillCatalogRevision,
  projectRoot: string,
  scan: SkillScanResult,
  migration: SkillPreferenceMigration | null,
): CanonicalSkillInventorySnapshot {
  const inventory: ScannedSkill[] = scan.inventory.filter(hasDurableSkillIdentity).map((skill) => {
    const preference = migration === null ? undefined : getSkillRuntimePreference(migration, skill);
    const enabled = preference?.enabled ?? skill.enabled;
    return Object.freeze({
      ...skill,
      enabled,
      pinned: preference?.pinned ?? skill.pinned,
      runtimeStatus:
        skill.runtimeStatus === 'state_error' ? 'state_error' : enabled ? 'enabled' : 'disabled',
      declaredTools: Object.freeze([...skill.declaredTools]) as unknown as string[],
      requiredTools: Object.freeze([...skill.requiredTools]) as unknown as string[],
      requiredCapabilities: Object.freeze([...skill.requiredCapabilities]) as unknown as string[],
    });
  });
  const diagnostics: SkillScanDiagnostic[] = scan.diagnostics.map((diagnostic) =>
    Object.freeze({
      ...diagnostic,
      issues: Object.freeze(
        diagnostic.issues.map((issue) => Object.freeze({ ...issue })),
      ) as unknown as SkillScanDiagnostic['issues'],
    }),
  );
  const discoveryDiagnostics = scan.discoveryDiagnostics.map((diagnostic) =>
    Object.freeze({ ...diagnostic }),
  );
  return Object.freeze({
    revision,
    projectRoot,
    inventory: Object.freeze(inventory),
    diagnostics: Object.freeze(diagnostics),
    discoveryDiagnostics: Object.freeze(discoveryDiagnostics),
  });
}

function freezeGovernanceItem(item: SkillCatalogGovernanceItem): SkillCatalogGovernanceItem {
  return Object.freeze({
    ...item,
    declaredTools: Object.freeze([...item.declaredTools]),
    validationCodes: Object.freeze([...new Set(item.validationCodes)].sort()),
  });
}

function compareGovernance(
  left: SkillCatalogGovernanceItem,
  right: SkillCatalogGovernanceItem,
): number {
  return (
    left.scope.localeCompare(right.scope) ||
    left.source.localeCompare(right.source) ||
    left.name.localeCompare(right.name) ||
    left.ref.localeCompare(right.ref)
  );
}

function itemsForView(
  snapshot: RepositorySnapshot,
  view: SkillCatalogView,
): readonly SkillCatalogPageItem[] {
  if (view === 'governance') return snapshot.governance;
  if (view === 'bundled') return snapshot.bundled;
  return snapshot.managedSources;
}

function createPage(
  revision: SkillCatalogRevision,
  view: SkillCatalogView,
  items: readonly SkillCatalogPageItem[],
  offset: number,
): SkillCatalogQueryProjection {
  const pageItems: SkillCatalogPageItem[] = [];
  let cursor = offset;
  while (cursor < items.length && pageItems.length < SKILL_CATALOG_PAGE_MAX_ITEMS) {
    const candidate = [...pageItems, items[cursor]];
    const hasMore = cursor + 1 < items.length;
    const result = {
      kind: 'page' as const,
      view,
      revision,
      items: candidate,
      nextCursor: hasMore ? encodeCursor(view, cursor + 1) : null,
    };
    if (jsonBytes(result) > SKILL_CATALOG_PAGE_MAX_BYTES) {
      if (pageItems.length === 0) {
        throw new SkillCatalogRepositoryError(
          'persistence_failed',
          'A Skill catalog metadata item exceeds the page projection bound',
        );
      }
      break;
    }
    pageItems.push(items[cursor]);
    cursor += 1;
  }
  return {
    kind: 'page',
    view,
    revision,
    items: Object.freeze(pageItems),
    nextCursor: cursor < items.length ? encodeCursor(view, cursor) : null,
  };
}

function encodeCursor(view: SkillCatalogView, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, view, offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, view: SkillCatalogView): number | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('v' in decoded) ||
      decoded.v !== 1 ||
      !('view' in decoded) ||
      decoded.view !== view ||
      !('offset' in decoded) ||
      !Number.isSafeInteger(decoded.offset) ||
      (decoded.offset as number) < 0
    ) {
      return null;
    }
    return decoded.offset as number;
  } catch {
    return null;
  }
}

function invocableRevision(
  catalogRevision: SkillCatalogRevision,
  host: HostCapabilities,
): SkillCatalogRevision {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        catalogRevision,
        toolNames: [...host.toolNames].sort(),
        capabilities: [...(host.capabilities ?? [])].sort(),
      }),
    )
    .digest('hex');
  return `sha256:${digest}`;
}

function createInvocablePage(
  revision: SkillCatalogRevision,
  items: readonly SkillCatalogInvocableItem[],
  offset: number,
): SkillCatalogInvocableQueryResult {
  const pageItems: SkillCatalogInvocableItem[] = [];
  let cursor = offset;
  while (cursor < items.length && pageItems.length < SKILL_CATALOG_PAGE_MAX_ITEMS) {
    const candidate = [...pageItems, items[cursor]];
    const hasMore = cursor + 1 < items.length;
    const result = {
      kind: 'page' as const,
      revision,
      items: candidate,
      nextCursor: hasMore ? encodeInvocableCursor(cursor + 1) : null,
    };
    if (jsonBytes(result) > SKILL_CATALOG_PAGE_MAX_BYTES) {
      if (pageItems.length === 0) {
        throw new SkillCatalogRepositoryError(
          'persistence_failed',
          'An invocable Skill metadata item exceeds the page projection bound',
        );
      }
      break;
    }
    pageItems.push(items[cursor]);
    cursor += 1;
  }
  return {
    kind: 'page',
    revision,
    items: Object.freeze(pageItems),
    nextCursor: cursor < items.length ? encodeInvocableCursor(cursor) : null,
  };
}

function encodeInvocableCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: 'invocable', offset }), 'utf8').toString(
    'base64url',
  );
}

function decodeInvocableCursor(cursor: string): number | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('v' in decoded) ||
      decoded.v !== 1 ||
      !('kind' in decoded) ||
      decoded.kind !== 'invocable' ||
      !('offset' in decoded) ||
      !Number.isSafeInteger(decoded.offset) ||
      (decoded.offset as number) < 0
    ) {
      return null;
    }
    return decoded.offset as number;
  } catch {
    return null;
  }
}

async function canonicalProjectRoot(value: string): Promise<string> {
  if (!isSkillCatalogProjectRootLexicallyAbsolute(value)) {
    throw new Error('Project root must be absolute');
  }
  const candidate = resolve(value);
  const candidateStat = await stat(candidate);
  if (!candidateStat.isDirectory()) throw new Error('blocked');
  return realpath(candidate);
}

async function canonicalDataRoot(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('Data Root must be absolute');
  const candidate = resolve(value);
  const candidateStat = await lstat(candidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new Error('Data Root is unsafe');
  }
  return realpath(candidate);
}

async function readPublicationNamespace(root: string): Promise<PublicationNamespace> {
  const skillsRoot = join(root, 'skills');
  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(skillsRoot);
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read_failed',
      occupiedIds: Object.freeze([]),
      deletionFacts: new Map(),
    };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return {
      status: 'blocked_path',
      occupiedIds: Object.freeze([]),
      deletionFacts: new Map(),
    };
  }
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    const occupiedIds = entries.map((entry) => publicationId(entry.name)).sort();
    const deletionFacts = new Map<string, WorkspaceDeletionFact>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillId(entry.name)) continue;
      try {
        const manifest = await snapshotWorkspaceSkillTree(root, entry.name);
        deletionFacts.set(`workspace:legacy:${entry.name}`, {
          kind: 'workspace',
          skillId: entry.name,
          manifest,
        });
      } catch {
        // Unsafe or over-budget trees remain occupied but are not manageable.
      }
    }
    return {
      status: 'available',
      occupiedIds: Object.freeze(occupiedIds),
      deletionFacts,
    };
  } catch {
    return {
      status: 'read_failed',
      occupiedIds: Object.freeze([]),
      deletionFacts: new Map(),
    };
  }
}

async function readContainedArtifact(
  root: string,
  path: string,
): Promise<
  | { status: 'available'; content: string; sha256: string }
  | { status: 'invalid_encoding'; sha256: string }
  | { status: 'unavailable' }
> {
  const read = await readContainedRegularFile(root, path);
  if (!read.ok) return { status: 'unavailable' };
  const sha256 = hashBytes(read.bytes);
  const content = read.bytes.toString('utf8');
  if (!hasLosslessUtf8Content(content, sha256)) {
    return { status: 'invalid_encoding', sha256 };
  }
  return {
    status: 'available',
    content,
    sha256,
  };
}

function hasLosslessUtf8Content(content: string, rawSha256: string): boolean {
  return hashBytes(Buffer.from(content, 'utf8')) === rawSha256;
}

function hashBytes(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function bundledArtifacts(source: BundledSkillSource): ManagedSkillTransactionArtifacts {
  return {
    skill: source.body,
    lock: `${JSON.stringify(createBundledSkillLock(source), null, 2)}\n`,
    baseline: source.body,
  };
}

function managedArtifacts(
  id: string,
  content: string,
  contentSha256: string,
): ManagedSkillTransactionArtifacts {
  return {
    skill: content,
    lock: `${JSON.stringify(createManagedSkillLock(id, contentSha256, contentSha256), null, 2)}\n`,
    baseline: content,
  };
}

function publicationId(id: string): string {
  return id.toLowerCase();
}

function publicationOccupancy(namespace: PublicationNamespace): ReadonlySet<string> {
  return new Set(namespace.occupiedIds.map(publicationId));
}

async function readManagedArtifacts(skill: ScannedSkill): Promise<{
  artifacts: ManagedSkillTransactionArtifacts;
  skillSha256: string;
  lockSha256: string;
  baselineSha256: string;
} | null> {
  const [skillFile, lock, baseline] = await Promise.all([
    readContainedArtifact(skill.path, join(skill.path, SKILL_FILE)),
    readContainedArtifact(skill.path, join(skill.path, LOCK_FILE)),
    readContainedArtifact(skill.path, join(skill.path, BASELINE_FILE)),
  ]);
  if (
    skillFile.status !== 'available' ||
    lock.status !== 'available' ||
    baseline.status !== 'available'
  ) {
    return null;
  }
  return {
    artifacts: {
      skill: skillFile.content,
      lock: lock.content,
      baseline: baseline.content,
    },
    skillSha256: skillFile.sha256,
    lockSha256: lock.sha256,
    baselineSha256: baseline.sha256,
  };
}

function validateFreshManagedArtifacts(
  skillId: string,
  current: {
    artifacts: ManagedSkillTransactionArtifacts;
    skillSha256: string;
    baselineSha256: string;
  },
  sourceContentSha256: string,
): 'clean' | 'local_modified' | 'metadata_error' {
  let lock: unknown;
  try {
    lock = JSON.parse(String(current.artifacts.lock));
  } catch {
    return 'metadata_error';
  }
  const governance = validateSkillLock({
    lock,
    skillId,
    currentContentSha256: current.skillSha256,
    managedSource: { status: 'available', contentSha256: sourceContentSha256 },
  });
  if (governance.validationStatus === 'metadata_error' || governance.sourceType !== 'managed') {
    return 'metadata_error';
  }
  if (
    governance.userModified ||
    governance.contentSha256 === undefined ||
    current.baselineSha256 !== governance.contentSha256
  ) {
    return 'local_modified';
  }
  return 'clean';
}

interface ProjectedMetadata {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly declaredTools: readonly string[];
  readonly truncated: boolean;
}

function requireProjectableSkillContent(content: string): ProjectedMetadata {
  const validation = validateSkillMetadata(content);
  if (!validation.valid) {
    throw new SkillCatalogRepositoryError(
      'persistence_failed',
      'Skill content cannot produce valid catalog metadata',
    );
  }
  return requireProjectableMetadata(validation.manifest);
}

function requireProjectableMetadata(metadata: SkillManifest): ProjectedMetadata {
  return projectMetadata({
    name: metadata.name ?? '',
    description: metadata.description ?? '',
    category: metadata.category ?? '',
    declaredTools: metadata.allowedTools,
  });
}

function projectMetadata(input: {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly declaredTools: readonly string[];
}): ProjectedMetadata {
  const name = truncateUtf8(input.name, SKILL_CATALOG_NAME_MAX_BYTES);
  const description = truncateUtf8(input.description, SKILL_CATALOG_DESCRIPTION_MAX_BYTES);
  const category = truncateUtf8(input.category, SKILL_CATALOG_CATEGORY_MAX_BYTES);
  const declaredTools = input.declaredTools
    .slice(0, SKILL_CATALOG_STRING_ARRAY_MAX_ITEMS)
    .map((tool) => truncateUtf8(tool, SKILL_CATALOG_STRING_ARRAY_ITEM_MAX_BYTES));
  const truncated =
    name !== input.name ||
    description !== input.description ||
    category !== input.category ||
    declaredTools.length !== input.declaredTools.length ||
    declaredTools.some((tool, index) => tool !== input.declaredTools[index]);
  return {
    name,
    description,
    category,
    declaredTools: Object.freeze(declaredTools),
    truncated,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function projectWireIdentity(value: string, fallback: string, maxBytes: number): string {
  if (/[\u0000-\u001F\u007F]/.test(value)) return fallback;
  const projected = truncateUtf8(value, maxBytes);
  return projected.length > 0 ? projected : fallback;
}

function hasDurableSkillIdentity(skill: { readonly id: string; readonly ref: string }): boolean {
  return (
    skill.id.length > 0 &&
    skill.ref.length > 0 &&
    Buffer.byteLength(skill.id, 'utf8') <= SKILL_CATALOG_DISPLAY_ID_MAX_BYTES &&
    Buffer.byteLength(skill.ref, 'utf8') <= SKILL_CATALOG_REF_MAX_BYTES &&
    !/[\u0000-\u001F\u007F]/.test(skill.id) &&
    !/[\u0000-\u001F\u007F]/.test(skill.ref)
  );
}

function diagnosticIdentity(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function starterOrdinal(id: string): number | null {
  const match = STARTER_ID_PATTERN.exec(publicationId(id));
  if (!match) return null;
  return match[1] ? Number(match[1]) : 1;
}

function starterId(ordinal: number): string {
  return ordinal === 1 ? 'starter-skill' : `starter-skill-${ordinal}`;
}

async function durableWriteState(
  root: string,
  preferences: ReadonlyMap<string, SkillRuntimePreference>,
  needsReview: ReadonlySet<string>,
): Promise<void> {
  const metadataDir = join(root, STATE_DIRECTORY);
  const target = join(metadataDir, STATE_FILE);
  const temp = join(metadataDir, `.skills-state.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const priorMetadata = await lstat(metadataDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (priorMetadata === null) {
      await mkdir(metadataDir, { mode: 0o700 });
      await syncDirectory(root);
    }
    const [rootReal, metadataStat] = await Promise.all([realpath(root), lstat(metadataDir)]);
    if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) {
      throw new Error('Skill state directory is unsafe');
    }
    const metadataReal = await realpath(metadataDir);
    if (!isPathInside(rootReal, metadataReal))
      throw new Error('Skill state directory escaped root');
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error('Skill state target is unsafe');
    }
    const content = encodeSkillRuntimePreferences(preferences, {
      defaultUpdatedAt: new Date().toISOString(),
      needsReview,
    });
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    renamed = true;
    await syncDirectory(metadataDir);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (renamed) {
      throw commitOutcomeUnknown('Skill state commit outcome is unknown', error);
    }
    throw new SkillCatalogRepositoryError(
      'persistence_failed',
      'Skill state could not be persisted',
      { cause: error },
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function boundedSnippet(content: string): { text: string; truncated: boolean } {
  const lines = content.split(/\r?\n/);
  let text = lines.slice(0, PREVIEW_MAX_LINES).join('\n');
  let truncated = lines.length > PREVIEW_MAX_LINES;
  while (Buffer.byteLength(text, 'utf8') > PREVIEW_SNIPPET_MAX_BYTES) {
    text = text.slice(0, Math.max(0, text.length - 256));
    truncated = true;
  }
  return { text, truncated };
}

function shrinkPreview(
  result: Extract<SkillCatalogPreviewUpdateOutcome, { kind: 'preview' }>,
): SkillCatalogPreviewUpdateOutcome {
  let currentSnippet = result.currentSnippet;
  let sourceSnippet = result.sourceSnippet;
  while (
    jsonBytes({ ...result, currentSnippet, sourceSnippet }) >
      SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES &&
    (currentSnippet.length > 0 || sourceSnippet.length > 0)
  ) {
    if (Buffer.byteLength(currentSnippet, 'utf8') >= Buffer.byteLength(sourceSnippet, 'utf8')) {
      currentSnippet = currentSnippet.slice(0, Math.max(0, currentSnippet.length - 256));
    } else {
      sourceSnippet = sourceSnippet.slice(0, Math.max(0, sourceSnippet.length - 256));
    }
  }
  return {
    ...result,
    currentSnippet,
    sourceSnippet,
    currentTruncated: result.currentTruncated || currentSnippet !== result.currentSnippet,
    sourceTruncated: result.sourceTruncated || sourceSnippet !== result.sourceSnippet,
  };
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function changedLineCount(current: string, source: string): number {
  const currentLines = current.split(/\r?\n/);
  const sourceLines = source.split(/\r?\n/);
  const length = Math.max(currentLines.length, sourceLines.length);
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (currentLines[index] !== sourceLines[index]) changed += 1;
  }
  return changed;
}

function digestRevision(value: unknown): SkillCatalogRevision {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Unsupported canonical catalog fact');
}

function revisionConflict(
  expectedRevision: SkillCatalogRevision,
  actualRevision: SkillCatalogRevision,
): Extract<SkillCatalogMutationOutcome, { kind: 'revision_conflict' }> {
  return { kind: 'revision_conflict', expectedRevision, actualRevision };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function invalidRequest(message: string, cause?: unknown): SkillCatalogRepositoryError {
  return new SkillCatalogRepositoryError('invalid_request', message, { cause });
}

function commitOutcomeUnknown(message: string, cause?: unknown): SkillCatalogRepositoryError {
  return new SkillCatalogRepositoryError('commit_outcome_unknown', message, { cause });
}

function mapPersistenceError(error: unknown): SkillCatalogRepositoryError {
  if (error instanceof SkillCatalogRepositoryError) return error;
  if (error instanceof SkillCatalogTransactionError) {
    return new SkillCatalogRepositoryError(error.code, error.message, { cause: error });
  }
  return new SkillCatalogRepositoryError('persistence_failed', 'Skill catalog persistence failed', {
    cause: error,
  });
}
