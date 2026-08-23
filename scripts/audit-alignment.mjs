/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Systematic row-alignment auditor (design governance tool).
//
// For every e2e-fixture fixture, finds horizontal clusters of interactive
// controls and reports:
//   - height mismatch  (same control type sharing a row)
//   - centerline drift (mixed control types sharing a row)
//   - radius mismatch  (same-row controls on different radius families;
//                       role=switch is pill by design and exempt)
// Usage: node scripts/audit-alignment.mjs   (expects a built renderer)
// Rule of thumb: mixed types align CENTERS; same types also match heights.
//
// Deliberate change from the original raw-spawn launcher: fixture windows now
// launch through `withFixtureWindow`, which means MAKA_E2E=1, a throwaway
// userData dir, and a sandboxed $HOME. The audit used to run against the real
// userData path — a developer with Maka open lost the single-instance lock —
// and could enumerate the real `~/.maka/skills`. Fixture pages render fixture
// data either way, so control geometry is unaffected; the isolation is the
// point.
import { withFixtureWindow } from './fixture-window.mjs';

// Each fixture names the element that means "this surface has rendered", so
// the audit never measures a half-mounted page. The module pages share one
// shell (`.maka-module-main`), every settings scenario mounts the settings
// modal (`.settingsSurface`), and turn-narrative is the chat surface.
const FIXTURES = [
  ['module-skills', '.maka-module-main'],
  ['module-mcp', '.maka-module-main'],
  ['module-daily-review', '.maka-module-main'],
  ['scheduled-tasks', '.maka-module-main'],
  ['settings-general', '.settingsSurface'],
  ['settings-models', '.settingsSurface'],
  ['settings-data', '.settingsSurface'],
  // 使用统计 restyle: the range/refresh row, underline tab bar, and stats
  // tables now sit under the alignment auditor's watch.
  ['settings-usage', '.settingsSurface'],
  ['turn-narrative', '.maka-session-workbar'],
  // #2188: the browser toolbar's four-control-plus-input row.
  ['turn-narrative-browser', '.maka-browser-panel'],
  ['settings-permissions', '.settingsSurface'],
  // #1233 deferral: bot QR-onboarding modal in its deterministic waiting state.
  ['settings-bots-onboarding', '.settingsSurface'],
];
// The readiness selector proves the shell rendered; content that arrives
// after it (the QR-onboarding modal, the usage stats tables) lands as DOM
// mutations, so the audit waits for a mutation-quiet window instead of
// sleeping a flat budget. QUIET_MS must outlast the longest fixture-internal
// deferral (settings-bots-onboarding arms its waiting state ~300ms after
// mount); SETTLE_MS caps the whole wait so a never-quiet page (an animating
// fixture) still proceeds on the old CI-gate budget.
const SETTLE_MS = Number(process.env.AUDIT_SETTLE_MS ?? 2_500);
const QUIET_MS = Number(process.env.AUDIT_QUIET_MS ?? 500);

// Resolves once the DOM has stayed mutation-free for `quietMs`, bounded by
// `budgetMs` overall. Runs after withFixtureWindow's own settle expression,
// which has already frozen animations and awaited document.fonts, so the only
// remaining movement is real content landing.
const QUIESCENT_EXPR = (quietMs, budgetMs) => `new Promise((resolve)=>{
  let last=performance.now();
  const observer=new MutationObserver(()=>{ last=performance.now(); });
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  const started=performance.now();
  const tick=()=>{
    const now=performance.now();
    if(now-last>=${quietMs} || now-started>=${budgetMs}){ observer.disconnect(); resolve('settled'); return; }
    setTimeout(tick,50);
  };
  tick();
})`;
let totalIssues = 0;
let fixtureErrors = 0;

const EXPR = `(()=>{
  const controls=[...document.querySelectorAll('button,[role=button],[role=switch],input,select,[role=combobox],[role=tab]')].filter(e=>{
    const r=e.getBoundingClientRect();
    const cs=getComputedStyle(e);
    return r.width>0 && r.height>8 && cs.visibility!=='hidden' && cs.display!=='none';
  });
  const clusters=new Map();
  for(const e of controls){
    const p=e.parentElement; if(!p) continue;
    if(!clusters.has(p)) clusters.set(p,[]);
    clusters.get(p).push(e);
  }
  const issues=[];
  for(const [p,els] of clusters){
    if(els.length<2) continue;
    const rects=els.map(e=>({e,r:e.getBoundingClientRect(),cs:getComputedStyle(e)}));
    // horizontal cluster: vertical ranges overlap pairwise with the first
    const base=rects[0].r;
    const horiz=rects.filter(({r})=>Math.min(r.bottom,base.bottom)-Math.max(r.top,base.top) > Math.min(r.height,base.height)*0.5);
    if(horiz.length<2) continue;
    const type=(e)=>e.getAttribute('role')||e.tagName;
    const sameType=new Set(horiz.map(({e})=>type(e))).size===1;
    const hs=horiz.map(({r})=>+r.height.toFixed(1));
    const cys=horiz.map(({r})=>+(r.top+r.height/2).toFixed(1));
    const label=(e)=>((e.getAttribute('aria-label')||e.textContent||e.className||'').trim().slice(0,16));
    const hSpread=Math.max(...hs)-Math.min(...hs);
    const cySpread=Math.max(...cys)-Math.min(...cys);
    const radSet=[...new Set(horiz.filter(({e})=>e.getAttribute('role')!=='switch').map(({cs})=>cs.borderRadius).filter(x=>!x.includes('%')&&parseFloat(x)<100))];
    if(hSpread>2.5 && sameType) issues.push({kind:'height',parent:p.className.split(' ')[0]||p.tagName,spread:+hSpread.toFixed(1),items:horiz.map(({e,r})=>label(e)+':'+r.height.toFixed(0))});
    if(cySpread>1.5 && (!sameType || hSpread<=2.5)) issues.push({kind:'center',parent:p.className.split(' ')[0]||p.tagName,spread:+cySpread.toFixed(1),items:horiz.map(({e,r})=>label(e)+':'+(r.top+r.height/2).toFixed(0))});
    if(radSet.length>1 && hSpread<=2.5) issues.push({kind:'radius',parent:p.className.split(' ')[0]||p.tagName,items:horiz.map(({e,cs})=>label(e)+':'+cs.borderRadius)});
  }
  return JSON.stringify(issues.slice(0,12));
})()`;

for (const [fixture, readySelector] of FIXTURES) {
  try {
    const issues = await withFixtureWindow(
      fixture,
      { theme: 'light', readySelector, settleMs: 0 },
      async ({ evaluate }) => {
        await evaluate(QUIESCENT_EXPR(QUIET_MS, SETTLE_MS));
        return JSON.parse(await evaluate(EXPR));
      },
    );
    console.log('==', fixture, '==');
    for (const issue of issues) console.log(JSON.stringify(issue));
    totalIssues += issues.length;
    if (!issues.length) console.log('(clean)');
  } catch (err) {
    console.log('==', fixture, '== ERROR', err.message);
    fixtureErrors++;
  }
}

// CI semantics: alignment findings fail the run; fixture-level launch errors
// fail too (a fixture that can't boot means the audit didn't actually cover it).
if (totalIssues > 0 || fixtureErrors > 0) {
  console.log(`FAIL: ${totalIssues} alignment issue(s), ${fixtureErrors} fixture error(s)`);
  process.exit(1);
}
console.log('alignment audit: all fixtures clean');
process.exit(0);
