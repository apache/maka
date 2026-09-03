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
  decodeClientCapabilityReplaceInput,
  type ClientCapabilityCallFrame,
  type ClientCapabilityCallResult,
  type ClientCapabilityContentBlock,
  type ClientCapabilityHostPathAccess,
  type ClientCapabilityOffer,
  type ClientCapabilityServiceCallFrame,
  type ClientCapabilityServiceOffer,
  type ClientCapabilityToolDescriptor,
} from "@maka/runtime-host/protocol";
import { toJSONSchema, z } from "zod";
import { withBrowserOriginAdmission } from './browser/browser-origin-admission.js';
import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';

const CAPABILITY_VERSION = "0";
const BROWSER_OFFER_ID = "desktop_browser";
const COMPUTER_USE_OFFER_ID = "desktop_computer_use";
// A registration id used only to validate a single tool's descriptor against
// the protocol before advertising it; never sent to a Host.
const CAPABILITY_PROBE_REGISTRATION_ID = "desktop-capability-tool-probe";

export interface DesktopCapabilityGroup {
  readonly offerId: string;
  readonly label: string;
  readonly description: string;
  readonly tools: readonly MakaTool[];
}

interface NativeToolBinding {
  readonly tool: MakaTool;
}

/**
 * An advertised offer paired with the Maka tools that survived validation, in
 * the same order as `offer.tools`. Bindings are built from this so the provider
 * only ever dispatches a tool it actually advertised.
 */
interface ResolvedCapability {
  readonly offer: ClientCapabilityOffer;
  readonly tools: readonly MakaTool[];
}

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
  readonly nativeSessionId?: (sessionId: string) => string;
  readonly targetScope?: DesktopTargetScope;
}

/** Adapt Desktop-owned Maka tools to the open Client Capability protocol. */
export function createDesktopNativeCapabilityProvider(
  input: DesktopNativeCapabilityProviderInput,
  providerOptions: DesktopNativeCapabilityProviderOptions = {},
): DesktopNativeCapabilityProvider {
  const groups = capabilityGroups(input);
  const hostPathAccess = providerOptions.hostPathAccess ?? "cwd";
  const resolved = groups
    .map((group) => capabilityOffer(group, hostPathAccess))
    .filter((entry): entry is ResolvedCapability => entry !== undefined);
  const offers = Object.freeze(resolved.map((entry) => entry.offer));
  const bindings = indexBindings(resolved);
  const oauthPresentation = input.oauthPresentation
    ? createOAuthPresentationClientProvider(input.oauthPresentation)
    : undefined;
  const additionalServices = input.additionalServices
    ? input.additionalServices(requireTargetScope(providerOptions.targetScope))
    : [];
  const services = indexServices(oauthPresentation?.services?.() ?? [], additionalServices);
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
    services: () => [...services.values()].map(({ serviceId, version }) => ({ serviceId, version })),
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
  const args = await parseToolArguments(binding.tool, frame.arguments);
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
  group: DesktopCapabilityGroup,
  hostPathAccess: ClientCapabilityHostPathAccess,
): ResolvedCapability | undefined {
  const surviving: {
    readonly descriptor: ClientCapabilityToolDescriptor;
    readonly tool: MakaTool;
  }[] = [];
  for (const tool of group.tools) {
    const descriptor = offerableToolDescriptor(group, tool, hostPathAccess);
    if (descriptor) surviving.push({ descriptor, tool });
  }
  if (surviving.length === 0) {
    console.warn(
      `[capabilities] Desktop capability ${group.offerId} has no representable tools; not advertising it`,
    );
    return undefined;
  }
  const offer: ClientCapabilityOffer = Object.freeze({
    offerId: group.offerId,
    version: CAPABILITY_VERSION,
    affinity: "session" as const,
    hostPathAccess,
    label: group.label,
    description: group.description,
    tools: Object.freeze(surviving.map((entry) => entry.descriptor)),
  });
  return { offer, tools: surviving.map((entry) => entry.tool) };
}

/**
 * Build one tool's protocol descriptor, or skip it. `replace()` sends the whole
 * registration as a single frame (`client-capability-channel.ts`), so a tool
 * whose schema cannot be expressed — an unrepresentable Zod type, or a JSON
 * Schema keyword outside the protocol's allowlist — must not throw from here:
 * that would drop every Desktop capability at once (Browser, Computer Use,
 * Client settings, Rive and MCP), which is exactly the #4591 outage. Each tool
 * is validated on its own, inside its group's real offer metadata, so an
 * unrepresentable tool costs only itself and is logged rather than fatal. A
 * group whose metadata is itself invalid (a caller bug: every production
 * offerId is a literal) drops all of its tools the same way, so the group is
 * still shed rather than advertised.
 */
function offerableToolDescriptor(
  group: DesktopCapabilityGroup,
  tool: MakaTool,
  hostPathAccess: ClientCapabilityHostPathAccess,
): ClientCapabilityToolDescriptor | undefined {
  try {
    const descriptor: ClientCapabilityToolDescriptor = Object.freeze({
      serverId: group.offerId,
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputSchema(tool),
      ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
      ...(tool.displayName
        ? { annotations: Object.freeze({ title: tool.displayName }) }
        : {}),
    });
    decodeClientCapabilityReplaceInput({
      registrationId: CAPABILITY_PROBE_REGISTRATION_ID,
      offers: [
        {
          offerId: group.offerId,
          version: CAPABILITY_VERSION,
          affinity: "session",
          hostPathAccess,
          label: group.label,
          description: group.description,
          tools: [descriptor],
        },
      ],
    });
    return descriptor;
  } catch (error) {
    console.warn(
      `[capabilities] Skipping Desktop tool ${group.offerId}/${tool.name}: it cannot be offered over the Client Capability protocol`,
      error,
    );
    return undefined;
  }
}

function toolInputSchema(tool: MakaTool): Record<string, unknown> {
  const parameters = tool.parameters;
  const schema: Record<string, unknown> =
    parameters instanceof z.ZodType
      ? (toJSONSchema(parameters, {
          io: "input",
          target: "draft-07",
          unrepresentable: "any",
          cycles: "ref",
          reused: "inline",
        }) as Record<string, unknown>)
      : cloneNativeToolJsonSchema(tool);
  delete schema.$schema;
  if (schema.type !== "object") {
    throw new Error(
      `Desktop native capability tool schema must be an object: ${tool.name}`,
    );
  }
  return Object.freeze(schema);
}

function cloneNativeToolJsonSchema(tool: MakaTool): Record<string, unknown> {
  const json = aiSchemaJson(tool.parameters);
  if (!json) {
    throw new Error(
      `Desktop native capability tool has an invalid schema: ${tool.name}`,
    );
  }
  // Copy defensively before the offer deletes `$schema` and freezes the result,
  // so we never mutate the source object. Today the only non-Zod source is an
  // MCP tool, whose `inputSchema` is already `$schema`-stripped and deep-frozen
  // upstream (`packages/mcp/src/index.ts`), so this copy is belt-and-suspenders
  // rather than load-bearing — but Desktop must not depend on that invariant.
  return { ...json };
}

/**
 * Read the JSON Schema from an AI SDK `Schema` (e.g. an MCP tool built through
 * `jsonSchema()`), when it is synchronously available. Desktop offers are built
 * eagerly and frozen; an async (thenable) schema is not resolved here and is
 * rejected downstream by `toolInputSchema`'s object-shape check.
 */
function aiSchemaJson(
  parameters: unknown,
): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const json = (parameters as { jsonSchema?: unknown }).jsonSchema;
  if (json && typeof json === "object") {
    return json as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Coerce/validate incoming call arguments against a tool's declared parameters,
 * mirroring the runtime's `validateDeclaredToolArgs` precedence. Zod schemas
 * parse (applying defaults/transforms); JSON-schema-only tools (MCP) carry no
 * client-side validator, so their arguments pass through unchanged — the
 * receiving Runtime Host rebuilds these tools with `buildMcpTools` and likewise
 * does not validate them, so the owning MCP server is the validator, as it is
 * for the TUI.
 */
async function parseToolArguments(
  tool: MakaTool,
  rawArgs: unknown,
): Promise<unknown> {
  const parameters = tool.parameters;
  if (parameters instanceof z.ZodType) {
    return parameters.parseAsync(rawArgs);
  }
  if (aiSchemaJson(parameters)) return rawArgs;
  throw new Error(
    `Desktop native capability tool cannot parse call arguments: ${tool.name}`,
  );
}

function indexBindings(
  resolved: readonly ResolvedCapability[],
): Map<string, NativeToolBinding> {
  const bindings = new Map<string, NativeToolBinding>();
  for (const { offer, tools } of resolved) {
    for (const tool of tools) {
      const key = bindingKey({
        offerId: offer.offerId,
        serverId: offer.offerId,
        toolName: tool.name,
      });
      if (bindings.has(key)) {
        throw new Error(
          `Duplicate Desktop native capability tool: ${offer.offerId}/${tool.name}`,
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
