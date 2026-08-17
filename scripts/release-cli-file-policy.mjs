const DEVELOPMENT_DIRECTORIES = new Set([
  '.nyc_output',
  '__fixtures__',
  '__tests__',
  'coverage',
  'fixture',
  'fixtures',
  'test',
  'tests',
]);

export function isThirdPartyDevelopmentArtifact(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => DEVELOPMENT_DIRECTORIES.has(segment))) return true;

  const file = segments.at(-1) ?? '';
  return (
    /\.(?:spec|test)\.(?:cjs|js|mjs)$/.test(file) ||
    /\.d\.ts(?:\.map)?$/.test(file) ||
    /\.(?:cjs|js|mjs)\.map$/.test(file) ||
    /\.(?:cts|mts|ts|tsx)$/.test(file) ||
    file.endsWith('.tsbuildinfo')
  );
}

export function isMakaDevelopmentArtifact(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => segment === 'src')) return true;
  if (segments.some((segment) => DEVELOPMENT_DIRECTORIES.has(segment))) return true;

  const file = segments.at(-1) ?? '';
  return (
    file === 'dev-cli.js' ||
    /\.(?:spec|test)\.js$/.test(file) ||
    /\.d\.ts(?:\.map)?$/.test(file) ||
    /\.js\.map$/.test(file)
  );
}
