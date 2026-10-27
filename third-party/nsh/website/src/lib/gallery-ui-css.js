import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { galleryUiCss } from '../../../examples/nsh-gallery-ui/css.js';

const shared = new URL('../../../examples/nsh-gallery-ui/', import.meta.url);
const files = ['theme.json', 'finishes.json'].map((name) => fileURLToPath(new URL(name, shared)));
const specifier = 'virtual:nsh-gallery-ui.css';
const resolved = '\0nsh-gallery-ui.css';

/** Build the website's CSS from the example component layer's data. */
export function galleryUiStyles() {
  return {
    name: 'nsh-gallery-ui-styles',
    resolveId(id) { if (id === specifier) return resolved; },
    load(id) {
      if (id !== resolved) return;
      for (const file of files) this.addWatchFile(file);
      const [theme, finishes] = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
      return galleryUiCss(theme, finishes);
    },
    handleHotUpdate(context) {
      if (!files.includes(context.file)) return;
      const module = context.server.moduleGraph.getModuleById(resolved);
      if (module) {
        context.server.moduleGraph.invalidateModule(module);
        return [module];
      }
    },
  };
}
