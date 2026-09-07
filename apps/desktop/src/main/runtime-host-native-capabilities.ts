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

import { Buffer } from "node:buffer";
import type { ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  createOAuthPresentationClientProvider,
  type ClientCapabilityProvider,
  type OAuthPresentationBackend,
} from "@maka/runtime-host/client";
import {
  CLIENT_CAPABILITY_MAX_MANIFEST_BYTES,
  CLIENT_CAPABILITY_MAX_OFFERS,
  CLIENT_CAPABILITY_MAX_TOOLS,
  CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER,
  decodeClientCapabilityReplaceInput,
  decodeClientCapabilityToolDescriptor,
  projectToolInputSchema,
  type ClientCapabilityCallFrame,
  type ClientCapabilityCallResult,
  type ClientCapabilityContentBlock,
  type ClientCapabilityHostPathAccess,
  type ClientCapabilityOffer,
  type ClientCapabilityServiceCallFrame,
  type ClientCapabilityServiceOffer,
  type ClientCapabilityToolDescriptor,
} from "@maka/runtime-host/protocol";
import { clientCapabilityEntityId } from "@maka/runtime-host/client-capability-entity-id";
import { toJSONSchema, z } from "zod";
import { withBrowserOriginAdmission } from './browser/browser-origin-admission.js';
import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';

const CAPABILITY_VERSION = "0";
const BROWSER_OFFER_ID = "desktop_browser";
const COMPUTER_USE_OFFER_ID = "desktop_computer_use";
// Same wire length as the registrationId the Client Capability channel assigns.
const MANIFEST_REGISTRATION_ID_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

/** A tool published under its own wire identity instead of the group default. */
export interface DesktopIdentifiedCapabilityTool {
  readonly tool: MakaTool;
  readonly serverId: string;
  readonly toolName: string;
}

export interface DesktopCapabilityGroup {
  readonly offerId: string;
  readonly label: string;
  readonly description: string;
  readonly tools: readonly (MakaTool | DesktopIdentifiedCapabilityTool)[];
  /**
   * Marks a dynamically sourced group: tools the decoder rejects are omitted
   * with a diagnostic, the group may be chunked past the single-offer tool
   * limit, and its trailing tools are shed first under the manifest budget.
   * Fixed groups never set this — their failures stay loud.
   */
  readonly dynamic?: boolean;
}

interface PreparedDesktopCapabilityTool {
  readonly tool: MakaTool;
  readonly descriptor: ClientCapabilityToolDescriptor;
}

interface PreparedDesktopCapabilityGroup {
  readonly offerId: string;
  readonly label: string;
  readonly description: string;
  readonly tools: readonly PreparedDesktopCapabilityTool[];
  readonly dynamic?: boolean;
}

type NativeToolBinding = Pick<PreparedDesktopCapabilityTool, "tool">;

type DesktopToolModelOutput = Awaited<
  ReturnType<NonNullable<MakaTool["toModelOutput"]>>
>;
type DesktopToolContentPart = Extract<
  DesktopToolModelOutput,
  { type: "content" }
>["value"][number];

export interface DesktopNativeCapabilityProviderInput {
  readonly browserTools: readonly MakaTool[];
  readonly resolveBrowserUrl: (input: {
    readonly sessionId: string;
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly signal: AbortSignal;
  }) => string | Promise<string>;
  readonly releaseBrowserSession: (sessionId: string) => void | Promise<void>;
  readonly computerUseTools: ComputerUseToolSet;
  readonly releaseComputerUseSession: (
    sessionId: string,
  ) => void | Promise<void>;
  readonly oauthPresentation?: OAuthPresentationBackend;
  readonly additionalGroups?: () => readonly DesktopCapabilityGroup[];
  readonly additionalServices?: (
    scope: DesktopTargetScope,
  ) => readonly DesktopCapabilityService[];
}

export interface DesktopCapabilityService extends ClientCapabilityServiceOffer {
  call(
    method: string,
    input: Record<string, unknown>,
    options: { readonly signal: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

export interface DesktopNativeCapabilityProvider extends ClientCapabilityProvider {
  abortSession(sessionId: string): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

interface DesktopNativeCapabilityProviderOptions {
  readonly releaseResourcesOnClose?: boolean;
  readonly hostPathAccess?: ClientCapabilityHostPathAccess;
  readonly clientCwd?: string;
  readonly isTargetValid?: () => boolean;
  readonly onSessionUsed?: (sessionId: string) => void;
  readonly onComputerUseTurnUsed?: (sessionId: string, turnId: string) => void;
  readonly onClosed?: () => void;
  /** Reports a visible degradation while assembling the published manifest. */
  readonly onDiagnostic?: (diagnostic: string) => void;
  readonly nativeSessionId?: (sessionId: string) => string;
  readonly targetScope?: DesktopTargetScope;
}

/** Adapt Desktop-owned Maka tools to the open Client Capability protocol. */
export function createDesktopNativeCapabilityProvider(
  input: DesktopNativeCapabilityProviderInput,
  providerOptions: DesktopNativeCapabilityProviderOptions = {},
): DesktopNativeCapabilityProvider {
  const hostPathAccess = providerOptions.hostPathAccess ?? "cwd";
  const oauthPresentation = input.oauthPresentation
    ? createOAuthPresentationClientProvider(input.oauthPresentation)
    : undefined;
  const additionalServices = input.additionalServices
    ? input.additionalServices(requireTargetScope(providerOptions.targetScope))
    : [];
  const services = indexServices(oauthPresentation?.services?.() ?? [], additionalServices);
  const serviceOffers = Object.freeze(
    [...services.values()].map(({ serviceId, version }) =>
      Object.freeze({ serviceId, version }),
    ),
  );
  const groups = fitDesktopCapabilityManifest(
    prepareCapabilityGroups(capabilityGroups(input), providerOptions.onDiagnostic),
    serviceOffers,
    hostPathAccess,
    providerOptions.onDiagnostic,
  );
  const offers = Object.freeze(
    groups.map((group) => capabilityOffer(group, hostPathAccess)),
  );
  // Authoritative check: a manifest that will be sent must decode first, so a
  // budget overrun can never fail the whole registration at the channel. An
  // empty provider is legal and never registers.
  if (offers.length > 0 || serviceOffers.length > 0) {
    decodeClientCapabilityReplaceInput({
      registrationId: MANIFEST_REGISTRATION_ID_PLACEHOLDER,
      offers,
      ...(serviceOffers.length === 0 ? {} : { services: serviceOffers }),
    });
  }
  const bindings = indexBindings(groups);
  const releaseSessionResources = [
    input.releaseBrowserSession,
    input.releaseComputerUseSession,
  ] as const;
  const activeInvocations = new Map<
    AbortController,
    { readonly sessionId: string; readonly settled: Promise<void> }
  >();
  const usedSessionIds = new Set<string>();
  let closed = false;
  let closeTask: Promise<void> | undefined;

  function close(): Promise<void> {
    if (closeTask) return closeTask;
    closed = true;
    closeTask = closeProvider(
      activeInvocations,
      usedSessionIds,
      releaseSessionResources,
      providerOptions.releaseResourcesOnClose !== false,
    ).finally(() => providerOptions.onClosed?.());
    return closeTask;
  }

  return {
    offers: () => offers,
    services: () => [...serviceOffers],
    call: (frame, options) => {
      if (closed)
        throw new Error("Desktop native capability provider is closed");
      if (providerOptions.isTargetValid?.() === false) {
        throw new Error("Desktop native capability target is no longer valid");
      }
      const binding = bindings.get(bindingKey(frame));
      if (!binding) throw new Error("Desktop native capability is not offered");

      const invocation = new AbortController();
      const task = invokeNativeTool(
        input,
        binding,
        frame,
        options,
        providerOptions,
        invocation,
        usedSessionIds,
      );
      const settled = task.then(
        () => undefined,
        () => undefined,
      );
      activeInvocations.set(invocation, {
        sessionId: frame.sessionId,
        settled,
      });
      void settled.finally(() => activeInvocations.delete(invocation));
      return task;
    },
    callService: (frame, options) => {
      if (closed)
        throw new Error("Desktop native capability provider is closed");
      if (providerOptions.isTargetValid?.() === false) {
        throw new Error("Desktop native capability target is no longer valid");
      }
      const service = services.get(serviceKey(frame));
      if (service?.kind === "additional") {
        return invokeAdditionalService(service.value, frame, options);
      }
      if (!oauthPresentation?.callService) throw new Error("Desktop native capability service is not offered");
      return oauthPresentation.callService(frame, options);
    },
    abortSession: async (sessionId) => {
      const settling = abortInvocations(activeInvocations, sessionId);
      await Promise.all(settling);
    },
    releaseSession: async (sessionId) => {
      const settling = abortInvocations(activeInvocations, sessionId);
      await Promise.all(settling);
      usedSessionIds.delete(sessionId);
      await settleSessionReleases(releaseSessionResources, [sessionId]);
    },
    close,
  };
}

function requireTargetScope(scope: DesktopTargetScope | undefined): DesktopTargetScope {
  if (!scope) throw new Error('Desktop native capability target scope is required');
  return scope;
}

type IndexedService =
  | { readonly kind: "oauth"; readonly serviceId: string; readonly version: string }
  | { readonly kind: "additional"; readonly serviceId: string; readonly version: string; readonly value: DesktopCapabilityService };

function indexServices(
  oauth: readonly ClientCapabilityServiceOffer[],
  additional: readonly DesktopCapabilityService[],
): Map<string, IndexedService> {
  const services = new Map<string, IndexedService>();
  for (const service of oauth) {
    services.set(serviceKey(service), { kind: "oauth", ...service });
  }
  for (const service of additional) {
    const key = serviceKey(service);
    if (services.has(key)) throw new Error(`Duplicate Desktop capability service: ${key}`);
    services.set(key, { kind: "additional", ...service, value: service });
  }
  return services;
}

function serviceKey(
  service: Pick<ClientCapabilityServiceOffer, "serviceId" | "version">,
): string {
  return `${service.serviceId}\0${service.version}`;
}

async function invokeAdditionalService(
  service: DesktopCapabilityService,
  frame: ClientCapabilityServiceCallFrame,
  options: Parameters<NonNullable<ClientCapabilityProvider["callService"]>>[1],
): Promise<Record<string, unknown>> {
  options.signal.throwIfAborted();
  await options.accept({ kind: "none" });
  options.signal.throwIfAborted();
  return service.call(frame.method, frame.input, { signal: options.signal });
}

async function closeProvider(
  activeInvocations: ReadonlyMap<
    AbortController,
    { readonly sessionId: string; readonly settled: Promise<void> }
  >,
  usedSessionIds: Set<string>,
  releases: readonly ((sessionId: string) => void | Promise<void>)[],
  releaseResources: boolean,
): Promise<void> {
  const settling: Promise<void>[] = [];
  for (const [invocation, active] of activeInvocations) {
    invocation.abort(new Error("Desktop native capability provider closed"));
    settling.push(active.settled);
  }
  await Promise.all(settling);
  const sessionIds = [...usedSessionIds];
  usedSessionIds.clear();
  if (releaseResources) await settleSessionReleases(releases, sessionIds);
}

async function settleSessionReleases(
  releases: readonly ((sessionId: string) => void | Promise<void>)[],
  sessionIds: readonly string[],
): Promise<void> {
  const results = await Promise.allSettled(
    sessionIds.flatMap((sessionId) =>
      releases.map(async (release) => release(sessionId)),
    ),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

function capabilityGroups(
  input: DesktopNativeCapabilityProviderInput,
): DesktopCapabilityGroup[] {
  return [
    ...(input.browserTools.length > 0
      ? [
          {
            offerId: BROWSER_OFFER_ID,
            label: "Browser",
            description:
              "Operate the embedded browser owned by this Desktop client.",
            tools: input.browserTools,
          },
        ]
      : []),
    ...(input.computerUseTools.length > 0
      ? [
          {
            offerId: COMPUTER_USE_OFFER_ID,
            label: "Computer Use",
            description:
              "Observe and operate the desktop through this Desktop client.",
            tools: input.computerUseTools,
          },
        ]
      : []),
    ...(input.additionalGroups?.() ?? []),
  ];
}

async function invokeNativeTool(
  input: DesktopNativeCapabilityProviderInput,
  binding: NativeToolBinding,
  frame: ClientCapabilityCallFrame,
  options: Parameters<NonNullable<ClientCapabilityProvider["call"]>>[1],
  providerOptions: DesktopNativeCapabilityProviderOptions,
  invocation: AbortController,
  usedSessionIds: Set<string>,
): Promise<ClientCapabilityCallResult> {
  const hostPathAccess = providerOptions.hostPathAccess ?? "cwd";
  if (hostPathAccess === "none" && frame.cwd !== undefined) {
    throw new Error("Desktop native capability does not accept a Host path");
  }
  const cwd = hostPathAccess === "cwd"
    ? frame.cwd ?? providerOptions.clientCwd
    : providerOptions.clientCwd;
  if (cwd === undefined) {
    throw new Error("Desktop native capability requires an execution cwd");
  }
  const signal = AbortSignal.any([options.signal, invocation.signal]);
  signal.throwIfAborted();
  const args = await parseNativeToolArguments(binding.tool.parameters, frame.arguments);
  signal.throwIfAborted();
  const sessionId =
    frame.offerId === BROWSER_OFFER_ID || frame.offerId === COMPUTER_USE_OFFER_ID
      ? providerOptions.nativeSessionId?.(frame.sessionId) ?? frame.sessionId
      : frame.sessionId;
  const admissionEvidence =
    frame.offerId === BROWSER_OFFER_ID
      ? {
          kind: "browser_url" as const,
          url: await input.resolveBrowserUrl({
            sessionId,
            toolName: frame.toolName,
            arguments: frame.arguments,
            signal,
          }),
        }
      : { kind: "none" as const };
  signal.throwIfAborted();
  await options.accept(admissionEvidence);
  signal.throwIfAborted();
  if (admissionEvidence.kind === "browser_url") {
    const currentUrl = await input.resolveBrowserUrl({
      sessionId,
      toolName: frame.toolName,
      arguments: frame.arguments,
      signal,
    });
    if (browserOrigin(currentUrl) !== browserOrigin(admissionEvidence.url)) {
      throw new Error("Browser origin changed while admission was pending");
    }
  }
  signal.throwIfAborted();
  usedSessionIds.add(frame.sessionId);
  providerOptions.onSessionUsed?.(frame.sessionId);
  if (frame.offerId === COMPUTER_USE_OFFER_ID) {
    providerOptions.onComputerUseTurnUsed?.(frame.sessionId, frame.turnId);
  }
  const execute = () =>
    binding.tool.impl(args, {
      sessionId,
      turnId: frame.turnId,
      cwd,
      toolCallId: frame.toolCallId,
      abortSignal: signal,
      emitOutput() {},
      ...(options.progress ? { emitProgress: options.progress } : {}),
    });
  const output = await (admissionEvidence.kind === "browser_url"
    ? withBrowserOriginAdmission(
        { sessionId, url: admissionEvidence.url },
        execute,
      )
    : execute());
  return projectToolResult(binding.tool, frame.toolCallId, args, output);
}

function browserOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser admission requires an HTTP origin");
  }
  return url.origin;
}

function abortInvocations(
  activeInvocations: ReadonlyMap<
    AbortController,
    { readonly sessionId: string; readonly settled: Promise<void> }
  >,
  sessionId: string,
): Promise<void>[] {
  const settling: Promise<void>[] = [];
  for (const [invocation, active] of activeInvocations) {
    if (active.sessionId !== sessionId) continue;
    invocation.abort(new Error("Desktop native capability Session released"));
    settling.push(active.settled);
  }
  return settling;
}

function capabilityOffer(
  group: PreparedDesktopCapabilityGroup,
  hostPathAccess: ClientCapabilityHostPathAccess,
): ClientCapabilityOffer {
  return Object.freeze({
    offerId: group.offerId,
    version: CAPABILITY_VERSION,
    affinity: "session",
    hostPathAccess,
    label: group.label,
    description: group.description,
    tools: Object.freeze(
      group.tools.map(({ descriptor }) => descriptor),
    ),
  });
}

function prepareCapabilityGroups(
  groups: readonly DesktopCapabilityGroup[],
  onDiagnostic?: (diagnostic: string) => void,
): PreparedDesktopCapabilityGroup[] {
  return groups.flatMap((group) => {
    const tools = group.tools.flatMap((entry): PreparedDesktopCapabilityTool[] => {
      const tool = isIdentifiedEntry(entry) ? entry.tool : entry;
      const identity = isIdentifiedEntry(entry)
        ? { serverId: entry.serverId, toolName: entry.toolName }
        : undefined;
      let descriptor: ClientCapabilityToolDescriptor;
      try {
        const declaredSchema = declaredToolInputSchema(tool);
        descriptor = Object.freeze(
          decodeClientCapabilityToolDescriptor(
            capabilityToolDescriptor(group.offerId, tool, declaredSchema, identity),
          ),
        );
      } catch (error) {
        const dynamic = group.dynamic || group.offerId === 'desktop_mcp';
        if (!dynamic) throw error;
        onDiagnostic?.(
          `Desktop omitted ${group.offerId} tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
      return [{ tool, descriptor }];
    });
    if (group.dynamic && tools.length === 0) return [];
    return chunkPreparedGroup({ ...group, tools });
  });
}

/**
 * Split a dynamic group beyond the single-offer tool limit into stable chunks.
 * Chunked offers keep the group's server identity, so published tool names and
 * Session Grant scopes do not depend on how the group was split. The grant key
 * still carries the offer contract, so changing the published tool set
 * re-prompts already-approved tools.
 */
function chunkPreparedGroup(
  group: PreparedDesktopCapabilityGroup,
): PreparedDesktopCapabilityGroup[] {
  if (
    !group.dynamic ||
    group.tools.length <= CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER
  ) {
    return [group];
  }
  const chunks: PreparedDesktopCapabilityGroup[] = [];
  for (
    let offset = 0;
    offset < group.tools.length;
    offset += CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER
  ) {
    chunks.push({
      ...group,
      offerId:
        offset === 0
          ? group.offerId
          : `${group.offerId}_${offset / CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER + 1}`,
      tools: group.tools.slice(offset, offset + CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER),
    });
  }
  return chunks;
}

/**
 * Fit the assembled manifest to the Client Capability budgets before it is
 * sent. Fixed capability groups are never degraded: if they alone exceed a
 * budget the registration must fail loudly. Dynamic (omittable) groups shed
 * their trailing tools instead, and the omission is reported.
 */
function fitDesktopCapabilityManifest(
  groups: readonly PreparedDesktopCapabilityGroup[],
  services: readonly ClientCapabilityServiceOffer[],
  hostPathAccess: ClientCapabilityHostPathAccess,
  onDiagnostic?: (diagnostic: string) => void,
): PreparedDesktopCapabilityGroup[] {
  const fitting = groups.map((group) => ({ group, tools: [...group.tools] }));
  const omitted: string[] = [];
  const assemble = (): PreparedDesktopCapabilityGroup[] =>
    fitting
      .filter((entry) => entry.tools.length > 0)
      .map((entry) => ({ ...entry.group, tools: entry.tools }));
  while (!manifestFitsBudget(assemble(), services, hostPathAccess)) {
    let index = fitting.length - 1;
    while (
      index >= 0 &&
      (!fitting[index]?.group.dynamic || fitting[index]?.tools.length === 0)
    ) {
      index -= 1;
    }
    const entry = fitting[index];
    if (!entry) {
      throw new Error(
        "Desktop fixed capability groups exceed the Client Capability manifest budget",
      );
    }
    const dropped = entry.tools.pop();
    if (dropped) omitted.push(dropped.descriptor.name);
  }
  if (omitted.length > 0) {
    const names = omitted.reverse();
    const shown = names.slice(0, 8).join(", ");
    onDiagnostic?.(
      `Desktop omitted ${names.length} MCP tool(s) beyond the Client Capability manifest budget: ${shown}${names.length > 8 ? `, +${names.length - 8} more` : ""}`,
    );
  }
  return assemble();
}

function manifestFitsBudget(
  groups: readonly PreparedDesktopCapabilityGroup[],
  services: readonly ClientCapabilityServiceOffer[],
  hostPathAccess: ClientCapabilityHostPathAccess,
): boolean {
  if (groups.length > CLIENT_CAPABILITY_MAX_OFFERS) return false;
  const offers = groups.map((group) => capabilityOffer(group, hostPathAccess));
  let toolCount = 0;
  for (const offer of offers) toolCount += offer.tools.length;
  if (toolCount > CLIENT_CAPABILITY_MAX_TOOLS) return false;
  const manifest = {
    registrationId: MANIFEST_REGISTRATION_ID_PLACEHOLDER,
    offers,
    ...(services.length === 0 ? {} : { services }),
  };
  return (
    Buffer.byteLength(JSON.stringify(manifest), "utf8") <= CLIENT_CAPABILITY_MAX_MANIFEST_BYTES
  );
}

function isIdentifiedEntry(
  entry: MakaTool | DesktopIdentifiedCapabilityTool,
): entry is DesktopIdentifiedCapabilityTool {
  return 'tool' in entry;
}

function capabilityToolDescriptor(
  offerId: string,
  tool: MakaTool,
  inputSchema: Record<string, unknown>,
  identity?: { readonly serverId: string; readonly toolName: string },
): ClientCapabilityToolDescriptor {
  return Object.freeze({
    serverId: clientCapabilityEntityId(identity?.serverId ?? offerId),
    name: clientCapabilityEntityId(identity?.toolName ?? tool.name),
    description: tool.description,
    inputSchema,
    ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
    ...(tool.displayName
      ? { annotations: Object.freeze({ title: tool.displayName }) }
      : {}),
  });
}

function declaredToolInputSchema(tool: MakaTool): Record<string, unknown> {
  const schema = tool.parameters instanceof z.ZodType
    ? toJSONSchema(tool.parameters, {
        io: "input",
        target: "draft-07",
        unrepresentable: "any",
        cycles: "ref",
        reused: "inline",
      })
    : cloneDeclaredJsonSchema(tool);
  delete schema.$schema;
  return Object.freeze(projectToolInputSchema(schema));
}

function cloneDeclaredJsonSchema(tool: MakaTool): Record<string, unknown> {
  const parameters = tool.parameters as { readonly jsonSchema?: unknown } | undefined;
  const schema = parameters?.jsonSchema;
  if (!isPlainRecord(schema)) {
    throw new Error(
      `Desktop native capability tool has an invalid schema: ${tool.name}`,
    );
  }
  const projected = Object.hasOwn(schema, 'type')
    ? schema
    : { ...schema, type: 'object' };
  return structuredClone(projected);
}

async function parseNativeToolArguments(parameters: unknown, args: unknown): Promise<unknown> {
  if (parameters instanceof z.ZodType) {
    return parameters.parseAsync(args);
  }
  // MCP servers remain the authority for their full JSON Schema. The Client
  // Capability publication is a deliberately smaller protocol projection, so
  // compiling the external schema again here would duplicate that authority
  // and execute untrusted regular expressions on the main thread.
  return args;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function indexBindings(
  groups: readonly PreparedDesktopCapabilityGroup[],
): Map<string, NativeToolBinding> {
  const bindings = new Map<string, NativeToolBinding>();
  for (const group of groups) {
    for (const { tool, descriptor } of group.tools) {
      const key = bindingKey({
        offerId: group.offerId,
        serverId: descriptor.serverId,
        toolName: descriptor.name,
      });
      if (bindings.has(key)) {
        throw new Error(
          `Duplicate Desktop native capability tool: ${group.offerId}/${tool.name}`,
        );
      }
      bindings.set(key, { tool });
    }
  }
  return bindings;
}

function bindingKey(
  frame: Pick<ClientCapabilityCallFrame, "offerId" | "serverId" | "toolName">,
): string {
  return `${frame.offerId}\0${frame.serverId}\0${frame.toolName}`;
}

async function projectToolResult(
  tool: MakaTool,
  toolCallId: string,
  input: unknown,
  output: unknown,
): Promise<ClientCapabilityCallResult> {
  const modelOutput = tool.toModelOutput
    ? await tool.toModelOutput({
        toolCallId,
        input,
        output,
      })
    : undefined;
  if (!modelOutput) {
    return typeof output === "string"
      ? { content: [{ type: "text", text: output }] }
      : { content: [], structuredContent: output };
  }
  switch (modelOutput.type) {
    case "text":
    case "error-text":
      return { content: [{ type: "text", text: modelOutput.value }] };
    case "json":
    case "error-json":
      return { content: [], structuredContent: modelOutput.value };
    case "execution-denied":
      return {
        content: [
          { type: "text", text: modelOutput.reason ?? "Execution denied" },
        ],
      };
    case "content":
      return { content: modelOutput.value.map(projectContentPart) };
  }
}

function projectContentPart(
  part: DesktopToolContentPart,
): ClientCapabilityContentBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "file":
      if (part.data.type !== "data") {
        throw new Error(
          "Desktop native capability cannot return referenced or URL files",
        );
      }
      return projectBinaryContent(part.data.data, part.mediaType);
    default:
      throw new Error(
        `Desktop native capability cannot return ${part.type} content`,
      );
  }
}

function projectBinaryContent(
  data: string | Uint8Array | ArrayBuffer | Buffer,
  mimeType: string,
): ClientCapabilityContentBlock {
  const encoded =
    typeof data === "string"
      ? data
      : Buffer.from(
          data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        ).toString("base64");
  if (mimeType.startsWith("image/"))
    return { type: "image", data: encoded, mimeType };
  if (mimeType.startsWith("audio/"))
    return { type: "audio", data: encoded, mimeType };
  throw new Error(
    `Desktop native capability cannot return file type ${mimeType}`,
  );
}
