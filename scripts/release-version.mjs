import { pathToFileURL } from 'node:url';

export function parseProductReleaseVersion(version) {
  if (typeof version !== 'string') throw new Error('Expected a valid product release version');
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      version,
    );
  if (!match) throw new Error(`Expected a valid product release version; found ${version}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (
    prerelease.some(
      (identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier[0] === '0',
    )
  ) {
    throw new Error(`Expected a valid product release version; found ${version}`);
  }
  return {
    version,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version] = process.argv.slice(2);
  if (!version || process.argv.length !== 3) {
    throw new Error('usage: release-version.mjs <version>');
  }
  parseProductReleaseVersion(version);
}
