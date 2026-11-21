import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Ii as r,
  Or as i,
  Pi as a,
  Pr as o,
  S as s,
  Vt as c,
  dr as l,
  fi as u,
  oi as d,
  wr as f,
  yr as p,
} from "./vendor-antd.QfSgOu5e.js";
import { n as m, t as h } from "./moment-ROF23LCm.js";
import { n as g } from "./fileUtils-BjWnOXhL.js";
import { t as _ } from "./Button-Docou5u1.js";
import { D as v, i as y, n as b, r as x } from "./index.B_LPe2F7.js";
import { t as S } from "./ListLayout-B8lj_6O3.js";
import { t as C } from "./lodash-B2QhZcyQ.js";
import { t as w } from "./vendor-charts.C3duJp8P.js";
import {
  C as T,
  E,
  S as D,
  _ as O,
  a as k,
  c as A,
  f as j,
  g as M,
  h as N,
  i as P,
  m as F,
  n as I,
  o as L,
  p as ee,
  r as te,
  s as ne,
  t as re,
  u as ie,
  v as ae,
  w as R,
  x as z,
} from "./data-analysis-DIdIvKkr.js";
import {
  a as B,
  i as V,
  n as H,
  r as U,
  t as W,
} from "./LargeModelAnalysis-DEuQiWtF.js";
var G = e(t(), 1);
(c(), m());
var K = e(C(), 1),
  q = {
    container: `_container_w9ecn_1`,
    title: `_title_w9ecn_11`,
    text: `_text_w9ecn_17`,
    columns: `_columns_w9ecn_21`,
    chart: `_chart_w9ecn_29`,
  },
  J = n(),
  { RangePicker: oe } = o,
  se = (0, G.memo)(
    ({ saasAppId: e, children: t, isUser: n, filterLoading: i = !1 }) => {
      let { userInfo: a } = y(),
        [o] = p.useForm(),
        s = p.useWatch(`dateType`, o),
        c = (0, G.useRef)({}),
        f = (0, G.useRef)(null),
        m = G.useRef(),
        [b, x] = (0, G.useState)(() => t),
        [S, C] = (0, G.useState)(!1),
        T = (
          e = [],
          t = h().subtract(7, `days`).format(`YYYY-MM-DD`),
          n = h().add(1, `days`).format(`YYYY-MM-DD`),
        ) => {
          m.current = w(f.current, { renderer: `svg` });
          let r = {
            tooltip: {
              trigger: `axis`,
              formatter: function (e) {
                return `<p>${e?.[0]?.data?.[0]}</p>
                  <p>智能体平均响应时长：${e?.[0]?.data?.[1]}</p>`;
              },
              axisPointer: { animation: !1 },
            },
            xAxis: { type: `category`, boundaryGap: !1 },
            yAxis: {},
            dataZoom: [
              e?.length ? { type: `slider`, startValue: t, endValue: n } : null,
            ],
            series: [
              {
                type: `line`,
                showSymbol: !1,
                smooth: !0,
                symbolSize: 8,
                z: 1,
                itemStyle: { color: `#16C784` },
                lineStyle: { color: `#16C784` },
                areaStyle: {
                  color: {
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    type: `linear`,
                    global: !1,
                    colorStops: [
                      { offset: 0.25, color: `rgba(57, 205, 151,0.15)` },
                      { offset: 1, color: `rgba(57, 205, 151,0)` },
                    ],
                  },
                },
                data: e,
              },
            ],
          };
          m?.current?.setOption(r);
        },
        E = async (t) => {
          let { microAppId: r, dateType: i, customizeDate: o } = t,
            s = i === H.CustomizeDate;
          if (s && !o) return;
          let l = s
              ? {
                  startTime: o?.[0]?.format(`YYYY-MM-DD`),
                  endTime: o?.[1]?.format(`YYYY-MM-DD`),
                }
              : { startTime: U[i][0], endTime: U[i][1] },
            u = {
              saasAppId: K.isEmpty(e) ? null : e,
              microAppId: r ? Number(r) : null,
              ...l,
            };
          (n || (u.tenantCode = K.isEmpty(a) ? null : a), C(!0));
          try {
            let e = n ? await D(u) : await M(u);
            if (((c.current = u), e.success)) {
              let t = e?.data?.map((e) => [e.date, e.time]);
              T(t, l.startTime, l.endTime);
            }
          } finally {
            C(!1);
          }
        },
        O = () => {
          m?.current?.resize();
        };
      return (
        (0, G.useEffect)(() => {
          (x(t),
            o?.setFieldsValue({ microAppId: t?.[0]?.microAppId }),
            o?.submit());
        }, [e, t]),
        (0, G.useEffect)(
          () => (
            T(),
            window.addEventListener(`resize`, O),
            () => {
              (window.removeEventListener(`resize`, O), m?.current?.dispose());
            }
          ),
          [],
        ),
        (0, J.jsx)(d, {
          className: `${q.container}`,
          styles: { body: { padding: 0 } },
          children: (0, J.jsxs)(l, {
            spinning: S || i,
            children: [
              (0, J.jsxs)(`div`, {
                className: `${q.title}`,
                children: [
                  (0, J.jsx)(`span`, {
                    className: `${q.text}`,
                    children: `智能体应用分析`,
                  }),
                  (0, J.jsx)(_, {
                    type: `link`,
                    permissions: n
                      ? v.MODEL_ANALYZE_EXPORT_EXCEL
                      : v.MODEL_ANALYZE_ADMIN_EXPORT_EXCEL,
                    onClick: async () => {
                      let e = c?.current;
                      n || (e.tenantCode = K.isEmpty(a) ? null : a);
                      let t = n ? await A(e) : await P(e),
                        r = decodeURIComponent(
                          t?.headers?.[`content-disposition`],
                        )?.split(`filename=`)?.[1],
                        i = new Blob([t.data]),
                        o = window.URL.createObjectURL(i);
                      (g(o, r), window.URL.revokeObjectURL(o));
                    },
                    children: `导出为Excel`,
                  }),
                ],
              }),
              (0, J.jsxs)(p, {
                form: o,
                onFinish: E,
                initialValues: { dateType: `1` },
                onValuesChange: () => {
                  o.submit();
                },
                children: [
                  (0, J.jsxs)(`div`, {
                    className: `${q.columns}`,
                    children: [
                      (0, J.jsx)(p.Item, {
                        label: `智能体应用`,
                        name: `microAppId`,
                        children: (0, J.jsx)(r, {
                          placeholder: `请选择`,
                          options: b.map((e) => ({
                            label: e.microAppName,
                            value: e.microAppId,
                          })),
                          showSearch: !0,
                          filterOption: (e, t) =>
                            (t?.label ?? ``)
                              ?.toLowerCase()
                              ?.includes(e?.toLowerCase()),
                        }),
                      }),
                      (0, J.jsx)(p.Item, {
                        label: `日期`,
                        name: `dateType`,
                        children: (0, J.jsx)(r, {
                          placeholder: `请选择`,
                          options: V,
                        }),
                      }),
                    ],
                  }),
                  (0, J.jsxs)(`div`, {
                    className: `${q.columns}`,
                    children: [
                      s === H.CustomizeDate &&
                        (0, J.jsx)(p.Item, {
                          label: `自定义日期`,
                          name: `customizeDate`,
                          children: (0, J.jsx)(oe, {}),
                        }),
                      (0, J.jsx)(p.Item, {
                        children: (0, J.jsx)(u.Group, {
                          value: 1,
                          children: (0, J.jsx)(u, {
                            value: 1,
                            children: `智能体平均响应时长`,
                          }),
                        }),
                      }),
                    ],
                  }),
                ],
              }),
              (0, J.jsx)(`div`, { ref: f, className: `${q.chart}` }),
            ],
          }),
        })
      );
    },
  ),
  Y = {
    container: `_container_n6wa8_1`,
    title: `_title_n6wa8_10`,
    text: `_text_n6wa8_16`,
    columns: `_columns_n6wa8_20`,
    chart: `_chart_n6wa8_28`,
    "message-analysis-card": `_message-analysis-card_n6wa8_32`,
  },
  X = (e, t) => {
    let n = e.clone(),
      r = [];
    for (; n.isSameOrBefore(t);)
      (r.push(n.clone()?.format(`YYYY-MM-DD`)), n.add(1, `days`));
    return r;
  };
(c(), m());
var { RangePicker: ce } = o,
  le = (0, G.memo)(
    ({ saasAppId: e, children: t, isUser: n, filterLoading: i = !1 }) => {
      let { userInfo: o } = y(),
        [c] = p.useForm(),
        f = p.useWatch(`dateType`, c),
        m = p.useWatch(`moreOptions`, c) || 1,
        b = (0, G.useRef)({}),
        x = (0, G.useRef)(null),
        S = G.useRef(),
        [C, T] = (0, G.useState)(() => t),
        [D, A] = (0, G.useState)(!1),
        j = (
          e = [],
          t = h().subtract(7, `days`).format(`YYYY-MM-DD`),
          n = h().add(1, `days`).format(`YYYY-MM-DD`),
        ) => {
          S.current = w(x.current, { renderer: `svg` });
          let r = {
            tooltip: {
              trigger: `axis`,
              formatter: function (e) {
                return `<p>${e?.[0]?.data?.[0]}</p>
                  <p>${{ 1: `人均消息数`, 2: `消息数` }[m]}：${e?.[0]?.data?.[1]}</p>`;
              },
              axisPointer: { animation: !1 },
            },
            xAxis: { type: `category`, boundaryGap: !1 },
            yAxis: {},
            dataZoom: [
              { type: `slider`, startValue: t, endValue: n },
              { type: `inside`, start: 0, end: 100 },
            ],
            series: [
              {
                type: `line`,
                showSymbol: !1,
                smooth: !0,
                symbolSize: 8,
                z: 1,
                itemStyle: { color: `#16C784` },
                lineStyle: { color: `#16C784` },
                areaStyle: {
                  color: {
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    type: `linear`,
                    global: !1,
                    colorStops: [
                      { offset: 0.25, color: `rgba(57, 205, 151,0.15)` },
                      { offset: 1, color: `rgba(57, 205, 151,0)` },
                    ],
                  },
                },
                data: e,
              },
            ],
          };
          S?.current?.setOption(r);
        },
        M = async (t) => {
          let {
            microAppId: r,
            dateType: i,
            customizeDate: a,
            moreOptions: s,
          } = t;
          if (i === H.CustomizeDate && !a) return;
          let [c, l] = [
              a?.[0].format(`YYYY-MM-DD`) || U[i][0],
              a?.[1].format(`YYYY-MM-DD`) || U[i][1],
            ],
            u = {
              saasAppId: K.isEmpty(e) ? null : e,
              microAppId: Number(r),
              startTime: c,
              endTime: l,
            },
            d;
          b.current = u;
          let f = { 1: ae, 2: E };
          (n ||
            ((f = { 1: F, 2: O }), (u.tenantCode = K.isEmpty(o) ? null : o)),
            A(!0));
          try {
            let e = await f?.[s]?.(u);
            ((d =
              e?.success && e?.data?.length
                ? e?.data?.map((e) => [e.date, e.count])
                : X(h(c), h(l)).map((e) => [e, 0])),
              j(d, c, l));
          } finally {
            A(!1);
          }
        },
        N = () => {
          S?.current?.resize();
        };
      return (
        (0, G.useEffect)(() => {
          (T(t),
            c?.setFieldsValue({ microAppId: t?.[0]?.microAppId }),
            c?.submit());
        }, [e, t]),
        (0, G.useEffect)(
          () => (
            j(),
            window.addEventListener(`resize`, N),
            () => {
              (window.removeEventListener(`resize`, N), S?.current?.dispose());
            }
          ),
          [],
        ),
        (0, J.jsxs)(d, {
          className: Y[`message-analysis-card`],
          styles: { body: { padding: 0 } },
          children: [
            ` `,
            (0, J.jsxs)(l, {
              spinning: D || i,
              wrapperClassName: `${Y.container}`,
              children: [
                (0, J.jsxs)(`div`, {
                  className: `${Y.title}`,
                  children: [
                    (0, J.jsx)(`span`, {
                      className: `${Y.text}`,
                      children: `消息分析`,
                    }),
                    (0, J.jsx)(_, {
                      type: `link`,
                      permissions: n
                        ? v.MODEL_ANALYZE_EXPORT_EXCEL
                        : v.MODEL_ANALYZE_ADMIN_EXPORT_EXCEL,
                      onClick: async () => {
                        let e = b?.current,
                          t = { 1: ne, 2: ie };
                        (n ||
                          ((e.tenantCode = K.isEmpty(o) ? null : o),
                          (t = { 1: te, 2: k })),
                          console.log(`=>(index.tsx:176) params`, e));
                        let r = await t?.[m]?.(e),
                          i = decodeURIComponent(
                            r?.headers?.[`content-disposition`],
                          )?.split(`filename=`)?.[1],
                          a = new Blob([r.data]),
                          s = window.URL.createObjectURL(a);
                        (g(s, i), window.URL.revokeObjectURL(s));
                      },
                      children: `导出为Excel`,
                    }),
                  ],
                }),
                (0, J.jsxs)(p, {
                  form: c,
                  onFinish: M,
                  initialValues: { dateType: `1`, moreOptions: 1 },
                  onValuesChange: () => {
                    c.submit();
                  },
                  children: [
                    (0, J.jsxs)(`div`, {
                      className: `${Y.columns}`,
                      children: [
                        (0, J.jsx)(p.Item, {
                          label: `智能体应用`,
                          name: `microAppId`,
                          children: (0, J.jsx)(r, {
                            placeholder: `请选择`,
                            options: C.map((e) => ({
                              label: e.microAppName,
                              value: e.microAppId,
                            })),
                            showSearch: !0,
                            filterOption: (e, t) =>
                              (t?.label ?? ``)
                                ?.toLowerCase()
                                ?.includes(e?.toLowerCase()),
                          }),
                        }),
                        (0, J.jsx)(p.Item, {
                          label: `日期`,
                          name: `dateType`,
                          children: (0, J.jsx)(r, {
                            placeholder: `请选择`,
                            options: V,
                          }),
                        }),
                      ],
                    }),
                    (0, J.jsxs)(`div`, {
                      className: `${Y.columns}`,
                      children: [
                        f === H.CustomizeDate &&
                          (0, J.jsx)(p.Item, {
                            label: `自定义日期`,
                            name: `customizeDate`,
                            children: (0, J.jsx)(ce, {}),
                          }),
                        (0, J.jsx)(p.Item, {
                          name: `moreOptions`,
                          children: (0, J.jsxs)(u.Group, {
                            children: [
                              (0, J.jsxs)(u, {
                                value: 1,
                                children: [
                                  (0, J.jsx)(`span`, {
                                    children: `人均消息数`,
                                  }),
                                  (0, J.jsx)(a, {
                                    title: `反应每个会话用户的持续沟通次数，如此次会话中回答了用户10个问题，即为 10条消息。该指标反映了用户粘性。`,
                                    children: (0, J.jsx)(s, {}),
                                  }),
                                ],
                              }),
                              (0, J.jsxs)(u, {
                                value: 2,
                                children: [
                                  (0, J.jsx)(`span`, { children: `消息数` }),
                                  (0, J.jsx)(a, {
                                    title: `每回答用户一个问题算一条消息。`,
                                    children: (0, J.jsx)(s, {}),
                                  }),
                                ],
                              }),
                            ],
                          }),
                        }),
                      ],
                    }),
                  ],
                }),
                (0, J.jsx)(`div`, { ref: x, className: `${Y.chart}` }),
              ],
            }),
          ],
        })
      );
    },
  ),
  Z = {
    "user-analysis-card": `_user-analysis-card_s7zx1_1`,
    container: `_container_s7zx1_4`,
    title: `_title_s7zx1_13`,
    text: `_text_s7zx1_19`,
    columns: `_columns_s7zx1_23`,
    chart: `_chart_s7zx1_31`,
  };
(c(), m());
var { RangePicker: ue } = o,
  de = (0, G.memo)(
    ({ saasAppId: e, children: t, isUser: n, filterLoading: i = !1 }) => {
      let { userInfo: o } = y(),
        [c] = p.useForm(),
        f = p.useWatch(`dateType`, c) || 1,
        m = p.useWatch(`moreOptions`, c),
        b = (0, G.useRef)({}),
        x = (0, G.useRef)(null),
        S = G.useRef(),
        [C, T] = (0, G.useState)(() => t),
        [E, D] = (0, G.useState)(!1),
        O = (e = [], t = U[f][0], n = U[f][1]) => {
          S.current = w(x.current, { renderer: `svg` });
          let r = {
            tooltip: {
              trigger: `axis`,
              formatter: function (e) {
                return `<p>${e?.[0]?.data?.[0]}</p>
                  <p>${{ 1: `新增用户`, 2: `活跃用户` }[m]}：${e?.[0]?.data?.[1]}</p>`;
              },
              axisPointer: { animation: !1 },
            },
            xAxis: { type: `category`, boundaryGap: !1 },
            yAxis: {},
            dataZoom: [
              { type: `slider`, startValue: t, endValue: n },
              { type: `inside`, start: 0, end: 100 },
            ],
            series: [
              {
                type: `line`,
                showSymbol: !1,
                smooth: !0,
                symbolSize: 8,
                z: 1,
                itemStyle: { color: `#16C784` },
                lineStyle: { color: `#16C784` },
                areaStyle: {
                  color: {
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    type: `linear`,
                    global: !1,
                    colorStops: [
                      { offset: 0.25, color: `rgba(57, 205, 151,0.15)` },
                      { offset: 1, color: `rgba(57, 205, 151,0)` },
                    ],
                  },
                },
                data: e,
              },
            ],
          };
          S?.current?.setOption(r);
        },
        k = async (t) => {
          let { microAppId: r, dateType: i, customizeDate: a } = t;
          if (i === H.CustomizeDate && !a) return;
          let [s, c] = [
              a?.[0].format(`YYYY-MM-DD`) || U[i][0],
              a?.[1].format(`YYYY-MM-DD`) || U[i][1],
            ],
            l = {
              saasAppId: K.isEmpty(e) ? null : e,
              microAppId: r ? Number(r) : null,
              startTime: s,
              endTime: c,
            };
          b.current = l;
          let u,
            d = { 1: z, 2: j };
          (n ||
            ((d = { 1: N, 2: ee }), (l.tenantCode = K.isEmpty(o) ? null : o)),
            D(!0));
          try {
            let e = await d?.[m]?.(l);
            ((u =
              e?.success && e?.data?.length
                ? e?.data?.map((e) => [e.date, e.count])
                : X(h(s), h(c)).map((e) => [e, 0])),
              O(u, s, c));
          } finally {
            D(!1);
          }
        },
        A = () => {
          S?.current?.resize();
        };
      return (
        (0, G.useEffect)(() => {
          (T(t),
            c?.setFieldsValue({ microAppId: t?.[0]?.microAppId }),
            c?.submit());
        }, [e, t]),
        (0, G.useEffect)(
          () => (
            O(),
            window.addEventListener(`resize`, A),
            () => {
              (window.removeEventListener(`resize`, A), S?.current?.dispose());
            }
          ),
          [],
        ),
        (0, J.jsx)(d, {
          className: Z[`user-analysis-card`],
          styles: { body: { padding: 0 } },
          children: (0, J.jsxs)(l, {
            spinning: E || i,
            wrapperClassName: `${Z.container}`,
            children: [
              (0, J.jsxs)(`div`, {
                className: `${Z.title}`,
                children: [
                  (0, J.jsx)(`span`, {
                    className: `${Z.text}`,
                    children: `用户分析`,
                  }),
                  (0, J.jsx)(_, {
                    type: `link`,
                    permissions: n
                      ? v.MODEL_ANALYZE_EXPORT_EXCEL
                      : v.MODEL_ANALYZE_ADMIN_EXPORT_EXCEL,
                    onClick: async () => {
                      let e = b?.current,
                        t = { 1: L, 2: re };
                      n ||
                        ((e.tenantCode = K.isEmpty(o) ? null : o),
                        (t = { 1: I, 2: I }));
                      let r = await t[m](e),
                        i = decodeURIComponent(
                          r?.headers?.[`content-disposition`],
                        )?.split(`filename=`)?.[1],
                        a = new Blob([r.data]),
                        s = window.URL.createObjectURL(a);
                      (g(s, i), window.URL.revokeObjectURL(s));
                    },
                    children: `导出为Excel`,
                  }),
                ],
              }),
              (0, J.jsxs)(p, {
                form: c,
                onFinish: k,
                initialValues: { dateType: `1`, moreOptions: 1 },
                onValuesChange: () => {
                  c.submit();
                },
                children: [
                  (0, J.jsxs)(`div`, {
                    className: `${Z.columns}`,
                    children: [
                      (0, J.jsx)(p.Item, {
                        label: `智能体应用`,
                        name: `microAppId`,
                        children: (0, J.jsx)(r, {
                          placeholder: `请选择`,
                          options: C.map((e) => ({
                            label: e.microAppName,
                            value: e.microAppId,
                          })),
                          showSearch: !0,
                          filterOption: (e, t) =>
                            (t?.label ?? ``)
                              ?.toLowerCase()
                              ?.includes(e?.toLowerCase()),
                        }),
                      }),
                      (0, J.jsx)(p.Item, {
                        label: `日期`,
                        name: `dateType`,
                        children: (0, J.jsx)(r, {
                          placeholder: `请选择`,
                          options: V,
                        }),
                      }),
                    ],
                  }),
                  (0, J.jsxs)(`div`, {
                    className: `${Z.columns}`,
                    children: [
                      f === H.CustomizeDate &&
                        (0, J.jsx)(p.Item, {
                          label: `自定义日期`,
                          name: `customizeDate`,
                          children: (0, J.jsx)(ue, {}),
                        }),
                      (0, J.jsx)(p.Item, {
                        name: `moreOptions`,
                        children: (0, J.jsxs)(u.Group, {
                          children: [
                            (0, J.jsxs)(u, {
                              value: 1,
                              children: [
                                (0, J.jsx)(`span`, { children: `新增用户` }),
                                (0, J.jsx)(a, {
                                  title: `进行有效沟通的新增用户数。有效沟通的判定标准为用户在智能体应用中进行一次及以上的一问一答。`,
                                  children: (0, J.jsx)(s, {}),
                                }),
                              ],
                            }),
                            (0, J.jsxs)(u, {
                              value: 2,
                              children: [
                                (0, J.jsx)(`span`, { children: `活跃用户` }),
                                (0, J.jsx)(a, {
                                  title: `进行有效沟通的用户数。有效沟通的判定标准为用户在智能体应用中进行一次及以上的一问一答。`,
                                  children: (0, J.jsx)(s, {}),
                                }),
                              ],
                            }),
                          ],
                        }),
                      }),
                    ],
                  }),
                ],
              }),
              (0, J.jsx)(`div`, { ref: x, className: `${Z.chart}` }),
            ],
          }),
        })
      );
    },
  ),
  Q = {
    box: `_box_13c9p_1`,
    "toolbar-tabs-header": `_toolbar-tabs-header_13c9p_7`,
    title: `_title_13c9p_11`,
    select: `_select_13c9p_23`,
    children: `_children_13c9p_26`,
  };
c();
var $ = (e, t) =>
    String(t?.label ?? ``)
      .toLowerCase()
      .includes(e.toLowerCase()),
  fe = (e) => {
    let { isUser: t } = e,
      { userInfo: n, userInfoList: a, appId: o = null, appList: s } = y(),
      c = x(),
      [l, u] = G.useState({ value: ``, options: [], children: [] }),
      [d, p] = G.useState(!1),
      m = (0, G.useMemo)(() => {
        let e = a.map((e) => ({
          label: e.tenantName,
          value: e.tenantCode.toString(),
        }));
        return (e.unshift({ label: `所有用户`, value: `` }), e);
      }, [a]),
      h = (0, G.useMemo)(() => {
        let e = s.map((e) => ({ label: e.appName, value: e.appId }));
        return (e.unshift({ label: `所有应用`, value: `` }), e);
      }, [s, n]);
    (0, G.useEffect)(() => {
      t || c(b.APP_ID, ``);
    }, [s, t, c]);
    let g = async (e) => {
        p(!0);
        try {
          let t = await T({ userId: null, tenantCode: e });
          if (t.success)
            if ((c(b.APP_LIST, t.data), t.data.length > 0)) {
              let e = [
                {
                  microAppId: ``,
                  microAppName: `所有智能体`,
                  serviceInfoList: null,
                },
                ...t.data.map((e) => [...e.microApplicationList]).flat(),
              ];
              ((e = [...new Set(e.map((e) => JSON.stringify(e)))].map((e) =>
                JSON.parse(e),
              )),
                u({ value: ``, options: t.data, children: e }));
            } else u({ value: ``, options: [], children: [] });
        } finally {
          p(!1);
        }
      },
      _ = async () => {
        let e = await B({ pageIndex: 1, pageRows: 99999 });
        e.code === 0 && c(b.USER_INFO_LIST, e.data?.list);
      };
    ((0, G.useEffect)(() => {
      t || g(n);
    }, [n, t]),
      (0, G.useEffect)(
        () => (
          t ? v() : _(),
          () => {
            u({ value: ``, options: [], children: [] });
          }
        ),
        [t],
      ));
    let v = async () => {
        let e = await R();
        if (e.success) {
          let t = e?.data?.map((e) => ({
            label: e.appName,
            value: e.appId,
            children: e.microApplicationList,
          }));
          u((e) => ({
            ...e,
            value: t?.[0]?.value,
            options: t,
            children: t?.[0]?.children || [],
          }));
        }
      },
      C = async (e, n, r) => {
        t ? u((t) => ({ ...t, value: e, children: n?.children })) : c(r, e);
      };
    return (0, J.jsx)(S, {
      mode: `card`,
      title: `Agent分析`,
      basicListClassName: Q.box,
      headerClassName: Q[`toolbar-tabs-header`],
      children: (0, J.jsxs)(f, {
        vertical: !0,
        gap: 20,
        children: [
          (0, J.jsx)(`div`, {
            className: `${Q.title}`,
            children: t
              ? (0, J.jsxs)(J.Fragment, {
                  children: [
                    (0, J.jsx)(`p`, { children: `Agent场景：` }),
                    (0, J.jsx)(r, {
                      className: `${Q.select}`,
                      showSearch: !0,
                      placeholder: `请选择`,
                      value: l.value,
                      onChange: (e, t) => C(e, t, b.APP_ID),
                      options: l.options,
                      filterOption: $,
                    }),
                  ],
                })
              : (0, J.jsxs)(J.Fragment, {
                  children: [
                    (0, J.jsx)(`p`, { children: `用户：` }),
                    (0, J.jsx)(r, {
                      className: `${Q.select}`,
                      showSearch: !0,
                      placeholder: `请选择`,
                      value: n,
                      onChange: (e, t) => C(e, t, b.USER_INFO),
                      options: m,
                      filterOption: $,
                    }),
                    (0, J.jsx)(`p`, { children: `Agent场景：` }),
                    (0, J.jsx)(r, {
                      className: `${Q.select}`,
                      showSearch: !0,
                      placeholder: `请选择`,
                      value: o,
                      onChange: (e, t) => C(e, t, b.APP_ID),
                      options: h,
                      filterOption: $,
                    }),
                  ],
                }),
          }),
          (0, J.jsxs)(i, {
            className: `${Q.children}`,
            children: [
              (0, J.jsx)(de, {
                saasAppId: l.value,
                isUser: t,
                filterLoading: !t && d,
                children: l.children,
              }),
              (0, J.jsx)(le, {
                saasAppId: l.value,
                isUser: t,
                filterLoading: !t && d,
                children: l.children,
              }),
            ],
          }),
          (0, J.jsxs)(`div`, {
            className: `${Q.children}`,
            children: [
              (0, J.jsx)(se, {
                saasAppId: l.value,
                isUser: t,
                filterLoading: !t && d,
                children: l.children,
              }),
              (0, J.jsx)(W, {
                saasAppId: l.value,
                isUser: t,
                filterLoading: !t && d,
                children: l.children,
              }),
            ],
          }),
        ],
      }),
    });
  };
export { fe as default };
