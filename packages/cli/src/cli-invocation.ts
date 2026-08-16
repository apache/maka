export interface MakaResumeCommandOptions {
  readonly cwd?: string;
  readonly hostProfileId?: string;
}

export function formatMakaResumeCommand(
  cliCommand: string,
  sessionId: string,
  options: MakaResumeCommandOptions = {},
): string {
  return [
    `${cliCommand} --resume ${sessionId}`,
    ...(options.cwd ? ['--cwd', options.cwd] : []),
    ...(options.hostProfileId ? ['--host', options.hostProfileId] : []),
  ].join(' ');
}

export function formatMakaResumeHint(
  cliCommand: string,
  sessionId: string | null,
  options: MakaResumeCommandOptions = {},
): string | null {
  if (!sessionId) return null;
  return `Resume this session with:\n  ${formatMakaResumeCommand(cliCommand, sessionId, options)}`;
}
