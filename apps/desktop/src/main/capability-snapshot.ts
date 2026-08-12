import { Notification, systemPreferences } from 'electron';
import { BOT_PROVIDERS, type BotProvider } from '@maka/core/bot-chat-settings';
import {
  deriveCapabilityReadiness,
  runtimeProbeFromBotReadiness,
  type CapabilityActionApprovalSignal,
  type CapabilityConfigurationSignal,
  type CapabilityFeatureSignal,
  type CapabilityMemoryAcceptanceSignal,
  type CapabilityPermissionRequirement,
  type CapabilityRuntimeProbeSignal,
  type CapabilitySnapshot,
  type CapabilitySnapshotCollection,
  type OsPermissionId,
  type OsPermissionSnapshot,
  type PermissionSnapshot,
} from '@maka/core/capabilities';
import { type AppSettings } from '@maka/core/settings';
import type { CuBackendId } from '@maka/computer-use';
import type { BotStatus } from '@maka/runtime/bots';
import type { computerUseServiceHealth } from './computer-use-host.js';
import {
  mapMediaAccessStatus,
  mediaPermissionActions,
  supportsMediaPermissionProbe,
} from './os-permission-policy.js';

const MAC_TCC_PERMISSIONS: OsPermissionId[] = ['accessibility', 'screen_recording', 'automation'];

export function buildPermissionSnapshot(now = Date.now(), platform: NodeJS.Platform = process.platform): PermissionSnapshot {
  return {
    checkedAt: now,
    platform,
    permissions: {
      accessibility: accessibilitySnapshot(now, platform),
      screen_recording: mediaPermissionSnapshot('screen_recording', 'screen', now, platform),
      notifications: notificationSnapshot(now, platform),
      automation: automationSnapshot(now, platform),
    },
  };
}

export function buildCapabilitySnapshotCollection(input: {
  settings: AppSettings;
  permissions: PermissionSnapshot;
  botStatuses: Record<BotProvider, BotStatus>;
  computerUse?: {
    backendId: CuBackendId | 'none';
    health: ReturnType<typeof computerUseServiceHealth>;
  };
  now?: number;
}): CapabilitySnapshotCollection {
  const now = input.now ?? Date.now();
  const permissions = input.permissions.permissions;
  const capabilities: CapabilitySnapshot[] = [
    computerUseCapability(input.computerUse, permissions, now),
    staticCapability({
      id: 'activity_recorder',
      label: 'Activity Recorder',
      now,
      feature: {
        state: 'partial',
        source: 'runtime',
        reason: 'Daily Review 已聚合本地会话 / 工具 / 模型活动；当前不包含屏幕与应用级录制',
      },
      requiredPermissions: [
        { id: 'screen_recording', required: false, status: permissions.screen_recording.status },
      ],
      actionApproval: { state: 'not_required', source: 'not_applicable' },
      memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
      runtimeProbe: {
        state: 'not_run',
        source: 'runtime_probe',
        reason: '打开 Daily Review 可查看本地活动聚合结果',
      },
    }),
    staticCapability({
      id: 'memory_write',
      label: 'Memory',
      now,
      feature: {
        state: 'partial',
        source: 'runtime',
        reason: '本地 MEMORY.md 已可见；自动抽取/写入仍需用户确认',
      },
      requiredPermissions: [],
      actionApproval: { state: 'not_required', source: 'not_applicable' },
      memoryAcceptance: { state: 'draft_required', source: 'memory_contract' },
      runtimeProbe: {
        state: 'not_run',
        source: 'runtime_probe',
        reason: '透明本地记忆为文件读写能力，不做后台探测',
      },
    }),
    ...BOT_PROVIDERS.map((provider) =>
      botCapability(provider, input.settings, input.botStatuses[provider], now),
    ),
  ];

  return { checkedAt: now, capabilities };
}

function computerUseCapability(
  input: {
    backendId: CuBackendId | 'none';
    health: ReturnType<typeof computerUseServiceHealth>;
  } | undefined,
  permissions: PermissionSnapshot['permissions'],
  now: number,
): CapabilitySnapshot {
  // Any selected executor is an executor. Naming one here made the capability
  // read `not_available` for a machine that had a working backend, merely a
  // different one.
  const artifactAvailable = input !== undefined && input.backendId !== 'none';
  return staticCapability({
    id: 'computer_use',
    label: 'Computer Use',
    now,
    feature: {
      state: artifactAvailable ? 'enabled' : 'not_available',
      source: 'runtime',
      reason: computerUseCapabilityReason(input, permissions),
    },
    requiredPermissions: [
      { id: 'accessibility', required: true, status: permissions.accessibility.status },
      { id: 'screen_recording', required: true, status: permissions.screen_recording.status },
    ],
    actionApproval: {
      state: 'required_scoped_lease',
      source: 'capability_policy',
    },
    memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
    runtimeProbe: {
      state: input?.health.state ?? 'not_available',
      source: 'runtime_probe',
      lastCheckedAt: now,
      reason: input?.health.reason ?? 'Computer Use 后端当前不可用。',
    },
  });
}

function computerUseCapabilityReason(
  input: {
    backendId: CuBackendId | 'none';
    health: ReturnType<typeof computerUseServiceHealth>;
  } | undefined,
  permissions: PermissionSnapshot['permissions'],
): string {
  if (input === undefined || input.backendId === 'none') {
    return '未找到通过完整性检查的 Computer Use 执行器 artifact。';
  }

  const reasons = [`${input.backendId} artifact 已通过本地完整性检查。`];
  const missingPermissions = [
    ['辅助功能', permissions.accessibility.status],
    ['屏幕录制', permissions.screen_recording.status],
  ].filter((entry) => entry[1] !== 'granted').map((entry) => entry[0]);
  if (missingPermissions.length > 0) {
    reasons.push(`等待${missingPermissions.join('、')}权限。`);
  }
  switch (input.health.state) {
    case 'not_available':
      reasons.push(`${input.backendId} service 启动失败、已退出或已停止。`);
      break;
    case 'degraded':
      reasons.push(`${input.backendId} service 正在启动或恢复。`);
      break;
    case 'healthy':
      reasons.push('操作与截图 service 已就绪；按目标与动作类别授权后可操作本机应用。');
      break;
    case 'not_run':
      reasons.push('service 将在首次调用时启动；按目标与动作类别授权后可操作本机应用。');
      break;
  }
  return reasons.join('');
}

function staticCapability(input: {
  id: CapabilitySnapshot['id'];
  label: string;
  now: number;
  feature: CapabilityFeatureSignal;
  requiredPermissions: CapabilityPermissionRequirement[];
  actionApproval: CapabilityActionApprovalSignal;
  memoryAcceptance: CapabilityMemoryAcceptanceSignal;
  runtimeProbe: CapabilityRuntimeProbeSignal;
  guidance?: string[];
}): CapabilitySnapshot {
  const configuration: CapabilityConfigurationSignal = { state: 'not_required', source: 'not_applicable' };
  return {
    id: input.id,
    label: input.label,
    readiness: deriveCapabilityReadiness({
      feature: input.feature,
      configuration,
      osPermissions: input.requiredPermissions,
      runtimeProbe: input.runtimeProbe,
    }),
    feature: input.feature,
    configuration,
    osPermissions: input.requiredPermissions,
    actionApproval: input.actionApproval,
    memoryAcceptance: input.memoryAcceptance,
    runtimeProbe: input.runtimeProbe,
    canRevoke: false,
    canPause: input.feature.state === 'enabled',
    guidance: input.guidance ?? [],
    auditEvents: [],
    updatedAt: input.now,
  };
}

function botCapability(
  provider: BotProvider,
  settings: AppSettings,
  status: BotStatus,
  now: number,
): CapabilitySnapshot {
  const channel = settings.botChat.channels[provider];
  const hasConfig = Boolean(channel.token.trim() || channel.appId || channel.appSecret);
  const feature: CapabilityFeatureSignal = {
    state: channel.enabled ? 'enabled' : 'disabled',
    source: 'settings',
  };
  const configuration: CapabilityConfigurationSignal = hasConfig
    ? { state: 'present', source: 'settings' }
    : { state: 'missing', source: 'settings', reason: '未配置平台凭据' };
  const runtimeProbe = runtimeProbeFromBotReadiness(
    status.readiness,
    channel.readinessUpdatedAt,
    status.reason ?? channel.readinessReason,
  );

  return {
    id: `bot:${provider}`,
    label: `${provider} Bot`,
    readiness: deriveCapabilityReadiness({
      feature,
      configuration,
      osPermissions: [],
      runtimeProbe,
    }),
    feature,
    configuration,
    osPermissions: [],
    actionApproval: { state: 'not_required', source: 'not_applicable' },
    memoryAcceptance: { state: 'disabled', source: 'memory_contract' },
    runtimeProbe,
    canRevoke: channel.enabled || hasConfig,
    canPause: channel.enabled,
    guidance: [],
    auditEvents: [],
    updatedAt: now,
  };
}

function accessibilitySnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  if (platform !== 'darwin') return unsupportedPermission('accessibility', now, '仅 macOS TCC 权限适用');
  try {
    const granted = systemPreferences.isTrustedAccessibilityClient(false);
    return {
      id: 'accessibility',
      status: granted ? 'granted' : 'not_determined',
      source: 'electron',
      checkedAt: now,
      reason: granted ? undefined : 'macOS 不区分辅助功能权限是未授权还是未申请',
      canOpenSettings: true,
      canRequest: false,
    };
  } catch (error) {
    return unknownPermission('accessibility', now, generalizedReason(error), true);
  }
}

function mediaPermissionSnapshot(
  id: 'screen_recording',
  mediaType: 'screen',
  now: number,
  platform: NodeJS.Platform,
): OsPermissionSnapshot {
  if (!supportsMediaPermissionProbe(id, platform)) {
    return unsupportedPermission(
      id,
      now,
      '屏幕录制权限状态仅能在 macOS 上读取',
    );
  }
  try {
    const status = mapMediaAccessStatus(systemPreferences.getMediaAccessStatus(mediaType));
    const actions = mediaPermissionActions({ id, platform, status });
    return {
      id,
      status,
      source: 'electron',
      checkedAt: now,
      ...actions,
    };
  } catch (error) {
    return unknownPermission(id, now, generalizedReason(error), platform === 'darwin');
  }
}

function notificationSnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  const supported = Notification.isSupported();
  return {
    id: 'notifications',
    status: supported ? 'unknown' : 'unsupported',
    source: 'electron',
    checkedAt: now,
    reason: supported
      ? platform === 'darwin'
        ? 'Electron 无法可靠读取 macOS 通知授权状态，请在系统设置中确认'
        : 'Electron 无法可靠读取当前系统的通知授权状态'
      : 'Electron 通知能力不可用',
    canOpenSettings: platform === 'darwin',
    // Showing a Notification is not an authorization API and does not report
    // whether macOS delivered or suppressed it. Never present that probe as a
    // successful permission request.
    canRequest: false,
  };
}

function automationSnapshot(now: number, platform: NodeJS.Platform): OsPermissionSnapshot {
  if (platform !== 'darwin') return unsupportedPermission('automation', now, '仅 macOS TCC 权限适用');
  return {
    id: 'automation',
    status: 'unknown',
    source: 'static',
    checkedAt: now,
    reason: 'Electron 暂不支持读取逐 App 的 Apple Events 授权状态',
    canOpenSettings: true,
    canRequest: false,
  };
}

function unsupportedPermission(id: OsPermissionId, now: number, reason: string): OsPermissionSnapshot {
  return {
    id,
    status: 'unsupported',
    source: MAC_TCC_PERMISSIONS.includes(id) ? 'platform' : 'static',
    checkedAt: now,
    reason,
    canOpenSettings: false,
    canRequest: false,
  };
}

function unknownPermission(
  id: OsPermissionId,
  now: number,
  reason: string,
  canOpenSettings: boolean,
): OsPermissionSnapshot {
  return {
    id,
    status: 'unknown',
    source: 'electron',
    checkedAt: now,
    reason,
    canOpenSettings,
    canRequest: false,
  };
}

function generalizedReason(error: unknown): string {
  return error instanceof Error ? error.message : 'permission probe failed';
}
