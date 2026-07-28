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
    // Bind both editing protocols; `projectEffectiveProductToolSurface` selects
    // exactly one via policy.editingProtocol (#1493 / #1552).
    editingProtocol: options.editingProtocol ?? 'all',
    includeEdit: Boolean(options.filesystemWorker),
  });
}
