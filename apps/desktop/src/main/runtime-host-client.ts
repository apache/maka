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

import { createHash, randomUUID } from "node:crypto";
import type { AttachmentRef, ShellRunUpdate } from "@maka/core/events";
import type { PlanSessionState, PlanUserControlInput } from "@maka/core/plan";
import {
  decodeStoredMessage,
  type StoredMessage,
  type TurnRecord,
} from "@maka/core/session";
import type { Task } from "@maka/core/task-ledger";
import type {
  ConnectionCatalogSnapshot,
  ConnectionVersionBasis,
  CredentialLocator,
  CredentialStatus,
  RuntimePolicy,
  RuntimePolicyMutation,
} from "@maka/core/runtime-policy";
import {
  canonicalPricingConfigsEqual,
  comparePricingModelKeys,
} from "@maka/core/usage-stats/pricing";
import type { PricingConfig } from "@maka/core/usage-stats/types";
import {
  type ClientCapabilityProvider,
  type DecodedSessionTranscriptPage,
  type DirectRequestOperationKey,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
  RuntimeHostCatalogReadError,
  RuntimeHostOperationError,
  readRuntimeHostAgentGraphEpochs,
  readRuntimeHostConnectionCatalog,
  readRuntimeHostInvocableSkills,
  readRuntimeHostResources,
  readRuntimeHostProjectDetails,
  readRuntimeHostProjects,
  readRuntimeHostSessions,
  readRuntimeHostSkillCatalog,
} from "@maka/runtime-host/client";
import {
  ARTIFACT_INGEST_CHUNK_MAX_BYTES,
  decodePricingMutateInput,
  type ArtifactBinaryPreview,
  type ArtifactProjection,
  type ArtifactQueryResult,
  type ArtifactTextPreview,
  type EffectivePricingEntry,
  type ExternalSessionCatalogQueryInput,
  type ExternalSessionCatalogQueryResult,
  type ExternalSessionSourceQueryResult,
  type ClientCapabilityReplaceResult,
  type ClientCapabilityUnregisterResult,
  type InteractionAnswerInput,
  type MemoryMutateInput,
  type MemoryMutateResult,
  type MemoryQueryInput,
  type MemoryQueryResult,
  type GoalControlAction,
  type GoalProjection,
  type OperationInput,
  type OperationOutput,
  type PlanProjectionItem,
  type PlanQueryResult,
  type PricingMutation,
  type PricingQueryResult,
  type ProjectCatalogMutateInput,
  type ProjectCatalogMutateResult,
  type ProjectCatalogProject,
  type ProjectCatalogProjectDetails,
  PROJECT_DIRECTORY_MAX_ENTRIES,
  type ProjectDirectoryEntry,
  type ProjectDirectoryRoot,
  type QueueRetractInput,
  type QueueRetractResult,
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  type SessionCatalogChangedFrame,
  type ScheduledTaskChangedFrame,
  type SessionCatalogItem,
  type SessionCatalogProjection,
  type SessionConfiguration,
  type SessionAssistantStreamIdentity,
  type SessionContinuitySnapshot,
  type SessionTranscriptBootstrap,
  type SessionTranscriptPage,
  type SessionTranscriptPageInput,
  mergeSessionTurnContributions,
  projectSessionTurnContribution,
  type SessionConversationCopyInput,
  type SessionConversationCopyResult,
  type SessionCreateInput,
  type ExecutionBoundarySummary,
  type SessionLifecycleState,
  type SessionMetadataPatch,
  type SessionUpdateResult,
  type SkillCatalogWorkspaceContext,
  type SkillCatalogInvocableItem,
  type SkillCatalogInvocableTarget,
  type SkillCatalogMutateInput,
  type SkillCatalogMutateResult,
  type SkillCatalogPageItem,
  type SkillCatalogPreviewUpdateInput,
  type SkillCatalogPreviewUpdateResult,
  type SkillCatalogRevision,
  type SkillCatalogView,
  type SubscriptionFrame,
  type TurnInterruptInput,
  type TurnInterruptResult,
  type TurnMessageSubmitInput,
  type TurnMessageSubmitResult,
  type WorkspaceProjection,
} from "@maka/runtime-host/protocol";

const MAX_OPTIMISTIC_ATTEMPTS = 3;
const MAX_SESSION_REVISION_ATTEMPTS = 8;
const MAX_PRICING_SNAPSHOT_ATTEMPTS = 3;

export type DesktopSessionConfigurationPatch = Partial<SessionConfiguration>;

/**
 * How a remove settled. `restored` is not a failure: the task left the state
 * the caller decided against, so nothing was destroyed and nothing is wrong.
 */
export type SessionRemoveDisposition = "removed" | "restored";

export type DesktopRuntimeHostClientErrorCode =
  | "catalog_unstable"
  | "client_closed"
  | "projection_unstable"
  | "pricing_snapshot_stale"
  | "pricing_unstable"
  | "revision_conflict"
  | "session_not_found"
  | "skill_catalog_unstable"
  | "unsupported_session";

export class DesktopRuntimeHostClientError extends Error {
  constructor(
    readonly code: DesktopRuntimeHostClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopRuntimeHostClientError";
  }
}

export interface DesktopRuntimeHostSession {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams: readonly SessionAssistantStreamIdentity[];
  readonly transcriptBootstrap: SessionTranscriptBootstrap;
  readonly events: AsyncIterable<SubscriptionFrame>;
  loadTranscript(): Promise<StoredMessage[]>;
  loadTranscriptOverlay(
    maxMessageBytes?: number,
    accountAssemblyBytes?: (deltaBytes: number) => void,
  ): Promise<StoredMessage[]>;
  decodeTranscriptPage(
    page: SessionTranscriptPage,
    maxMessageBytes?: number,
    accountAssemblyBytes?: (deltaBytes: number) => void,
  ): Promise<DecodedSessionTranscriptPage<StoredMessage>>;
  loadTranscriptPage(
    input: Omit<SessionTranscriptPageInput, "subscriptionId">,
  ): Promise<SessionTranscriptPage>;
  close(): Promise<void>;
}

export interface DesktopPricingSnapshot {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly entries: readonly EffectivePricingEntry[];
}

export interface DesktopSkillCatalogSnapshot {
  readonly revision: SkillCatalogRevision;
  readonly view: SkillCatalogView;
  readonly items: readonly SkillCatalogPageItem[];
  readonly workspace: WorkspaceProjection;
}

export interface DesktopPricingMutationInput {
  readonly base: DesktopPricingSnapshot;
  readonly mutation: PricingMutation;
}

export type DesktopPricingMutationOutcome =
  | {
      readonly kind: "saved";
      readonly disposition: "committed" | "unchanged";
      readonly snapshot: DesktopPricingSnapshot;
    }
  | {
      readonly kind: "saved_refresh_failed";
      readonly disposition: "committed" | "unchanged";
    }
  | {
      readonly kind: "synchronized" | "review_required";
      readonly reason: "revision_conflict" | "outcome_unknown";
      readonly snapshot: DesktopPricingSnapshot;
    }
  | {
      readonly kind: "reconciliation_unavailable";
      readonly reason: "revision_conflict" | "outcome_unknown";
    };

type PricingReconciliationTarget =
  | { readonly kind: "upsert"; readonly pricing: Readonly<PricingConfig> }
  | {
      readonly kind: "delete";
      readonly modelKey: string;
      readonly expected: "builtin" | "unpriced" | "no_override";
    };

export class DesktopRuntimeHostClient {
  readonly #sessions = new Set<DesktopSessionHandle>();
  #closeTask: Promise<void> | undefined;
  #connectionClosed = false;

  constructor(private readonly connection: RuntimeHostConnection) {
    void connection.closed?.then(() => {
      this.#connectionClosed = true;
    });
  }

  get hostEpoch(): string {
    return this.connection.hostEpoch;
  }

  get hostId(): string {
    return this.connection.rootId;
  }

  get lifecycleState(): 'ready' | 'unavailable' {
    return this.#connectionClosed || this.#closeTask ? 'unavailable' : 'ready';
  }

  finalizeAccessCredential(): Promise<OperationOutput<'access.credential.finalize'>> {
    return this.request('access.credential.finalize', {});
  }

  subscribeConfigurationChanges(listener: (revision: number) => void): () => void {
    this.#assertOpen();
    return this.connection.subscribeConfigurationChanges(listener);
  }

  subscribeProjectCatalogChanges(listener: (revision: number) => void): () => void {
    this.#assertOpen();
    return this.connection.subscribeProjectCatalogChanges(listener);
  }

  subscribeSessionCatalogChanges(
    listener: (frame: SessionCatalogChangedFrame) => void,
  ): () => void {
    this.#assertOpen();
    return this.connection.subscribeSessionCatalogChanges(listener);
  }

  subscribeScheduledTaskChanges(
    listener: (frame: ScheduledTaskChangedFrame) => void,
  ): () => void {
    this.#assertOpen();
    return this.connection.subscribeScheduledTaskChanges(listener);
  }

  async loadConnectionCatalog(): Promise<ConnectionCatalogSnapshot> {
    this.#assertOpen();
    try {
      return await readRuntimeHostConnectionCatalog(this.connection);
    } catch (error) {
      if (!(error instanceof RuntimeHostCatalogReadError)) throw error;
      throw new DesktopRuntimeHostClientError(
        "catalog_unstable",
        "Connection catalog kept changing while Desktop read it",
      );
    }
  }

  queryCredential(
    locator: CredentialLocator,
  ): Promise<CredentialStatus | null> {
    return this.request("credential.vault.query", { locator }).then(
      (result) => (result.kind === "status" ? result.status : null),
    );
  }

  queryRuntimePolicy(): Promise<OperationOutput<"runtime.policy.query">> {
    return this.request("runtime.policy.query", {});
  }

  async updateRuntimePolicy(
    buildOperation: (policy: RuntimePolicy) => RuntimePolicyMutation,
  ): Promise<OperationOutput<"runtime.policy.query">> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const current = await this.queryRuntimePolicy();
      const result = await this.request("runtime.policy.mutate", {
        expectedRevision: current.revision,
        operation: buildOperation(current.policy),
      });
      if (result.kind === "committed") return this.queryRuntimePolicy();
    }
    throw revisionConflict("Runtime Policy update", "workspace");
  }

  queryMemory(input: MemoryQueryInput): Promise<MemoryQueryResult> {
    return this.request("memory.query", input);
  }

  mutateMemory(input: MemoryMutateInput): Promise<MemoryMutateResult> {
    return this.request("memory.mutate", input);
  }

  createConnection(
    expectedCatalogRevision: number,
    connection: OperationInput<"connection.catalog.create">["connection"],
  ): Promise<OperationOutput<"connection.catalog.create">> {
    return this.request("connection.catalog.create", {
      expectedCatalogRevision,
      connection,
    });
  }

  updateConnection(
    expected: ConnectionVersionBasis,
    changes: OperationInput<"connection.catalog.update">["changes"],
  ): Promise<OperationOutput<"connection.catalog.update">> {
    return this.request("connection.catalog.update", { expected, changes });
  }

  removeConnection(
    expected: ConnectionVersionBasis,
  ): Promise<OperationOutput<"connection.catalog.remove">> {
    return this.request("connection.catalog.remove", { expected });
  }

  setDefaultConnectionTarget(
    expectedCatalogRevision: number,
    target: OperationInput<"connection.catalog.set-default-target">["target"],
  ): Promise<OperationOutput<"connection.catalog.set-default-target">> {
    return this.request("connection.catalog.set-default-target", {
      expectedCatalogRevision,
      target,
    });
  }

  setCredential(
    input: OperationInput<"credential.vault.set">,
  ): Promise<OperationOutput<"credential.vault.set">> {
    return this.request("credential.vault.set", input);
  }

  deleteCredential(
    input: OperationInput<"credential.vault.delete">,
  ): Promise<OperationOutput<"credential.vault.delete">> {
    return this.request("credential.vault.delete", input);
  }

  getConnectionRequestHeaders(
    connectionId: string,
  ): Promise<OperationOutput<"connection.request-headers.query">> {
    return this.request("connection.request-headers.query", { connectionId });
  }

  replaceConnectionRequestHeaders(
    connectionId: string,
    headers: OperationInput<"connection.request-headers.replace">["headers"],
  ): Promise<OperationOutput<"connection.request-headers.replace">> {
    return this.request("connection.request-headers.replace", { connectionId, headers });
  }

  fetchConnectionModels(
    connectionId: string,
  ): Promise<OperationOutput<"connection.models.fetch">> {
    return this.request("connection.models.fetch", { connectionId });
  }

  testConnection(
    connectionId: string,
    modelId?: string,
  ): Promise<OperationOutput<"connection.test.run">> {
    return this.request("connection.test.run", {
      connectionId,
      modelId: modelId ?? null,
    });
  }

  startOAuthLogin(
    attemptId: string,
    connectionId: string,
  ): Promise<OperationOutput<"oauth.login.start">> {
    return this.request("oauth.login.start", { attemptId, connectionId });
  }

  queryOAuthLogin(
    attemptId: string,
  ): Promise<OperationOutput<"oauth.login.query">> {
    return this.request("oauth.login.query", { attemptId });
  }

  cancelOAuthLogin(
    attemptId: string,
  ): Promise<OperationOutput<"oauth.login.cancel">> {
    return this.request("oauth.login.cancel", { attemptId });
  }

  async loadSkillCatalog(
    context: SkillCatalogWorkspaceContext,
    view: SkillCatalogView,
  ): Promise<DesktopSkillCatalogSnapshot> {
    this.#assertOpen();
    try {
      const snapshot = await readRuntimeHostSkillCatalog(
        this.connection,
        context,
        view,
      );
      return {
        revision: snapshot.revision,
        view: snapshot.view,
        items: snapshot.items,
        workspace: snapshot.resolvedWorkspace,
      };
    } catch (error) {
      if (!(error instanceof RuntimeHostCatalogReadError)) throw error;
      throw new DesktopRuntimeHostClientError(
        "skill_catalog_unstable",
        "Skill catalog kept changing while Desktop read it",
      );
    }
  }

  async listInvocableSkills(
    target: SkillCatalogInvocableTarget,
  ): Promise<readonly SkillCatalogInvocableItem[]> {
    this.#assertOpen();
    try {
      return await readRuntimeHostInvocableSkills(this.connection, target);
    } catch (error) {
      if (!(error instanceof RuntimeHostCatalogReadError)) throw error;
      throw new DesktopRuntimeHostClientError(
        "skill_catalog_unstable",
        "Invocable Skill catalog kept changing while Desktop read it",
      );
    }
  }

  mutateSkillCatalog(
    input: SkillCatalogMutateInput,
  ): Promise<SkillCatalogMutateResult> {
    return this.request("skill.catalog.mutate", input);
  }

  previewSkillUpdate(
    input: SkillCatalogPreviewUpdateInput,
  ): Promise<SkillCatalogPreviewUpdateResult> {
    return this.request("skill.catalog.preview-update", input);
  }

  async loadPricingSnapshot(): Promise<DesktopPricingSnapshot> {
    for (
      let attempt = 0;
      attempt < MAX_PRICING_SNAPSHOT_ATTEMPTS;
      attempt += 1
    ) {
      const snapshot = await this.#readPricingSnapshot();
      if (snapshot) return snapshot;
    }
    throw new DesktopRuntimeHostClientError(
      "pricing_unstable",
      "Pricing kept changing while Desktop read it",
    );
  }

  async applyPricingMutation(
    input: DesktopPricingMutationInput,
  ): Promise<DesktopPricingMutationOutcome> {
    this.#assertOpen();
    if (
      input.base.hostEpoch !== this.connection.hostEpoch ||
      input.base.connectionId !== this.connection.connectionId
    ) {
      throw new DesktopRuntimeHostClientError(
        "pricing_snapshot_stale",
        "Pricing snapshot belongs to a different Runtime Host connection",
      );
    }
    const request = decodePricingMutateInput({
      expectedRevision: input.base.revision,
      mutation: input.mutation,
    });
    const reconciliationTarget = createPricingReconciliationTarget(
      input.base,
      request.mutation,
    );
    let result: OperationOutput<"pricing.mutate">;
    try {
      result = await this.request("pricing.mutate", request);
    } catch (error) {
      if (
        error instanceof RuntimeHostOperationError &&
        error.code !== "commit_outcome_unknown"
      ) {
        throw error;
      }
      return this.#reconcilePricingMutation(
        reconciliationTarget,
        "outcome_unknown",
      );
    }

    if (result.kind === "revision_conflict") {
      return this.#reconcilePricingMutation(
        reconciliationTarget,
        "revision_conflict",
      );
    }

    try {
      return {
        kind: "saved",
        disposition: result.kind,
        snapshot: await this.loadPricingSnapshot(),
      };
    } catch {
      return { kind: "saved_refresh_failed", disposition: result.kind };
    }
  }

  async listSessions(): Promise<SessionCatalogProjection[]> {
    this.#assertOpen();
    try {
      return (await readRuntimeHostSessions(this.connection)).map(requireSessionProjection);
    } catch (error) {
      if (error instanceof DesktopRuntimeHostClientError) throw error;
      if (!(error instanceof RuntimeHostCatalogReadError)) throw error;
      throw new DesktopRuntimeHostClientError(
        "catalog_unstable",
        "Session catalog kept changing while Desktop read it",
      );
    }
  }

  async listProjects(
    includeLocations = true,
  ): Promise<(ProjectCatalogProject | ProjectCatalogProjectDetails)[]> {
    this.#assertOpen();
    try {
      return includeLocations
        ? await readRuntimeHostProjectDetails(this.connection)
        : await readRuntimeHostProjects(this.connection);
    } catch (error) {
      if (!(error instanceof RuntimeHostCatalogReadError)) throw error;
      throw new DesktopRuntimeHostClientError(
        "catalog_unstable",
        "Project catalog kept changing while Desktop read it",
      );
    }
  }

  async registerProject(path: string): Promise<ProjectCatalogProject> {
    const result = await this.#mutateProject({ kind: "register", path });
    return this.#projectForMutation(result);
  }

  async listProjectDirectoryRoots(): Promise<readonly ProjectDirectoryRoot[]> {
    const result = await this.request("project.catalog.query", { kind: "directory_roots" });
    if (result.kind !== "directory_roots") throw invalidProjection("Project directory roots");
    return result.roots;
  }

  async listProjectDirectories(
    rootId: string,
    segments: readonly string[],
  ): Promise<readonly ProjectDirectoryEntry[]> {
    const entries: ProjectDirectoryEntry[] = [];
    let result = await this.request(
      "project.catalog.query",
      { kind: "directory_list_start", rootId, segments },
    );
    const cursors = new Set<string>();
    while (true) {
      if (result.kind !== "directory_page") throw invalidProjection("Project directory");
      if (result.rootId !== rootId || !sameSegments(result.segments, segments)) {
        throw invalidProjection("Project directory identity");
      }
      if (entries.length + result.entries.length > PROJECT_DIRECTORY_MAX_ENTRIES) {
        throw invalidProjection("Project directory has too many entries");
      }
      entries.push(...result.entries);
      if (result.nextCursor === null) return entries;
      if (cursors.has(result.nextCursor)) throw repeatedCursor("Project directory");
      cursors.add(result.nextCursor);
      result = await this.request("project.catalog.query", {
        kind: "directory_list_continue",
        rootId,
        segments,
        cursor: result.nextCursor,
      });
    }
  }

  async registerProjectDirectory(
    rootId: string,
    segments: readonly string[],
  ): Promise<ProjectCatalogProject> {
    return this.#projectForMutation(
      await this.#mutateProject({ kind: "register_directory", rootId, segments }),
    );
  }

  async relinkProject(projectId: string, path: string): Promise<ProjectCatalogProject> {
    return this.#projectForMutation(
      await this.#mutateProject({ kind: "relink", projectId, path }),
    );
  }

  async renameProject(projectId: string, name: string): Promise<ProjectCatalogProject> {
    return this.#projectForMutation(
      await this.#mutateProject({ kind: "rename", projectId, name }),
    );
  }

  async archiveProject(projectId: string): Promise<ProjectCatalogProject> {
    return this.#projectForMutation(
      await this.#mutateProject({ kind: "archive", projectId }),
    );
  }

  async restoreProject(projectId: string): Promise<ProjectCatalogProject> {
    return this.#projectForMutation(
      await this.#mutateProject({ kind: "restore", projectId }),
    );
  }

  #mutateProject(input: ProjectCatalogMutateInput) {
    this.#assertOpen();
    return this.request("project.catalog.mutate", input);
  }

  #projectForMutation(result: ProjectCatalogMutateResult): ProjectCatalogProject {
    if (result.kind !== "project") throw invalidProjection("Project mutation");
    return result.project;
  }

  async listArtifacts(sessionId: string): Promise<ArtifactProjection[]> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const first = await this.request("artifact.query", {
        kind: "list_start",
        sessionId,
      });
      if (first.kind !== "page") throw invalidProjection("Artifact");
      const artifacts = [...first.artifacts];
      const cursors = new Set<string>();
      let page: Extract<ArtifactQueryResult, { kind: "page" }> = first;
      let retry = false;
      while (page.nextCursor !== null) {
        if (cursors.has(page.nextCursor)) throw repeatedCursor("Artifact");
        cursors.add(page.nextCursor);
        const next = await this.request("artifact.query", {
          kind: "list_continue",
          sessionId,
          revision: first.revision,
          cursor: page.nextCursor,
        });
        if (next.kind === "revision_changed") {
          retry = true;
          break;
        }
        if (
          next.kind !== "page" ||
          next.sessionId !== sessionId ||
          next.revision !== first.revision
        ) {
          throw invalidProjection("Artifact");
        }
        artifacts.push(...next.artifacts);
        page = next;
      }
      if (!retry) return artifacts;
    }
    throw unstableProjection("Artifact", sessionId);
  }

  async getArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactProjection | null> {
    const result = await this.request("artifact.query", {
      kind: "get",
      sessionId,
      artifactId,
    });
    if (result.kind !== "artifact" || result.sessionId !== sessionId) {
      throw invalidProjection("Artifact");
    }
    return result.artifact;
  }

  async readArtifactText(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactTextPreview> {
    const result = await this.request("artifact.query", {
      kind: "read_text",
      sessionId,
      artifactId,
    });
    if (
      result.kind !== "text" ||
      result.sessionId !== sessionId ||
      result.artifactId !== artifactId
    ) {
      throw invalidProjection("Artifact");
    }
    return result.preview;
  }

  async readArtifactBinary(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactBinaryPreview> {
    const result = await this.request("artifact.query", {
      kind: "read_binary",
      sessionId,
      artifactId,
    });
    if (
      result.kind !== "binary" ||
      result.sessionId !== sessionId ||
      result.artifactId !== artifactId
    ) {
      throw invalidProjection("Artifact");
    }
    return result.preview;
  }

  deleteArtifact(sessionId: string, artifactId: string) {
    return this.request("artifact.delete", { sessionId, artifactId });
  }

  async streamArtifact(
    sessionId: string,
    artifactId: string,
    writeChunk: (chunk: Uint8Array) => Promise<void>,
  ): Promise<number> {
    let offset = 0;
    let expectedTotal: number | undefined;
    while (true) {
      const result = await this.request("artifact.query", {
        kind: "read_chunk",
        sessionId,
        artifactId,
        offset,
      });
      if (
        result.kind !== "chunk" ||
        result.sessionId !== sessionId ||
        result.artifactId !== artifactId ||
        result.offset !== offset ||
        (expectedTotal !== undefined && result.totalBytes !== expectedTotal)
      ) {
        throw invalidProjection("Artifact content");
      }
      expectedTotal ??= result.totalBytes;
      const chunk = Buffer.from(result.chunkBase64, "base64");
      if (chunk.byteLength > 0) await writeChunk(chunk);
      if (result.nextOffset === null) return result.totalBytes;
      if (result.nextOffset !== offset + chunk.byteLength) {
        throw invalidProjection("Artifact content");
      }
      offset = result.nextOffset;
    }
  }

  async getSession(
    sessionId: string,
  ): Promise<SessionCatalogProjection | null> {
    const result = await this.request("session.catalog.query", {
      kind: "get",
      sessionId,
    });
    if (result.kind !== "session") {
      throw new DesktopRuntimeHostClientError(
        "catalog_unstable",
        "Runtime Host returned an invalid Session catalog lookup",
      );
    }
    return result.session === null
      ? null
      : requireSessionProjection(result.session);
  }

  async createSession(
    input: SessionCreateInput,
  ): Promise<SessionCatalogProjection> {
    return requireSessionProjection(
      await this.request("session.create", input),
    );
  }

  listExternalSessionSources(): Promise<ExternalSessionSourceQueryResult> {
    return this.request("external-session.source.query", {});
  }

  listExternalSessions(
    input: ExternalSessionCatalogQueryInput,
  ): Promise<ExternalSessionCatalogQueryResult> {
    return this.request("external-session.catalog.query", input);
  }

  async importExternalSession(input: {
    readonly adapterId: string;
    readonly sourceSessionId: string;
  }): Promise<SessionCatalogProjection> {
    const result = await this.request("external-session.import", input);
    return requireSessionProjection(result.session);
  }

  updateSessionMetadata(
    sessionId: string,
    patch: SessionMetadataPatch,
  ): Promise<SessionCatalogProjection> {
    return this.#updateSession(sessionId, (current) =>
      this.request("session.metadata.update", {
        sessionId,
        expectedRevision: current.revision,
        patch,
      }),
    );
  }

  async updateSessionConfiguration(
    sessionId: string,
    patch: DesktopSessionConfigurationPatch,
  ): Promise<SessionCatalogProjection> {
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as DesktopSessionConfigurationPatch;
    if (Object.keys(definedPatch).length === 0)
      return this.#requireSession(sessionId);
    return this.#updateSession(sessionId, (current) =>
      this.request("session.configuration.update", {
        sessionId,
        expectedRevision: current.revision,
        configuration: {
          // An unlocked Session still follows the Host-owned default route.
          // Once execution or an explicit model change locks it, the resolved
          // catalog route is the explicit target that must survive this patch.
          modelTarget: current.connectionLocked
            ? {
                kind: "explicit",
                connectionSlug: current.llmConnectionSlug,
                model: current.model,
              }
            : { kind: "default" },
          thinkingLevel: current.thinkingLevel ?? null,
          permissionMode: current.permissionMode,
          collaborationMode: current.collaborationMode,
          orchestrationMode: current.orchestrationMode,
          ...definedPatch,
        },
      }),
    );
  }

  async setSessionReadMarker(
    sessionId: string,
    readThroughMessageId: string,
  ): Promise<SessionCatalogProjection> {
    return requireSessionProjection(
      await this.request("session.read_marker.set", {
        sessionId,
        readThroughMessageId,
      }),
    );
  }

  readExecutionBoundary(sessionId: string): Promise<ExecutionBoundarySummary> {
    return this.request("session.execution_boundary.query", { sessionId });
  }

  async setSessionLifecycle(
    sessionId: string,
    state: SessionLifecycleState,
  ): Promise<SessionCatalogProjection> {
    return requireSessionProjection(
      await this.request("session.lifecycle.set", { sessionId, state }),
    );
  }

  /**
   * Removes a Session, optionally only while it is still archived.
   *
   * Replaying a rejected write at the fresh revision is right for a rename or a
   * configuration patch — the write means the same thing either way. It is
   * wrong for a remove: a lifecycle write bumps the revision, so a conflict can
   * be the task being restored, and replaying then destroys a task whose
   * deletion nobody asked for any more.
   *
   * `requireArchived` states the premise the caller decided on. Re-asserting it
   * against each fresh read is enough to hold it through the commit, because
   * the Host serializes the two writes that could disagree: `session.remove`
   * and `session.lifecycle.set` both enter `#withStableFamily`, which queues
   * per Session id through the admission gate, and the remove compares the
   * revision on the way in. So a restore either lands before that comparison —
   * bumping `metadataVersion` and rejecting the remove — or waits until the
   * retirement has finished. It cannot land between the check and the delete.
   */
  async removeSession(
    sessionId: string,
    options: { requireArchived?: boolean } = {},
  ): Promise<SessionRemoveDisposition> {
    for (let attempt = 0; attempt < MAX_SESSION_REVISION_ATTEMPTS; attempt += 1) {
      const current = await this.#requireSession(sessionId);
      if (options.requireArchived && !current.isArchived) return "restored";
      const result = await this.request("session.remove", {
        sessionId,
        expectedRevision: current.revision,
      });
      if (result.kind === "removed") return "removed";
    }
    throw revisionConflict("remove", sessionId);
  }

  async removeSessionCopy(sessionId: string): Promise<'removed' | 'retained'> {
    try {
      const current = await this.#requireSession(sessionId);
      if (current.revisionOfTurnId !== undefined) {
        const result = await this.request('session.revision.abandon', {
          targetSessionId: sessionId,
        });
        return result.kind === 'abandoned' ? 'removed' : 'retained';
      }
      await this.removeSession(sessionId);
      return 'removed';
    } catch (error) {
      if (isMissingSessionError(error)) return 'removed';
      throw error;
    }
  }

  async copySession(
    kind: "branch" | "revision",
    input: Omit<SessionConversationCopyInput, "expectedSourceRevision">,
  ): Promise<SessionCatalogProjection> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const source = await this.#requireSession(input.sourceSessionId);
      const request = { ...input, expectedSourceRevision: source.revision };
      const result: SessionConversationCopyResult =
        kind === "branch"
          ? await this.request("session.branch.create", request)
          : await this.request("session.revision.create", request);
      if (result.kind === "committed")
        return requireSessionProjection(result.session);
    }
    throw revisionConflict(`${kind} copy`, input.sourceSessionId);
  }

  async ingestAttachment(input: {
    sessionId: string;
    name: string;
    mimeType: string;
    content: Uint8Array;
    uploadId?: string;
  }): Promise<AttachmentRef> {
    const uploadId = input.uploadId ?? randomUUID();
    const digest =
      `sha256:${createHash("sha256").update(input.content).digest("hex")}` as const;
    let opened = false;
    try {
      const begin = await this.request("artifact.ingest", {
        kind: "begin",
        sessionId: input.sessionId,
        uploadId,
        name: input.name,
        mimeType: input.mimeType,
        totalBytes: input.content.byteLength,
        contentSha256: digest,
      });
      if (begin.kind === "committed") return begin.attachment;
      if (begin.kind !== "upload_opened") {
        throw new Error("Runtime Host did not open the Attachment upload");
      }
      opened = true;
      let offset = begin.nextOffset;
      while (offset < input.content.byteLength) {
        const chunk = input.content.subarray(
          offset,
          Math.min(
            input.content.byteLength,
            offset + ARTIFACT_INGEST_CHUNK_MAX_BYTES,
          ),
        );
        const accepted = await this.request("artifact.ingest", {
          kind: "chunk",
          sessionId: input.sessionId,
          uploadId,
          offset,
          chunkBase64: Buffer.from(chunk).toString("base64"),
        });
        if (
          accepted.kind !== "chunk_accepted" ||
          accepted.nextOffset <= offset
        ) {
          throw new Error("Runtime Host did not advance the Attachment upload");
        }
        offset = accepted.nextOffset;
      }
      const committed = await this.request("artifact.ingest", {
        kind: "commit",
        sessionId: input.sessionId,
        uploadId,
      });
      if (committed.kind !== "committed") {
        throw new Error("Runtime Host did not commit the Attachment upload");
      }
      return committed.attachment;
    } catch (error) {
      if (opened) {
        await this.request("artifact.ingest", {
          kind: "abort",
          sessionId: input.sessionId,
          uploadId,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  submitMessage(
    input: Omit<TurnMessageSubmitInput, "originHostEpoch">,
  ): Promise<TurnMessageSubmitResult> {
    return this.request("turn.message.submit", {
      ...input,
      originHostEpoch: this.connection.hostEpoch,
    });
  }

  retractQueue(
    input: Omit<QueueRetractInput, "originHostEpoch">,
  ): Promise<QueueRetractResult> {
    return this.request("queue.retract", {
      ...input,
      originHostEpoch: this.connection.hostEpoch,
    });
  }

  interruptTurn(
    input: Omit<TurnInterruptInput, "originHostEpoch">,
  ): Promise<TurnInterruptResult> {
    return this.request("turn.interrupt", {
      ...input,
      originHostEpoch: this.connection.hostEpoch,
    });
  }

  answerInteraction(
    input: InteractionAnswerInput,
  ): Promise<OperationOutput<"interaction.answer">> {
    return this.request("interaction.answer", input);
  }

  queryInteraction(
    input: OperationInput<"interaction.query">,
  ): Promise<OperationOutput<"interaction.query">> {
    return this.request("interaction.query", input);
  }

  testNetworkProxy(
    input: OperationInput<"network-proxy.test">,
  ): Promise<OperationOutput<"network-proxy.test">> {
    return this.request("network-proxy.test", input);
  }

  exportConfigurationCredentials(
    input: OperationInput<"configuration.credentials.export">,
  ): Promise<OperationOutput<"configuration.credentials.export">> {
    return this.request("configuration.credentials.export", input);
  }

  startTurn(
    input: OperationInput<"turn.start">,
  ): Promise<OperationOutput<"turn.start">> {
    return this.request("turn.start", input);
  }

  queryTurn(
    input: OperationInput<"turn.query">,
  ): Promise<OperationOutput<"turn.query">> {
    return this.request("turn.query", input);
  }

  queryHostDiagnostics(): Promise<OperationOutput<"host.diagnostics.query">> {
    return this.connection.queryHostDiagnostics(2_000);
  }

  prepareHostUpgrade(
    allowInterruptActiveTasks: boolean,
  ): Promise<OperationOutput<"host.upgrade.prepare">> {
    return this.request("host.upgrade.prepare", {
      expectedHostEpoch: this.connection.hostEpoch,
      allowInterruptActiveTasks,
    });
  }

  stopTurn(
    input: OperationInput<"turn.stop">,
  ): Promise<OperationOutput<"turn.stop">> {
    return this.request("turn.stop", input);
  }

  regenerateTurn(
    input: OperationInput<"turn.regenerate">,
  ): Promise<OperationOutput<"turn.regenerate">> {
    return this.request("turn.regenerate", input);
  }

  queryTurnResume(
    input: OperationInput<"turn.resume.query">,
  ): Promise<OperationOutput<"turn.resume.query">> {
    return this.request("turn.resume.query", input);
  }

  startTurnResume(
    input: OperationInput<"turn.resume.start">,
  ): Promise<OperationOutput<"turn.resume.start">> {
    return this.request("turn.resume.start", input);
  }

  queryContextDiagnostics(
    sessionId: string,
  ): Promise<OperationOutput<"context.diagnostics.query">> {
    return this.request("context.diagnostics.query", { sessionId });
  }

  compactContext(
    input: OperationInput<"context.compact">,
  ): Promise<OperationOutput<"context.compact">> {
    return this.request("context.compact", input);
  }

  async listTasks(sessionId: string): Promise<Task[]> {
    const projection = await collectStableProjection({
      name: "Task ledger",
      sessionId,
      start: () =>
        this.request("task.ledger.query", { kind: "list_start", sessionId }),
      continue: (first, cursor) =>
        this.request("task.ledger.query", {
          kind: "list_continue",
          sessionId,
          revision: first.revision,
          cursor,
        }),
      page(result, first) {
        if (
          result.kind !== "page" ||
          result.sessionId !== sessionId ||
          (first !== undefined && result.revision !== first.revision)
        ) {
          throw invalidProjection("Task ledger");
        }
        return {
          source: result,
          items: result.tasks,
          nextCursor: result.nextCursor,
        };
      },
    });
    return projection.items;
  }

  queryUsage(
    input: OperationInput<"usage.query">,
  ): Promise<OperationOutput<"usage.query">> {
    return this.request("usage.query", input);
  }

  queryGoal(sessionId: string): Promise<OperationOutput<"goal.query">> {
    return this.request("goal.query", { sessionId });
  }

  /**
   * Arm a Goal the user asked for. No optimistic retry loop like `clearGoal`:
   * arming names no revision, so there is no stale one to refresh — a Session
   * that already has an unfinished Goal fails with `operation_conflict`, and
   * that is an answer for the user, not a race to re-run.
   */
  armGoal(input: OperationInput<"goal.arm">): Promise<OperationOutput<"goal.arm">> {
    return this.request("goal.arm", input);
  }

  controlGoal(
    goal: Pick<GoalProjection, "sessionId" | "goalId" | "revision">,
    action: GoalControlAction,
  ): Promise<OperationOutput<"goal.control">> {
    return this.request("goal.control", {
      sessionId: goal.sessionId,
      goalId: goal.goalId,
      expectedRevision: goal.revision,
      action,
    });
  }

  async controlGoalWithRetry(sessionId: string, action: GoalControlAction): Promise<void> {
    const initial = await this.queryGoal(sessionId);
    if (initial.goal === null) return;
    const goalId = initial.goal.goalId;
    let goal = initial.goal;
    let conflict: RuntimeHostOperationError | null = null;
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      try {
        await this.controlGoal(goal, action);
        return;
      } catch (error) {
        if (
          !(error instanceof RuntimeHostOperationError) ||
          error.code !== "operation_conflict"
        ) {
          throw error;
        }
        conflict = error;
        if (attempt === MAX_OPTIMISTIC_ATTEMPTS - 1) break; // a re-query would have no retry to serve
      }
      const current = await this.queryGoal(sessionId);
      if (current.goal === null || current.goal.goalId !== goalId) return;
      if (current.goal.revision === goal.revision) {
        // The host folds invalid transitions into operation_conflict too
        // ("Goal cannot pause from status paused"). Every accepted transition
        // bumps the revision, so a conflict at an unchanged revision is a
        // status refusal, not a race — retrying is futile; surface the reason.
        throw conflict;
      }
      goal = current.goal;
    }
    throw revisionConflict(`Goal ${action}`, sessionId);
  }

  async clearGoal(sessionId: string): Promise<void> {
    await this.controlGoalWithRetry(sessionId, "clear");
  }

  async getPlanState(sessionId: string): Promise<PlanSessionState> {
    const projection = await collectStableProjection({
      name: "Plan",
      sessionId,
      start: () =>
        this.request("plan.query", { kind: "list_start", sessionId }),
      continue: (first, cursor) =>
        this.request("plan.query", {
          kind: "list_continue",
          sessionId,
          storeVersion: first.storeVersion,
          cursor,
        }),
      page(result, first) {
        if (
          result.kind !== "page" ||
          result.sessionId !== sessionId ||
          (first !== undefined && result.storeVersion !== first.storeVersion)
        ) {
          throw invalidProjection("Plan");
        }
        return {
          source: result,
          items: result.items,
          nextCursor: result.nextCursor,
        };
      },
    });
    return planState(projection.first, projection.items);
  }

  controlPlan(
    input: PlanUserControlInput,
  ): Promise<OperationOutput<"plan.control">> {
    return this.request("plan.control", input);
  }

  startPlanTurn(
    input: OperationInput<"plan.turn.start">,
  ): Promise<OperationOutput<"plan.turn.start">> {
    return this.request("plan.turn.start", input);
  }

  queryAgentGraph(
    input: OperationInput<"agent.graph.query">,
  ): Promise<OperationOutput<"agent.graph.query">> {
    return this.request("agent.graph.query", input);
  }

  listAgentGraphEpochs(rootSessionId: string) {
    this.#assertOpen();
    return readRuntimeHostAgentGraphEpochs(this.connection, rootSessionId);
  }

  listCurrentAgentGraphEpochs(rootSessionId: string) {
    return this.request("agent.graph.epochs.query", { rootSessionId });
  }

  queryAgentGraphOperator(
    input: OperationInput<"agent.graph.operator.query">,
  ): Promise<OperationOutput<"agent.graph.operator.query">> {
    return this.request("agent.graph.operator.query", input);
  }

  stopAgentGraph(
    input: OperationInput<"agent.graph.stop">,
  ): Promise<OperationOutput<"agent.graph.stop">> {
    return this.request("agent.graph.stop", input);
  }

  queryDeepResearch(
    sessionId: string,
  ): Promise<OperationOutput<"deep-research.query">> {
    return this.request("deep-research.query", { sessionId });
  }

  async listRuntimeResources(sessionId: string): Promise<ShellRunUpdate[]> {
    this.#assertOpen();
    try {
      return await readRuntimeHostResources(this.connection, sessionId);
    } catch (error) {
      if (!(error instanceof RuntimeHostCatalogReadError)) throw error;
      throw unstableProjection("Runtime Resource", sessionId);
    }
  }

  async getRuntimeResource(
    sessionId: string,
    ref: string,
  ): Promise<ShellRunUpdate | null> {
    const result = await this.request("runtime.resource.query", {
      kind: "get",
      sessionId,
      ref,
    });
    if (result.kind !== "resource" || result.sessionId !== sessionId) {
      throw invalidProjection("Runtime Resource");
    }
    return result.resource;
  }

  startRuntimeResource(
    input: OperationInput<"runtime.resource.start">,
  ): Promise<OperationOutput<"runtime.resource.start">> {
    return this.request("runtime.resource.start", input);
  }

  acquireRuntimeResourceController(
    input: OperationInput<"runtime.resource.controller.acquire">,
  ): Promise<OperationOutput<"runtime.resource.controller.acquire">> {
    return this.request("runtime.resource.controller.acquire", input);
  }

  controlRuntimeResource(
    input: OperationInput<"runtime.resource.controller.control">,
  ): Promise<OperationOutput<"runtime.resource.controller.control">> {
    return this.request("runtime.resource.controller.control", input);
  }

  releaseRuntimeResourceController(
    input: OperationInput<"runtime.resource.controller.release">,
  ): Promise<OperationOutput<"runtime.resource.controller.release">> {
    return this.request("runtime.resource.controller.release", input);
  }

  stopRuntimeResource(
    input: OperationInput<"runtime.resource.stop">,
  ): Promise<OperationOutput<"runtime.resource.stop">> {
    return this.request("runtime.resource.stop", input);
  }

  replaceClientCapabilities(
    provider: ClientCapabilityProvider,
    timeoutMs?: number,
  ): Promise<ClientCapabilityReplaceResult> {
    this.#assertOpen();
    return this.connection.replaceClientCapabilities(provider, timeoutMs);
  }

  unregisterClientCapabilities(
    timeoutMs?: number,
  ): Promise<ClientCapabilityUnregisterResult> {
    this.#assertOpen();
    return this.connection.unregisterClientCapabilities(timeoutMs);
  }

  async openSession(sessionId: string): Promise<DesktopRuntimeHostSession> {
    this.#assertOpen();
    const subscription = await this.connection.openSessionSubscription({
      sessionId,
      transcript: { kind: "tail", maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
    });
    if (this.#closeTask) {
      await subscription.close().catch(() => undefined);
      throw clientClosed();
    }
    const session = new DesktopSessionHandle(subscription, () =>
      this.#sessions.delete(session),
    );
    this.#sessions.add(session);
    return session;
  }

  async listSessionTurns(sessionId: string): Promise<TurnRecord[]> {
    this.#assertOpen();
    const contributions = new Map<
      string,
      OperationOutput<'session.turns.query'>['contributions'][number]
    >();
    let throughSequence: number | null = null;
    let position = 0;
    const positions = new Set<number>();
    while (true) {
      if (positions.has(position)) throw invalidProjection('Session turns');
      positions.add(position);
      const page: OperationOutput<'session.turns.query'> = await this.request(
        'session.turns.query', {
          sessionId,
          throughSequence,
          position,
          maxContributions: 128,
        },
      );
      throughSequence = page.throughSequence;
      for (const contribution of page.contributions) {
        const current = contributions.get(contribution.turnId);
        if (!current) {
          contributions.set(contribution.turnId, contribution);
          continue;
        }
        contributions.set(
          contribution.turnId,
          mergeSessionTurnContributions(current, contribution),
        );
      }
      if (page.nextPosition === null) break;
      if (page.nextPosition <= position) throw invalidProjection('Session turns');
      position = page.nextPosition;
    }
    return [...contributions.values()]
      .sort((left, right) => left.firstSequence - right.firstSequence)
      .map(projectSessionTurnContribution);
  }

  async listSessionTurnLandmarks(
    sessionId: string,
  ): Promise<OperationOutput<'session.turn_landmarks.query'>> {
    this.#assertOpen();
    return this.request('session.turn_landmarks.query', {
      sessionId,
      maxLandmarks: 64,
    });
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    try {
      await Promise.all([...this.#sessions].map((session) => session.close()));
    } finally {
      await this.connection.close();
    }
  }

  async #readPricingSnapshot(): Promise<DesktopPricingSnapshot | undefined> {
    this.#assertOpen();
    const first = await this.request("pricing.query", { kind: "start" });
    if (first.kind !== "page" || first.offset !== 0) {
      throw new DesktopRuntimeHostClientError(
        "pricing_unstable",
        "Runtime Host returned an invalid initial Pricing page",
      );
    }
    const entries = [...first.entries];
    const offsets = new Set<number>([0]);
    let page: Extract<PricingQueryResult, { kind: "page" }> = first;
    while (page.nextOffset !== null) {
      const offset = page.nextOffset;
      if (offset <= page.offset || offsets.has(offset)) {
        throw new DesktopRuntimeHostClientError(
          "pricing_unstable",
          "Runtime Host repeated a Pricing page offset",
        );
      }
      offsets.add(offset);
      const next = await this.request("pricing.query", {
        kind: "continue",
        revision: first.revision,
        offset,
      });
      if (next.kind === "revision_changed") return undefined;
      if (next.revision !== first.revision || next.offset !== offset) {
        throw new DesktopRuntimeHostClientError(
          "pricing_unstable",
          "Runtime Host returned an inconsistent Pricing page",
        );
      }
      entries.push(...next.entries);
      page = next;
    }
    if (!pricingEntriesAreCanonical(entries)) {
      throw new DesktopRuntimeHostClientError(
        "pricing_unstable",
        "Runtime Host returned non-canonical Pricing pages",
      );
    }
    return {
      hostEpoch: this.connection.hostEpoch,
      connectionId: this.connection.connectionId,
      revision: first.revision,
      entries,
    };
  }

  async #reconcilePricingMutation(
    target: PricingReconciliationTarget,
    reason: "revision_conflict" | "outcome_unknown",
  ): Promise<DesktopPricingMutationOutcome> {
    try {
      const snapshot = await this.loadPricingSnapshot();
      return {
        kind: pricingTargetMatchesSnapshot(target, snapshot)
          ? "synchronized"
          : "review_required",
        reason,
        snapshot,
      };
    } catch {
      return { kind: "reconciliation_unavailable", reason };
    }
  }

  async #updateSession(
    sessionId: string,
    update: (current: SessionCatalogProjection) => Promise<SessionUpdateResult>,
  ): Promise<SessionCatalogProjection> {
    for (let attempt = 0; attempt < MAX_SESSION_REVISION_ATTEMPTS; attempt += 1) {
      const current = await this.#requireSession(sessionId);
      const result = await update(current);
      if (result.kind === "committed")
        return requireSessionProjection(result.session);
    }
    throw revisionConflict("update", sessionId);
  }

  async #requireSession(sessionId: string): Promise<SessionCatalogProjection> {
    const session = await this.getSession(sessionId);
    if (session) return session;
    throw new DesktopRuntimeHostClientError(
      "session_not_found",
      `Runtime Host Session not found: ${sessionId}`,
    );
  }

  request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>> {
    this.#assertOpen();
    return this.connection.request(operation, input, timeoutMs);
  }

  #assertOpen(): void {
    if (this.#closeTask) throw clientClosed();
  }
}

class DesktopSessionHandle implements DesktopRuntimeHostSession {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams: readonly SessionAssistantStreamIdentity[];
  readonly transcriptBootstrap: SessionTranscriptBootstrap;
  readonly events: AsyncIterable<SubscriptionFrame>;
  #closeTask: Promise<void> | undefined;
  #transcriptTask: Promise<StoredMessage[]> | undefined;

  constructor(
    private readonly subscription: RuntimeHostSessionSubscription,
    private readonly onClose: () => void,
  ) {
    if (!subscription.transcriptBootstrap) {
      throw new Error("Desktop Session subscription omitted its transcript bootstrap");
    }
    this.hostEpoch = subscription.hostEpoch;
    this.subscriptionId = subscription.subscriptionId;
    this.snapshot = subscription.snapshot;
    this.activeAssistantStreams = subscription.activeAssistantStreams;
    this.transcriptBootstrap = subscription.transcriptBootstrap;
    this.events = subscription;
  }

  loadTranscript(): Promise<StoredMessage[]> {
    this.#transcriptTask ??= this.subscription.loadTranscript(decodeStoredMessage);
    return this.#transcriptTask;
  }

  loadTranscriptOverlay(
    maxMessageBytes?: number,
    accountAssemblyBytes?: (deltaBytes: number) => void,
  ): Promise<StoredMessage[]> {
    return this.subscription.loadTranscriptOverlay(
      decodeStoredMessage,
      maxMessageBytes,
      accountAssemblyBytes,
    );
  }

  decodeTranscriptPage(
    page: SessionTranscriptPage,
    maxMessageBytes?: number,
    accountAssemblyBytes?: (deltaBytes: number) => void,
  ): Promise<DecodedSessionTranscriptPage<StoredMessage>> {
    return this.subscription.decodeTranscriptPage(
      page,
      decodeStoredMessage,
      maxMessageBytes,
      accountAssemblyBytes,
    );
  }

  loadTranscriptPage(
    input: Omit<SessionTranscriptPageInput, "subscriptionId">,
  ): Promise<SessionTranscriptPage> {
    return this.subscription.loadTranscriptPage(input);
  }

  close(): Promise<void> {
    this.#closeTask ??= this.subscription.close().finally(this.onClose);
    return this.#closeTask;
  }
}

function requireSessionProjection(
  item: SessionCatalogItem,
): SessionCatalogProjection {
  if (!("kind" in item)) return item;
  throw new DesktopRuntimeHostClientError(
    "unsupported_session",
    `Runtime Host Session is not representable by this Desktop Client: ${item.id}`,
  );
}

function clientClosed(): DesktopRuntimeHostClientError {
  return new DesktopRuntimeHostClientError(
    "client_closed",
    "Desktop Runtime Host Client is closed",
  );
}

function isMissingSessionError(error: unknown): boolean {
  return (
    (error instanceof DesktopRuntimeHostClientError && error.code === 'session_not_found') ||
    (error instanceof RuntimeHostOperationError && error.code === 'not_found')
  );
}

function revisionConflict(
  operation: string,
  sessionId: string,
): DesktopRuntimeHostClientError {
  return new DesktopRuntimeHostClientError(
    "revision_conflict",
    `Runtime Host Session kept changing during ${operation}: ${sessionId}`,
  );
}

function planState(
  first: Extract<PlanQueryResult, { kind: "page" }>,
  items: readonly PlanProjectionItem[],
): PlanSessionState {
  return {
    schemaVersion: 1,
    sessionId: first.sessionId,
    storeVersion: first.storeVersion,
    proposals: items.flatMap((item) =>
      item.kind === "proposal" ? [item.proposal] : [],
    ),
    executions: items.flatMap((item) =>
      item.kind === "execution" ? [item.execution] : [],
    ),
    ...(first.latestProposalId === null
      ? {}
      : { latestProposalId: first.latestProposalId }),
    ...(first.activeExecutionId === null
      ? {}
      : { activeExecutionId: first.activeExecutionId }),
  };
}

interface StableProjectionPage<TResult extends { kind: string }, TItem> {
  source: Exclude<TResult, { kind: "revision_changed" }>;
  items: readonly TItem[];
  nextCursor: string | null;
}

async function collectStableProjection<
  TResult extends { kind: string },
  TItem,
>(options: {
  name: string;
  sessionId: string;
  start(): Promise<TResult>;
  continue(
    first: Exclude<TResult, { kind: "revision_changed" }>,
    cursor: string,
  ): Promise<TResult>;
  page(
    result: TResult,
    first: Exclude<TResult, { kind: "revision_changed" }> | undefined,
  ): StableProjectionPage<TResult, TItem>;
}): Promise<{
  first: Exclude<TResult, { kind: "revision_changed" }>;
  items: TItem[];
}> {
  for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
    const initial = await options.start();
    if (initial.kind === "revision_changed")
      throw invalidProjection(options.name);
    const first = options.page(initial, undefined);
    const items = [...first.items];
    const cursors = new Set<string>();
    let cursor = first.nextCursor;
    let retry = false;
    while (cursor !== null) {
      if (cursors.has(cursor)) throw repeatedCursor(options.name);
      cursors.add(cursor);
      const result = await options.continue(first.source, cursor);
      if (result.kind === "revision_changed") {
        retry = true;
        break;
      }
      const page = options.page(result, first.source);
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    if (!retry) return { first: first.source, items };
  }
  throw unstableProjection(options.name, options.sessionId);
}

function invalidProjection(name: string): DesktopRuntimeHostClientError {
  return new DesktopRuntimeHostClientError(
    "projection_unstable",
    `Runtime Host returned an invalid ${name} projection`,
  );
}

function repeatedCursor(name: string): DesktopRuntimeHostClientError {
  return new DesktopRuntimeHostClientError(
    "projection_unstable",
    `Runtime Host repeated a ${name} cursor`,
  );
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function unstableProjection(
  name: string,
  sessionId: string,
): DesktopRuntimeHostClientError {
  return new DesktopRuntimeHostClientError(
    "projection_unstable",
    `Runtime Host ${name} kept changing while Desktop read Session ${sessionId}`,
  );
}

function createPricingReconciliationTarget(
  base: DesktopPricingSnapshot,
  mutation: PricingMutation,
): PricingReconciliationTarget {
  if (mutation.kind === "upsert")
    return { kind: "upsert", pricing: mutation.pricing };
  const baseEntry = base.entries.find(
    ({ pricing }) => pricing.modelKey === mutation.modelKey,
  );
  const expected =
    baseEntry?.source === "custom"
      ? baseEntry.resetEffect === "restore_builtin"
        ? "builtin"
        : "unpriced"
      : "no_override";
  return { kind: "delete", modelKey: mutation.modelKey, expected };
}

function pricingTargetMatchesSnapshot(
  target: PricingReconciliationTarget,
  snapshot: DesktopPricingSnapshot,
): boolean {
  const current = snapshot.entries.find(
    ({ pricing }) => pricing.modelKey === pricingTargetModelKey(target),
  );
  if (target.kind === "upsert") {
    return (
      current?.source === "custom" &&
      canonicalPricingConfigsEqual(current.pricing, target.pricing)
    );
  }
  switch (target.expected) {
    case "builtin":
      return current?.source === "builtin";
    case "unpriced":
      return current === undefined;
    case "no_override":
      return current === undefined || current.source === "builtin";
  }
}

function pricingTargetModelKey(target: PricingReconciliationTarget): string {
  return target.kind === "upsert" ? target.pricing.modelKey : target.modelKey;
}

function pricingEntriesAreCanonical(
  entries: readonly EffectivePricingEntry[],
): boolean {
  return entries.every(
    (entry, index) =>
      index === 0 ||
      comparePricingModelKeys(
        entries[index - 1]!.pricing.modelKey,
        entry.pricing.modelKey,
      ) < 0,
  );
}
