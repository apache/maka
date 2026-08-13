import { Buffer } from "node:buffer";
import type { ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  createOAuthPresentationClientProvider,
  type ClientCapabilityProvider,
  type OAuthPresentationBackend,
} from "@maka/runtime-host/client";
import type {
  ClientCapabilityCallFrame,
  ClientCapabilityCallResult,
  ClientCapabilityContentBlock,
  ClientCapabilityHostPathAccess,
  ClientCapabilityOffer,
  ClientCapabilityServiceCallFrame,
  ClientCapabilityServiceOffer,
} from "@maka/runtime-host/protocol";
import { toJSONSchema, z } from "zod";

const CAPABILITY_VERSION = "0";
const BROWSER_OFFER_ID = "desktop_browser";
const COMPUTER_USE_OFFER_ID = "desktop_computer_use";

export interface DesktopCapabilityGroup {
  readonly offerId: string;
  readonly label: string;
  readonly description: string;
  readonly tools: readonly MakaTool[];
}

interface NativeToolBinding {
  readonly tool: MakaTool;
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
  readonly releaseBrowserSession: (sessionId: string) => void | Promise<void>;
  readonly computerUseTools: ComputerUseToolSet;
  readonly releaseComputerUseSession: (
    sessionId: string,
  ) => void | Promise<void>;
  readonly oauthPresentation?: OAuthPresentationBackend;
  readonly additionalGroups?: () => readonly DesktopCapabilityGroup[];
  readonly additionalServices?: () => readonly DesktopCapabilityService[];
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
}

/** Adapt Desktop-owned Maka tools to the open Client Capability protocol. */
export function createDesktopNativeCapabilityProvider(
  input: DesktopNativeCapabilityProviderInput,
  providerOptions: DesktopNativeCapabilityProviderOptions = {},
): DesktopNativeCapabilityProvider {
  const groups = capabilityGroups(input);
  const hostPathAccess = providerOptions.hostPathAccess ?? "cwd";
  const offers = Object.freeze(
    groups.map((group) => capabilityOffer(group, hostPathAccess)),
  );
  const bindings = indexBindings(groups);
  const oauthPresentation = input.oauthPresentation
    ? createOAuthPresentationClientProvider(input.oauthPresentation)
    : undefined;
  const services = indexServices(oauthPresentation?.services?.() ?? [], input.additionalServices?.() ?? []);
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
  await options.accept();
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
  const parameters = requireZodSchema(binding.tool);
  const args = await parameters.parseAsync(frame.arguments);
  signal.throwIfAborted();
  await options.accept();
  signal.throwIfAborted();
  usedSessionIds.add(frame.sessionId);
  providerOptions.onSessionUsed?.(frame.sessionId);
  if (frame.offerId === COMPUTER_USE_OFFER_ID) {
    providerOptions.onComputerUseTurnUsed?.(frame.sessionId, frame.turnId);
  }
  const sessionId =
    frame.offerId === BROWSER_OFFER_ID || frame.offerId === COMPUTER_USE_OFFER_ID
      ? providerOptions.nativeSessionId?.(frame.sessionId) ?? frame.sessionId
      : frame.sessionId;
  const output = await binding.tool.impl(args, {
    sessionId,
    turnId: frame.turnId,
    cwd,
    toolCallId: frame.toolCallId,
    abortSignal: signal,
    emitOutput() {},
  });
  return projectToolResult(binding.tool, frame.toolCallId, args, output);
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
): ClientCapabilityOffer {
  return Object.freeze({
    offerId: group.offerId,
    version: CAPABILITY_VERSION,
    affinity: "session",
    hostPathAccess,
    label: group.label,
    description: group.description,
    tools: Object.freeze(
      group.tools.map((tool) =>
        Object.freeze({
          serverId: group.offerId,
          name: tool.name,
          description: tool.description,
          inputSchema: toolInputSchema(tool),
          ...(tool.displayName
            ? { annotations: Object.freeze({ title: tool.displayName }) }
            : {}),
        }),
      ),
    ),
  });
}

function toolInputSchema(tool: MakaTool): Record<string, unknown> {
  const schema = toJSONSchema(requireZodSchema(tool), {
    io: "input",
    target: "draft-07",
    unrepresentable: "any",
    cycles: "ref",
    reused: "inline",
  });
  delete schema.$schema;
  if (schema.type !== "object") {
    throw new Error(
      `Desktop native capability tool schema must be an object: ${tool.name}`,
    );
  }
  return Object.freeze(schema);
}

function requireZodSchema(tool: MakaTool): z.ZodType {
  if (!(tool.parameters instanceof z.ZodType)) {
    throw new Error(
      `Desktop native capability tool has an invalid schema: ${tool.name}`,
    );
  }
  return tool.parameters;
}

function indexBindings(
  groups: readonly DesktopCapabilityGroup[],
): Map<string, NativeToolBinding> {
  const bindings = new Map<string, NativeToolBinding>();
  for (const group of groups) {
    for (const tool of group.tools) {
      const key = bindingKey({
        offerId: group.offerId,
        serverId: group.offerId,
        toolName: tool.name,
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
