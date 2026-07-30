import {
  buildBuiltinTools,
  type BuildBuiltinToolsOptions,
  type MakaTool,
} from '@maka/runtime';

type DesktopBuiltinToolsOptions = Omit<BuildBuiltinToolsOptions, 'includeEdit'>;

/** Keep worker-backed tools aligned across the Desktop parent and child surfaces. */
export function buildDesktopBuiltinTools(options: DesktopBuiltinToolsOptions): MakaTool[] {
  return buildBuiltinTools({
    ...options,
    includeEdit: Boolean(options.filesystemWorker),
  });
}
