import { readFile } from 'node:fs/promises';
import { app, BrowserWindow } from 'electron';

async function main() {
  const stylesheet = await readFile(
    new URL('../src/renderer/styles/agent-graph.css', import.meta.url),
    'utf8',
  );
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
    <html>
      <head>
        <style>
          :root { --duration-quick: 0s; --ease-out-strong: linear; }
          ${stylesheet}
        </style>
      </head>
      <body>
        <button class="maka-agent-graph-collapse-toggle" aria-expanded="true">
          <svg aria-hidden="true" viewBox="0 0 16 16"></svg>
        </button>
      </body>
    </html>`)}`,
  );

  const transformFor = (expanded) =>
    window.webContents.executeJavaScript(
      `(async () => {
        const toggle = document.querySelector('.maka-agent-graph-collapse-toggle');
        toggle.setAttribute('aria-expanded', ${JSON.stringify(String(expanded))});
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return getComputedStyle(toggle.querySelector('svg')).transform;
      })()`,
      true,
    );

  try {
    const expanded = await transformFor(true);
    const collapsed = await transformFor(false);
    const expandedAgain = await transformFor(true);
    if (
      expanded !== 'none' ||
      collapsed !== 'matrix(-1, 0, 0, -1, 0, 0)' ||
      expandedAgain !== 'none'
    ) {
      throw new Error(
        `Unexpected Agent Graph chevron transforms: ${JSON.stringify({
          expanded,
          collapsed,
          expandedAgain,
        })}`,
      );
    }
    console.log('Agent graph chevron browser smoke passed');
  } finally {
    window.destroy();
  }
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
