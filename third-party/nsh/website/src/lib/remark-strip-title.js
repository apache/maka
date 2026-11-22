// The layout prints the frontmatter `title` as the page's heading, so a page
// that also opens with `# Title` (as Markdown read on GitHub does) would show
// it twice. The leading h1 is dropped; the frontmatter is the source of truth.
export function remarkStripTitle() {
  return (tree) => {
    const first = tree.children.findIndex((node) => node.type !== 'html' && node.type !== 'yaml');
    if (first !== -1 && tree.children[first].type === 'heading' && tree.children[first].depth === 1) {
      tree.children.splice(first, 1);
    }
  };
}
