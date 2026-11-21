import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Ii as r,
  Pr as i,
  Vt as a,
  Yi as o,
  ci as s,
  dr as c,
  or as l,
  yi as u,
} from "./vendor-antd.QfSgOu5e.js";
import { l as d, n as f, s as p } from "./client-BfElcTb7.js";
import { r as m } from "./fileUtils-BjWnOXhL.js";
import { Tt as h, Y as g } from "./index.B_LPe2F7.js";
import { t as _ } from "./ListLayout-B8lj_6O3.js";
import {
  A as v,
  B as ee,
  C as te,
  D as ne,
  E as y,
  F as b,
  G as x,
  H as re,
  I as S,
  K as C,
  L as ie,
  M as ae,
  P as oe,
  R as se,
  S as ce,
  T as w,
  U as T,
  W as E,
  _ as le,
  a as ue,
  b as de,
  c as fe,
  d as pe,
  f as D,
  g as O,
  i as k,
  j as A,
  k as j,
  m as M,
  o as N,
  p as P,
  q as F,
  r as I,
  s as L,
  t as R,
  v as z,
  w as B,
  x as me,
  y as he,
  z as ge,
} from "./service-QgnF39bM.js";
import { t as V } from "./vendor-charts.C3duJp8P.js";
var H = e(t(), 1),
  U = e(u(), 1);
a();
var W = n(),
  _e = ({ activeKey: e, onChange: t }) =>
    (0, W.jsx)(s, {
      activeKey: e,
      onChange: (e) => t(e),
      items: Object.values(x).map((e) => ({ key: e, label: T[e] })),
    }),
  G = { label: `全部行业`, value: `` },
  K = { label: `全部企业`, value: `` },
  q = { label: `全部机构`, value: `` },
  J = (e = []) => {
    let t = [],
      n = new Set(),
      r = (e) => {
        e.forEach((e) => {
          let i = String(e.orgId ?? ``).trim();
          (i &&
            !n.has(i) &&
            (n.add(i),
            t.push({ value: i, label: e.orgName || e.fullName || i })),
            Array.isArray(e.children) && e.children.length && r(e.children));
        });
      };
    return (r(e), t);
  },
  Y = ({ industryId: e, enterpriseId: t }) => {
    let [n, r] = (0, H.useState)([G]),
      [i, a] = (0, H.useState)([]),
      [o, s] = (0, H.useState)([q]),
      [c, l] = (0, H.useState)(!1),
      [u, m] = (0, H.useState)(!1),
      [h, g] = (0, H.useState)(!1),
      _ = (0, H.useMemo)(() => n.find((t) => t.value === e), [e, n]),
      v = (0, H.useMemo)(
        () =>
          e
            ? [
                K,
                { label: _?.label || e, value: e },
                ...i.filter((t) => t.value !== e),
              ]
            : [K],
        [i, e, _],
      );
    return (
      (0, H.useEffect)(() => {
        let e = !1;
        return (
          (async () => {
            if (!f.getTenantList) {
              r([G]);
              return;
            }
            l(!0);
            try {
              let t =
                (
                  await f.getTenantList({
                    pageIndex: 1,
                    pageRows: 9999,
                    tenantLevel: d.INDUSTRY,
                    state: p.ENABLED,
                  })
                )?.list ?? [];
              if (e) return;
              r([
                G,
                ...t
                  .map((e) => ({
                    label: e.tenantName || e.tenantBriefName || e.tenantCode,
                    value: String(e.tenantCode ?? ``).trim(),
                  }))
                  .filter((e) => e.value),
              ]);
            } catch (t) {
              (console.error(`获取行业列表失败`, t), e || r([G]));
            } finally {
              e || l(!1);
            }
          })(),
          () => {
            e = !0;
          }
        );
      }, []),
      (0, H.useEffect)(() => {
        let t = !1;
        return (
          (async () => {
            if (!e) {
              (a([]), m(!1));
              return;
            }
            if (!f.getTenantList) {
              a([]);
              return;
            }
            m(!0);
            try {
              let n = (
                (
                  await f.getTenantList({
                    pageIndex: 1,
                    pageRows: 9999,
                    tenantLevel: d.ENTERPRISE,
                    state: p.ENABLED,
                    parentCode: e,
                  })
                )?.list ?? []
              ).filter((t) => {
                let n = String(t.parentCode ?? ``).trim();
                return !n || n === e;
              });
              if (t) return;
              a(
                n
                  .map((e) => ({
                    label: e.tenantName || e.tenantBriefName || e.tenantCode,
                    value: String(e.tenantCode ?? ``).trim(),
                  }))
                  .filter((e) => e.value),
              );
            } catch (e) {
              (console.error(`获取企业列表失败`, e), t || a([]));
            } finally {
              t || m(!1);
            }
          })(),
          () => {
            t = !0;
          }
        );
      }, [e]),
      (0, H.useEffect)(() => {
        let e = !1;
        return (
          (async () => {
            if (!t) {
              (s([q]), g(!1));
              return;
            }
            let n = f.getOrgPlatList ?? f.getOrgListByChildTenant;
            if (!n) {
              s([q]);
              return;
            }
            g(!0);
            try {
              let r = [];
              if (f.getOrgPlatList) {
                let e = await f.getOrgPlatList({
                  tenantCode: t,
                  orgTreeFormat: !1,
                  state: p.ENABLED,
                });
                r = J(Array.isArray(e) ? e : []);
              } else {
                let e = await n({ tenantCodes: t });
                r = J(
                  (Array.isArray(e)
                    ? e
                    : Array.isArray(e?.data)
                      ? e.data
                      : []
                  ).flatMap((e) => {
                    let t = e;
                    return [
                      ...(Array.isArray(t.orgs) ? t.orgs : []),
                      ...(Array.isArray(t.children) ? t.children : []),
                    ];
                  }),
                );
              }
              if (e) return;
              s([q, ...r]);
            } catch (t) {
              (console.error(`获取机构列表失败`, t), e || s([q]));
            } finally {
              e || g(!1);
            }
          })(),
          () => {
            e = !0;
          }
        );
      }, [t]),
      {
        industryOptions: n,
        enterpriseOptions: v,
        orgOptions: o,
        industryLoading: c,
        enterpriseLoading: u,
        orgLoading: h,
      }
    );
  };
a();
var { RangePicker: X } = i,
  Z = (e) => e >= (0, U.default)().startOf(`day`),
  ve = ({ value: e, onChange: t, onExport: n, exportLoading: i }) => {
    let {
      industryOptions: a,
      enterpriseOptions: s,
      orgOptions: c,
      industryLoading: u,
      enterpriseLoading: d,
      orgLoading: f,
    } = Y({ industryId: e.industryId, enterpriseId: e.enterpriseId });
    return (0, W.jsxs)(`div`, {
      className: F[`filters-row`],
      children: [
        (0, W.jsx)(r, {
          style: { width: 140 },
          value: e.timePreset,
          options: E,
          onChange: (n) =>
            t({
              ...e,
              timePreset: n,
              dateRange: n === C.CUSTOM ? e.dateRange : void 0,
            }),
        }),
        e.timePreset === C.CUSTOM
          ? (0, W.jsx)(X, {
              value: e.dateRange
                ? [
                    (0, U.default)(e.dateRange[0]),
                    (0, U.default)(e.dateRange[1]),
                  ]
                : null,
              onChange: (n) => {
                if (!n?.[0] || !n?.[1]) {
                  t({ ...e, timePreset: C.CUSTOM, dateRange: void 0 });
                  return;
                }
                if (n[1].diff(n[0], `day`) + 1 > 90) {
                  l.warning(`自定义时间范围最长 90 天`);
                  return;
                }
                t({
                  ...e,
                  timePreset: C.CUSTOM,
                  dateRange: [
                    n[0].format(`YYYY-MM-DD`),
                    n[1].format(`YYYY-MM-DD`),
                  ],
                });
              },
              disabledDate: Z,
            })
          : null,
        (0, W.jsx)(r, {
          style: { width: 160 },
          value: e.industryId,
          options: a,
          loading: u,
          showSearch: !0,
          optionFilterProp: `label`,
          onChange: (n) =>
            t({ ...e, industryId: n, enterpriseId: ``, orgId: `` }),
        }),
        (0, W.jsx)(r, {
          style: { width: 180 },
          value: e.enterpriseId,
          options: s,
          loading: d,
          disabled: !e.industryId,
          showSearch: !0,
          optionFilterProp: `label`,
          onChange: (n) => t({ ...e, enterpriseId: n, orgId: `` }),
        }),
        (0, W.jsx)(r, {
          style: { width: 180 },
          value: e.orgId,
          options: c,
          loading: f,
          disabled: !e.enterpriseId,
          showSearch: !0,
          optionFilterProp: `label`,
          onChange: (n) => t({ ...e, orgId: n }),
        }),
        (0, W.jsx)(`div`, { className: F[`filters-spacer`] }),
        (0, W.jsx)(o, {
          type: `primary`,
          loading: i,
          onClick: n,
          children: `导出报表`,
        }),
      ],
    });
  },
  ye = ({ items: e }) =>
    (0, W.jsx)(`div`, {
      className: F[`overview-cards`],
      children: e.map((e) =>
        (0, W.jsxs)(
          `div`,
          {
            className: F[`overview-card`],
            children: [
              (0, W.jsx)(`div`, {
                className: F[`overview-card-label`],
                children: e.label,
              }),
              (0, W.jsxs)(`div`, {
                className: F[`overview-card-value`],
                children: [
                  e.value,
                  e.unit
                    ? (0, W.jsx)(`span`, {
                        className: F[`overview-card-unit`],
                        children: e.unit,
                      })
                    : null,
                ],
              }),
            ],
          },
          e.key,
        ),
      ),
    }),
  Q = ({ items: e }) =>
    (0, W.jsx)(`div`, {
      className: F[`metrics-row`],
      style: { "--metrics-count": e.length || 1 },
      children: e.map((e) =>
        (0, W.jsxs)(
          `div`,
          {
            className: F[`metric-card`],
            children: [
              (0, W.jsx)(`div`, {
                className: F[`metric-label`],
                children: e.label,
              }),
              (0, W.jsxs)(`div`, {
                className: F[`metric-value`],
                children: [
                  e.value,
                  e.unit
                    ? (0, W.jsx)(`span`, {
                        className: F[`metric-unit`],
                        children: e.unit,
                      })
                    : null,
                ],
              }),
            ],
          },
          e.key,
        ),
      ),
    });
a();
var be = ({ title: e, columns: t, data: n, loading: r }) => {
  let i = !!t.extra;
  return (0, W.jsxs)(`div`, {
    className: F[`panel-card`],
    children: [
      (0, W.jsx)(`div`, { className: F[`panel-title`], children: e }),
      (0, W.jsxs)(`div`, {
        className: F[`ranking-header`],
        children: [
          (0, W.jsx)(`span`, { className: F[`ranking-rank-placeholder`] }),
          (0, W.jsx)(`span`, {
            className: F[`ranking-name`],
            children: t.name,
          }),
          i
            ? (0, W.jsx)(`span`, {
                className: F[`ranking-value`],
                children: t.extra,
              })
            : null,
          (0, W.jsx)(`span`, {
            className: F[`ranking-value`],
            children: t.value,
          }),
        ],
      }),
      (0, W.jsx)(`div`, {
        className: F[`ranking-body`],
        children: (0, W.jsxs)(`div`, {
          className: F[`ranking-list`],
          children: [
            n.map((e) =>
              (0, W.jsxs)(
                `div`,
                {
                  className: F[`ranking-item`],
                  children: [
                    (0, W.jsx)(`span`, {
                      className: `${F[`ranking-rank`]} ${e.rank <= 3 ? F[`ranking-rank-top`] : ``}`,
                      children: e.rank,
                    }),
                    (0, W.jsx)(`span`, {
                      className: F[`ranking-name`],
                      title: e.name,
                      children: e.name,
                    }),
                    i
                      ? (0, W.jsx)(`span`, {
                          className: F[`ranking-value`],
                          children: e.extra,
                        })
                      : null,
                    (0, W.jsx)(`span`, {
                      className: F[`ranking-value`],
                      children: e.value,
                    }),
                  ],
                },
                `${e.rank}-${e.name}`,
              ),
            ),
            !n.length && !r
              ? (0, W.jsx)(`div`, {
                  className: F[`ranking-empty`],
                  children: `暂无数据`,
                })
              : null,
          ],
        }),
      }),
      r
        ? (0, W.jsx)(`div`, {
            className: F[`panel-loading`],
            children: (0, W.jsx)(c, {}),
          })
        : null,
    ],
  });
};
a();
var $ = ({ title: e, type: t, data: n, unit: r, loading: i }) => {
    let a = (0, H.useRef)(null),
      o = (0, H.useRef)();
    return (
      (0, H.useEffect)(() => {
        if (!a.current) return;
        o.current = V(a.current);
        let e = () => o.current?.resize();
        return (
          window.addEventListener(`resize`, e),
          () => {
            (window.removeEventListener(`resize`, e), o.current?.dispose());
          }
        );
      }, []),
      (0, H.useEffect)(() => {
        if (!o.current) return;
        let e = n.some((e) => e.series),
          i = [...new Set(n.map((e) => e.date))];
        if (e) {
          let e = [...new Set(n.map((e) => e.series).filter(Boolean))];
          o.current.setOption({
            color: [`#5B8FF9`, `#5AD8A6`, `#F6BD16`, `#716AE5`],
            tooltip: { trigger: `axis` },
            legend: { data: e, top: 0, right: 0 },
            grid: { left: 8, right: 16, top: 40, bottom: 32, containLabel: !0 },
            xAxis: { type: `category`, data: i },
            yAxis: { type: `value`, name: r },
            series: e.map((e) => ({
              name: e,
              type: `line`,
              smooth: !0,
              data: i.map(
                (t) =>
                  n.find((n) => n.date === t && n.series === e)?.value ?? 0,
              ),
            })),
          });
          return;
        }
        o.current.setOption({
          color: [`#5B8FF9`],
          tooltip: { trigger: `axis` },
          grid: { left: 8, right: 16, top: 24, bottom: 32, containLabel: !0 },
          xAxis: { type: `category`, data: i },
          yAxis: { type: `value`, name: r },
          series: [
            {
              type: t,
              data: i.map((e) => n.find((t) => t.date === e)?.value ?? 0),
              barMaxWidth: 28,
              itemStyle: { borderRadius: [4, 4, 0, 0] },
            },
          ],
        });
      }, [n, t, r]),
      (0, W.jsxs)(`div`, {
        className: F[`panel-card`],
        children: [
          (0, W.jsxs)(`div`, {
            className: F[`panel-title`],
            children: [e, r ? `（单位：${r}）` : ``],
          }),
          (0, W.jsx)(`div`, {
            className: F[`chart-wrap`],
            children: (0, W.jsx)(`div`, { ref: a, className: F[`chart-box`] }),
          }),
          i
            ? (0, W.jsx)(`div`, {
                className: F[`panel-loading`],
                children: (0, W.jsx)(c, {}),
              })
            : null,
        ],
      })
    );
  },
  xe = ({
    config: e,
    onViewDetail: t,
    tableFetcher: n,
    extraParams: r,
    loading: i,
  }) => {
    let a = n ?? D(e.tableData, e.tableFilters);
    return (0, W.jsxs)(`div`, {
      children: [
        (0, W.jsx)(Q, { items: e.metrics }),
        (0, W.jsxs)(`div`, {
          className: F[`chart-rank-row`],
          children: [
            (0, W.jsx)($, {
              title: e.chartTitle,
              type: e.chartType,
              data: e.trendData,
              unit: e.chartUnit,
              loading: i,
            }),
            (0, W.jsx)(be, {
              title: e.rankingTitle,
              columns: e.rankingColumns,
              data: e.rankingData,
              loading: i,
            }),
          ],
        }),
        e.tokenTrend
          ? (0, W.jsx)(`div`, {
              style: { marginBottom: 16 },
              children: (0, W.jsx)($, {
                title: e.tokenTrend.title,
                type: `line`,
                data: e.tokenTrend.data,
                unit: e.tokenTrend.unit,
                loading: i,
              }),
            })
          : null,
        (0, W.jsx)(
          v,
          {
            title: e.tableTitle,
            filters: e.tableFilters,
            columns: e.tableColumns,
            fetchData: a,
            extraParams: r,
            onView: t,
          },
          e.tab,
        ),
      ],
    });
  };
a();
var Se = () => {
  let e = g(),
    [t, n] = (0, H.useState)(() => b() ?? ee),
    [r, i] = (0, H.useState)(() => oe() ?? ge),
    [a, o] = (0, H.useState)(null),
    [s, c] = (0, H.useState)(null),
    [u, d] = (0, H.useState)(null),
    [f, p] = (0, H.useState)(null),
    [v, C] = (0, H.useState)(null),
    [T, E] = (0, H.useState)(null),
    [D, V] = (0, H.useState)(!0),
    [G, K] = (0, H.useState)(!1),
    q = (0, H.useMemo)(() => A(r), [r]);
  ((0, H.useEffect)(() => {
    ie(r);
  }, [r]),
    (0, H.useEffect)(() => {
      se(t);
    }, [t]),
    (0, H.useEffect)(() => {
      let e = !1;
      return (
        te(ae(r))
          .then((t) => {
            e || o(S(t) ?? null);
          })
          .catch(() => {
            e || o(null);
          }),
        () => {
          e = !0;
        }
      );
    }, [r]),
    (0, H.useEffect)(() => {
      let e = !1,
        n = () => {
          t === x.POINTS
            ? c(null)
            : t === x.MODEL
              ? d(null)
              : t === x.AGENT
                ? p(null)
                : t === x.SKILL
                  ? C(null)
                  : E(null);
        };
      return (
        (async () => {
          V(!0);
          try {
            if (t === x.POINTS) {
              let t = await y(q);
              e || c(S(t) ?? null);
            } else if (t === x.MODEL) {
              let t = await B(q);
              e || d(S(t) ?? null);
            } else if (t === x.AGENT) {
              let t = await ce(q);
              e || p(S(t) ?? null);
            } else if (t === x.SKILL) {
              let t = await ne(q);
              e || C(S(t) ?? null);
            } else if (t === x.EXPERT) {
              let t = await w(q);
              e || E(S(t) ?? null);
            }
          } catch {
            e || n();
          } finally {
            e || V(!1);
          }
        })(),
        () => {
          e = !0;
        }
      );
    }, [t, q]));
  let J = (0, H.useMemo)(() => ue(a), [a]),
    Y = (0, H.useMemo)(
      () =>
        t === x.POINTS
          ? N(s)
          : t === x.MODEL
            ? k(u)
            : t === x.AGENT
              ? R(f)
              : t === x.SKILL
                ? L(v)
                : t === x.EXPERT
                  ? I(T)
                  : j[t],
      [t, f, T, u, s, v],
    ),
    X = (0, H.useMemo)(() => {
      if (t === x.POINTS) return M(q);
      if (t === x.MODEL) return P(q);
      if (t === x.AGENT) return fe(q);
      if (t === x.SKILL) return O(q);
      if (t === x.EXPERT) return pe(q);
    }, [t, q]),
    Z = (0, H.useCallback)(async () => {
      K(!0);
      try {
        let e;
        e =
          t === x.POINTS
            ? await de(q)
            : t === x.MODEL
              ? await z(q)
              : t === x.AGENT
                ? await le(q)
                : t === x.SKILL
                  ? await me(q)
                  : await he(q);
        let n = (0, U.default)().format(`YYYY-MM-DD HH:mm:ss`),
          r = `${re[t]}_${n}.xlsx`;
        (m(e, r), l.success(`导出成功`));
      } catch {
        l.error(`导出失败`);
      } finally {
        K(!1);
      }
    }, [t, q]),
    Q = (0, H.useCallback)(
      (n) => {
        let i = new URLSearchParams({
          tabType: t,
          timePreset: r.timePreset,
          industryId: r.industryId,
          enterpriseId: r.enterpriseId,
          orgId: r.orgId,
          ...(r.dateRange
            ? { start: r.dateRange[0], end: r.dateRange[1] }
            : {}),
          ...(n.code ? { code: String(n.code) } : {}),
          ...(n.tencentCode ? { tenantCode: String(n.tencentCode) } : {}),
          ...(n.tencentName ? { tencentName: String(n.tencentName) } : {}),
          ...(n.orgId ? { targetOrgId: String(n.orgId) } : {}),
          ...(n.orgName ? { orgName: String(n.orgName) } : {}),
          ...(n.modelName ? { modelName: String(n.modelName) } : {}),
          ...(n.supplierName ? { supplierName: String(n.supplierName) } : {}),
          ...(n.supplierId ? { supplierId: String(n.supplierId) } : {}),
          ...(n.agentName ? { agentName: String(n.agentName) } : {}),
          ...(n.agentId ? { agentId: String(n.agentId) } : {}),
          ...(n.skillId ? { skillId: String(n.skillId) } : {}),
          ...(n.skillName || n.skillDisplayName
            ? { skillName: String(n.skillDisplayName || n.skillName) }
            : {}),
          ...(n.pluginId ? { expertId: String(n.pluginId) } : {}),
          ...(n.pluginName || n.pluginNameCN
            ? { expertName: String(n.pluginNameCN || n.pluginName) }
            : {}),
        });
        e(`${h.AGENT_PLATFORM_DATA_ANALYSIS_DETAIL}?${i.toString()}`);
      },
      [t, r, e],
    );
  return (0, W.jsx)(_, {
    mode: `card`,
    title: `数据分析`,
    tip: { type: `question`, content: `平台统一多维度数据看板` },
    basicListClassName: F.box,
    headerClassName: F[`toolbar-tabs-header`],
    children: (0, W.jsxs)(`div`, {
      className: F.page,
      children: [
        (0, W.jsxs)(`div`, {
          className: F[`sticky-header`],
          children: [
            (0, W.jsx)(ye, { items: J }),
            (0, W.jsx)(_e, { activeKey: t, onChange: n }),
          ],
        }),
        (0, W.jsx)(ve, {
          value: r,
          onChange: i,
          onExport: Z,
          exportLoading: G,
        }),
        (0, W.jsx)(xe, {
          config: Y,
          onViewDetail: Q,
          tableFetcher: X,
          extraParams: q,
          loading: D,
        }),
      ],
    }),
  });
};
export { Se as default };
