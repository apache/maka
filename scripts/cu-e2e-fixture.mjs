import { validateCuE2eScenario } from './cu-e2e-scenarios.mjs';

function windowBody(spec) {
  switch (spec.kind) {
    case 'observe':
      return `
        <h1>Observe-only verification</h1>
        <p class="code">${spec.verificationCode}</p>
        <ul><li>Network: ready</li><li>Storage: isolated</li><li>Safety: armed</li></ul>
        <button id="forbidden">Do not interact</button>`;
    case 'single-click':
      return `
        <h1>Single-click verification</h1>
        <div class="row">
          <button id="primary" class="primary">Increment once</button>
          <button id="danger" class="danger">Do not click red</button>
          <output id="count">0</output>
        </div>`;
    case 'multi-control':
      return `
        <h1>Multi-control verification</h1>
        <label>Exact text <input id="text" type="text" autocomplete="off"></label>
        <label>Level <input id="level" type="range" min="0" max="100" value="10">
          <output id="levelValue">10</output>
        </label>
        <div id="scrollbox">
          <div class="scroll-content">
            <p>Scroll inside this panel.</p>
            <button id="confirm" class="primary">Confirm scrolled</button>
          </div>
        </div>
        <div class="row">
          <button id="reset">Reset</button>
          <button id="danger" class="danger">Danger</button>
        </div>`;
    case 'background-semantic':
      return `
        <h1>Background semantic verification</h1>
        <label>Background text
          <input id="backgroundText" type="text" aria-label="Background text" autocomplete="off">
        </label>
        <label class="row">
          <input id="backgroundCheckbox" type="checkbox" aria-label="Background checkbox">
          Background checkbox
        </label>
        <button id="backgroundCommit" class="primary">Commit background</button>
        <output id="backgroundCount">0</output>`;
    case 'click-target':
      return `
        <h1>${spec.title}</h1>
        <div class="row">
          <button id="commit" class="primary">${spec.buttonLabel}</button>
          <output id="count">0</output>
        </div>`;
    case 'occluder':
      return `
        <h1>Occlusion guard</h1>
        <p>This separate owned window intentionally covers the target control.</p>
        <button id="occluderSurface">Do not click through</button>`;
    case 'sentinel':
      return `
        <h1>Concurrent user activity sentinel</h1>
        <p>This fixture is read-only while focus and cursor channels are monitored.</p>`;
    case 'provider-matrix':
      return `
        <h1>Provider matrix aggregation</h1>
        <p>No UI actions are permitted during report aggregation.</p>`;
    default:
      throw new Error(`unsupported fixture kind "${spec.kind}"`);
  }
}

function windowScript(spec) {
  const initialState =
    spec.kind === 'observe'
      ? `{ verificationCode: ${JSON.stringify(spec.verificationCode)}, interactions: 0 }`
      : spec.kind === 'single-click'
        ? '{ primaryClicks: 0, primaryOverClicks: 0, dangerClicks: 0 }'
        : spec.kind === 'multi-control'
          ? `{ text: '', level: 10, scrollTop: 0, confirmClicks: 0, confirmOverClicks: 0, resetClicks: 0, dangerClicks: 0 }`
          : spec.kind === 'background-semantic'
            ? '{ buttonClicks: 0, buttonOverClicks: 0 }'
          : spec.kind === 'click-target'
            ? '{ clicks: 0, overClicks: 0 }'
            : spec.kind === 'sentinel'
              ? '{ agentViolations: 0 }'
              : spec.kind === 'provider-matrix'
                ? '{ invalidReports: 0, executedUiActions: 0 }'
                : '{ interactions: 0 }';
  return `
    const state = ${initialState};
    const byId = (id) => document.getElementById(id);
    if (${JSON.stringify(spec.kind)} === 'observe') {
      byId('forbidden').addEventListener('click', () => { state.interactions += 1; });
    }
    if (${JSON.stringify(spec.kind)} === 'single-click') {
      byId('primary').addEventListener('click', () => {
        state.primaryClicks += 1;
        state.primaryOverClicks = Math.max(0, state.primaryClicks - 1);
        byId('count').value = String(state.primaryClicks);
      });
      byId('danger').addEventListener('click', () => { state.dangerClicks += 1; });
    }
    if (${JSON.stringify(spec.kind)} === 'multi-control') {
      byId('text').addEventListener('input', (event) => { state.text = event.target.value; });
      byId('level').addEventListener('input', (event) => {
        state.level = Number(event.target.value);
        byId('levelValue').value = event.target.value;
      });
      byId('scrollbox').addEventListener('scroll', (event) => {
        state.scrollTop = Math.round(event.target.scrollTop);
      });
      byId('confirm').addEventListener('click', () => {
        state.confirmClicks += 1;
        state.confirmOverClicks = Math.max(0, state.confirmClicks - 1);
      });
      byId('reset').addEventListener('click', () => {
        state.resetClicks += 1;
        byId('text').value = '';
        byId('level').value = '10';
        byId('levelValue').value = '10';
        byId('scrollbox').scrollTop = 0;
        Object.assign(state, { text: '', level: 10, scrollTop: 0 });
      });
      byId('danger').addEventListener('click', () => { state.dangerClicks += 1; });
    }
    if (${JSON.stringify(spec.kind)} === 'background-semantic') {
      byId('backgroundCommit').addEventListener('click', () => {
        state.buttonClicks += 1;
        state.buttonOverClicks = Math.max(0, state.buttonClicks - 1);
        byId('backgroundCount').value = String(state.buttonClicks);
      });
    }
    if (${JSON.stringify(spec.kind)} === 'click-target') {
      byId('commit').addEventListener('click', () => {
        state.clicks += 1;
        state.overClicks = Math.max(0, state.clicks - 1);
        byId('count').value = String(state.clicks);
      });
    }
    if (${JSON.stringify(spec.kind)} === 'occluder') {
      byId('occluderSurface').addEventListener('click', () => { state.interactions += 1; });
    }
    globalThis.__makaCuFixtureState = () => {
      const snapshot = structuredClone(state);
      if (${JSON.stringify(spec.kind)} === 'background-semantic') {
        snapshot.text = byId('backgroundText').value;
        snapshot.checked = byId('backgroundCheckbox').checked;
      }
      return snapshot;
    };
  `;
}

function fixtureHtml(spec) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${spec.title}</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; background: #f4f6f8; }
      body { box-sizing: border-box; padding: 24px; color: #172033; font: 16px/1.45 -apple-system, sans-serif; }
      main { display: grid; align-content: start; gap: 18px; height: 100%; }
      h1 { margin: 0; font-size: 22px; }
      label { display: grid; gap: 8px; font-weight: 600; }
      input[type="text"] { height: 42px; padding: 0 12px; font: 16px ui-monospace, monospace; }
      input[type="range"] { width: 100%; }
      button { min-width: 150px; height: 48px; border: 2px solid #697386; background: white; font: 600 15px -apple-system, sans-serif; }
      .primary { border-color: #2463eb; color: #1746ae; }
      .danger { border-color: #c43d3d; color: #9b2525; }
      .row { display: flex; align-items: center; gap: 16px; }
      .code, output { font: 700 24px ui-monospace, monospace; }
      #scrollbox { height: 170px; overflow: auto; border: 1px solid #8d98a8; background: white; }
      .scroll-content { box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; min-height: 720px; padding: 16px; }
    </style>
  </head>
  <body>
    <main>${windowBody(spec)}</main>
    <script>${windowScript(spec)}</script>
  </body>
</html>`;
}

function layoutBounds(setup, workArea) {
  const margin = 36;
  const width = Math.min(720, Math.max(520, workArea.width - margin * 2));
  const height = Math.min(560, Math.max(420, workArea.height - margin * 2));
  const base = {
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + margin,
    width,
    height,
  };
  if (setup.layout === 'split') {
    const gap = 18;
    const splitWidth = Math.max(
      360,
      Math.floor((Math.min(workArea.width - margin * 2, 980) - gap) / 2),
    );
    return setup.windows.map((_, index) => ({
      x: workArea.x + workArea.width - margin - splitWidth * (2 - index) - gap * (1 - index),
      y: base.y,
      width: splitWidth,
      height,
    }));
  }
  if (setup.layout === 'overlap') {
    return setup.windows.map((_, index) =>
      index === 0
        ? base
        : {
            x: base.x + 80,
            y: base.y + 105,
            width: Math.min(420, base.width - 120),
            height: 190,
          },
    );
  }
  return setup.windows.map(() => base);
}

async function readWindowState(window) {
  if (!window || window.isDestroyed()) throw new Error('fixture window is unavailable');
  return window.webContents.executeJavaScript('globalThis.__makaCuFixtureState?.() ?? null', true);
}

async function readElementRect(window, selector) {
  if (!window || window.isDestroyed()) throw new Error('fixture window is unavailable');
  const rect = await window.webContents.executeJavaScript(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`,
    true,
  );
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`fixture element has no visible rect: ${selector}`);
  }
  const content = window.getContentBounds();
  return {
    x: content.x + rect.x,
    y: content.y + rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export async function createCuE2eFixture({ BrowserWindow, screen, scenario }) {
  validateCuE2eScenario(scenario);
  if (typeof BrowserWindow !== 'function') throw new Error('BrowserWindow is required');
  if (!screen?.getPrimaryDisplay) throw new Error('Electron screen is required');

  const windows = new Map();
  const specs = new Map();
  const staleWindowIds = [];
  const workArea = screen.getPrimaryDisplay().workArea;

  const createWindow = async (spec, bounds) => {
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      focusable: true,
      backgroundColor: '#f4f6f8',
      title: spec.title,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setMenuBarVisibility(false);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml(spec))}`);
    windows.set(spec.id, window);
    specs.set(spec.id, spec);
    if (spec.reveal !== false) window.showInactive();
    return window;
  };

  const bounds = layoutBounds(scenario.fixtureSetup, workArea);
  try {
    for (const [index, spec] of scenario.fixtureSetup.windows.entries()) {
      await createWindow(spec, bounds[index]);
    }

    for (const transition of scenario.fixtureSetup.transitions ?? []) {
      const stale = windows.get(transition.removeWindowId);
      const staleBounds = stale?.getBounds() ?? bounds[0];
      if (stale && !stale.isDestroyed()) {
        staleWindowIds.push(stale.id);
        stale.destroy();
      }
      windows.delete(transition.removeWindowId);
      specs.delete(transition.removeWindowId);
      await createWindow(transition.addWindow, staleBounds);
    }

    for (const windowId of scenario.fixtureSetup.zOrder ?? [...windows.keys()]) {
      const window = windows.get(windowId);
      if (window && !window.isDestroyed()) {
        window.showInactive();
        window.moveTop();
      }
    }
  } catch (error) {
    for (const window of windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    throw error;
  }

  return {
    scenario,
    staleWindowIds: Object.freeze(staleWindowIds),
    windowIds() {
      return [...windows.keys()];
    },
    getWindow(windowId) {
      const window = windows.get(windowId);
      if (!window || window.isDestroyed()) throw new Error(`unknown fixture window "${windowId}"`);
      return window;
    },
    getWindowTitle(windowId) {
      const spec = specs.get(windowId);
      if (!spec) throw new Error(`unknown fixture window "${windowId}"`);
      return spec.title;
    },
    async readState(windowId) {
      return readWindowState(this.getWindow(windowId));
    },
    async readAllStates() {
      return Object.fromEntries(
        await Promise.all(
          [...windows].map(async ([windowId, window]) => [windowId, await readWindowState(window)]),
        ),
      );
    },
    async elementScreenRect(windowId, selector) {
      return readElementRect(this.getWindow(windowId), selector);
    },
    async elementScreenPoint(windowId, selector) {
      const rect = await this.elementScreenRect(windowId, selector);
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    },
    destroy() {
      for (const window of windows.values()) {
        if (!window.isDestroyed()) window.destroy();
      }
      windows.clear();
      specs.clear();
    },
  };
}
