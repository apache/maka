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

// The bot sidecar's state and commands, apart from its stdio.
//
// Desktop assembles the same pieces in its main process
// (apps/desktop/src/main/runtime-host-boot.ts, around `new BotRegistry`): one
// `BotRegistry` whose incoming messages go to the routing service of the
// current Host connection, settings applied with `botRegistry.applySettings`,
// channel tests with `testBotChannel`, and a restart that re-applies the
// saved settings (`settings:bots:restart` in settings-bots-ipc-main.ts).
//
// Two things are this client's own. The settings arrive from the client with
// `apply_settings` (the sidecar never reads or writes a settings file), and
// the Session workspace with `set_workspace`, since the client, not the
// sidecar, knows which project new tasks go into. And a Telegram channel
// whose `getUpdates` is answered with 409 Conflict is suspended here and
// reported with its status (`telegram-api.mjs`), instead of polling against
// the other client forever. The guided onboarding (`onboarding.mjs`) runs
// here too, since its requests go through the bridges' own `proxiedFetch`;
// it hands a confirmed channel to the client, which saves it.

import { createHostLink } from './host-link.mjs';
import { createBotIncomingService } from './incoming.mjs';
import { createBotOnboarding, isOnboardingBrand, isOnboardingProvider } from './onboarding.mjs';
import { createHostBotSessionAdapter, createHostSessionClient } from './session-adapter.mjs';

/** The version of the stdio protocol in docs/bots-sidecar.md. */
export const SIDECAR_PROTOCOL_VERSION = 1;

/** A command the client sent that the sidecar cannot run. */
export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'CommandError';
  }
}

/**
 * @param {object} deps
 * @param {object} deps.maka from `loadMaka`
 * @param {string} deps.stateRoot the State Root whose Host the bots use
 * @param {(event: object) => void} deps.emit writes one event to the client
 * @param {(level: string, message: string) => void} deps.log
 * @param {() => Promise<object>} [deps.connectHost] overrides the connection
 * @param {Function} [deps.fetch] overrides the onboarding's `proxiedFetch`
 */
export function createBotSidecar(deps) {
  const { maka } = deps;
  const { BOT_PROVIDERS, createDefaultBotChatSettings, mergeBotChatSettings, normalizeBotChatSettings } =
    maka.botChatSettings;
  const suspended = new Map();
  let applied = normalizeBotChatSettings(createDefaultBotChatSettings(), undefined);
  let workspace = null;
  let closed = false;

  const registry = new maka.bots.BotRegistry({
    onIncomingMessage: (message) => {
      void host
        .handleBotIncomingMessage(message)
        .catch((error) => deps.log('error', `bot message failed: ${describe(error)}`));
    },
    onStatusChange: (status) => deps.emit({ event: 'status', ...channelStatus(status) }),
  });

  const onboarding = createBotOnboarding({
    fetch: deps.fetch ?? maka.bots.proxiedFetch,
    redaction: maka.redaction,
    readStatus: (provider) => registry.getStatus(provider),
    log: deps.log,
    productVersion: maka.productVersion,
  });

  const connectHost =
    deps.connectHost ??
    (() =>
      maka.client.connectExistingRuntimeHost({
        rootPath: deps.stateRoot,
        protocol: {
          min: maka.protocol.RUNTIME_HOST_PROTOCOL_VERSION,
          max: maka.protocol.RUNTIME_HOST_PROTOCOL_VERSION,
        },
        compositionId: maka.protocol.INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      }));

  const host = createHostLink({
    connect: connectHost,
    createIncoming: (connection) =>
      createBotIncomingService({
        botRegistry: registry,
        maka,
        sessions: createHostBotSessionAdapter({
          client: createHostSessionClient(connection, maka.protocol),
          maka,
          resolveCreateTarget: async () => {
            // `currentDesktopWorkspaceTarget` in runtime-host-boot.ts.
            if (!workspace) throw new Error('Select a project from the Runtime Host first');
            return { workspace };
          },
        }),
      }),
    onState: (state) => deps.emit({ event: 'host', ...state }),
  });

  function normalize(raw) {
    // `normalizeSettings` in packages/core/src/settings.ts: merge over the
    // defaults, then normalize against what was given.
    return normalizeBotChatSettings(mergeBotChatSettings(createDefaultBotChatSettings(), raw), raw);
  }

  function channelStatus(status) {
    const conflict = suspended.get(status.platform);
    return conflict ? { status, conflict } : { status };
  }

  function statuses() {
    return Object.values(registry.allStatuses()).map(channelStatus);
  }

  /** The settings the registry runs: the applied ones minus suspended channels. */
  function effective() {
    if (suspended.size === 0) return applied;
    const channels = { ...applied.channels };
    for (const provider of suspended.keys()) {
      channels[provider] = { ...channels[provider], enabled: false };
    }
    return { ...applied, channels };
  }

  function requireProvider(value) {
    if (!BOT_PROVIDERS.includes(value)) {
      throw new CommandError('invalid_command', 'Unknown bot provider');
    }
    return value;
  }

  function requireSessionId(value) {
    if (typeof value !== 'string' || !value) {
      throw new CommandError('invalid_command', 'sessionId must be a non-empty string');
    }
    return value;
  }

  function requireChannel(provider, value) {
    if (!value || typeof value !== 'object') {
      throw new CommandError('invalid_command', 'The command needs a channel');
    }
    return normalize({ channels: { [provider]: value } }).channels[provider];
  }

  const commands = {
    async apply_settings(command) {
      if (!command.settings || typeof command.settings !== 'object') {
        throw new CommandError('invalid_command', 'apply_settings needs settings');
      }
      const next = normalize(command.settings);
      // A channel whose identity changed (another token, switched off and on)
      // is not the channel that met the conflict.
      for (const provider of [...suspended.keys()]) {
        if (maka.bots.botSettingsRequireRestart(applied.channels[provider], next.channels[provider])) {
          suspended.delete(provider);
        }
      }
      applied = next;
      await registry.applySettings(effective());
      return {};
    },

    async set_workspace(command) {
      workspace = decodeWorkspace(command.workspace);
      return {};
    },

    async test_channel(command) {
      const provider = requireProvider(command.provider);
      const channel = requireChannel(provider, command.channel);
      return { result: await maka.bots.testBotChannel(provider, channel) };
    },

    async restart_listeners(command) {
      if (command.provider === undefined) suspended.clear();
      else suspended.delete(requireProvider(command.provider));
      await registry.applySettings(effective());
      return { statuses: statuses() };
    },

    async list_statuses() {
      return { statuses: statuses() };
    },

    // `settings:bots:onboarding:*` in settings-bots-ipc-main.ts.
    async onboarding_start(command) {
      if (!isOnboardingProvider(command.provider)) {
        throw new CommandError('invalid_command', 'Unsupported bot onboarding provider');
      }
      if (command.brand !== undefined && (command.provider !== 'feishu' || !isOnboardingBrand(command.brand))) {
        throw new CommandError('invalid_command', 'brand is only valid for Feishu onboarding');
      }
      return { snapshot: await onboarding.start({ provider: command.provider, brand: command.brand }) };
    },

    async onboarding_poll(command) {
      return onboarding.poll(requireSessionId(command.sessionId));
    },

    async onboarding_finish(command) {
      return { snapshot: onboarding.finish(requireSessionId(command.sessionId)) };
    },

    async onboarding_cancel(command) {
      return { snapshot: onboarding.cancel(requireSessionId(command.sessionId)) };
    },

    async onboarding_url(command) {
      return { url: onboarding.browserUrl(requireSessionId(command.sessionId)) };
    },

    // `settings:bots:wechatQrCode`: the QR code of the local wechat-bridge.
    async wechat_bridge_qr(command) {
      const channel = requireChannel('wechat', command.channel);
      return { result: await maka.bots.getWechatBridgeQrCode(channel) };
    },
  };

  return {
    start() {
      void host.start();
    },

    /** Runs one command; resolves to the fields of its success answer. */
    async handle(command) {
      if (closed) throw new CommandError('stopping', 'The bot sidecar is stopping');
      const run = Object.hasOwn(commands, command?.command) ? commands[command.command] : undefined;
      if (!run) throw new CommandError('unknown_command', 'Unknown command');
      return run(command);
    },

    /**
     * Suspends the Telegram channel after Telegram answered its `getUpdates`
     * with 409, and reports it. Only a running, enabled channel is suspended;
     * `restart_listeners` or new credentials resume it.
     */
    telegramConflict(conflict) {
      if (closed || suspended.has('telegram') || !applied.channels.telegram?.enabled) return;
      suspended.set('telegram', { ...conflict, detectedAt: Date.now() });
      deps.log(
        'warn',
        `[bots:telegram] stopped: another client ${
          conflict.kind === 'webhook' ? 'receives this bot through a webhook' : 'polls this bot token'
        }`,
      );
      void registry
        .applySettings(effective())
        .catch((error) => deps.log('error', `[bots:telegram] stop failed: ${describe(error)}`));
    },

    async close() {
      if (closed) return;
      closed = true;
      onboarding.dispose();
      await Promise.allSettled([registry.stopAll(), host.close()]);
    },
  };
}

/** `WorkspaceTarget` (packages/runtime-host/src/protocol), or null for none. */
function decodeWorkspace(value) {
  if (value === null || value === undefined) return null;
  if (value?.kind === 'project' && typeof value.projectId === 'string' && value.projectId) {
    return { kind: 'project', projectId: value.projectId };
  }
  if (value?.kind === 'host_path' && typeof value.path === 'string' && value.path) {
    return { kind: 'host_path', path: value.path };
  }
  throw new CommandError('invalid_command', 'Invalid workspace target');
}

export function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
