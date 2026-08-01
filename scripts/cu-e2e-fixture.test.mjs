import assert from 'node:assert/strict';
import test from 'node:test';
import { createCuE2eFixture } from './cu-e2e-fixture.mjs';
import { getCuE2eScenario } from './cu-e2e-scenarios.mjs';

class FakeWindow {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.id = FakeWindow.instances.length + 1;
    this.destroyed = false;
    this.webContents = {
      executeJavaScript: async () => ({}),
    };
    FakeWindow.instances.push(this);
  }
  setMenuBarVisibility() {}
  async loadURL() {
    if (this.options.title === 'fail') throw new Error('load failed');
  }
  showInactive() {}
  moveTop() {}
  getBounds() {
    return { x: 0, y: 0, width: 640, height: 480 };
  }
  getContentBounds() {
    return this.getBounds();
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}

const fakeScreen = {
  getPrimaryDisplay: () => ({
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
  }),
};

test('partial fixture construction destroys already-created windows', async () => {
  FakeWindow.instances = [];
  const scenario = structuredClone(getCuE2eScenario('l3-two-window'));
  scenario.fixtureSetup.windows[1].title = 'fail';
  await assert.rejects(
    createCuE2eFixture({
      BrowserWindow: FakeWindow,
      screen: fakeScreen,
      scenario,
    }),
    /load failed/,
  );
  assert.equal(FakeWindow.instances[0]?.destroyed, true);
});
