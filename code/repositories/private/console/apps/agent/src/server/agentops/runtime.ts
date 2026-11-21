import path from "node:path";
import {
  createProfileLoader,
  getDefaultProfile,
} from "@/server/agentops/config";
import { createJsonRunStore } from "@/server/agentops/run-store";
import { createExecutor } from "@/server/agentops/executor";
import type { ProfileConfig } from "@ggbdpq/console-shared";

// 配置台运行时单例：对齐原 config-engine server.ts 的装配逻辑（去 Hono 化）。
// runs/configs 目录跟随 CONSOLE_DATA_DIR（测试隔离），默认落 apps/console/data/。
interface AgentopsRuntime {
  runsDir: string;
  getProfile: (name: string) => ProfileConfig | null;
  listProfiles: () => string[];
}

export interface AgentopsApi {
  runsDir: string;
  getProfile: (name: string) => ProfileConfig | null;
  listProfiles: () => string[];
  createRunStore: () => ReturnType<typeof createJsonRunStore>;
  createEngine: () => ReturnType<typeof createExecutor>;
}

const g = globalThis as typeof globalThis & {
  __agentopsRuntime?: AgentopsRuntime;
};

function resolveDataDir(): string {
  return process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR)
    : path.resolve(process.cwd(), "data");
}

export function getAgentopsRuntime(): AgentopsApi {
  if (!g.__agentopsRuntime) {
    const dataDir = resolveDataDir();
    const runsDir = path.join(dataDir, "agentops-runs");
    const configDir = path.join(dataDir, "agentops-configs");

    let getProfile: (name: string) => ProfileConfig | null;
    let listProfiles: () => string[];
    try {
      // createProfileLoader 是异步的，这里用同步占位：profile 目录不存在时回退 default。
      getProfile = (name) => (name === "default" ? getDefaultProfile() : null);
      listProfiles = () => ["default"];
      void createProfileLoader(configDir)
        .then((loader) => {
          getProfile = loader.createProfileGetter();
          listProfiles = () => loader.listProfiles();
        })
        .catch(() => {
          // 保持 default 回退
        });
    } catch {
      const defaultProfile = getDefaultProfile();
      getProfile = (name) => (name === "default" ? defaultProfile : null);
      listProfiles = () => ["default"];
    }

    g.__agentopsRuntime = { runsDir, getProfile, listProfiles };
  }
  const rt = g.__agentopsRuntime;
  return {
    runsDir: rt.runsDir,
    getProfile: rt.getProfile,
    listProfiles: rt.listProfiles,
    createRunStore: () => createJsonRunStore(rt.runsDir),
    createEngine: () => createExecutor(createJsonRunStore(rt.runsDir)),
  };
}
