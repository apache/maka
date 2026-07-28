import type { PermissionProfile } from '@maka/core/permission-profile';

import type {
  SandboxBackend,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionResult,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './types.js';

const DEFAULT_PREFERENCE: SandboxablePreference = 'auto';

export class SandboxManager {
  private readonly backends: ReadonlyMap<Exclude<SandboxType, 'none'>, SandboxBackend>;

  constructor(backends: readonly SandboxBackend[] = []) {
    this.backends = new Map(backends.map((backend) => [backend.type, backend]));
  }

  shouldSandbox(
    profile: PermissionProfile,
    preference: SandboxablePreference = DEFAULT_PREFERENCE,
    _platform: SandboxPlatform = process.platform,
  ): boolean {
    if (preference === 'forbid') return false;
    if (preference === 'require') return true;
    return profileRequiresSandbox(profile);
  }

  selectInitial(input: SandboxSelectionInput): SandboxSelectionResult {
    const preference = input.preference ?? DEFAULT_PREFERENCE;
    const platform = input.platform ?? process.platform;
    const requiresSandbox = this.shouldSandbox(input.profile, preference, platform);

    if (!requiresSandbox) {
      return {
        ok: true,
        sandboxType: 'none',
        requiresSandbox: false,
        reason: 'sandbox_not_required',
        platform,
        preference,
      };
    }

    if (platform === 'darwin') {
      if (this.backends.has('macos-seatbelt')) {
        return {
          ok: true,
          sandboxType: 'macos-seatbelt',
          requiresSandbox: true,
          reason: 'platform_sandbox_selected',
          platform,
          preference,
        };
      }

      return {
        ok: false,
        reason: 'backend_not_available',
        sandboxType: 'macos-seatbelt',
        requiresSandbox: true,
        platform,
        preference,
        message: 'macOS Seatbelt backend is not registered.',
      };
    }

    if (platform === 'linux') {
      if (this.backends.has('linux')) {
        return {
          ok: true,
          sandboxType: 'linux',
          requiresSandbox: true,
          reason: 'platform_sandbox_selected',
          platform,
          preference,
        };
      }

      return {
        ok: false,
        reason: 'backend_not_available',
        sandboxType: 'linux',
        requiresSandbox: true,
        platform,
        preference,
        message: 'Linux sandbox backend is not registered.',
      };
    }

    return {
      ok: false,
      reason: 'unsupported_platform',
      requiresSandbox: true,
      platform,
      preference,
      message: `Sandbox enforcement is unsupported on platform ${platform}.`,
    };
  }

  canEnforce(input: SandboxSelectionInput): boolean {
    const selected = this.selectInitial(input);
    if (!selected.ok) return false;
    if (selected.sandboxType === 'none') return true;
    const backend = this.backends.get(selected.sandboxType);
    if (!backend) return false;
    if (!(backend.isAvailable?.(selected.platform) ?? true)) return false;
    return backend.canEnforceProfile?.(input.profile) ?? true;
  }

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    const selected = this.selectInitial({
      profile: request.command.profile,
      preference: request.preference,
      platform: request.platform,
    });

    if (!selected.ok) return selected;

    if (selected.sandboxType === 'none') {
      const { command } = request;
      return {
        ok: true,
        exec: {
          argv: [command.program, ...command.args],
          cwd: command.cwd,
          env: command.env,
          sandboxType: 'none',
          effectiveProfile: command.profile,
        },
        sandboxType: 'none',
        requiresSandbox: false,
        preference: selected.preference,
      };
    }

    const backend = this.backends.get(selected.sandboxType);
    if (!backend) {
      return {
        ok: false,
        reason: 'backend_not_available',
        sandboxType: selected.sandboxType,
        requiresSandbox: selected.requiresSandbox,
        platform: selected.platform,
        preference: selected.preference,
        message: `Sandbox backend ${selected.sandboxType} is not registered.`,
      };
    }

    return backend.transform({
      ...request,
      preference: selected.preference,
      platform: selected.platform,
    });
  }
}

function profileRequiresSandbox(profile: PermissionProfile): boolean {
  if (profile.type !== 'managed') return false;
  return profile.fileSystem.kind === 'restricted';
}
