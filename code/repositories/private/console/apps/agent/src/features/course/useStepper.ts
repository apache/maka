import { useEffect, useState } from "react";

/**
 * 分步播放引擎：step 从 0 走到 steps-1，isPlaying 时按 interval 自动步进。
 * 各课的「可操作实验」用它驱动流程动画。
 */
export function useStepper(steps: number, interval = 780) {
  const [step, setStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!isPlaying || step >= steps - 1) {
      if (isPlaying && step >= steps - 1) setIsPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setStep((s) => s + 1), interval);
    return () => window.clearTimeout(t);
  }, [interval, isPlaying, step, steps]);

  return {
    step,
    isPlaying,
    replay: () => {
      setStep(0);
      setIsPlaying(true);
    },
    next: () => {
      setIsPlaying(false);
      setStep((s) => Math.min(s + 1, steps - 1));
    },
  };
}
