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

import { render } from 'pele';

export type DiagramPalette = {
  background: string;
  text: string;
  muted: string;
  secondary: string;
  surface: string;
  raised: string;
  line: string;
  accent: string;
  danger: string;
};

// Image SVGs have no surrounding DOM or inherited CSS custom properties.
export function diagramSvg(source: string, palette: DiagramPalette, maxWidth: number) {
  const result = render(source, {
    responsive: false,
    maxWidth,
    links: false,
    images: false,
    limit: 50_000,
    outputLimit: 4_000_000,
    maxEdges: 1_000,
  });
  const variables: Record<string, string> = {
    '--pele-bg': palette.background,
    '--pele-fg': palette.text,
    '--pele-muted': palette.muted,
    '--pele-line': palette.secondary,
    '--pele-surface': palette.surface,
    '--pele-surface-alt': palette.raised,
    '--pele-border': palette.line,
    '--pele-accent': palette.accent,
    '--pele-critical': palette.danger,
    '--pele-error': palette.danger,
  };
  const rootStyle = result.svg.match(/^<svg\b[^>]*\bstyle="([^"]*)"/)?.[1] ?? '';
  for (const declaration of rootStyle.split(';')) {
    const colon = declaration.indexOf(':');
    if (declaration.startsWith('--') && colon > 0)
      variables[declaration.slice(0, colon)] = declaration.slice(colon + 1);
  }
  const resolve = (value: string, depth = 0): string => {
    if (depth > 32) throw new Error('Circular diagram color variable');
    let previous: string;
    do {
      previous = value;
      value = value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_, name, fallback) => {
        const selected = variables[name] ?? fallback?.trim();
        if (selected === undefined) throw new Error(`Unknown diagram color variable: ${name}`);
        return resolve(selected, depth + 1);
      });
    } while (value !== previous && value.includes('var('));
    return value;
  };
  // Resolve attribute values only: a label containing "var(...)" is literal text.
  const svg = result.svg.replace(/([\w:-]+)="([^"]*)"/g, (attribute, name, value) =>
    value.includes('var(') &&
    !name.startsWith('data-') &&
    !name.startsWith('aria-') &&
    !['id', 'class', 'href'].includes(name)
      ? `${name}="${resolve(value)}"`
      : attribute,
  );
  return { svg, width: result.width, height: result.height };
}
