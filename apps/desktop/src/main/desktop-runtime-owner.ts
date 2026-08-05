export type DesktopRuntimeOwner = 'embedded' | 'runtime-host';

export const DESKTOP_RUNTIME_OWNER_ENV = 'MAKA_DESKTOP_RUNTIME_OWNER';

/**
 * Select the one Interactive Runtime owner before either boot graph is loaded.
 * An invalid opt-in is fatal so startup can never drift into an embedded fallback.
 */
export function resolveDesktopRuntimeOwner(value: string | undefined): DesktopRuntimeOwner {
  if (value === undefined || value === '' || value === 'embedded') return 'embedded';
  if (value === 'runtime-host') return 'runtime-host';
  throw new Error(
    `${DESKTOP_RUNTIME_OWNER_ENV} must be "embedded" or "runtime-host"`,
  );
}
