/**
 * 文件监听 Hook
 * 增强版：支持环境检测 + 写入标记防止误报冲突
 */

import { useEffect, useCallback, useRef } from "react";
import { useQueryClient, useIsMutating } from "@tanstack/react-query";
import { usePluginStore } from "@/stores/cc/pluginStore";
import { isTauriEnvironment } from "@/lib/cc/api";

interface FileChangeEvent {
  newHash: string;
  changeType: string;
  timestamp: string;
}

/**
 * 监听配置文件变更
 * @param onConflict 冲突回调（仅外部修改时触发）
 */
export function useFileWatcher(onConflict?: (event: FileChangeEvent) => void) {
  const queryClient = useQueryClient();
  const { lastKnownHash, setLastKnownHash, setConflict } = usePluginStore();
  
  // 检测是否有正在进行的 mutation（写入操作）
  const isMutating = useIsMutating();
  
  // 用于防抖：忽略写入后短时间内的文件变更事件
  const ignoreUntilRef = useRef<number>(0);

  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      const now = Date.now();
      
      // 如果在忽略窗口内，跳过此事件
      if (now < ignoreUntilRef.current) {
        console.log("忽略自身写入触发的文件变更事件");
        setLastKnownHash(event.newHash);
        return;
      }
      
      // 如果有正在进行的 mutation，设置忽略窗口（2秒）
      if (isMutating > 0) {
        console.log("检测到 mutation 进行中，设置忽略窗口");
        ignoreUntilRef.current = now + 2000;
        setLastKnownHash(event.newHash);
        return;
      }

      console.log("检测到外部配置文件变更:", event);

      // 真正的外部修改：哈希与上次已知的不同
      if (lastKnownHash && event.newHash !== lastKnownHash) {
        setConflict(true);
        onConflict?.(event);
      }

      // 更新已知哈希
      setLastKnownHash(event.newHash);

      // 触发数据刷新
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    [lastKnownHash, setLastKnownHash, setConflict, onConflict, queryClient, isMutating]
  );

  useEffect(() => {
    // Web 化：轮询后端 watcher 版本号（settings.json 外部修改 → 冲突检测），替代 Tauri 事件
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/agentops/cc/settings/version");
        if (!res.ok) return;
        const body = (await res.json()) as { version: number; hash: string };
        if (lastKnownHash && body.hash && body.hash !== lastKnownHash && !isMutating) {
          handleFileChange({ path: "", hash: body.hash } as unknown as FileChangeEvent);
        }
      } catch {
        // 网络异常时静默（dev 重启窗口期）
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [handleFileChange, lastKnownHash, isMutating]);

  // 暴露方法：标记即将进行写入（用于 mutation 之前调用）
  return {
    markWritePending: useCallback(() => {
      ignoreUntilRef.current = Date.now() + 2000;
    }, []),
  };
}
