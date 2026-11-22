// Drives `components/ui/Select.astro` (WAI-ARIA select-only combobox, as
// shadcn/ui's Select through Radix): the trigger opens the listbox and
// focus moves into it; arrows, Home / End, Page Up / Down and typing a
// label's first letters move the highlight (`data-highlighted`, named by
// `aria-activedescendant`); Enter or Space picks, Escape and Tab close.
// The root keeps the value in `data-value` and fires `change` when the
// reader picks another.

export interface SelectApi {
  readonly value: string;
  /** Selects `value` without firing `change` (a page restoring its state). */
  set(value: string): void;
}

const mounted = new WeakMap<HTMLElement, SelectApi>();

export function mountSelect(root: HTMLElement): SelectApi {
  const existing = mounted.get(root);
  if (existing) return existing;
  const trigger = root.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!;
  const content = root.querySelector<HTMLElement>('[data-slot="select-content"]')!;
  const current = root.querySelector<HTMLElement>('[data-slot="select-value"]')!;
  const items = [...content.querySelectorAll<HTMLElement>('[data-slot="select-item"]')];
  const labelOf = (item: HTMLElement) => item.querySelector('[data-slot="select-item-text"]')?.textContent ?? '';
  let highlighted = 0;
  let typed = '';
  let typedAt = 0;

  const selectedIndex = () => Math.max(0, items.findIndex((item) => item.dataset.value === root.dataset.value));
  const highlight = (i: number) => {
    highlighted = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((item, k) => item.toggleAttribute('data-highlighted', k === highlighted));
    content.setAttribute('aria-activedescendant', items[highlighted].id);
    items[highlighted].scrollIntoView({ block: 'nearest' });
  };
  const isOpen = () => !content.hidden;
  const open = () => {
    content.hidden = false;
    // Below the trigger, or above it when the viewport has no room below.
    delete content.dataset.side;
    const box = trigger.getBoundingClientRect();
    const height = content.offsetHeight;
    if (box.bottom + height + 8 > window.innerHeight && box.top - height - 8 > 0) content.dataset.side = 'top';
    trigger.setAttribute('aria-expanded', 'true');
    highlight(selectedIndex());
    content.focus({ preventScroll: true });
  };
  const close = (refocus = true) => {
    if (!isOpen()) return;
    content.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
  };
  const set = (value: string) => {
    const item = items.find((candidate) => candidate.dataset.value === value);
    if (!item) return;
    root.dataset.value = value;
    for (const candidate of items) candidate.setAttribute('aria-selected', String(candidate === item));
    current.textContent = labelOf(item);
  };
  const choose = (i: number) => {
    const value = items[i].dataset.value!;
    close();
    if (value === root.dataset.value) return;
    set(value);
    root.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));
  };
  const typeahead = (key: string) => {
    const now = performance.now();
    typed = now - typedAt > 600 ? key : typed + key;
    typedAt = now;
    const needle = typed.toLowerCase();
    const start = typed.length === 1 ? highlighted + 1 : highlighted;
    for (let k = 0; k < items.length; k++) {
      const i = (start + k) % items.length;
      if (labelOf(items[i]).toLowerCase().startsWith(needle)) return highlight(i);
    }
  };

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  content.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': highlight(highlighted + 1); break;
      case 'ArrowUp': highlight(highlighted - 1); break;
      case 'Home': highlight(0); break;
      case 'End': highlight(items.length - 1); break;
      case 'PageDown': highlight(highlighted + 8); break;
      case 'PageUp': highlight(highlighted - 8); break;
      case 'Enter':
      case ' ': choose(highlighted); break;
      case 'Escape': close(); break;
      case 'Tab': close(); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeahead(e.key);
        else return;
    }
    e.preventDefault();
  });
  content.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-slot="select-item"]');
    if (item) choose(items.indexOf(item));
  });
  content.addEventListener('pointermove', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-slot="select-item"]');
    if (item && items.indexOf(item) !== highlighted) highlight(items.indexOf(item));
  });
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !root.contains(e.target as Node)) close(false);
  });
  content.addEventListener('focusout', (e) => {
    if (isOpen() && !root.contains(e.relatedTarget as Node | null)) close(false);
  });

  const api: SelectApi = {
    get value() {
      return root.dataset.value ?? '';
    },
    set,
  };
  mounted.set(root, api);
  return api;
}

/** Mounts every Select under `scope`. */
export function initSelects(scope: ParentNode = document) {
  for (const root of scope.querySelectorAll<HTMLElement>('[data-slot="select"]')) mountSelect(root);
}
