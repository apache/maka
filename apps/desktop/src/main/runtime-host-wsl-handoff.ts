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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { EnvironmentRuntimeHostProfile, HostHandoffBlocker, HostHandoffPhase, RuntimeHostRemoteCompatibilityError } from '@maka/runtime-host/client';
import { compareProductReleaseVersions } from '@maka/runtime-host/operator';
import type { DesktopRuntimeHostManagedServiceBinding } from './runtime-host-managed-services.js';
import { runtimeHostSetupPackageDisplayVersion, runtimeHostSetupPackageVersion, type DesktopRuntimeHostSetupPackage } from './runtime-host-setup-package.js';
import { runDesktopRuntimeHostWslManagement, runDesktopRuntimeHostWslUpdate } from './runtime-host-wsl-controller.js';

/** A WSL route is a capability only after its persisted management binding is validated. */
export async function resolveDesktopWslHostHandoff(
  profile: EnvironmentRuntimeHostProfile,
  error: RuntimeHostRemoteCompatibilityError,
  signal: AbortSignal,
  deps: {
    readonly locale?: UiLocale;
    resolveBinding(profileId: string): Promise<DesktopRuntimeHostManagedServiceBinding | undefined>;
    resolvePackage(signal: AbortSignal): Promise<DesktopRuntimeHostSetupPackage>;
    status?: typeof runDesktopRuntimeHostWslManagement;
    update?: typeof runDesktopRuntimeHostWslUpdate;
  },
): Promise<HostHandoffBlocker> {
  const guidance = GUIDANCE[deps.locale ?? 'en'];
  const base: HostHandoffBlocker = {
    identity: JSON.stringify([profile, error.hostEpoch, error.details]),
    target: { name: profile.name, location: 'remote', rootId: profile.rootId, hostEpoch: error.hostEpoch },
    reason: 'upgrade', mayExitNaturally: false, manualRecheck: true,
    diagnostic: error.message,
  };
  // Host compatibility is not a release ordering, but a newer contract must
  // never be replaced by this older Client's package to make Connect succeed.
  if (error.details.host.compatibilityEpoch > error.details.client.compatibilityEpoch) {
    return { ...base, operatorStep: guidance.client };
  }
  const binding = await deps.resolveBinding(profile.id);
  if (!binding || binding.state !== 'active' || binding.profile.kind !== 'environment' ||
      JSON.stringify(binding.profile) !== JSON.stringify(profile) || !binding.deployment.deploymentId) {
    return { ...base, operatorStep: guidance.binding };
  }
  const expectedTarget = {
    serviceId: binding.deployment.id, rootPath: binding.deployment.rootPath,
    rootId: profile.rootId, deploymentId: binding.deployment.deploymentId,
  };
  const status = await (deps.status ?? runDesktopRuntimeHostWslManagement)({
    distribution: profile.provider.distribution, operator: profile.operator,
    action: 'status', expectedTarget, signal,
  });
  if (status.kind !== 'result' || status.action !== 'status' || status.service.lifecycle?.mode !== 'on_demand' ||
      !status.service.pid || !status.service.installedVersion) {
    return { ...base, operatorStep: guidance.source };
  }
  const setupPackage = await deps.resolvePackage(signal);
  const targetVersion = runtimeHostSetupPackageVersion(setupPackage);
  const targetDisplayVersion = runtimeHostSetupPackageDisplayVersion(setupPackage);
  if (targetVersion && (/(?:-|\.)dev-[0-9a-f]{12}$/u.test(status.service.installedVersion) || compareProductReleaseVersions(targetVersion, status.service.installedVersion) <= 0)) {
    return { ...base, operatorStep: guidance.target };
  }
  const currentVersion = status.service.installedVersion;
  // Legacy operators omit the fingerprint. The transaction still fences the source
  // package version, deployment identity and exact Host generation under its lease.
  const expectedConfigFingerprint = status.service.configurationFingerprint;
  const expectedHost = { hostEpoch: error.hostEpoch, pid: status.service.pid };
  const identity = JSON.stringify([base.identity, binding.deployment, expectedHost, currentVersion, expectedConfigFingerprint, setupPackage]);
  return {
    ...base, identity,
    packageChange: {
      current: currentVersion,
      target: targetDisplayVersion ?? guidance.development,
    },
    replacement: {
      kind: 'replace', canReplaceIdle: true, canInterrupt: true, requiresExplicitSelection: true,
      execute: async (policy, progress, _consent, retirementSignal) => {
        const fresh = await deps.resolveBinding(profile.id);
        if (JSON.stringify(fresh) !== JSON.stringify(binding)) return { kind: 'changed' };
        const result = await (deps.update ?? runDesktopRuntimeHostWslUpdate)({
          distribution: profile.provider.distribution, setupPackage, expectedTarget,
          expectedConfigFingerprint, expectedHost, expectedSourceVersion: currentVersion,
          allowInterruptActiveTasks: policy === 'interrupt_active_work', signal: retirementSignal,
        }, (phase) => {
          const phases: readonly string[] = ['checking', 'staging', 'retiring', 'replacing', 'verifying'];
          if (phases.includes(phase)) progress(phase as HostHandoffPhase);
        });
        if (result.kind === 'error') {
          if (result.error.code === 'target_mismatch') return { kind: 'changed' };
          if (result.error.code === 'active_tasks') return { kind: 'active_work' };
          return { kind: 'recovery_required', diagnostic: result.error.message };
        }
        if (result.action !== 'update') return { kind: 'recovery_required', diagnostic: 'WSL returned an unrelated update result' };
        return { kind: result.update.kind === 'active_tasks' ? 'active_work' : 'completed' };
      },
    },
  };
}


interface WslHandoffGuidance {
  readonly client: string;
  readonly binding: string;
  readonly source: string;
  readonly target: string;
  readonly development: string;
}

const GUIDANCE = {
  en: {
    client: 'Update Desktop to a build compatible with this Host. The Host will not be downgraded.',
    binding: 'The WSL management binding is unavailable. Restore it through Runtime Host settings before updating.',
    source: 'The installed WSL operator could not verify the running on-demand Host. Recheck its service status in Runtime Host settings.',
    target: 'This Desktop cannot verify a suitable replacement package. Update Desktop or manage the selected development artifact explicitly; the existing Host will be preserved.',
    development: 'selected development build',
  },
  'zh-CN': {
    client: '请更新 Desktop，使它与此 Host 兼容。不会降级现有 Host。',
    binding: 'WSL 管理绑定不可用。请先在 Runtime Host 设置中恢复管理入口，再进行更新。',
    source: '已安装的 WSL 管理程序无法验证正在运行的按需 Host。请在 Runtime Host 设置中检查服务状态。',
    target: '当前 Desktop 无法验证合适的替换包。请更新 Desktop，或通过开发环境明确管理选定的开发包；现有 Host 会被保留。',
    development: '选定的开发构建',
  },
  'zh-TW': {
    client: '請更新 Desktop，使它與此 Host 相容。不會降級現有 Host。',
    binding: 'WSL 管理綁定不可用。請先在 Runtime Host 設定中恢復管理入口，再進行更新。',
    source: '已安裝的 WSL 管理程式無法驗證正在執行的按需 Host。請在 Runtime Host 設定中檢查服務狀態。',
    target: '目前 Desktop 無法驗證合適的替換套件。請更新 Desktop，或透過開發環境明確管理選定的開發套件；現有 Host 會被保留。',
    development: '選定的開發構建',
  },
} satisfies UiCatalog<WslHandoffGuidance>;
