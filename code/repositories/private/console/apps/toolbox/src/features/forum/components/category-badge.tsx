"use client"

import Link from "next/link";
import { cn } from "@ggbdpq/console-ui";
import type { Category } from "@/features/forum/schemas/forum";

interface CategoryBadgeProps {
  category: Pick<Category, "slug" | "name" | "color">;
  className?: string;
}

export function CategoryBadge({ category, className }: CategoryBadgeProps) {
  return (
    <Link
      href={`/forum/c/${category.slug}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <span
        className="inline-block size-2 rounded-[3px]"
        style={{ backgroundColor: category.color }}
      />
      {category.name}
    </Link>
  );
}
