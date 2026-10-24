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

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export const SVG_PREVIEW_MAX_CHARS = 256 * 1024;
export const SVG_PREVIEW_MAX_NODES = 4000;
const NS = 'http://www.w3.org/2000/svg';
const TAGS = new Set(
  'svg g defs symbol style title desc path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop clipPath mask pattern marker'.split(
    ' ',
  ),
);
const ATTRS = new Set(
  'id class viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit opacity color font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline dx dy rotate textLength lengthAdjust letter-spacing word-spacing gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr clip-path clip-rule mask maskUnits maskContentUnits patternUnits patternContentUnits patternTransform marker-start marker-mid marker-end markerWidth markerHeight refX refY orient markerUnits preserveAspectRatio vector-effect paint-order visibility display'.split(
    ' ',
  ),
);
const STYLE = new Set(
  'fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity color font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing word-spacing stop-color stop-opacity'.split(
    ' ',
  ),
);

/** Cheap byte sniff keeps ordinary unsupported binaries out of the XML parser. */
export function isSvgPreviewCandidate(bytes: Uint8Array): boolean {
  if (bytes.byteLength > SVG_PREVIEW_MAX_CHARS * 4) return false;
  let offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32) break;
    offset++;
  }
  return bytes[offset] === 60;
}

function safeValue(value: string): boolean {
  // Reject CSS escapes, external URLs and expression syntax; fragment paint servers are supported.
  return (
    !/[\\<>@]/.test(value) &&
    !/expression|javascript|data:|https?:|\/\*/i.test(value) &&
    !/url\s*\(/i.test(value.replace(/url\(\s*['"]?#[a-zA-Z_][\w:.-]*['"]?\s*\)/g, ''))
  );
}

function staticDeclarations(source: string): string {
  return source
    .split(';')
    .flatMap((declaration) => {
      const colon = declaration.indexOf(':');
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      return colon > 0 && STYLE.has(property) && safeValue(value) ? [`${property}:${value}`] : [];
    })
    .join(';');
}

/** A deliberately small static CSS subset, scoped by the SVG image document. */
function staticStylesheet(source: string): string {
  if (source.length > 32 * 1024) return '';
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim();
    if (!/^[a-zA-Z_.*#][\w.*# ,>:+-]*$/.test(selector)) continue;
    const declarations = staticDeclarations(match[2]!);
    if (declarations) rules.push(`${selector}{${declarations}}`);
  }
  return rules.join('');
}

/** Static SVG only. Never insert the returned document into the application's DOM. */
export function prepareSvgPreview(source: string): string {
  if (!source || source.length > SVG_PREVIEW_MAX_CHARS || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('SVG exceeds preview limits or contains a document type');
  let invalid = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => {
        invalid = true;
      },
      error: () => {
        invalid = true;
      },
      fatalError: () => {
        invalid = true;
      },
    },
  }).parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (
    invalid ||
    !root ||
    root.localName !== 'svg' ||
    (root.namespaceURI && root.namespaceURI !== NS)
  )
    throw new Error('Invalid SVG document');
  // Iterate rather than recurse: pathological nesting cannot exhaust the call stack.
  const pending: { node: Element; depth: number }[] = [{ node: root, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > SVG_PREVIEW_MAX_NODES || depth > 64)
      throw new Error('SVG complexity exceeds preview limits');
    for (let i = node.attributes.length - 1; i >= 0; i--) {
      const attribute = node.attributes.item(i)!;
      const name = attribute.name;
      if (name === 'style') {
        const declarations = staticDeclarations(attribute.value);
        if (declarations) node.setAttribute('style', declarations);
        else node.removeAttribute(name);
      } else if (!ATTRS.has(name) || !safeValue(attribute.value)) node.removeAttribute(name);
    }
    for (let child = node.firstChild; child; ) {
      const next = child.nextSibling;
      if (child.nodeType === 1) {
        const element = child as Element;
        if (!TAGS.has(element.localName) || (element.namespaceURI && element.namespaceURI !== NS))
          node.removeChild(child);
        else if (element.localName === 'style') {
          const css = staticStylesheet(element.textContent ?? '');
          if (!css) node.removeChild(child);
          else {
            element.textContent = css;
            pending.push({ node: element, depth: depth + 1 });
          }
        } else pending.push({ node: element, depth: depth + 1 });
      } else if (child.nodeType !== 3 && child.nodeType !== 4) node.removeChild(child);
      child = next;
    }
  }
  root.setAttribute('xmlns', NS);
  const viewBox = root.hasAttribute('viewBox')
    ? root.getAttribute('viewBox')!.trim().split(/[ ,]+/).map(Number)
    : undefined;
  if (
    viewBox &&
    (viewBox.length !== 4 ||
      viewBox.some((v) => !Number.isFinite(v)) ||
      viewBox[2]! <= 0 ||
      viewBox[3]! <= 0)
  )
    throw new Error('Invalid SVG viewBox');
  for (const name of ['width', 'height']) {
    const value = root.getAttribute(name);
    if (
      value &&
      (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:px|%)?$/.test(value) ||
        parseFloat(value) > 16384 ||
        parseFloat(value) <= 0)
    )
      root.removeAttribute(name);
  }
  const width = parseFloat(root.getAttribute('width') || '300');
  const height = parseFloat(root.getAttribute('height') || '150');
  if (width * height > 32 * 1024 * 1024) throw new Error('SVG dimensions exceed preview limits');
  return new XMLSerializer().serializeToString(root);
}
