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

import { Button, IconButton } from '@astryxdesign/core';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Dialog } from '@astryxdesign/core/Dialog';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { useEffect, useRef, useState } from 'react';
import type { MermaidConfig } from 'mermaid';
import { ICON_SIZE, Maximize2, Minimize2, Scan, ZoomIn, ZoomOut } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export const MAX_MERMAID_SOURCE_LENGTH = 20_000;
export const MAX_MERMAID_EDGES = 500;
export const MIN_MERMAID_ZOOM = 0.5;
export const MAX_MERMAID_ZOOM = 3;
export const MERMAID_ZOOM_STEP = 0.25;
const MIN_MERMAID_VIEWPORT_HEIGHT = 112;
const MAX_MERMAID_VIEWPORT_HEIGHT = 480;
const MAX_MERMAID_VIEWPORT_HEIGHT_RATIO = 0.55;

type MermaidTheme = 'default' | 'dark';

type MermaidRenderState =
  | { status: 'deferred' }
  | { status: 'loading' }
  | { status: 'rendered'; svg: string; naturalWidth: number; naturalHeight: number }
  | { status: 'error'; reason: 'invalid' | 'too-large' };

type MermaidViewportLayout = {
  fitWidth: number;
  viewportHeight: number;
};

let mermaidModule: Promise<typeof import('mermaid').default> | undefined;
let renderQueue: Promise<void> = Promise.resolve();
let diagramSequence = 0;

export function createMermaidConfig(theme: MermaidTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
    maxEdges: MAX_MERMAID_EDGES,
    htmlLabels: false,
    logLevel: 'fatal',
    theme,
  };
}

function loadMermaid() {
  mermaidModule ??= import('mermaid').then((module) => module.default);
  return mermaidModule;
}

function sanitizeRenderedMermaidSvg(svg: string): string {
  const documentNode = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (documentNode.querySelector('parsererror')) throw new Error('Invalid Mermaid SVG output');

  for (const element of documentNode.querySelectorAll('script, foreignObject')) element.remove();
  for (const link of documentNode.querySelectorAll('a')) {
    link.replaceWith(...Array.from(link.childNodes));
  }
  for (const element of documentNode.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const unsafeReference =
        (name === 'href' || name.endsWith(':href'))
        && !value.startsWith('#')
        && !value.startsWith('data:image/');
      const unsafeStyle = name === 'style' && /(?:javascript:|expression\s*\()/i.test(value);
      if (name.startsWith('on') || unsafeReference || unsafeStyle) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return new XMLSerializer().serializeToString(documentNode.documentElement);
}

/**
 * Mermaid owns global configuration, so initialization and rendering must be
 * one serialized operation. This also caps concurrent layout work when one
 * assistant turn contains several diagrams.
 */
function renderMermaid(
  code: string,
  theme: MermaidTheme,
  shouldRender: () => boolean,
): Promise<string | null> {
  const task = renderQueue.then(async () => {
    if (!shouldRender()) return null;
    const mermaid = await loadMermaid();
    if (!shouldRender()) return null;
    mermaid.initialize(createMermaidConfig(theme));
    const id = `maka-mermaid-${++diagramSequence}`;
    const { svg } = await mermaid.render(id, code);
    return sanitizeRenderedMermaidSvg(svg);
  });

  renderQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function currentMermaidTheme(): MermaidTheme {
  if (typeof document === 'undefined') return 'default';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

function mermaidViewBoxSize(svg: string): { width: number; height: number } {
  const viewBox = /\bviewBox=["']\s*[-+\d.e]+[\s,]+[-+\d.e]+[\s,]+([-+\d.e]+)[\s,]+([-+\d.e]+)/i.exec(svg);
  const width = Number(viewBox?.[1]);
  const height = Number(viewBox?.[2]);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : { width: 1200, height: 675 };
}

function clampMermaidZoom(value: number): number {
  return Math.min(MAX_MERMAID_ZOOM, Math.max(MIN_MERMAID_ZOOM, value));
}

export function calculateMermaidFitScale(options: {
  availableWidth: number;
  availableHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  expanded: boolean;
}): number {
  const widthScale = options.availableWidth / options.naturalWidth;
  const heightScale = options.availableHeight / options.naturalHeight;
  return options.expanded
    ? Math.min(widthScale, heightScale)
    : Math.min(1, widthScale, heightScale);
}

function useMermaidTheme(): MermaidTheme {
  const [theme, setTheme] = useState<MermaidTheme>(currentMermaidTheme);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => setTheme(currentMermaidTheme());
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    updateTheme();
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function MermaidDiagram(props: {
  code: string;
  density: 'default' | 'compact';
  autoRender?: boolean;
}) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const theme = useMermaidTheme();
  const autoRender = props.autoRender ?? true;
  const [manualRenderRequested, setManualRenderRequested] = useState(false);
  const [state, setState] = useState<MermaidRenderState>(() =>
    props.code.length > MAX_MERMAID_SOURCE_LENGTH
      ? { status: 'error', reason: 'too-large' }
      : autoRender
        ? { status: 'loading' }
        : { status: 'deferred' },
  );
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [panning, setPanning] = useState(false);
  const [pannableAxis, setPannableAxis] = useState<'none' | 'horizontal' | 'vertical' | 'both'>('none');
  const [viewportLayout, setViewportLayout] = useState<MermaidViewportLayout | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    if (props.code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setState({ status: 'error', reason: 'too-large' });
      return;
    }
    if (!autoRender && !manualRenderRequested) {
      setState({ status: 'deferred' });
      return;
    }

    let cancelled = false;
    setZoom(1);
    setViewportLayout(null);
    setState({ status: 'loading' });
    void renderMermaid(props.code, theme, () => !cancelled).then(
      (svg) => {
        if (!cancelled && svg) {
          const { width: naturalWidth, height: naturalHeight } = mermaidViewBoxSize(svg);
          setState({ status: 'rendered', svg, naturalWidth, naturalHeight });
        }
      },
      () => {
        if (!cancelled) setState({ status: 'error', reason: 'invalid' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [autoRender, manualRenderRequested, props.code, theme]);

  const naturalWidth = state.status === 'rendered' ? state.naturalWidth : 0;
  const naturalHeight = state.status === 'rendered' ? state.naturalHeight : 0;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || naturalWidth <= 0 || naturalHeight <= 0) return;

    let frame = 0;
    const updateLayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const style = getComputedStyle(viewport);
        const horizontalPadding = (Number.parseFloat(style.paddingLeft) || 0)
          + (Number.parseFloat(style.paddingRight) || 0);
        const verticalPadding = (Number.parseFloat(style.paddingTop) || 0)
          + (Number.parseFloat(style.paddingBottom) || 0);
        const availableWidth = Math.max(1, viewport.clientWidth - horizontalPadding);
        const maxViewportHeight = expanded
          ? Math.max(MIN_MERMAID_VIEWPORT_HEIGHT, viewport.clientHeight)
          : Math.max(
              MIN_MERMAID_VIEWPORT_HEIGHT,
              Math.min(
                MAX_MERMAID_VIEWPORT_HEIGHT,
                window.innerHeight * MAX_MERMAID_VIEWPORT_HEIGHT_RATIO,
              ),
            );
        const availableHeight = Math.max(1, maxViewportHeight - verticalPadding);
        const fitScale = calculateMermaidFitScale({
          availableWidth,
          availableHeight,
          naturalWidth,
          naturalHeight,
          expanded,
        });
        const fitWidth = naturalWidth * fitScale;
        const viewportHeight = Math.max(
          MIN_MERMAID_VIEWPORT_HEIGHT,
          Math.min(maxViewportHeight, naturalHeight * fitScale + verticalPadding),
        );
        setViewportLayout((current) =>
          current
          && Math.abs(current.fitWidth - fitWidth) < 0.5
          && Math.abs(current.viewportHeight - viewportHeight) < 0.5
            ? current
            : { fitWidth, viewportHeight });
      });
    };

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(viewport);
    window.addEventListener('resize', updateLayout);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', updateLayout);
    };
  }, [expanded, naturalHeight, naturalWidth]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) {
        setPannableAxis('none');
        return;
      }
      const horizontal = viewport.scrollWidth > viewport.clientWidth + 1;
      const vertical = viewport.scrollHeight > viewport.clientHeight + 1;
      setPannableAxis(horizontal
        ? vertical ? 'both' : 'horizontal'
        : vertical ? 'vertical' : 'none');
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, viewportLayout, zoom]);

  function updateZoom(nextZoom: number, anchor?: { clientX: number; clientY: number }) {
    const next = clampMermaidZoom(nextZoom);
    if (next === zoom) return;
    const viewport = viewportRef.current;
    const viewportBounds = viewport?.getBoundingClientRect();
    const anchorX = viewport && viewportBounds && anchor
      ? Math.min(viewport.clientWidth, Math.max(0, anchor.clientX - viewportBounds.left))
      : (viewport?.clientWidth ?? 0) / 2;
    const anchorY = viewport && viewportBounds && anchor
      ? Math.min(viewport.clientHeight, Math.max(0, anchor.clientY - viewportBounds.top))
      : (viewport?.clientHeight ?? 0) / 2;
    const contentX = viewport && viewport.scrollWidth > 0
      ? (viewport.scrollLeft + anchorX) / viewport.scrollWidth
      : 0.5;
    const contentY = viewport && viewport.scrollHeight > 0
      ? (viewport.scrollTop + anchorY) / viewport.scrollHeight
      : 0.5;
    setZoom(next);
    requestAnimationFrame(() => {
      if (!viewport) return;
      viewport.scrollLeft = contentX * viewport.scrollWidth - anchorX;
      viewport.scrollTop = contentY * viewport.scrollHeight - anchorY;
    });
  }

  function resetViewport() {
    setZoom(1);
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }

  const className = `maka-markdown-code maka-markdown-code-${props.density}`;
  if (state.status === 'rendered') {
    const zoomPercent = Math.round(zoom * 100);
    const canvasWidth = viewportLayout
      ? `${viewportLayout.fitWidth * zoom}px`
      : `min(${state.naturalWidth * zoom}px, ${zoomPercent}%)`;
    const renderDiagram = (isExpanded: boolean, showContent: boolean) => (
      <figure
        className={`${className} maka-mermaid-diagram${isExpanded ? ' maka-mermaid-diagram-expanded' : ''}`}
        data-maka-contract="mermaid"
        data-maka-mermaid-state="rendered"
        data-maka-mermaid-zoom={zoom.toFixed(2)}
        data-maka-mermaid-layout={viewportLayout ? 'ready' : 'measuring'}
        aria-label={copy.mermaidDiagram}
      >
        <Toolbar
          className="maka-mermaid-toolbar"
          label={copy.mermaidToolbar}
          size="sm"
          startContent={<span className="maka-mermaid-title">{copy.mermaidDiagram}</span>}
          endContent={(
            <div className="maka-mermaid-actions">
              <div className="maka-mermaid-zoom-actions">
                <IconButton
                  variant="ghost"
                  label={copy.mermaidZoomOut}
                  tooltip={copy.mermaidZoomOut}
                  isDisabled={zoom <= MIN_MERMAID_ZOOM}
                  onClick={() => updateZoom(zoom - MERMAID_ZOOM_STEP)}
                  icon={<ZoomOut size={ICON_SIZE.chrome} aria-hidden="true" />}
                />
                <output
                  className="maka-mermaid-zoom-level"
                  aria-label={copy.mermaidZoomLevel(zoomPercent)}
                >
                  {zoomPercent}%
                </output>
                <IconButton
                  variant="ghost"
                  label={copy.mermaidZoomIn}
                  tooltip={copy.mermaidZoomIn}
                  isDisabled={zoom >= MAX_MERMAID_ZOOM}
                  onClick={() => updateZoom(zoom + MERMAID_ZOOM_STEP)}
                  icon={<ZoomIn size={ICON_SIZE.chrome} aria-hidden="true" />}
                />
                <IconButton
                  variant="ghost"
                  label={copy.mermaidResetView}
                  tooltip={copy.mermaidResetView}
                  onClick={resetViewport}
                  icon={<Scan size={ICON_SIZE.chrome} aria-hidden="true" />}
                />
              </div>
              <IconButton
                variant="ghost"
                label={isExpanded ? copy.mermaidCollapseView : copy.mermaidExpandView}
                tooltip={isExpanded ? copy.mermaidCollapseView : copy.mermaidExpandView}
                aria-expanded={isExpanded}
                data-autofocus={isExpanded ? true : undefined}
                onClick={() => setExpanded(!isExpanded)}
                icon={isExpanded
                  ? <Minimize2 size={ICON_SIZE.chrome} aria-hidden="true" />
                  : <Maximize2 size={ICON_SIZE.chrome} aria-hidden="true" />}
              />
            </div>
          )}
        />
        {showContent && <div
          ref={viewportRef}
          className="maka-mermaid-viewport"
          data-maka-mermaid-panning={panning ? 'true' : 'false'}
          data-maka-mermaid-pannable={pannableAxis}
          style={isExpanded || !viewportLayout
            ? undefined
            : { height: `${viewportLayout.viewportHeight}px` }}
          aria-label={copy.mermaidViewport}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              updateZoom(zoom + MERMAID_ZOOM_STEP);
            } else if (event.key === '-' || event.key === '_') {
              event.preventDefault();
              updateZoom(zoom - MERMAID_ZOOM_STEP);
            } else if (event.key === '0') {
              event.preventDefault();
              resetViewport();
            }
          }}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            updateZoom(
              zoom + (event.deltaY < 0 ? MERMAID_ZOOM_STEP : -MERMAID_ZOOM_STEP),
              { clientX: event.clientX, clientY: event.clientY },
            );
          }}
          onPointerDown={(event) => {
            const viewport = viewportRef.current;
            if (!viewport || event.button !== 0 || pannableAxis === 'none') return;
            panRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              scrollLeft: viewport.scrollLeft,
              scrollTop: viewport.scrollTop,
            };
            viewport.setPointerCapture(event.pointerId);
            setPanning(true);
          }}
          onPointerMove={(event) => {
            const viewport = viewportRef.current;
            const pan = panRef.current;
            if (!viewport || !pan || pan.pointerId !== event.pointerId) return;
            viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
            viewport.scrollTop = pan.scrollTop - (event.clientY - pan.y);
          }}
          onPointerUp={(event) => {
            if (panRef.current?.pointerId !== event.pointerId) return;
            panRef.current = null;
            setPanning(false);
          }}
          onPointerCancel={() => {
            panRef.current = null;
            setPanning(false);
          }}
        >
          <div
            className="maka-mermaid-canvas"
            style={{ width: canvasWidth, aspectRatio: `${state.naturalWidth} / ${state.naturalHeight}` }}
          >
            <div
              className="maka-mermaid-svg"
              // Mermaid's strict security level disables link callbacks, encodes
              // HTML labels, and sanitizes the SVG. A final product-owned pass
              // removes navigation wrappers, event attributes, scripts, and
              // foreignObject before output crosses React's HTML boundary. We
              // never call bindFunctions.
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </div>
        </div>}
        {showContent && <Collapsible
          className="maka-mermaid-source"
          trigger={copy.mermaidViewSource}
          defaultIsOpen={false}
        >
          <CodeBlock
            code={props.code}
            language="mermaid"
            hasCopyButton
            isCollapsible
          />
        </Collapsible>}
      </figure>
    );
    return (
      <>
        {renderDiagram(false, !expanded)}
        <Dialog
          className="maka-mermaid-dialog"
          isOpen={expanded}
          onOpenChange={setExpanded}
          variant="fullscreen"
          purpose="form"
          padding={0}
          aria-label={copy.mermaidDiagram}
        >
          {expanded ? renderDiagram(true, true) : null}
        </Dialog>
      </>
    );
  }

  const message = state.status === 'loading'
    ? copy.mermaidRendering
    : state.status === 'deferred'
      ? copy.mermaidDeferred
      : state.reason === 'too-large'
      ? copy.mermaidTooLarge
      : copy.mermaidRenderFailed;

  return (
    <div
      className={`${className} maka-mermaid-fallback`}
      data-maka-contract="mermaid"
      data-maka-mermaid-state={state.status}
    >
      <CodeBlock
        code={props.code}
        language="mermaid"
        hasCopyButton
        isCollapsible
      />
      <div className="maka-mermaid-fallback-actions">
        <span className="maka-mermaid-status" role="status">
          {message}
        </span>
        {state.status === 'deferred' && <Button
          size="sm"
          variant="secondary"
          label={copy.mermaidRender}
          onClick={() => setManualRenderRequested(true)}
        />}
      </div>
    </div>
  );
}
