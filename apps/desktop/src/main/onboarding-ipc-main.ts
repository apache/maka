import { ipcMain } from 'electron';
import type { createOnboardingService } from './onboarding-service.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

export interface OnboardingIpcDeps {
  onboardingService: ReturnType<typeof createOnboardingService>;
  ipcMain?: ReconnectableReadIpcMain;
}

export function registerOnboardingIpc(deps: OnboardingIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  // PR110b: Onboarding snapshot + milestone IPCs. Renderer polls via
  // these on app load and whenever `sessions:changed` /
  // `connections:changed` / settings change events fire. No push from
  // main.
  handleReconnectableRead(target, 'onboarding:getSnapshot', async () =>
    deps.onboardingService.getSnapshot(),
  );
  target.handle('onboarding:setMilestone', async (_event, id: unknown, status: unknown) => {
    // Service throws INVALID_MILESTONE_ID / INVALID_MILESTONE_STATUS
    // for bad inputs; let the error propagate so the renderer sees
    // it as a typed reject rather than silently swallowing.
    return deps.onboardingService.setMilestone(id, status);
  });
  target.handle('onboarding:clearMilestone', async (_event, id: unknown) => {
    return deps.onboardingService.clearMilestone(id);
  });
}
