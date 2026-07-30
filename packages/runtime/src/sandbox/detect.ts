const SANDBOX_DENIAL_PATTERN =
  /operation not permitted|sandbox-exec|file system sandbox blocked|sandbox(?:ed)?[^\n]*den(?:y|ied)/i;

export function isLikelySandboxDenial(input: {
  stdout: string;
  stderr: string;
  sandboxed: boolean;
}): boolean {
  if (!input.sandboxed) return false;
  return SANDBOX_DENIAL_PATTERN.test(`${input.stderr}\n${input.stdout}`);
}
