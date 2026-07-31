import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const REPO_ROOT = existsSync(resolve(process.cwd(), "packages", "ui"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const readRepo = (path: string) =>
  readFileSync(resolve(REPO_ROOT, path), "utf8");

test("Astryx selectors own their labels without compatibility wrappers", () => {
  const panel = readRepo("packages/ui/src/plan-reminder-panel.tsx");
  const dialog = readRepo("packages/ui/src/plan-reminder-form-dialog.tsx");

  assert.doesNotMatch(panel, /<label className="maka-plan-compact-select/);
  assert.match(panel, /label=\{copy\.page\.sort\}/);
  assert.match(panel, /label=\{copy\.page\.state\}/);
  assert.match(panel, /label=\{copy\.page\.range\}/);

  assert.doesNotMatch(dialog, /<label className="maka-plan-field">/);
  assert.doesNotMatch(
    dialog,
    /label=\{copy\.field\.(?:recurrence|delivery|platform)\}\s+isLabelHidden/,
  );
});

test("product layout classes wrap Astryx controls instead of restyling their chrome", () => {
  const skills = readRepo("packages/ui/src/skills-panel.tsx");
  const skillStyles = readRepo(
    "apps/desktop/src/renderer/styles/module-pages/skills.css",
  );
  const appearance = readRepo(
    "apps/desktop/src/renderer/settings/appearance-settings-page.tsx",
  );
  const dailyReview = readRepo("packages/ui/src/daily-review-panel.tsx");
  const dailyReviewStyles = readRepo(
    "apps/desktop/src/renderer/styles/daily-review.css",
  );

  assert.doesNotMatch(
    skills,
    /<Selector(?:(?!\/>)[\s\S])*?className="maka-skill-market-select"/,
  );
  assert.equal(
    skills.match(/<div className="maka-skill-market-select">/g)?.length,
    2,
  );

  const marketSelectRule = skillStyles.match(
    /\.maka-skill-market-select\s*\{([\s\S]*?)\}/,
  )?.[1];
  assert.ok(marketSelectRule);
  assert.doesNotMatch(marketSelectRule, /(?:min-)?height\s*:/);

  assert.doesNotMatch(appearance, /className="min-h-21 w-full"/);
  assert.match(
    appearance,
    /<TextArea[\s\S]*?label=\{copy\.assistantTone\}[\s\S]*?width="100%"/,
  );

  assert.doesNotMatch(dailyReview, /className="maka-daily-review-model-select"/);
  assert.doesNotMatch(
    dailyReviewStyles,
    /\.maka-daily-review-model-select\s*\{/,
  );
});
