import { scanSettings, getConfigFilePath } from "@/server/agentops/adapters";
import { createPlan, type PlanInput } from "@/server/agentops/planner";
import type { Executor } from "@/server/agentops/executor";
import type { ExecuteRequest, ProfileConfig } from "@ggbdpq/console-shared";
import type { AgentopsApi } from "@/server/agentops/runtime";

// 与原 config-engine routes.ts 的 executeRun 同构：扫描 → 计划 → 执行。
export async function executeRun(
  request: ExecuteRequest,
  mode: "dry-run" | "apply",
  rt: AgentopsApi,
  executor: Executor,
) {
  const profile: ProfileConfig | null = rt.getProfile(request.profile);
  if (!profile) {
    return {
      success: false,
      error: `Profile not found: ${request.profile}`,
      code: "PROFILE_NOT_FOUND",
    };
  }

  const scanResults = await scanSettings(request.targets);

  const planInputs: PlanInput[] = scanResults.map((result) => ({
    profile,
    targetType: result.targetType,
    currentSettings: result.content,
    configPath: getConfigFilePath(result.targetType, "settings"),
  }));

  const plan = createPlan(planInputs);
  const result = await executor.execute(plan, mode);

  return {
    run: result.run,
    success: result.success,
    error: result.error,
  };
}
