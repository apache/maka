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
import { DEFAULT_SETTLE_MS, withFixtureWindow } from './fixture-window.mjs';

const FIXTURES = [
  'module-skills',
  'module-mcp',
  'module-daily-review',
  'plan-reminders',
  'settings-general',
  'fetched-empty',
  'settings-data',
  'settings-gateway',
  // 使用统计 restyle: the range/refresh row, underline tab bar, and stats
  // tables now sit under the alignment auditor's watch.
  'settings-usage',
  'turn-narrative',
  'settings-permissions',
  // #1233 deferral: bot QR-onboarding modal in its deterministic waiting state.
  'settings-bots-onboarding',
];
const SETTLE_MS = Number(process.env.AUDIT_SETTLE_MS ?? DEFAULT_SETTLE_MS);
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

for (const fixture of FIXTURES) {
  try {
    const issues = await withFixtureWindow(
      fixture,
      { theme: 'light', settleMs: SETTLE_MS },
      async ({ evaluate }) => JSON.parse(await evaluate(EXPR)),
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
