"use client";

import { useTooltip } from "@astryxdesign/core/Tooltip";
import { mergeRefs } from "@astryxdesign/core/utils";
import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useRef,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
} from "react";
import { cn } from "../utils.js";

// Astryx tooltip behavior behind the frozen Tooltip/TooltipTrigger/
// TooltipContent composition API (#1565 barrel freeze). Astryx's primitive is
// single-element (a `content` prop), so the root owns one useTooltip instance
// shared through context: the trigger merges its props into the `render`
// element (preserving the Base UI render-prop call shape) and carries the
// hover/focus listeners plus the CSS anchor name; the content renders through
// renderTooltip into the native-Popover top layer — no portal, no z-index.
// Astryx owns the surface look (inverted palette, animation, WCAG 1.4.13
// hover bridge and Escape dismiss).

type TooltipContextValue = ReturnType<typeof useTooltip>;

const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltipContext(component: string): TooltipContextValue {
  const context = useContext(TooltipContext);
  if (context === null) {
    throw new Error(`${component} must be used inside <Tooltip>`);
  }
  return context;
}

export interface TooltipProps {
  children?: ReactNode;
  /** Delay before showing on hover (ms). Astryx default: 200. */
  delay?: number;
  /** Controlled open state; leave undefined for hover/focus behavior. */
  open?: boolean;
  /** Show on mount (still dismissible). */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export function Tooltip({
  children,
  delay,
  open,
  defaultOpen,
  onOpenChange,
  disabled,
}: TooltipProps): ReactElement {
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const onShow = useCallback(() => onOpenChangeRef.current?.(true), []);
  const onHide = useCallback(() => onOpenChangeRef.current?.(false), []);
  const tooltip = useTooltip({
    delay,
    isOpen: open,
    isDefaultOpen: defaultOpen,
    isEnabled: disabled !== true,
    onShow,
    onHide,
  });
  return (
    <TooltipContext.Provider value={tooltip}>
      {children}
    </TooltipContext.Provider>
  );
}

type TooltipTriggerRenderElement = ReactElement<{
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
  onClick?: MouseEventHandler<HTMLElement>;
  "aria-describedby"?: string;
}>;

export interface TooltipTriggerProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Element to render as the trigger (Base UI render-prop shape). */
  render?: TooltipTriggerRenderElement;
}

export function TooltipTrigger({
  render,
  className,
  children,
  ...props
}: TooltipTriggerProps): ReactElement {
  const tooltip = useTooltipContext("TooltipTrigger");
  // Compose with any description the render element (or the call site)
  // already carries — the Base UI trigger merged these the same way.
  const existingDescribedBy =
    props["aria-describedby"] ?? render?.props["aria-describedby"];
  const describedBy = existingDescribedBy
    ? `${existingDescribedBy} ${tooltip.describedBy}`
    : tooltip.describedBy;
  // The Base UI trigger dismissed the tooltip on activation (closeOnClick
  // default): clicking a button must not leave its hint floating under the
  // pointer. Astryx's useTooltip returns no hide(), so this goes through its
  // own seams — hidePopover() on the layer element (whose `toggle` listener
  // syncs React state back) plus a synthetic mouseleave on the trigger,
  // which cancels a show still pending its delay so the hint cannot pop in
  // after the click. Astryx re-shows only on a real mouseenter, so the
  // tooltip stays away until the pointer re-enters — closeOnClick semantics.
  const hideOnActivate = (event: ReactMouseEvent<HTMLElement>) => {
    const surface = document.getElementById(tooltip.describedBy);
    if (surface?.matches(":popover-open")) surface.hidePopover();
    event.currentTarget.dispatchEvent(new MouseEvent("mouseleave"));
  };
  if (render) {
    const merged = {
      ...props,
      className: cn(render.props.className, className),
      ref: mergeRefs<HTMLElement>(tooltip.ref, render.props.ref),
      "aria-describedby": describedBy,
      "data-slot": "tooltip-trigger",
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        render.props.onClick?.(event);
        // Call-site props are button-typed but land on the render element —
        // the same widening the prop spread below already performs.
        (props.onClick as MouseEventHandler<HTMLElement> | undefined)?.(event);
        hideOnActivate(event);
      },
    };
    return children !== undefined
      ? cloneElement(render, merged, children)
      : cloneElement(render, merged);
  }
  return (
    <button
      type="button"
      {...props}
      className={className}
      ref={tooltip.ref as RefCallback<HTMLButtonElement>}
      aria-describedby={describedBy}
      data-slot="tooltip-trigger"
      onClick={(event) => {
        props.onClick?.(event);
        hideOnActivate(event);
      }}
    >
      {children}
    </button>
  );
}

export interface TooltipContentProps {
  children?: ReactNode;
  className?: string;
}

export function TooltipContent({
  children,
  className,
}: TooltipContentProps): ReactNode {
  const tooltip = useTooltipContext("TooltipContent");
  return tooltip.renderTooltip(
    <span className={className} data-slot="tooltip-content">
      {children}
    </span>,
  );
}
