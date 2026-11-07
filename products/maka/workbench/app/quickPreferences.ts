/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { batch, effect, host, signal } from 'nsh';
import { z } from 'zod';
import { appearance, paletteIds, textSizes } from './appearance';
import { parseHex } from './colorPalette';

const preferences = z.object({
  locale: z.string().max(30),
  theme: z.enum(['system', 'light', 'dark']),
  textSize: z.number().refine((value) => textSizes.includes(value)),
  palette: z.enum(paletteIds as [(typeof paletteIds)[number], ...(typeof paletteIds)[number][]]),
  custom: z.object({
    hue: z.number(),
    tint: z.number(),
    accent: z.string().refine((value) => parseHex(value) !== null),
  }),
});
/** Each window has a separate JS VM; the shell relays changes and replays the latest snapshot. */
export function initializeQuickPreferences(runtime: {
  locale(): string;
  setLocale(value: string): void;
}) {
  if (!host.params.nativeQuickTools && !host.params.quickToolsPanel) return;
  const pending = signal<z.infer<typeof preferences> | null>(null);
  let received = !host.params.quickToolsPanel,
    last = '';
  const accept = (value: unknown) => {
    if (value !== null) pending.set(preferences.parse(value));
  };
  host.on('quickTools.preferences', accept);
  if (host.params.quickToolsPanel)
    void host
      .call('quickTools.preferences.read', {})
      .then(accept)
      .catch((error) => console.warn(String(error)));
  effect(() => {
    if (!appearance.ready()) return;
    const value = pending();
    if (!value) return;
    received = true;
    last = JSON.stringify(value);
    batch(() => {
      runtime.setLocale(value.locale);
      appearance.sync(value);
      pending.set(null);
    });
  });
  effect(() => {
    if (!appearance.ready()) return;
    const value = {
      locale: runtime.locale(),
      theme: appearance.theme(),
      textSize: appearance.textSize(),
      palette: appearance.palette(),
      custom: appearance.custom(),
    };
    const encoded = JSON.stringify(value);
    if (!received || encoded === last) return;
    last = encoded;
    void host
      .call('quickTools.preferences.update', value)
      .catch((error) => console.warn(String(error)));
  });
}
