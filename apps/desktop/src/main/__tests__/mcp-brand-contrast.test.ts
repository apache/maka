import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DARK_PLATE_MIN_LUMINANCE,
  hexRelativeLuminance,
  shouldUseCurrentColorOnDark,
} from '../../renderer/mcp-brand-contrast.js';

test('the dark-plate threshold flips exactly the near-black MCP brand marks', () => {
  // Marks that must flip to currentColor on the dark plate.
  for (const hex of ['#000000' /* Vercel/Notion */, '#4A154B' /* Slack aubergine */]) {
    assert.equal(shouldUseCurrentColorOnDark(hex), true, `${hex} should fall back to currentColor`);
    assert.ok(hexRelativeLuminance(hex) < DARK_PLATE_MIN_LUMINANCE);
  }
  // Marks bright enough to keep their brand hex on the dark plate.
  for (const hex of ['#00C300' /* LINE */, '#4285F4' /* Google */, '#F24E1E' /* Figma */, '#3FCF8E' /* Supabase */]) {
    assert.equal(shouldUseCurrentColorOnDark(hex), false, `${hex} should keep its brand hex`);
    assert.ok(hexRelativeLuminance(hex) >= DARK_PLATE_MIN_LUMINANCE);
  }
});
