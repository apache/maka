// GitHub alerts — `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`,
// `> [!CAUTION]` — rendered as `<aside class="callout callout--note">` with a
// title, so the same Markdown reads well on GitHub and on the site.

const LABELS = {
  en: { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' },
  'zh-CN': { note: '备注', tip: '提示', important: '重要', warning: '警告', caution: '注意' },
};

const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

export function remarkCallouts() {
  return (tree, file) => {
    const path = file?.path ?? file?.history?.[0] ?? '';
    const labels = /[\\/]zh-CN[\\/]/.test(path) ? LABELS['zh-CN'] : LABELS.en;

    const walk = (node) => {
      for (const child of node.children ?? []) walk(child);
      if (node.type !== 'blockquote') return;

      const first = node.children?.[0];
      const text = first?.type === 'paragraph' ? first.children?.[0] : undefined;
      if (text?.type !== 'text') return;
      const match = MARKER.exec(text.value);
      if (!match) return;

      const kind = match[1].toLowerCase();
      text.value = text.value.slice(match[0].length);
      if (text.value === '') first.children.shift();
      // `[!NOTE]` followed by a hard break leaves a leading break node.
      if (first.children[0]?.type === 'break') first.children.shift();
      if (first.children.length === 0) node.children.shift();

      node.data = {
        ...node.data,
        hName: 'aside',
        hProperties: { className: ['callout', `callout--${kind}`] },
      };
      node.children.unshift({
        type: 'paragraph',
        data: { hProperties: { className: ['callout__title'] } },
        children: [{ type: 'text', value: labels[kind] }],
      });
    };
    walk(tree);
  };
}
