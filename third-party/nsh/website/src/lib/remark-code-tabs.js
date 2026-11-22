// Code tabs: consecutive fenced code blocks whose meta holds the word `tabs`
// become one tabbed block, a tab per block named after its language:
//
//   ```rust tabs
//   view().child(text("Hi"))
//   ```
//
//   ```tsx tabs
//   <View><Text>Hi</Text></View>
//   ```
//
// The first tab is selected; the others' panels are `hidden`. A small script
// (`initCodeTabs` in `code-tabs-client.ts`, run by DocsLayout) switches them, by click and by the
// arrow keys, and every group on the page follows the reader's choice. The
// `.md` endpoints print the blocks plainly (`stripTabsMeta`).

const LABELS = {
  rust: 'Rust',
  tsx: 'TSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  sh: 'Shell',
  bash: 'Shell',
  json: 'JSON',
  toml: 'TOML',
  xml: 'XML',
  html: 'HTML',
  css: 'CSS',
  yaml: 'YAML',
};

const LIST_LABEL = { en: 'Language', 'zh-CN': '语言' };

/** The tab's label for a fence's language: `rust` → "Rust", `tsx` → "TSX", others capitalized. */
export function tabLabel(lang) {
  const key = (lang ?? '').toLowerCase();
  if (!key) return 'Text';
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

const isTabbed = (node) => node?.type === 'code' && /(?:^|\s)tabs(?:\s|$)/.test(node.meta ?? '');

/** A fence's info string without the `tabs` word, for readers of the raw Markdown. */
export function stripTabsMeta(markdown) {
  return markdown.replace(/^([ \t]*(?:`{3,}|~{3,})[^\s`~]+)((?:[ \t]+\S+)*)[ \t]*$/gm, (whole, fence, meta) => {
    if (!/(?:^|\s)tabs(?:\s|$)/.test(meta)) return whole;
    const rest = meta.split(/\s+/).filter((word) => word && word !== 'tabs');
    return rest.length ? `${fence} ${rest.join(' ')}` : fence;
  });
}

export function remarkCodeTabs() {
  return (tree, file) => {
    const path = file?.path ?? file?.history?.[0] ?? '';
    const listLabel = /(?:^|[\\/])zh-CN[\\/]/.test(path) ? LIST_LABEL['zh-CN'] : LIST_LABEL.en;
    let groups = 0;

    const walk = (node) => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        if (!isTabbed(children[i])) {
          walk(children[i]);
          continue;
        }
        let end = i;
        while (isTabbed(children[end + 1])) end++;
        const blocks = children.slice(i, end + 1);
        children.splice(i, blocks.length, group(blocks, ++groups, listLabel));
      }
    };
    walk(tree);
  };
}

function group(blocks, number, listLabel) {
  const id = `code-tabs-${number}`;
  const tabs = [];
  const panels = [];
  blocks.forEach((block, index) => {
    const words = (block.meta ?? '').split(/\s+/).filter((word) => word && word !== 'tabs');
    block.meta = words.length ? words.join(' ') : null;
    const key = (block.lang ?? 'text').toLowerCase();
    const selected = index === 0;
    const tabId = `${id}-tab-${index}`;
    const panelId = `${id}-panel-${index}`;
    tabs.push({
      type: 'codeTab',
      data: {
        hName: 'button',
        hProperties: {
          type: 'button',
          role: 'tab',
          id: tabId,
          className: ['code-tabs__tab'],
          dataSlot: 'tabs-trigger',
          ariaControls: panelId,
          ariaSelected: selected ? 'true' : 'false',
          tabIndex: selected ? 0 : -1,
          dataTab: key,
        },
      },
      children: [{ type: 'text', value: tabLabel(block.lang) }],
    });
    panels.push({
      type: 'codeTabPanel',
      data: {
        hName: 'div',
        hProperties: {
          role: 'tabpanel',
          id: panelId,
          className: ['code-tabs__panel'],
          ariaLabelledBy: tabId,
          dataTab: key,
          tabIndex: 0,
          hidden: !selected,
        },
      },
      children: [block],
    });
  });
  return {
    type: 'codeTabs',
    data: { hName: 'div', hProperties: { className: ['code-tabs'], dataCodeTabs: '' } },
    children: [
      {
        type: 'codeTabHead',
        data: { hName: 'div', hProperties: { className: ['code-tabs__head'] } },
        children: [
          {
            type: 'codeTabList',
            data: { hName: 'div', hProperties: { role: 'tablist', className: ['code-tabs__list'], dataSlot: 'tabs-list', dataSize: 'xs', ariaLabel: listLabel } },
            children: tabs,
          },
        ],
      },
      ...panels,
    ],
  };
}
