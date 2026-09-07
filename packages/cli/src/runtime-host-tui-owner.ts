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
import { isDeepStrictEqual } from 'node:util';
import { formatUiMessage, type UiLocale } from '@maka/core/ui-locale';
import {
  connectExistingRuntimeHost,
  type RuntimeHostConnection,
  type RuntimeHostProfile,
} from '@maka/runtime-host/client';
import {
  readLocalHostDeploymentRecord,
  withLocalHostDeploymentAuthority,
} from '@maka/runtime-host/operator';
import { isProductReleaseVersion } from '@maka/runtime-host/operator/update-package-evidence';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostDiagnosticsResult,
} from '@maka/runtime-host/protocol';
import type { MakaPiTuiHostControl } from './pi-tui-contracts.js';
import { resolveRuntimeHostNpmGlobalInstallation } from './runtime-host-cli-installation.js';
import { runRuntimeHostInstalledUpdateBootstrap } from './runtime-host-installed-update-bootstrap.js';
import { retireRuntimeHostLifecycleOwner } from './runtime-host-lifecycle-transaction.js';
import { openRuntimeHostNpmGlobalStagedDeployment } from './runtime-host-local-handoff.js';
import { launchRuntimeHostTargetActivator } from './runtime-host-local-target-activation.js';
import { getTuiHostOwnerCopy } from './tui-host-owner-copy.js';

type OwnerAction = Parameters<MakaPiTuiHostControl['prepare']>[0];

interface TuiOwnerDeps {
  resolveInstallation: typeof resolveRuntimeHostNpmGlobalInstallation;
  readRecord: typeof readLocalHostDeploymentRecord;
  connectExisting: typeof connectExistingRuntimeHost;
  withAuthority: typeof withLocalHostDeploymentAuthority;
  retire: typeof retireRuntimeHostLifecycleOwner;
  openStaged: typeof openRuntimeHostNpmGlobalStagedDeployment;
  activate: typeof launchRuntimeHostTargetActivator;
  update: typeof runRuntimeHostInstalledUpdateBootstrap;
}

/** A thin owner adapter. The caller disconnects its reconnecting client before execute. */
export async function prepareTuiHostOwnerAction(
  input: {
    profile: RuntimeHostProfile;
    connection: RuntimeHostConnection;
    rootPath: string;
    action: OwnerAction;
    locale?: UiLocale;
    confirm: (detail: string) => Promise<'cancel' | 'safe' | 'interrupt'>;
  },
  overrides: Partial<TuiOwnerDeps> = {},
): Promise<(() => Promise<number>) | undefined> {
  const locale = input.locale ?? 'en';
  const copy = getTuiHostOwnerCopy(locale);
  if (input.profile.kind !== 'local') {
    throw new Error(copy.foreign);
  }
  const deps: TuiOwnerDeps = {
    resolveInstallation: resolveRuntimeHostNpmGlobalInstallation,
    readRecord: readLocalHostDeploymentRecord,
    connectExisting: connectExistingRuntimeHost,
    withAuthority: withLocalHostDeploymentAuthority,
    retire: retireRuntimeHostLifecycleOwner,
    openStaged: openRuntimeHostNpmGlobalStagedDeployment,
    activate: launchRuntimeHostTargetActivator,
    update: runRuntimeHostInstalledUpdateBootstrap,
    ...overrides,
  };
  const installation = await deps.resolveInstallation();
  const rootId = input.connection.rootId;
  const hostEpoch = input.connection.hostEpoch;
  const record = await deps.readRecord(rootId);
  if (
    record?.state.kind !== 'owned' ||
    record.state.owner.kind !== 'cli' ||
    record.state.owner.installationId !== installation.owner.installationId
  ) {
    throw new Error(copy.notOwner);
  }
  const observed = await deps.connectExisting({
    rootPath: input.rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  });
  try {
    if (
      observed.kind !== 'connected' ||
      observed.registration.rootId !== rootId ||
      observed.registration.hostEpoch !== hostEpoch ||
      observed.registration.lifecycleMode !== 'ephemeral'
    ) {
      throw new Error(copy.hostChanged);
    }
  } finally {
    if (observed.kind === 'connected') await observed.connection.close();
  }
  const diagnostics = await input.connection
    .request('host.diagnostics.query', {})
    .catch(() => undefined);
  const fingerprint = activityFingerprint(diagnostics);
  let allowInterruptActiveTasks = false;
  if (!diagnostics || diagnostics.upgradeBlockingActivity) {
    const choice = await input.confirm(
      [
        formatUiMessage(
          copy.actionSummary,
          { action: copy[`action_${input.action.action}`], name: input.profile.name },
          locale,
        ),
        formatUiMessage(copy.owner, { owner: installation.owner.installationId }, locale),
        formatUiMessage(copy.root, { root: rootId }, locale),
        formatUiMessage(copy.epoch, { epoch: hostEpoch }, locale),
        diagnostics
          ? formatUiMessage(
              copy.activity,
              {
                connections: diagnostics.connections,
                operations: diagnostics.activeOperations,
                residencies: JSON.stringify(diagnostics.residencies),
              },
              locale,
            )
          : copy.unknownActivity,
        input.action.action === 'update' ? copy.updateSafeOnly : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    if (choice === 'cancel') return undefined;
    allowInterruptActiveTasks = choice === 'interrupt';
  }
  const target = input.action.target ?? 'latest';
  if (
    input.action.action === 'update' &&
    target !== 'latest' &&
    target !== 'next' &&
    !isProductReleaseVersion(target)
  )
    throw new Error(copy.invalidTarget);
  if (input.action.action === 'update' && allowInterruptActiveTasks) {
    throw new Error(copy.updateRequiresSafe);
  }
  return async () => {
    if (!isDeepStrictEqual(await deps.resolveInstallation(), installation)) {
      throw new Error(copy.installationChanged);
    }
    if (input.action.action === 'update') {
      return deps.update({
        rootPath: input.rootPath,
        selector:
          target === 'latest' || target === 'next'
            ? { kind: 'channel', channel: target }
            : { kind: 'exact', version: target },
        allowInterruptActiveTasks: false,
        expectedSource: {
          rootId,
          deploymentRevision: record.revision,
          ownerInstallationId: installation.owner.installationId,
          hostEpoch,
        },
      });
    }
    return deps.withAuthority(rootId, async (authority, inheritableAuthorityLeaseFd) => {
      if (!isDeepStrictEqual(await authority.read(), record)) {
        throw new Error(copy.ownerChanged);
      }
      // Same-artifact restart is a process lifecycle operation, not an update.
      // Open the already verified selected package; never restage/reinstall it.
      const staged =
        input.action.action === 'restart'
          ? await deps.openStaged({
              rootId,
              owner: installation.owner,
              target: record.state.selected,
              transactionId: `tui-restart:${randomUUID()}`,
            })
          : undefined;
      const retired = await deps.retire({
        rootPath: input.rootPath,
        rootId,
        allowInterruptActiveTasks,
        connectExisting: async (request) => {
          const current = await deps.connectExisting(request);
          if (
            current.kind !== 'connected' ||
            current.registration.rootId !== rootId ||
            current.registration.hostEpoch !== hostEpoch ||
            current.registration.lifecycleMode !== 'ephemeral'
          ) {
            if (current.kind === 'connected') await current.connection.close();
            throw new Error(copy.retirementHostChanged);
          }
          const currentDiagnostics = await current.connection
            .request('host.diagnostics.query', {})
            .catch(() => undefined);
          if (
            allowInterruptActiveTasks &&
            activityFingerprint(currentDiagnostics) !== fingerprint
          ) {
            await current.connection.close();
            throw new Error(copy.activityChanged);
          }
          return current;
        },
      });
      if (retired.kind === 'active_tasks') {
        throw new Error(formatUiMessage(copy.stillActive, { action: input.action.action }, locale));
      }
      await retired.owner.close();
      if (staged) {
        const activated = await deps.activate({
          rootPath: input.rootPath,
          rootId,
          staged,
          ownerInstallationId: installation.owner.installationId,
          target: record.state.selected,
          inheritableAuthorityLeaseFd,
        });
        if (activated.kind !== 'ready')
          throw new Error(formatUiMessage(copy.restartFailed, { detail: activated.kind }, locale));
        await activated.settle();
      }
      return 0;
    });
  };
}

function activityFingerprint(diagnostics: HostDiagnosticsResult | undefined): string {
  if (!diagnostics) return 'unknown';
  return JSON.stringify([
    diagnostics.hostEpoch,
    diagnostics.pid,
    diagnostics.state,
    diagnostics.connections,
    diagnostics.activeOperations,
    diagnostics.residencies,
    diagnostics.upgradeBlockingActivity,
  ]);
}

export async function describeTuiHost(input: {
  profile: RuntimeHostProfile;
  connection: RuntimeHostConnection;
  locale?: UiLocale;
}): Promise<string> {
  const locale = input.locale ?? 'en';
  const copy = getTuiHostOwnerCopy(locale);
  const status = await input.connection.status();
  return [
    formatUiMessage(
      copy.status,
      { name: input.profile.name, state: copy[`state_${status.state}`] },
      locale,
    ),
    formatUiMessage(copy.root, { root: input.connection.rootId }, locale),
    formatUiMessage(copy.epoch, { epoch: status.hostEpoch }, locale),
    formatUiMessage(
      copy.composition,
      { composition: status.compositionId, revision: status.compositionRevision },
      locale,
    ),
    formatUiMessage(
      copy.activity,
      {
        connections: status.connections,
        operations: status.activeOperations,
        residencies: status.activeResidencies,
      },
      locale,
    ),
    input.profile.kind === 'local' ? copy.localOwnerHint : copy.attachedOwnerHint,
  ].join('\n');
}
