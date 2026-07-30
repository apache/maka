import { test, expect } from './fixtures';

test('chat input preserves an IME composition when a file paste arrives', async ({ window: page }) => {
  const firstSend = page.locator('.maka-composer-textarea');
  await firstSend.fill('ime-paste-test');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: ime-paste-test/)).toBeVisible();

  const composer = page.locator('.maka-composer');
  await expect(composer).toHaveAttribute('data-maka-file-drop-target', 'true');
  const textarea = composer.locator('textarea');

  const pasteResults = await textarea.evaluate((input) => {
    const dispatchFilePaste = () => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(['content'], 'note.txt', { type: 'text/plain' }));
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: clipboardData });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    };

    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const duringComposition = dispatchFilePaste();
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const afterComposition = dispatchFilePaste();

    return { duringComposition, afterComposition };
  });

  expect(pasteResults).toEqual({ duringComposition: false, afterComposition: true });
});

/**
 * Attachment upload + ingest: enter the chat view, drop a file onto the main
 * composer, confirm it shows as a pending card, then send the message and
 * verify the fake backend received the attachment by name. Uses Playwright's
 * DataTransfer + dispatchEvent because the composer has no <input type=file>.
 */
test('dropping a file onto the composer delivers it to the backend on send', async ({ window: page }) => {
  // Enter chat view by sending a first message from the composer, which
  // creates the session on send.
  const firstSend = page.locator('.maka-composer-textarea');
  await firstSend.fill('attach-test');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: attach-test/)).toBeVisible();

  // Drop a file onto the main composer
  const composer = page.locator('.maka-composer');
  await expect(composer).toBeVisible();
  // Assistant text becomes visible before the turn's terminal event can clear
  // the streaming state. The composer intentionally rejects attachments until
  // that happens, so synchronize on its actual file-drop readiness contract.
  await expect(composer).toHaveAttribute('data-maka-file-drop-target', 'true');
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await dataTransfer.evaluate((dt: DataTransfer) => {
    dt.items.add(new File(['hello attachment content'], 'note.txt', { type: 'text/plain' }));
  });
  await composer.dispatchEvent('drop', { dataTransfer });

  // The dropped file appears as a pending attachment card
  await expect(page.getByText('note.txt')).toBeVisible();

  // Send the message carrying the attachment — the fake backend echoes the
  // attachment name, proving the ingest-on-send path delivered it (not just
  // that the UI rendered a card).
  const textarea = page.locator('.maka-composer textarea');
  await textarea.fill('sending with a file');
  await textarea.press('Enter');
  await expect(page.getByText(/Attachments received: note\.txt/)).toBeVisible();
});
