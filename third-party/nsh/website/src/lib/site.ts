/** The published address of the site: canonical links, sitemap, llms.txt. */
export const SITE_URL = 'https://nsh.dev';

export const SITE_TITLE = 'Native Shell';

export const SITE_DESCRIPTION =
  'Native Shell is a Rust-first native UI framework: build one app for iOS, Android, macOS, Windows, Linux and the web, with each platform’s own UI and interaction.';

export const REPO_URL = 'https://github.com/longbridge/nsh';

/** The App Stories catalog, where apps are submitted. */
export const SHOWCASES_URL = 'https://github.com/longbridge/nsh-showcases';

export const GPUI_KIT_URL = 'https://gpui-kit.com';

/** Where "Edit this page" points: the file's path relative to the repository root follows. */
export const EDIT_BASE = `${REPO_URL}/edit/main/`;

export type Lang = 'en' | 'zh-CN';

/** `BASE_URL` with exactly one trailing slash. */
export const BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/`;

/** A site path (`docs/x`, `/docs/x`) below the base. */
export function url(path = ''): string {
  const joined = `${BASE}${path.replace(/^\/+/, '')}`;
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

/** The same route in the other locale. */
export function localePrefix(lang: Lang): string {
  return lang === 'zh-CN' ? 'zh-CN/' : '';
}
