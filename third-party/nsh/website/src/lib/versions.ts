// Which version of the documentation this build is. `scripts/versions.js`
// builds the latest release at the root, `main` at /versions/main and every
// other release at /versions/<tag>, each with these variables set; a plain
// `bun run build` is `main` alone.

export interface SiteVersion {
  id: string;
  label: string;
}

const DEFAULT_VERSIONS: SiteVersion[] = [{ id: 'main', label: 'main' }];

function readVersions(): SiteVersion[] {
  const value = import.meta.env.PUBLIC_SITE_VERSIONS;
  if (!value) return DEFAULT_VERSIONS;
  try {
    const versions = JSON.parse(value);
    if (!Array.isArray(versions)) return DEFAULT_VERSIONS;
    const valid = versions.filter(
      (version): version is SiteVersion => typeof version?.id === 'string' && typeof version?.label === 'string',
    );
    return valid.length > 0 ? valid : DEFAULT_VERSIONS;
  } catch {
    return DEFAULT_VERSIONS;
  }
}

export const siteVersions = readVersions();
export const currentVersion: string = import.meta.env.PUBLIC_SITE_VERSION || 'main';
export const latestVersion: string = import.meta.env.PUBLIC_SITE_LATEST_VERSION || 'main';
/** Only the version at the root is indexed; the others point search engines at it. */
export const isLatestVersion = currentVersion === latestVersion;

/** The path inside a version, without the base: `/versions/main/docs/x` → `/docs/x`. */
export function versionPath(pathname: string, base: string): string {
  const prefix = base.replace(/\/+$/, '');
  const path = prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
  return `/${path.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
}

/** The same page in another version, from the site's root. */
export function versionHref(version: SiteVersion, path: string): string {
  const rest = path === '/' ? '' : path;
  return version.id === latestVersion ? rest || '/' : `/versions/${encodeURIComponent(version.id)}${rest}`;
}
