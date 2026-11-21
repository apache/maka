import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { Tt as r, Y as i, q as a } from "./index.B_LPe2F7.js";
import { t as o } from "./DetailLayout-139jNxZs.js";
import {
  A as s,
  F as c,
  G as l,
  K as u,
  N as d,
  O as f,
  P as p,
  V as m,
  W as h,
  f as g,
  h as _,
  j as v,
  k as y,
  l as b,
  n as x,
  q as S,
  u as C,
} from "./service-QgnF39bM.js";
var w = e(t(), 1),
  T = n(),
  E = new Set([l.POINTS, l.MODEL, l.AGENT, l.SKILL, l.EXPERT]);
function D(e) {
  let t = Object.values(l);
  return e && t.includes(e) ? e : (c() ?? l.POINTS);
}
function O(e) {
  return {
    code: e.get(`code`) ?? void 0,
    tenantCode: e.get(`tenantCode`) ?? void 0,
    tenantName: e.get(`tencentName`) ?? void 0,
    orgId: e.get(`targetOrgId`) ?? void 0,
    orgName: e.get(`orgName`) ?? void 0,
    modelName: e.get(`modelName`) ?? void 0,
    agentName: e.get(`agentName`) ?? void 0,
    agentId: e.get(`agentId`) ?? void 0,
    skillName: e.get(`skillName`) ?? void 0,
    skillId: e.get(`skillId`) ?? void 0,
    expertName: e.get(`expertName`) ?? void 0,
    expertId: e.get(`expertId`) ?? void 0,
  };
}
function k(e, t) {
  let n = p(),
    r = e.get(`timePreset`),
    i = e.get(`start`),
    a = e.get(`end`),
    o = h.map((e) => e.value);
  return {
    timePreset:
      r && o.includes(r)
        ? r
        : n?.timePreset && o.includes(n.timePreset)
          ? n.timePreset
          : u.LAST_7_DAYS,
    dateRange: i && a ? [i, a] : n?.dateRange,
    industryId: e.get(`industryId`) ?? n?.industryId ?? ``,
    enterpriseId:
      t.tenantCode ?? e.get(`enterpriseId`) ?? n?.enterpriseId ?? ``,
    orgId: t.orgId ?? e.get(`orgId`) ?? n?.orgId ?? ``,
  };
}
var A = () => {
  let e = i(),
    [t] = a(),
    n = D(t.get(`tabType`) || void 0),
    c = (0, w.useMemo)(() => O(t), [t]),
    u = (0, w.useMemo)(() => k(t, c), [c, t]),
    p = (0, w.useMemo)(() => v(u), [u]),
    h = (0, w.useMemo)(() => x(n), [n]),
    A = y[n],
    j = E.has(n),
    M = (0, w.useMemo)(
      () =>
        n === l.SKILL
          ? _({ code: c.code })
          : n === l.EXPERT
            ? C({ code: c.code })
            : j
              ? b({ ...p, code: c.code ?? `` })
              : g(f[n], y[n].tableFilters),
      [p, c.code, n, j],
    ),
    N = j ? h.title : A.tableTitle,
    P = j ? h.filters : A.tableFilters,
    F = (0, w.useMemo)(
      () =>
        j ? h.columns : A.tableColumns.filter((e) => e.dataIndex !== `action`),
      [h, A.tableColumns, j],
    ),
    { startDate: I, endDate: L } = d(u),
    R = [
      c.tenantName || c.tenantCode,
      c.orgName || (c.orgId ? `机构 ${c.orgId}` : ``),
      c.modelName ? `模型 ${c.modelName}` : ``,
      c.agentName
        ? `Agent ${c.agentName}${c.agentId ? `(${c.agentId})` : ``}`
        : ``,
      c.skillName
        ? `技能 ${c.skillName}${c.skillId ? `(${c.skillId})` : ``}`
        : ``,
      c.expertName
        ? `智能专家 ${c.expertName}${c.expertId ? `(${c.expertId})` : ``}`
        : ``,
    ]
      .filter(Boolean)
      .join(` / `);
  return (0, T.jsx)(o, {
    title: m[n],
    onBack: () => e(r.AGENT_PLATFORM_DATA_ANALYSIS),
    showCloseButton: !1,
    children: (0, T.jsxs)(`div`, {
      className: S[`detail-page`],
      children: [
        (0, T.jsxs)(`div`, {
          style: { color: `#9296a6`, fontSize: 12 },
          children: [
            `统计时间：`,
            I,
            ` ~ `,
            L,
            R ? `　|　下钻范围：${R}` : ``,
            j && !c.code ? `　|　缺少明细标识 code` : ``,
          ],
        }),
        (0, T.jsx)(s, {
          title: N,
          filters: P,
          columns: F,
          fetchData: M,
          extraParams: { ...p, code: c.code },
        }),
      ],
    }),
  });
};
export { A as default };
