// The HTML website consumes the same data as NSH's example components.
// This module has no NSH runtime dependency: Vite uses it while building CSS.

const prefix = '--nsh-gallery-';
const references = (value) => value.replace(/var\(\s*--([\w-]+)/g, `var(${prefix}$1`);
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** CSS variables for the canonical palette and surface finishes. */
export function galleryUiCss(theme, finishes) {
  const surfaces = Object.keys(finishes.dark);
  const properties = Object.fromEntries(surfaces.map((surface) => [
    surface,
    [...new Set([...Object.keys(finishes.dark[surface]), ...Object.keys(finishes.light[surface])])],
  ]));
  return [[':root', 'dark'], ['html.light', 'light']].map(([selector, mode]) => {
    const vars = { ...theme.cssVars.theme, ...theme.cssVars[mode] };
    const declarations = Object.entries(vars).map(([name, value]) => `${prefix}${name}: ${references(value)};`);
    for (const surface of surfaces) {
      for (const property of properties[surface]) {
        const value = finishes[mode][surface][property];
        declarations.push(`${prefix}finish-${surface}-${kebab(property)}: ${value ? references(value) : 'initial'};`);
      }
    }
    return `${selector} {\n  ${declarations.join('\n  ')}\n}`;
  }).join('\n');
}
