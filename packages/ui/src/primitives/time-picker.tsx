"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { Clock } from "../icons.js";
import { cn } from "../utils.js";
import { inputClasses } from "./input.js";
import {
  PopoverPopup,
  PopoverPortal,
  PopoverPositioner,
  PopoverRoot,
  PopoverTrigger,
} from "../ui.js";

/**
 * TimePicker — a maka-chrome replacement for `<input type="time">`.
 *
 * The native control was the only field in Settings that dropped out of
 * the design system: WebKit draws its own dropdown (a pair of columns in
 * the platform accent blue, platform metrics, no dark-mode participation)
 * and none of it is styleable — `::-webkit-*` reaches the in-field
 * spinner glyphs, never the popup. So the popup has to be ours.
 *
 * Shape: the trigger keeps the field's look (same `inputClasses` chrome
 * as every other settings input) and shows `HH:MM` plus a clock glyph.
 * The popup is two independent columns — hours 00-23 and minutes on a
 * `minuteStep` grid — because a daily schedule is picked as "which hour"
 * then "which minute", not as one flat list of 288 options.
 *
 * Value contract matches the native element it replaces: a `HH:MM`
 * 24-hour string, so callers (and the persisted config) are unchanged.
 * A malformed or empty incoming value falls back to `fallback` rather
 * than rendering an empty trigger.
 */

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export interface TimePickerProps {
  /** `HH:MM`, 24-hour. */
  value: string;
  onChange(next: string): void;
  ariaLabel: string;
  disabled?: boolean;
  /** Minute granularity; must divide 60. Defaults to 5. */
  minuteStep?: number;
  /** Shown when `value` is missing or malformed. Defaults to `08:00`. */
  fallback?: string;
  className?: string;
  /** Labels for the two columns, so the popup is not English-only. */
  hourLabel: string;
  minuteLabel: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(value: string, fallback: string): { hour: number; minute: number } {
  const source = TIME_RE.test(value) ? value : fallback;
  const match = TIME_RE.exec(source);
  // `fallback` is a developer-supplied constant; if it is malformed too
  // we still owe the caller a renderable value rather than a throw.
  if (!match) return { hour: 8, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function TimePicker(props: TimePickerProps): ReactElement {
  const fallback = props.fallback ?? "08:00";
  const step = props.minuteStep && 60 % props.minuteStep === 0 ? props.minuteStep : 5;
  const minutes = useMemo(
    () => Array.from({ length: 60 / step }, (_, i) => i * step),
    [step],
  );
  const { hour, minute } = parseTime(props.value, fallback);
  const [open, setOpen] = useState(false);
  // Centring has to wait for the open transition to finish. Base UI moves
  // focus into the popup as part of opening, and focusing a row scrolls
  // it into view — which silently undid a centring done any earlier.
  const [settled, setSettled] = useState(false);
  const selectedHourRef = useRef<HTMLButtonElement>(null);

  const commit = useCallback(
    (nextHour: number, nextMinute: number) => {
      const next = formatTime(nextHour, nextMinute);
      if (next !== props.value) props.onChange(next);
    },
    [props.onChange, props.value],
  );

  return (
    <PopoverRoot
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => setSettled(isOpen)}
    >
      <PopoverTrigger
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        className={cn(
          inputClasses,
          // The field chrome is width-greedy (`w-full`); a time field has
          // one fixed-width value, so it hugs instead and lets the row's
          // control-width bucket place it.
          "w-auto items-center justify-between gap-2 tabular-nums",
          "data-[popup-open]:border-ring data-[popup-open]:ring-2 data-[popup-open]:ring-ring/16",
          props.className,
        )}
      >
        <span>{formatTime(hour, minute)}</span>
        <Clock size={14} aria-hidden="true" className="shrink-0 text-foreground-secondary" />
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverPositioner align="end" sideOffset={6}>
          {/* Land focus on the CURRENT hour, not the first row. Base UI
              otherwise focuses row "00", which both reads wrong to a
              keyboard user and scrolls the column away from the value
              they came to change. */}
          <PopoverPopup className="flex gap-1" initialFocus={selectedHourRef}>
            <TimeColumn
              label={props.hourLabel}
              values={HOURS}
              selected={hour}
              settled={settled}
              selectedItemRef={selectedHourRef}
              onSelect={(next) => commit(next, minute)}
            />
            <TimeColumn
              label={props.minuteLabel}
              values={minutes}
              selected={minute}
              settled={settled}
              onSelect={(next) => commit(hour, next)}
            />
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </PopoverRoot>
  );
}

function TimeColumn(props: {
  label: string;
  values: readonly number[];
  selected: number;
  /** True once the popup's open transition (and its focus move) is done. */
  settled: boolean;
  /** Lifted so the popup can take initial focus on the selected row. */
  selectedItemRef?: RefObject<HTMLButtonElement | null>;
  onSelect(value: number): void;
}): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  const ownSelectedRef = useRef<HTMLButtonElement>(null);
  const selectedRef = props.selectedItemRef ?? ownSelectedRef;

  // A 24-row hour column opens scrolled to the top, which hides the
  // current value whenever it is past ~09:00. Centre it on open (not on
  // every change — that would fight the user's own scrolling).
  //
  // Gated on `settled`, not on `open`: Base UI mounts the popup before it
  // has measured it (every rect reads 0, so a write here commits scrollTop
  // 0 — the wrong answer, indistinguishable from "already at the top") and
  // then moves focus into it, whose scroll-into-view overwrites whatever
  // we set. `onOpenChangeComplete` fires after both.
  useEffect(() => {
    if (!props.settled) return;
    let frame = 0;
    let attempts = 0;
    const centre = () => {
      const node = selectedRef.current;
      const list = listRef.current;
      if (!node || !list) return;
      if (list.clientHeight === 0 || node.clientHeight === 0) {
        // Give up after ~10 frames so a permanently-collapsed popup can't
        // spin a rAF loop for the life of the component.
        if (attempts++ < 10) frame = requestAnimationFrame(centre);
        return;
      }
      // Rect delta, not `offsetTop`: the list box is not a positioned
      // ancestor, so `offsetTop` measures from the popup instead.
      const delta = node.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTop += delta - (list.clientHeight - node.clientHeight) / 2;
    };
    frame = requestAnimationFrame(centre);
    return () => cancelAnimationFrame(frame);
  }, [props.settled]);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="px-2 py-1 text-xs font-medium text-foreground-secondary">{props.label}</div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={props.label}
        className="max-h-50 overflow-y-auto"
      >
        {props.values.map((value) => {
          const isSelected = value === props.selected;
          return (
            <button
              key={value}
              ref={isSelected ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => props.onSelect(value)}
              className={cn(
                "flex w-full cursor-default items-center justify-center rounded-sm px-3 py-1.5 text-sm tabular-nums outline-none transition-colors",
                "hover:bg-muted focus-visible:bg-muted",
                isSelected
                  ? "bg-muted font-medium text-foreground"
                  : "text-foreground-secondary",
              )}
            >
              {String(value).padStart(2, "0")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
