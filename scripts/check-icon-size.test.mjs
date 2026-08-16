import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRawIconSizes } from './check-icon-size.mjs';

const repoRoot = '/repo';

function expressions(source, file = `${repoRoot}/apps/desktop/src/example.tsx`) {
  return findRawIconSizes(source, file, { repoRoot }).map((hit) => hit.expression);
}

test('rejects numeric sizes on named, aliased, derived, and namespace icon imports', () => {
  assert.deepEqual(
    expressions(`
      import { ICON_SIZE, Search, Trash2 as DeleteIcon } from '@maka/ui/icons';
      import * as Icons from '@maka/ui/icons';
      const SelectedIcon = true ? Search : DeleteIcon;
      export const Example = () => <>
        <Search size={16} />
        <DeleteIcon size={15.5} />
        <SelectedIcon size={14 as const} />
        <Icons.Sparkles size={+28} />
      </>;
    `),
    ['size={16}', 'size={15.5}', 'size={14 as const}', 'size={+28}'],
  );
});

test('accepts ICON_SIZE and ignores unrelated size props, comments, and non-numeric strings', () => {
  assert.deepEqual(
    expressions(`
      import { ICON_SIZE, Search } from '@maka/ui/icons';
      /* <Search size={16} /> */
      const sample = '<Search size={15} />';
      export const Example = () => <>
        <Search size={ICON_SIZE.chrome} />
        <Search size="lg" />
        <Avatar size={16} />
      </>;
    `),
    [],
  );
});

test('rejects numeric string sizes on icon tags', () => {
  assert.deepEqual(
    expressions(`
      import { Search } from '@maka/ui/icons';
      export const Example = () => <Search size="16" />;
    `),
    ['size="16"'],
  );
});

test('does not treat shadowed or unrelated local tags as icons', () => {
  assert.deepEqual(
    expressions(`
      import { Search } from '@maka/ui/icons';
      function Shadow(Search) {
        return <Search size={16} />;
      }
      export const Example = () => {
        const Comp = Avatar;
        return <Comp size={20} />;
      };
    `),
    [],
  );
});

test('resolves the relative icon seam', () => {
  assert.deepEqual(
    expressions(
      `
        import { Search } from './icons.js';
        import * as Icons from './icons.js';
        export const Example = () => <><Search size={13} /><Icons.Info size={20} /></>;
      `,
      `${repoRoot}/packages/ui/src/example.tsx`,
    ),
    ['size={13}', 'size={20}'],
  );
});
