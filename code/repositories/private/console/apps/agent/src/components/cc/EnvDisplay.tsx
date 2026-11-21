/**
 * 环境变量显示组件（带脱敏）
 */

import { useState } from "react";
import { Eye, EyeOff, Shield } from "lucide-react";
import { isSensitiveKey, maskSensitiveValue } from '@/types/cc/settings';
import { cn } from '@ggbdpq/console-ui';

interface EnvDisplayProps {
  env: Record<string, string>;
}

export function EnvDisplay({ env }: EnvDisplayProps) {
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

  const entries = Object.entries(env);

  if (entries.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic">
        无环境变量配置
      </div>
    );
  }

  const toggleReveal = (key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        // 5 秒后自动隐藏
        setTimeout(() => {
          setRevealedKeys((current) => {
            const updated = new Set(current);
            updated.delete(key);
            return updated;
          });
        }, 5000);
      }
      return next;
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-3">
        <Shield className="size-4 text-warning" />
        <span className="text-xs text-muted-foreground">
          敏感信息已脱敏显示，点击眼睛图标可临时查看（5秒后自动隐藏）
        </span>
      </div>

      <div className="space-y-1">
        {entries.map(([key, value]) => {
          const isSensitive = isSensitiveKey(key);
          const isRevealed = revealedKeys.has(key);
          const displayValue =
            isSensitive && !isRevealed ? maskSensitiveValue(value) : value;

          return (
            <div
              key={key}
              className={cn(
                "flex items-center justify-between py-2 px-3 rounded-lg",
                "bg-card"
              )}
            >
              <div className="flex-1 min-w-0 mr-3">
                <div className="font-mono text-sm text-foreground">
                  {key}
                </div>
                <div
                  className={cn(
                    "font-mono text-xs mt-1 break-all",
                    isSensitive && !isRevealed
                      ? "text-muted-foreground masked-text"
                      : "text-foreground"
                  )}
                >
                  {displayValue}
                </div>
              </div>

              {isSensitive && (
                <button
                  onClick={() => toggleReveal(key)}
                  className={cn(
                    "p-1.5 rounded-md transition-colors",
                    "hover:bg-background",
                    isRevealed && "text-warning"
                  )}
                  title={isRevealed ? "隐藏" : "显示（5秒后自动隐藏）"}
                >
                  {isRevealed ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
