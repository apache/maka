// Windows resolves `npm` to npm.cmd, and a bare `npm` never reaches it: libuv's
// process launcher tries only .com and .exe and ignores PATHEXT, and Node
// refuses to launch a .cmd without a shell at all. So every npm subprocess on
// Windows has to go through the shell, and every one on POSIX must not — there
// the extensionless shim resolves directly and a shell would only add quoting.
//
// This is one rule with more than one caller, and getting it wrong is invisible
// until something actually runs on Windows, which until now nothing did.
export function npmSpawnOptions(options = {}, platform = process.platform) {
  return { ...options, shell: platform === 'win32' };
}
