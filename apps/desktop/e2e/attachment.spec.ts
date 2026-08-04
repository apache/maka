import { test, expect, COMPOSER_INPUT } from './fixtures';

test('chat input preserves an IME composition when a file paste arrives', async ({ window: page }) => {
  const firstSend = page.locator(COMPOSER_INPUT);
  await firstSend.fill('ime-paste-test');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: ime-paste-test/)).toBeVisible();

  const composer = page.locator('.maka-composer');
  await expect(composer).toHaveAttribute('data-maka-file-drop-target', 'true');
  const editable = composer.locator('[contenteditable="true"]');

  const pasteResults = await editable.evaluate((input) => {
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
 * composer, confirm it shows as a pending token, then send the message and
 * verify the fake backend received the attachments by name. Uses Playwright's
 * DataTransfer + dispatchEvent because the composer has no <input type=file>.
 */
test('a mixed attachment send has the Astryx message hierarchy', async ({ window: page }) => {
  // Enter chat view by sending a first message from the composer, which
  // creates the session on send.
  const firstSend = page.locator(COMPOSER_INPUT);
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
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
      (character) => character.charCodeAt(0),
    );
    dt.items.add(new File([png], 'pixel.png', { type: 'image/png' }));
  });
  await composer.dispatchEvent('drop', { dataTransfer });

  // Both attachment kinds appear in the composer before send.
  await expect(page.getByText('note.txt')).toBeVisible();
  await expect(page.getByText('pixel.png')).toBeVisible();

  // Send the message carrying the attachment — the fake backend echoes the
  // attachment name, proving the ingest-on-send path delivered it (not just
  // that the UI rendered a card).
  const composerInput = page.locator(COMPOSER_INPUT);
  await composerInput.fill('sending mixed attachments');
  await composerInput.press('Enter');
  await expect(page.getByText(/Attachments received: note\.txt, pixel\.png/)).toBeVisible();

  const sentMessage = page.getByLabel('你发送的消息').last();
  const fileToken = sentMessage.locator('.maka-user-attachment-tokens .astryx-token');
  const fileIcon = fileToken.locator('.astryx-icon');
  const image = sentMessage.locator('.maka-user-attachments .astryx-thumbnail');
  const bubble = sentMessage.locator('.maka-chat-message-bubble-user');
  await expect(fileToken).toContainText('note.txt');
  await expect(fileIcon).toHaveCSS('width', '16px');
  await expect(fileIcon).toHaveCSS('height', '16px');
  await expect(image).toBeVisible();
  await expect(image).toHaveCSS('width', '64px');
  await expect(bubble).toContainText('sending mixed attachments');

  const [fileBox, imageBox, bubbleBox] = await Promise.all([
    fileToken.boundingBox(),
    image.boundingBox(),
    bubble.boundingBox(),
  ]);
  expect(fileBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(bubbleBox).not.toBeNull();
  // The token declares display:inline-flex + align-items:center; as a flex
  // item of the attachment row it computes display:flex (blockification) on
  // every platform. Assert the centering contract, not geometry: token height
  // resolves from line-height, which varies with font metrics (Linux CI can
  // drop below the 16px icon, overflowing a correctly centered icon by 2px).
  // A tolerance-based centerline check was rejected — a baseline regression
  // drifts exactly 2.00px, the tolerance boundary. display:flex is load-
  // bearing: align-items computes as declared even on non-flex boxes.
  await expect(fileToken).toHaveCSS('display', 'flex');
  await expect(fileToken).toHaveCSS('align-items', 'center');
  expect(fileBox!.y + fileBox!.height).toBeLessThanOrEqual(bubbleBox!.y);
  expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(bubbleBox!.y);

  await image.getByRole('button').click();
  await expect(page.locator('.astryx-lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.astryx-lightbox')).not.toBeVisible();
});
