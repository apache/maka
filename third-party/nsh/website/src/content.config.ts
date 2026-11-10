import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { machineLocales } from './lib/locales';

// One schema for every section and both locales; `tests/content.test.ts` checks
// that the Chinese pages mirror the English ones.
const schema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  /** Sidebar position, ascending; pages without one follow, by title. */
  order: z.number().optional(),
  /** The sidebar group the page is listed under: a key of `GROUPS` (`src/lib/sections.ts`). */
  group: z.string().optional(),
  /** The name of a demo app in `website/demos/<name>.tsx`, shown on the page. */
  demo: z.string().optional(),
});

function section(base: string) {
  return defineCollection({
    // The id is the file name as written, not a slug of it, so routes, links
    // between pages and the Chinese counterpart all agree on one name.
    loader: glob({ pattern: '*.md', base, generateId: ({ entry }) => entry.replace(/\.md$/, '') }),
    schema,
  });
}

export const collections = {
  docs: section('./docs'),
  elements: section('./elements'),
  modules: section('./modules'),
  'zh-docs': section('./zh-CN/docs'),
  'zh-elements': section('./zh-CN/elements'),
  'zh-modules': section('./zh-CN/modules'),
  // Machine translations, when the build has them (`src/lib/locales.ts`).
  ...Object.fromEntries(
    machineLocales.flatMap(({ code }) => ['docs', 'elements', 'modules'].map((s) => [`${code}-${s}`, section(`./translations/${code}/${s}`)])),
  ),
};
