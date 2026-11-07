/* Licensed under the Apache License, Version 2.0. See LICENSE. */
import english from './en.json' with { type: 'json' };
import type { Manifest, QuickLocale } from './plugin.js';
export type { QuickLocale } from './plugin.js';
// A worker and its independently bundled plugin share one locale without sharing imports.
const stateKey = Symbol.for('maka.quick-tools.locale.v1');
const globals = globalThis as typeof globalThis & {
  [stateKey]?: { locale: QuickLocale; listeners: Set<() => void> };
};
const state = (globals[stateKey] ??= { locale: 'zh-CN', listeners: new Set() });
export const quickLocale = (): QuickLocale => state.locale;
export function setQuickLocale(locale: QuickLocale): void {
  if (!['en', 'zh-CN', 'zh-TW'].includes(locale) || state.locale === locale) return;
  state.locale = locale;
  for (const listener of state.listeners) listener();
}
export function subscribeQuickLocale(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}
/** Call only on authored UI copy, never on arbitrary user content. */
export function qt(source: string, ...values: unknown[]): string {
  const copy =
    state.locale === 'en' ? ((english as Record<string, string>)[source] ?? source) : source;
  return copy.replace(/\$\{(\d+)\}/g, (match, index) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}
/** Manifest translations are explicit package metadata, not a rewrite of user rows. */
export function localizeManifest(manifest: Manifest): Manifest {
  const localized = manifest.locales?.[state.locale === 'en' ? 'en' : 'zh-CN'];
  if (!localized) return manifest;
  return {
    ...manifest,
    name: localized.name ?? manifest.name,
    description: localized.description ?? manifest.description,
    commands: manifest.commands.map((command) => {
      const copy = localized.commands?.[command.id];
      return copy
        ? {
            ...command,
            name: copy.name ?? command.name,
            kind: copy.kind ?? command.kind,
            keywords: `${command.keywords ?? ''} ${command.name} ${copy.name ?? ''}`,
            actions: command.actions.map((action) => ({
              ...action,
              title: copy.actions?.[action.id] ?? action.title,
            })),
          }
        : command;
    }),
  };
}
