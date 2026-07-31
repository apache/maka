import { cn } from "../utils.js";
import { Loader2Icon } from "../icons.js";
import type React from "react";
import { useUiLocale } from "../locale-context.js";
import { getSharedUiCopy } from "../shared-ui-copy.js";

export function Spinner({
  className,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof Loader2Icon>): React.ReactElement {
  const copy = getSharedUiCopy(useUiLocale()).primitives;
  return (
    <Loader2Icon
      aria-label={ariaLabel ?? copy.loading}
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}
