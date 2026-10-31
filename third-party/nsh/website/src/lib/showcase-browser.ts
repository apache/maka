// App Stories' browsing: search, category, sort and pages. The page's script
// and the tests share it; nothing here changes the editorial Featured order.

/** What browsing reads of an app. */
export interface BrowsedApp {
  id: string;
  name: string;
  author?: string;
  description: string;
  category: string;
  platforms: string[];
  source?: string | null;
  featured: boolean;
  stars: number | null;
  publishedAt: string | null;
}

export type ShowcaseSort = 'newest' | 'stars';

export interface ShowcaseQuery {
  query?: string;
  category?: string;
  sort?: ShowcaseSort;
}

/** The apps a search and category match: Featured in editorial order, the others and all of them sorted. */
export function selectShowcases<T extends BrowsedApp>(apps: T[], { query = '', category = 'all', sort = 'newest' }: ShowcaseQuery = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = apps.filter((app) => {
    const text = [app.name, app.author ?? '', app.id, app.description, ...app.platforms, app.source ?? ''].join(' ').toLocaleLowerCase();
    return (category === 'all' || app.category === category) && terms.every((term) => text.includes(term));
  });
  const compare = (a: T, b: T) => {
    if (sort === 'stars' && a.stars !== b.stars) return (b.stars ?? -1) - (a.stars ?? -1);
    return (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0) || a.name.localeCompare(b.name);
  };
  return {
    featured: matches.filter((app) => app.featured),
    community: matches.filter((app) => !app.featured).sort(compare),
    all: [...matches].sort(compare),
  };
}

/** Six editorial selections per page. */
export function paginateFeatured<T extends { featured: boolean }>(apps: T[], requestedPage = 1) {
  return paginate(apps.filter((app) => app.featured), requestedPage, 6);
}

/** Nine filtered and sorted catalog entries per page. */
export function paginateAll<T>(apps: T[], requestedPage = 1) {
  return paginate(apps, requestedPage, 9);
}

function paginate<T>(apps: T[], requestedPage: number, pageSize: number) {
  const totalPages = Math.ceil(apps.length / pageSize);
  const page = Math.max(1, Math.min(requestedPage, totalPages));
  return { apps: apps.slice((page - 1) * pageSize, page * pageSize), page, totalPages, total: apps.length };
}
