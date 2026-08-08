import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import {
  deriveTitlebarProjectName,
  TitlebarSessionIdentity,
} from '../titlebar-session-identity.js';

/**
 * The titlebar is the only place an open session states what it is. The name
 * lives otherwise only in the sidebar list (gone when that column collapses),
 * and the project only in the composer's WorkspacePicker (gone the moment a
 * session exists). So these assertions are about presence, not decoration.
 */
function render(props: {
  sessionName: string;
  projectName?: string;
  parentName?: string;
}): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TitlebarSessionIdentity
        sessionName={props.sessionName}
        onRenameSession={() => undefined}
        project={
          props.projectName
            ? { name: props.projectName, onOpenFolder: () => undefined }
            : undefined
        }
        parentSession={
          props.parentName
            ? { name: props.parentName, onOpen: () => undefined }
            : undefined
        }
      />
    </LocaleProvider>,
  );
}

describe('TitlebarSessionIdentity', () => {
  it('states the project and the session name as one trail', () => {
    const html = render({ sessionName: 'Rerun head-to-head', projectName: 'maka-agent' });
    assert.match(html, /maka-agent/);
    assert.match(html, /Rerun head-to-head/);
    assert.ok(
      html.indexOf('maka-agent') < html.indexOf('Rerun head-to-head'),
      'project must precede the session it contains',
    );
  });

  it('degrades to the session name alone when no directory is known', () => {
    const html = render({ sessionName: 'Scratch session' });
    assert.match(html, /Scratch session/);
    // One crumb, so no separator: an empty leading crumb would read as a
    // project whose name failed to load.
    assert.equal(html.match(/<li/g)?.length, 1);
  });

  it('makes both segments real controls, not decorated text', () => {
    // Regression: BreadcrumbItem renders an `isCurrent` item as a plain
    // <span aria-current="page"> and DISCARDS onClick, so the rename
    // affordance would be dead and unreachable by keyboard. What this pins is
    // the explicit-true form; omitting the prop keeps the button and only
    // adds `aria-current` from a post-mount effect, which static markup
    // cannot see either way.
    const html = render({ sessionName: 'Rerun head-to-head', projectName: 'maka-agent' });
    assert.equal(
      html.match(/<button[^>]*type="button"/g)?.length,
      2,
      'project and session segments must both be buttons',
    );
    assert.doesNotMatch(html, /aria-current/);
  });

  it('inserts the parent session between project and child when a linked child is open', () => {
    const html = render({
      sessionName: 'explore · layout',
      projectName: 'maka-agent',
      parentName: 'Implement session ledger',
    });
    assert.match(html, /maka-agent/);
    assert.match(html, /Implement session ledger/);
    assert.match(html, /explore · layout/);
    assert.ok(
      html.indexOf('maka-agent') < html.indexOf('Implement session ledger') &&
        html.indexOf('Implement session ledger') < html.indexOf('explore · layout'),
      'trail order is project › parent › child',
    );
    assert.equal(
      html.match(/<button[^>]*type="button"/g)?.length,
      3,
      'project, parent, and session segments must all be buttons',
    );
  });

  it('truncates each segment on its own rather than wrapping the strip', () => {
    const html = render({ sessionName: 'A'.repeat(200), projectName: 'B'.repeat(200) });
    // Word-boundary match: the session segment also carries the `--session`
    // modifier, and a bare substring count reads that one twice.
    assert.equal(
      html.match(/maka-titlebar-identity__segment(?![\w-])/g)?.length,
      2,
      'both segments carry the ellipsis class',
    );
  });

  it('gives the session segment the weight, and the project only the base class', () => {
    // The pair's hierarchy is carried by the modifier: `supporting` breadcrumb
    // type rendered both segments identically, leaving the `›` to do all the
    // work of saying which one is the subject.
    const html = render({ sessionName: 'Rerun head-to-head', projectName: 'maka-agent' });
    assert.equal(html.match(/maka-titlebar-identity__segment--session/g)?.length, 1);
    assert.ok(
      html.indexOf('maka-titlebar-identity__segment--session') > html.indexOf('maka-agent'),
      'the emphasis belongs to the trailing session crumb, not the project',
    );
  });
});

describe('deriveTitlebarProjectName', () => {
  it('prefers the registered project name over the path', () => {
    assert.equal(
      deriveTitlebarProjectName({ projectName: 'Maka', projectPath: '/src/maka-agent' }),
      'Maka',
    );
  });

  it('names the folder for a session started outside the project catalog', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: '/src/maka-agent' }), 'maka-agent');
  });

  it('ignores a trailing separator instead of naming nothing', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: '/src/maka-agent/' }), 'maka-agent');
  });

  it('reads a Windows path, which is what a Windows host sends', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: 'C:\\src\\maka-agent' }), 'maka-agent');
  });

  it('is undefined at a filesystem root, and with no path at all', () => {
    assert.equal(deriveTitlebarProjectName({ projectPath: '/' }), undefined);
    assert.equal(deriveTitlebarProjectName({}), undefined);
  });
});
