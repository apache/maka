import type { InlineReference } from '@maka/core';
import type { ChatComposerToken } from '@astryxdesign/core';
import { Sparkles } from './icons.js';

/** Last path segment of a POSIX-style relative path. */
export function inlineReferenceFileBasename(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
}

export function workspaceFileInlineReference(relativePath: string): InlineReference {
  return {
    kind: 'workspace_file',
    value: `@${relativePath}`,
    label: inlineReferenceFileBasename(relativePath),
  };
}

export function workspaceFileInlineReferencesFromTokenValues(
  values: Iterable<string | null>,
): InlineReference[] {
  const references: InlineReference[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value?.startsWith('@') || value.length === 1 || seen.has(value)) continue;
    seen.add(value);
    references.push(workspaceFileInlineReference(value.slice(1)));
  }
  return references;
}

/** The single visual projection shared by the Composer and sent transcript. */
export function inlineReferenceToken(reference: InlineReference): ChatComposerToken {
  return {
    value: reference.value,
    label: reference.label,
    ...(reference.kind === 'skill'
      ? { icon: <Sparkles size={12} aria-hidden="true" /> }
      : {}),
  };
}

export function inlineReferenceTokens(
  references: readonly InlineReference[],
): ChatComposerToken[] {
  return [...references]
    .sort((left, right) => right.value.length - left.value.length)
    .map(inlineReferenceToken);
}
