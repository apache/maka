/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { type CSSProperties, type ReactNode, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, useLayer } from '@astryxdesign/core';
import { Check, ICON_SIZE } from './icons.js';

export interface ModelWheelOption {
  value: string;
  label: string;
  heading?: string;
  description?: string;
  disabled?: boolean;
}

/** The trigger becomes a wheel in place; the settled model takes effect. */
export function ModelWheelPicker(props: {
  options: readonly ModelWheelOption[];
  value?: string;
  label: string;
  ariaLabel: string;
  icon?: ReactNode;
  tooltip?: string;
  triggerClassName?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onValueChange(value: string): void | Promise<void>;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const open = props.open ?? internalOpen;
  const height = ROW_HEIGHT * (props.options.length > 1 ? 3 : 1);
  const setOpen = (next: boolean) => {
    if (props.open === undefined) setInternalOpen(next);
    props.onOpenChange?.(next);
  };
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };
  const layer = useLayer({ mode: 'context', lazyMount: true, lightDismiss: true,
    onHide: () => setOpen(false) });
  const positionRef = useRef(layer.ref).current;
  const anchorRef = useCallback((element: HTMLSpanElement | null) => {
    anchor.current = element;
    positionRef(element);
  }, [positionRef]);
  useLayoutEffect(() => {
    if (open) layer.show();
    else layer.hide();
  }, [open, layer.show, layer.hide]);
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!open || !element) return;
    // Saving another model can change the label while the wheel is open.
    // Keep its anchor's footprint stable throughout that interaction.
    element.style.width = `${element.getBoundingClientRect().width}px`;
    return () => { element.style.removeProperty('width'); };
  }, [open]);
  return <span ref={anchorRef}
    className="maka-model-wheel-anchor" data-open={open}
    style={{ '--maka-model-wheel-height': `${height}px` } as CSSProperties}>
    <Button ref={trigger} type="button" variant="ghost" size={props.size ?? 'sm'}
    label={props.label} icon={props.icon} tooltip={open ? undefined : props.tooltip}
    isDisabled={props.disabled || props.options.length === 0}
    className={props.triggerClassName} aria-label={props.ariaLabel}
    aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? layer.id : undefined}
    onClick={() => setOpen(true)}
    onKeyDown={(event) => {
      if (!props.disabled && props.options.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault(); event.stopPropagation(); setOpen(true);
      }
    }} />
    {layer.render(open && layer.isOpen ? <ModelWheel {...props} onClose={close} /> : null,
      { positioning: 'custom', className: 'maka-model-wheel-expanded', style: {
        position: 'fixed', inset: 'auto',
        top: `clamp(0px, calc(anchor(center) - ${height / 2}px), calc(100dvh - ${height}px))`,
        left: 'clamp(0px, anchor(left), calc(100vw - min(264px, 55vw)))',
      } })}
  </span>;
}

const ROW_HEIGHT = 44;

function ModelWheel(props: Parameters<typeof ModelWheelPicker>[0] & {
  onClose(restoreFocus: boolean): void;
}) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; scrollTop: number; moved: boolean } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interacted = useRef(false);
  const saving = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const currentValue = pending ?? props.value;
  const count = props.options.length;
  const height = ROW_HEIGHT * (count > 1 ? 3 : 1);
  const inset = (height - ROW_HEIGHT) / 2;
  // Neighboring copies let the first and last models have real neighbors,
  // rather than empty padding. Only the middle copy is exposed to assistive technology.
  const copies = count > 1 ? [0, 1, 2] : [1];
  const centeredTop = (index: number) => (count > 1 ? count + index : 0) * ROW_HEIGHT - inset;
  const selectedIndex = Math.max(0, props.options.findIndex((option) => option.value === currentValue));
  const [preview, setPreview] = useState(selectedIndex);
  const latest = useRef(props);
  latest.current = props;
  const disabled = props.disabled || pending !== null;
  const rowAt = (element: HTMLDivElement) => Math.round((element.scrollTop + inset) / ROW_HEIGHT);
  const indexAt = (element: HTMLDivElement) => count ? ((rowAt(element) % count) + count) % count : 0;
  const clearTimer = () => clearTimeout(timer.current);
  const pick = async (index: number) => {
    const option = latest.current.options[index];
    if (!option || option.disabled || latest.current.disabled || saving.current || option.value === latest.current.value) return;
    saving.current = true;
    setPending(option.value);
    try {
      await latest.current.onValueChange(option.value);
    } catch { /* The action owner reports save failures. */ }
    finally { saving.current = false; setPending(null); }
  };
  const settle = (element: HTMLDivElement) => {
    clearTimer();
    if (!interacted.current || element.dataset.dragging || saving.current) return;
    const index = indexAt(element);
    if (Math.abs(element.scrollTop - (rowAt(element) * ROW_HEIGHT - inset)) > 1) return;
    interacted.current = false;
    element.scrollTop = centeredTop(index);
    void pick(index);
  };
  const moveTo = (element: HTMLDivElement, index: number) => {
    clearTimer();
    interacted.current = false;
    const next = count ? ((index % count) + count) % count : 0;
    element.scrollTop = centeredTop(next);
    setPreview(next);
    void pick(next);
  };
  const finishDrag = (element: HTMLDivElement) => {
    if (!element.dataset.dragging) return;
    delete element.dataset.dragging;
    // Keep `moved` until the synthetic click has been suppressed.
    const next = rowAt(element);
    element.scrollTo({ top: next * ROW_HEIGHT - inset, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    clearTimer();
    timer.current = setTimeout(() => settle(element), 180);
  };
  useLayoutEffect(() => {
    if (!viewport.current) return;
    interacted.current = false;
    clearTimer();
    viewport.current.scrollTop = centeredTop(selectedIndex);
    setPreview(selectedIndex);
  }, [selectedIndex, pending, props.value, props.options.length]);
  useLayoutEffect(() => {
    viewport.current?.focus({ preventScroll: true });
    return clearTimer;
  }, []);

  return <div className="maka-model-wheel">
    <div ref={viewport} className="maka-model-wheel-viewport" role="listbox" tabIndex={0}
      aria-label={props.ariaLabel} aria-disabled={disabled} aria-busy={pending !== null}
      aria-activedescendant={props.options.length ? `${id}-${preview}` : undefined}
      style={{ height }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        if (interacted.current) void pick(indexAt(event.currentTarget));
        props.onClose(false);
      }}
      onWheel={() => { if (!disabled) interacted.current = true; }}
      onTouchStart={() => { if (!disabled) interacted.current = true; }}
      onScroll={(event) => {
        const element = event.currentTarget;
        setPreview(indexAt(element));
        clearTimer();
        timer.current = setTimeout(() => settle(element), 180);
      }}
      onScrollEnd={(event) => settle(event.currentTarget)}
      onPointerDown={(event) => {
        drag.current = undefined;
        if (disabled || event.button !== 0 || event.pointerType !== 'mouse') return;
        drag.current = { pointerId: event.pointerId, startY: event.clientY, scrollTop: event.currentTarget.scrollTop, moved: false };
      }}
      onPointerMove={(event) => {
        const gesture = drag.current;
        if (disabled || !gesture || gesture.pointerId !== event.pointerId || !(event.buttons & 1)) return;
        const distance = event.clientY - gesture.startY;
        if (!gesture.moved && Math.abs(distance) < 5) return;
        if (!gesture.moved) {
          gesture.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.dragging = 'true';
        }
        interacted.current = true;
        event.preventDefault();
        event.currentTarget.scrollTop = gesture.scrollTop - distance;
      }}
      onPointerUp={(event) => finishDrag(event.currentTarget)}
      onPointerCancel={(event) => { finishDrag(event.currentTarget); drag.current = undefined; }}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget)}
      onClickCapture={(event) => {
        if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); }
        drag.current = undefined;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(true); return; }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation();
          if (!disabled) moveTo(event.currentTarget, preview);
          props.onClose(true);
          return;
        }
        if (disabled) return;
        const next = event.key === 'ArrowDown' ? preview + 1 : event.key === 'ArrowUp' ? preview - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? props.options.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); event.stopPropagation(); moveTo(event.currentTarget, next);
      }}>
      {copies.flatMap((copy) => props.options.map((option, index) => <div key={`${copy}-${option.value}`} id={copy === 1 ? `${id}-${index}` : undefined}
        className="maka-model-wheel-option" role={copy === 1 ? 'option' : undefined} aria-hidden={copy !== 1 || undefined}
        aria-selected={copy === 1 ? option.value === currentValue : undefined}
        data-active={index === preview} aria-disabled={disabled || option.disabled}
        style={{ height: ROW_HEIGHT }} title={[option.label, option.heading, option.description].filter(Boolean).join(' · ')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { if (!disabled && viewport.current) moveTo(viewport.current, index); }}>
        <span className="maka-model-wheel-label">{option.label}</span>
        {option.heading && <span className="maka-model-wheel-provider">{option.heading}</span>}
        {option.value === currentValue && <span className="maka-model-wheel-check"><Check size={ICON_SIZE.control} aria-hidden="true" /></span>}
      </div>))}
    </div>
  </div>;
}
