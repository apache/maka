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
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { ICON_SIZE, Check, Copy, Maximize2, Minimize2 } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';

export const MAX_MERMAID_SOURCE_LENGTH = 20_000;
export const MAX_MERMAID_EDGES = 500;
export const MERMAID_RENDER_CACHE_LIMIT = 24;
export const MERMAID_RENDER_CACHE_MAX_CHARS = 4 * 1024 * 1024;
export const MAX_MERMAID_ZOOM = 3;
export const MERMAID_EXPORT_PIXEL_RATIO = 2;
/** Leave a 2x margin below Chromium's canvas edge limit. */
export const MERMAID_EXPORT_MAX_EDGE_PX = 32_767;
/** Cap RGBA allocations at 256 MiB. */
export const MERMAID_EXPORT_MAX_PIXELS = 64 * 1024 * 1024;
const MERMAID_IMAGE_COPY_KEY = 'mermaid-image';
type MermaidLayout = { width: number; fontFamily: string; fontFamilyMono: string };

type MermaidRenderState =
  | { status: 'deferred' }
  | { status: 'loading' }
  | { status: 'rendered'; renderKey: string; svg: string; naturalWidth: number; naturalHeight: number }
  | { status: 'error'; reason: 'invalid' | 'too-large' };

type MermaidRenderTemplate = {
  renderKey: string;
  svg: string;
  namespace: string;
  naturalWidth: number;
  naturalHeight: number;
};

let diagramSequence = 0;
const mermaidRenderCache = new Map<string, MermaidRenderTemplate>();

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

function mermaidRenderKey(code: string, layout: MermaidLayout): string {
  return `${layout.width}\0${layout.fontFamily}\0${layout.fontFamilyMono}\0${code}`;
}

function touchMermaidRenderCacheEntry(key: string, entry: MermaidRenderTemplate): void {
  mermaidRenderCache.delete(key);
  mermaidRenderCache.set(key, entry);
}

function writeMermaidRenderCache(key: string, template: MermaidRenderTemplate): void {
  if (template.svg.length > MERMAID_RENDER_CACHE_MAX_CHARS) return;
  touchMermaidRenderCacheEntry(key, template);
  while (
    mermaidRenderCache.size > MERMAID_RENDER_CACHE_LIMIT
    || [...mermaidRenderCache.values()].reduce((total, entry) => total + entry.svg.length, 0) > MERMAID_RENDER_CACHE_MAX_CHARS
  ) {
    const oldestKey = mermaidRenderCache.keys().next().value;
    if (oldestKey === undefined) break;
    mermaidRenderCache.delete(oldestKey);
  }
}

function nextMermaidRenderId(kind: 'template' | 'instance', code = ''): string {
  let id: string;
  do id = `maka-mermaid-${kind}-${++diagramSequence}`;
  while (code.includes(id));
  return id;
}

function instantiateMermaidSvg(template: MermaidRenderTemplate): string {
  return template.svg.replaceAll(
    template.namespace,
    nextMermaidRenderId('instance', template.svg),
  );
}

// Standalone SVG images need explicit dimensions to preserve their aspect ratio.
export function mermaidSvgToDataUrl(svg: string, width: number, height: number): string {
  const rootTag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const sizedRootTag = rootTag
    .replace(/\s(?:width|height)="[^"]*"/gi, '')
    .replace(/\sstyle="([^"]*)"/i, (_match, style: string) => {
      const retained = style.split(';').filter((declaration) =>
        !/^\s*(?:width|height|max-width)\s*:/i.test(declaration) && declaration.trim()).join(';');
      return retained ? ` style="${retained}"` : '';
    })
    .replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedRootTag + svg.slice(rootTag.length))}`;
}

// Oversized canvases can lose their context or fail toBlob.
export function mermaidExportScale(width: number, height: number): number {
  return Math.min(
    MERMAID_EXPORT_PIXEL_RATIO,
    MERMAID_EXPORT_MAX_EDGE_PX / Math.max(width, height),
    Math.sqrt(MERMAID_EXPORT_MAX_PIXELS / (width * height)),
  );
}

// An SVG image cannot inherit the page's computed theme styles.
async function snapshotMermaidSvg(svg: SVGSVGElement, width: number, height: number): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const properties = [
    'fill', 'stroke', 'color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'stroke-dasharray',
    'stroke-linecap', 'stroke-linejoin', 'text-anchor', 'dominant-baseline', 'letter-spacing',
  ];
  const originals = [svg, ...svg.querySelectorAll<SVGElement>('*')];
  const copies = [clone, ...clone.querySelectorAll<SVGElement>('*')];
  const fonts = new Set<string>();
  for (let index = 0; index < originals.length; index++) {
    const computed = getComputedStyle(originals[index]!);
    if (originals[index]!.localName === 'text') {
      fonts.add(computed.getPropertyValue('font-family').split(',')[0]!.trim().replace(/^["']|["']$/g, ''));
    }
    for (const property of properties) {
      const value = computed.getPropertyValue(property);
      // Chromium resolves paint-server URLs against the page, but exported
      // gradients must still point into the standalone SVG.
      if (value) copies[index]!.style.setProperty(property, value.replace(/url\(["']?[^#)]+#([^"')]+)["']?\)/g, 'url(#$1)'));
    }
  }
  // Export the full diagram regardless of the current zoom.
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // SVG images cannot inherit the page's @font-face rules.
  const faces = new Map<string, string>();
  const collectFaces = (rules: CSSRuleList, baseUrl: string) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === 5) { // CSSRule.FONT_FACE_RULE
        const face = rule as CSSFontFaceRule;
        const family = face.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
        if (fonts.has(family)) faces.set(face.cssText, baseUrl);
      } else if ('cssRules' in rule) collectFaces((rule as CSSGroupingRule).cssRules, baseUrl);
    }
  };
  for (const sheet of Array.from(document.styleSheets ?? [])) {
    // Cross-origin stylesheets are inaccessible; product fonts are same-origin.
    try { collectFaces(sheet.cssRules, sheet.href ?? document.baseURI); } catch {}
  }
  const embedded = await Promise.all([...faces].map(async ([css, baseUrl]) => {
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const response = await fetch(new URL(match[1]!, baseUrl));
      if (!response.ok) throw new Error('Could not export diagram font');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        void response.blob().then((blob) => reader.readAsDataURL(blob), reject);
      });
      css = css.replace(match[0], `url("${dataUrl}")`);
    }
    return css;
  }));
  if (embedded.length > 0) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = embedded.join('\n');
    clone.prepend(style);
  }
  return new XMLSerializer().serializeToString(clone);
}

async function mermaidSvgToPngBlob(
  svg: string,
  width: number,
  height: number,
  background: string,
): Promise<Blob> {
  const scale = mermaidExportScale(width, height);
  // Round down so neither export budget can be exceeded.
  const canvasWidth = Math.floor(width * scale);
  const canvasHeight = Math.floor(height * scale);
  if (canvasWidth < 1 || canvasHeight < 1) throw new Error('Mermaid diagram too large to export');
  // The SVG decoder must respect the same size limits as the canvas.
  const image = new Image();
  image.src = mermaidSvgToDataUrl(svg, canvasWidth, canvasHeight);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Canvas toBlob returned no PNG blob');
  return blob;
}

function renderedMermaidState(template: MermaidRenderTemplate): MermaidRenderState {
  return {
    status: 'rendered',
    renderKey: template.renderKey,
    svg: instantiateMermaidSvg(template),
    naturalWidth: template.naturalWidth,
    naturalHeight: template.naturalHeight,
  };
}

export function MermaidDiagram(props: {
  code: string;
  density: 'default' | 'compact';
  autoRender?: boolean;
}) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const autoRender = props.autoRender ?? true;
  const [layout, setLayout] = useState<MermaidLayout>({ width: 640, fontFamily: 'sans-serif', fontFamilyMono: 'monospace' });
  const renderKey = mermaidRenderKey(props.code, layout);
  const [expanded, setExpanded] = useState(false);
  const [manualRenderRequested, setManualRenderRequested] = useState(false);
  const [state, setState] = useState<MermaidRenderState>(() => {
    if (props.code.length > MAX_MERMAID_SOURCE_LENGTH) return { status: 'error', reason: 'too-large' };
    if (!autoRender && !manualRenderRequested) return { status: 'deferred' };
    const cached = mermaidRenderCache.get(props.code);
    if (!cached) return { status: 'loading' };
    touchMermaidRenderCacheEntry(props.code, cached);
    return renderedMermaidState(cached);
  });
  const copyFeedback = useClipboardCopyFeedback();
  const containerRef = useRef<HTMLElement | null>(null);
  const svgRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      // Measuring SVG height would feed rendering back into layout.
      const width = Math.max(1, (container.clientWidth || 704) - 64);
      const style = getComputedStyle(container);
      const fontFamily = style.getPropertyValue('--font-family-body').trim() || style.fontFamily || 'sans-serif';
      const fontFamilyMono = style.getPropertyValue('--font-family-code').trim() || 'monospace';
      setLayout((current) => current.width === width && current.fontFamily === fontFamily && current.fontFamilyMono === fontFamilyMono
        ? current : { width, fontFamily, fontFamilyMono });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [expanded, state.status]);

  useEffect(() => {
    if (props.code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setState({ status: 'error', reason: 'too-large' });
      return;
    }
    if (!autoRender && !manualRenderRequested) {
      setState({ status: 'deferred' });
      return;
    }
    if (state.status === 'rendered' && state.renderKey === renderKey) return;

    let cancelled = false;
    setState((current) => current.status === 'rendered' ? current : { status: 'loading' });
    void (async () => {
      const { render } = await import('pele');
      await document.fonts?.ready;
      if (cancelled) return;
      // Recheck after awaiting: another instance may have populated the cache.
      let template = mermaidRenderCache.get(props.code);
      if (template?.renderKey === renderKey) {
        touchMermaidRenderCacheEntry(props.code, template);
      } else {
        const namespace = nextMermaidRenderId('template', props.code);
        const result = render(props.code, {
          limit: MAX_MERMAID_SOURCE_LENGTH,
          maxEdges: MAX_MERMAID_EDGES,
          outputLimit: MERMAID_RENDER_CACHE_MAX_CHARS,
          links: false,
          images: false,
          idPrefix: namespace,
          maxWidth: layout.width,
          fontFamily: layout.fontFamily,
          fontFamilyMono: layout.fontFamilyMono,
        });
        template = {
          renderKey,
          namespace,
          svg: sanitizeRenderedMermaidSvg(result.svg),
          naturalWidth: result.width,
          naturalHeight: result.height,
        };
        writeMermaidRenderCache(props.code, template);
      }
      setState(renderedMermaidState(template));
    })().catch(() => {
      if (!cancelled) setState({ status: 'error', reason: 'invalid' });
    });
    return () => {
      cancelled = true;
    };
  }, [autoRender, manualRenderRequested, props.code, layout]);

  useEffect(() => {
    const container = svgRef.current;
    if (!container || state.status !== 'rendered') return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    void import('pele').then(({ enableZoom }) => {
      if (cancelled) return;
      const zoom = enableZoom(container, {
        always: true,
        maxScale: MAX_MERMAID_ZOOM,
        labels: { zoomIn: copy.mermaidZoomIn, zoomOut: copy.mermaidZoomOut, reset: copy.mermaidResetView },
      });
      destroy = () => zoom.destroy();
    });
    return () => { cancelled = true; destroy?.(); };
  }, [expanded, state, copy]);

  const className = `maka-markdown-code maka-markdown-code-${props.density}`;
  if (state.status === 'rendered') {
    const diagramCopyPhase = copyFeedback.phaseFor(MERMAID_IMAGE_COPY_KEY);
    async function copyDiagramToClipboard(event: ReactMouseEvent<HTMLButtonElement>) {
      if (state.status !== 'rendered') return;
      const figure = event.currentTarget.closest('figure');
      if (!figure) return;
      const svg = figure.querySelector<SVGSVGElement>('.maka-mermaid-svg > svg');
      if (!svg) return;
      const background = getComputedStyle(figure).backgroundColor;
      await copyFeedback.attempt(MERMAID_IMAGE_COPY_KEY, async () => {
        const snapshot = await snapshotMermaidSvg(svg, state.naturalWidth, state.naturalHeight);
        const blob = await mermaidSvgToPngBlob(
          snapshot,
          state.naturalWidth,
          state.naturalHeight,
          background,
        );
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      });
    }
    const renderDiagram = (isExpanded: boolean, showContent: boolean) => (
      <figure
        className={`${className} maka-mermaid-diagram${isExpanded ? ' maka-mermaid-diagram-expanded' : ''}`}
        data-maka-contract="mermaid"
        data-maka-mermaid-state="rendered"
        style={{
          '--maka-mermaid-natural-width': `${state.naturalWidth}px`,
          '--maka-mermaid-ratio': state.naturalWidth / state.naturalHeight,
        } as CSSProperties}
        ref={isExpanded === expanded ? (element) => { containerRef.current = element; } : undefined}
        aria-label={copy.mermaidDiagram}
      >
        <Toolbar
          className="maka-mermaid-toolbar"
          label={copy.mermaidToolbar}
          size="sm"
          startContent={<span className="maka-mermaid-title">{copy.mermaidDiagram}</span>}
          endContent={(
            <div className="maka-mermaid-actions">
              <IconButton
                variant="ghost"
                label={diagramCopyPhase === 'failed' ? copy.mermaidCopyImageFailed : copy.mermaidCopyImage}
                tooltip={diagramCopyPhase === 'failed' ? copy.mermaidCopyImageFailed : copy.mermaidCopyImage}
                onClick={copyDiagramToClipboard}
                icon={diagramCopyPhase === 'copied'
                  ? <Check size={ICON_SIZE.chrome} aria-hidden="true" />
                  : <Copy size={ICON_SIZE.chrome} aria-hidden="true" />}
              />
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
        <div
          ref={showContent ? svgRef : undefined}
          className="maka-mermaid-viewport maka-mermaid-svg"
          aria-label={copy.mermaidViewport}
          dangerouslySetInnerHTML={{ __html: showContent ? state.svg : '' }}
        />
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
      ref={(element) => { containerRef.current = element; }}
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
