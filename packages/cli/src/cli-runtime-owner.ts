export const CLI_RUNTIME_OWNER_ENV = 'MAKA_CLI_RUNTIME_OWNER';

export type CliRuntimeOwner = 'embedded' | 'runtime-host';

export function resolveCliRuntimeOwner(value: string | undefined): CliRuntimeOwner {
  if (value === undefined || value === '' || value === 'embedded') return 'embedded';
  if (value === 'runtime-host') return value;
  throw new Error(`${CLI_RUNTIME_OWNER_ENV} must be "embedded" or "runtime-host"`);
}
