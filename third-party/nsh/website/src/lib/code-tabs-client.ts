// Switches the tabbed code blocks of `remark-code-tabs.js`. Choosing a tab
// switches every group on the page that has one for the same language, and
// the choice is remembered (localStorage, when the browser allows it).

const KEY = 'codeTab';

function tabsOf(group: HTMLElement): HTMLButtonElement[] {
  return [...group.querySelectorAll<HTMLButtonElement>(':scope > .code-tabs__head > [role="tablist"] > [role="tab"]')];
}

function select(group: HTMLElement, key: string): boolean {
  const tabs = tabsOf(group);
  const target = tabs.find((tab) => tab.dataset.tab === key);
  if (!target) return false;
  for (const tab of tabs) {
    const on = tab === target;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    if (panel) panel.hidden = !on;
  }
  return true;
}

function selectEverywhere(key: string, origin?: HTMLElement) {
  // The group the reader clicked stays where it is while the others above it change height.
  const top = origin?.getBoundingClientRect().top;
  for (const group of document.querySelectorAll<HTMLElement>('[data-code-tabs]')) select(group, key);
  if (origin && top !== undefined) {
    const moved = origin.getBoundingClientRect().top - top;
    if (moved) window.scrollBy(0, moved);
  }
}

export function initCodeTabs() {
  const groups = document.querySelectorAll<HTMLElement>('[data-code-tabs]');
  if (groups.length === 0) return;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {}
  if (saved) selectEverywhere(saved);

  for (const group of groups) {
    const tabs = tabsOf(group);
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => {
        const key = tab.dataset.tab ?? '';
        selectEverywhere(key, group);
        try {
          localStorage.setItem(KEY, key);
        } catch {}
      });
      tab.addEventListener('keydown', (event) => {
        let next = -1;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next === -1) return;
        event.preventDefault();
        tabs[next].click();
        tabs[next].focus();
      });
    }
  }
}
