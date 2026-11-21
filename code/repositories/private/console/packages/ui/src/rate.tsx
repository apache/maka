"use client";
import * as React from "react";
import { Star } from "lucide-react";
import { cn } from "./cn";

// Rate（ant-design Rate）：星级评分

export function Rate({
  value,
  onChange,
  max = 5,
  allowHalf = false,
  disabled = false,
  className,
}: {
  value: number;
  onChange?: (v: number) => void;
  max?: number;
  allowHalf?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [hover, setHover] = React.useState(0);
  const display = hover || value;

  return (
    <div className={cn("inline-flex gap-0.5", disabled && "opacity-60", className)} onMouseLeave={() => setHover(0)}>
      {Array.from({ length: max }, (_, i) => {
        const star = i + 1;
        const filled = allowHalf ? display >= star - 0.5 : display >= star;
        return (
          <button
            key={star}
            type="button"
            disabled={disabled}
            aria-label={`${star} 星`}
            onMouseEnter={() => !disabled && setHover(star)}
            onClick={() => !disabled && onChange?.(star)}
            className="p-0.5 transition-transform hover:scale-110"
          >
            <Star className={cn("size-5", filled ? "fill-warning text-warning" : "text-muted-foreground/40")} />
          </button>
        );
      })}
    </div>
  );
}
