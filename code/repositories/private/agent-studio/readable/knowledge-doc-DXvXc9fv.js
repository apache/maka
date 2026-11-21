import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Ei as r,
  Hi as i,
  K as a,
  Vt as o,
  Yi as s,
  or as c,
  rr as l,
} from "./vendor-antd.QfSgOu5e.js";
import { r as u } from "./fileUtils-BjWnOXhL.js";
import { n as d, r as f } from "./numberUtils-Bo2mH4mp.js";
import { c as p } from "./knowledge-B15iS6D5.js";
import { t as m } from "./AgentTable-DMLUccn2.js";
import {
  G as h,
  J as g,
  K as _,
  St as v,
  Tt as y,
  Y as b,
  _ as x,
  c as S,
  v as C,
} from "./index.B_LPe2F7.js";
import { t as w } from "./ListLayout-B8lj_6O3.js";
import { t as T } from "./components2-DnLGrzOm.js";
import { t as E } from "./doc.api-VLu_TcYx.js";
import { n as ee, t as te } from "./onDeployConfirm-LfJr7a5N.js";
var D = e(t(), 1);
o();
var O = (e, t, n) =>
    n
      ? 5
      : e < 4
        ? 1
        : e === 4
          ? t === 2
            ? 3
            : 2
          : e === 5
            ? 3
            : e === 6
              ? 4
              : 1,
  ne = (e, t) => {
    let n = e.createTime || e.modifyTime,
      r = Object.keys(e)[0];
    return r ? { ...t, column: r, isAsc: n !== `descend` } : t;
  },
  re = (e, t) => {
    let n = !1;
    return {
      list: e.map((e, r) => {
        let i = O(e.step, e.docStatus, t),
          a = { ...e, _docState: i, _index: r + 1 };
        return (!n && i === 2 && (n = !0), a);
      }),
      hasPublishing: n,
    };
  },
  ie = (e, t, n) => {
    let r = e;
    return (r === 5 && (r = n ? 5 : 3), t === 7 ? t : r);
  },
  ae = (e, t) => Math.floor((e / t) * 100) || 0,
  k = n(),
  A = [{ label: `全部`, value: 0 }, ...x.slice(0, 5)],
  j = [{ label: `全部`, value: 0 }, ...x.slice(0, 4)],
  M = 8 * 1e3,
  N = `1120`,
  oe = `1121`,
  se = (e) =>
    e ? y.AGENT_KNOWLEDGE_TABLEDOC_IMPORT : y.AGENT_KNOWLEDGE_DOC_IMPORT,
  P = (e, t) =>
    t
      ? [3, 4].includes(e._docState ?? 0)
        ? y.AGENT_KNOWLEDGE_TABLEDOC_DETAIL
        : y.AGENT_KNOWLEDGE_TABLEDOC_IMPORT
      : e._docState === 1
        ? y.AGENT_KNOWLEDGE_DOC_IMPORT
        : y.AGENT_KNOWLEDGE_DOC_IMPORT_DETAILS,
  F = (0, D.memo)(
    ({
      name: e,
      baseId: t,
      refs: n,
      baseType: o,
      onViewStepMsg: x,
      onPlatformTypeChange: w,
      onLoadingChange: O,
    }) => {
      let F = e === `draft`,
        { state: I } = g(),
        L = I ?? null,
        R = b(),
        [z, B] = (0, D.useState)(!1),
        V = (0, D.useRef)(!1),
        H = (0, D.useRef)(null),
        U = (0, D.useRef)(null),
        W = (0, D.useRef)(),
        [G, ce] = (0, D.useState)(null),
        K = (0, D.useCallback)(
          async (e) => {
            H.current && window.clearTimeout(H.current);
            let n = {
              ...e,
              name:
                typeof e.name == `string`
                  ? e.name
                  : typeof e.docName == `string`
                    ? e.docName
                    : void 0,
              baseId: e.baseId ?? t,
              status: F ? 5 : e.status,
            };
            V.current || (B(!0), O?.(!0));
            try {
              let e = await p({ ...n, baseId: String(n.baseId ?? ``) }),
                t = !1,
                r = [];
              if (e.code === 0) {
                let n = e.data || [];
                v(U.current) && (U.current = n.length === 0);
                let i = re(n, F);
                if (
                  ((r = i.list),
                  (t = i.hasPublishing),
                  r.length > 0 && G === null)
                ) {
                  let e = r[0].platformType ?? null;
                  (ce(e), w?.(e));
                }
              } else t = V.current;
              return (
                t &&
                  e.code !== h.CancelStatusCode &&
                  (H.current = setTimeout(() => {
                    ((V.current = !0), W.current?.reload());
                  }, M)),
                { data: r, success: !0 }
              );
            } catch {
              return (
                V.current || c.error(`获取文档列表失败`),
                { data: [], success: !0 }
              );
            } finally {
              (B(!1), O?.(!1));
            }
          },
          [t, F],
        ),
        q = (0, D.useCallback)(() => {
          ((n.current[e].refresh = !0), (V.current = !1), W.current?.reload());
        }, [e, n]),
        J = (0, D.useCallback)(
          (e) =>
            new Promise((t) => {
              l.confirm({
                title: `提示`,
                icon: (0, k.jsx)(a, {}),
                content: `确定要发布吗？`,
                onOk: async () => {
                  let n = (t) => {
                      R(P(e, 0), {
                        state: { ...L, sensitiveWords: t, docId: e.docId },
                      });
                    },
                    r = await {
                      0: () =>
                        te(e.docId, !0, q, n, [
                          { docId: e.docId, docName: e.docName },
                        ]),
                      1: () => ee(e.docId, { _hidden: !1 }, [e.docId]),
                    }[o || 0]();
                  (r.code === 0 && q(), t(r));
                },
              });
            }),
          [o, q, R, L],
        ),
        Y = (0, D.useCallback)(
          (e) => {
            l.confirm({
              title: `删除`,
              icon: (0, k.jsx)(a, {}),
              content: `确定要删除文档「${e.docName}」吗？删除后不可恢复。`,
              okText: `确认`,
              cancelText: `取消`,
              onOk: async () => {
                (await (F ? E.deleteDraft : E.delete)({ docId: e.docId }))
                  .code === 0 && (c.success(`删除成功`), q());
              },
            });
          },
          [q, F],
        ),
        X = (0, D.useCallback)(
          (e) => {
            l.confirm({
              title: `下架`,
              icon: (0, k.jsx)(a, {}),
              content: `确定要下架文档「${e.docName}」吗？`,
              okText: `确认`,
              cancelText: `取消`,
              onOk: async () => {
                let t = await E.unline({ docId: e.docId });
                return (t.code === 0 && (c.success(`下架成功`), q()), t);
              },
            });
          },
          [q],
        ),
        Z = (0, D.useCallback)(async (e) => {
          try {
            u((await E.queryLoadFile({ docId: e.docId }, {})).data, e.docName);
          } catch {
            c.error(`下载失败，请稍后重试`);
          }
        }, []),
        Q = (0, D.useCallback)(
          async (e) => {
            let t;
            try {
              let { code: n, data: r } = await E.queryBaseInfo(
                { docId: e.docId },
                { _hidden: !0 },
              );
              t = n === 0 ? r?.step : void 0;
            } catch {}
            R(P(e, o), {
              state: { ...L, docId: e.docId, baseType: o, record: e, step: t },
            });
          },
          [o, R, L],
        ),
        $ = (0, D.useCallback)(
          (e) => {
            R(y.AGENT_KNOWLEDGE_TABLEDOC_IMPORT, {
              state: { ...L, docId: e.docId, baseType: o, record: e, step: 1 },
            });
          },
          [o, R, L],
        ),
        le = (0, D.useMemo)(
          () => [
            {
              dataIndex: `docName`,
              title: `文档名称`,
              width: 210,
              ellipsis: !0,
              render: (e, t) =>
                (0, k.jsxs)(`span`, {
                  style: {
                    display: `inline-flex`,
                    alignItems: `center`,
                    gap: 8,
                  },
                  children: [
                    (0, k.jsx)(`img`, {
                      src: `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/${(() => {
                        let e =
                            typeof t.extension == `string` ? t.extension : ``,
                          n = (t.docName || ``).split(`.`).pop() || ``,
                          r = (e || n || ``).toLowerCase();
                        return [`doc`, `docx`].includes(r)
                          ? `file-word.svg`
                          : [`ppt`, `pptx`].includes(r)
                            ? `file-ppt.svg`
                            : [`xls`, `xlsx`, `csv`].includes(r)
                              ? `file-excel.svg`
                              : [`txt`, `html`, `md`].includes(r)
                                ? `file-text.svg`
                                : [`pdf`].includes(r)
                                  ? `file-ppf.png`
                                  : `doc-icon@2x.png`;
                      })()}`,
                      alt: `文档`,
                      style: { width: 20, height: 20, flexShrink: 0 },
                    }),
                    t.docName,
                  ],
                }),
            },
            {
              hideInTable: !0,
              title: `文档类型`,
              dataIndex: `extension`,
              valueType: `select`,
              fieldProps: { options: S, style: { minWidth: 120 } },
            },
            {
              dataIndex: `charSize`,
              title: `字符数`,
              hideInSearch: !0,
              width: 120,
              ellipsis: !0,
              render: (e, t) =>
                d(o ? t.excelCharSize || 0 : t.charSize || 0) || `-`,
            },
            {
              dataIndex: `rowNum`,
              title: `行数`,
              hideInSearch: !0,
              width: 120,
              hideInTable: !o,
            },
            {
              dataIndex: `segmentCount`,
              title: `段落数`,
              hideInSearch: !0,
              width: 120,
              hideInTable: !!o,
              render: (e, t) => f(t.segmentCount ?? 0) ?? `-`,
            },
            {
              dataIndex: `createTime`,
              title: `上传时间`,
              hideInSearch: !0,
              width: 180,
              sorter: !0,
            },
            {
              dataIndex: `modifyTime`,
              title: `最新编辑`,
              hideInSearch: !0,
              width: 180,
              sorter: !0,
            },
            {
              dataIndex: `status`,
              title: `状态`,
              width: 120,
              render: (e, t) => {
                let { label: n, status: i } =
                  C[ie(t._docState || 0, t.step, F)] || {};
                return (0, k.jsxs)(k.Fragment, {
                  children: [
                    (0, k.jsx)(r, { status: i, text: n }),
                    i === `warning` && !o && t.segmentCount
                      ? (0, k.jsxs)(`span`, {
                          children: [
                            `（`,
                            `${ae(t.segmentDeployedCount || 0, t.segmentCount)}%`,
                            `）`,
                          ],
                        })
                      : null,
                  ],
                });
              },
              hideInSearch: F,
              valueType: `select`,
              fieldProps: {
                options: G === 0 && o === 0 ? j : A,
                allowClear: !1,
                style: { minWidth: 120 },
              },
            },
            {
              dataIndex: `stepMsg`,
              title: `异常信息`,
              hideInSearch: !0,
              width: 180,
              render: (e, t) =>
                t.stepMsg
                  ? (0, k.jsx)(s, {
                      type: `link`,
                      onClick: () => x?.(t.stepMsg),
                      children: `查看`,
                    })
                  : `-`,
            },
            {
              dataIndex: `action`,
              title: `操作`,
              valueType: `option`,
              width: 180,
              fixed: `right`,
              actionButtons: (e) => {
                let t = e._docState === 2 || (!F && e.step === 5),
                  n = [1, 4, 5].includes(e._docState || 0),
                  r = e.platformType === 0 && o === 0;
                return [
                  {
                    key: `edit`,
                    menuCode: e._docState === 1 ? N : oe,
                    label: `查看与编辑`,
                    disabled: t,
                    onClick: () => Q(e),
                  },
                  {
                    key: `release`,
                    menuCode: `1122`,
                    label: `发布`,
                    disabled: !n || r,
                    onClick: () => J(e),
                  },
                  {
                    key: `remove`,
                    menuCode: `1123`,
                    label: `删除`,
                    disabled: !n || r,
                    onClick: () => Y(e),
                  },
                  {
                    key: `offline`,
                    menuCode: `1124`,
                    label: `下架`,
                    disabled: e._docState !== 3 || r,
                    onClick: () => X(e),
                  },
                  {
                    key: `download`,
                    menuCode: `1124`,
                    label: `下载`,
                    onClick: () => Z(e),
                  },
                  {
                    key: `tableConfig`,
                    hidden: !o,
                    menuCode: `1124`,
                    label: `表结构配置`,
                    disabled: t,
                    onClick: () => $(e),
                  },
                ];
              },
            },
          ],
          [o, G, Y, J, Z, X, $, Q, F, x],
        ),
        ue = (0, D.useCallback)(
          async (e, n) => K({ ...ne(n, e), baseId: t }),
          [t, K],
        ),
        de = (0, D.useMemo)(
          () =>
            F
              ? void 0
              : {
                  emptyText: (0, k.jsx)(i, {
                    image: i.PRESENTED_IMAGE_SIMPLE,
                    description: (0, k.jsxs)(k.Fragment, {
                      children: [
                        `暂无数据`,
                        U.current
                          ? (0, k.jsxs)(T, {
                              menuCode: N,
                              children: [
                                `，`,
                                (0, k.jsx)(_, {
                                  className: `global-primary-color`,
                                  to: se(o),
                                  state: L,
                                  children: `去导入`,
                                }),
                              ],
                            })
                          : null,
                      ],
                    }),
                  }),
                },
          [o, F, L],
        );
      return (
        (0, D.useEffect)(
          () => () => {
            H.current && window.clearTimeout(H.current);
          },
          [],
        ),
        (0, D.useEffect)(() => {
          W.current?.reload();
        }, [e]),
        (0, k.jsx)(m, {
          columns: le,
          loading: z,
          request: ue,
          className: `layout-content-scroll`,
          rowKey: `docId`,
          style: { paddingTop: 0, marginTop: `16px` },
          form: { initialValues: { status: 0 } },
          actionRef: W,
          scrollY: { type: `flex` },
          locale: de,
        })
      );
    },
  ),
  I = { "log-body": `_log-body_1kpfh_1` };
o();
var L = { WIDTH: 720, TITLE: `异常日志` },
  R = (0, D.forwardRef)((e, t) => {
    let [n, r] = (0, D.useState)(!1),
      [i, a] = (0, D.useState)(``),
      o = (0, D.useCallback)(() => {
        r(!1);
      }, []);
    return (
      (0, D.useImperativeHandle)(
        t,
        () => ({
          open: (e) => {
            (a(e), r(!0));
          },
          close: o,
        }),
        [o],
      ),
      (0, k.jsx)(l, {
        title: L.TITLE,
        open: n,
        onCancel: o,
        footer: null,
        width: L.WIDTH,
        destroyOnClose: !0,
        children: (0, k.jsx)(`pre`, { className: I[`log-body`], children: i }),
      })
    );
  });
((R.displayName = `StepMsgModal`), o());
var z = (0, D.memo)(() => {
  let e = (0, D.useRef)(null),
    [t, n] = (0, D.useState)(null),
    [r, i] = (0, D.useState)(!0),
    { state: a } = g(),
    o = b(),
    c = (0, D.useRef)({
      list: { refresh: !1, callback: null },
      draft: { refresh: !1, callback: null },
    }),
    { baseId: l = ``, baseType: u = 0, baseName: d = `` } = a || {},
    f = a?._tab || `list`;
  return (0, k.jsx)(w, {
    mode: `list`,
    title: d,
    showBack: !0,
    extra: (0, D.useMemo)(
      () => [
        u
          ? (0, k.jsx)(
              T,
              {
                menuCode: `1120`,
                children: (0, k.jsx)(_, {
                  to: y.AGENT_KNOWLEDGE_TABLEDOC_IMPORT,
                  state: a,
                  children: (0, k.jsx)(s, {
                    type: `primary`,
                    disabled: r || (t === 0 && u === 0),
                    children: `知识导入`,
                  }),
                }),
              },
              `1120`,
            )
          : (0, k.jsx)(
              T,
              {
                menuCode: `1120`,
                children: (0, k.jsx)(_, {
                  to: y.AGENT_KNOWLEDGE_DOC_IMPORT,
                  state: a,
                  children: (0, k.jsx)(s, {
                    type: `primary`,
                    disabled: r || (t === 0 && u === 0),
                    children: `知识导入`,
                  }),
                }),
              },
              `1120`,
            ),
      ],
      [u, a, t, r],
    ),
    onBack: () => o(y.AGENT_KNOWLEDGE, { state: { checkTabs: a?.checkTabs } }),
    children: (0, k.jsxs)(k.Fragment, {
      children: [
        (0, k.jsx)(F, {
          baseType: u,
          baseId: l,
          refs: c,
          name: f,
          onViewStepMsg: (0, D.useCallback)((t) => {
            e.current?.open(t);
          }, []),
          onPlatformTypeChange: n,
          onLoadingChange: i,
        }),
        (0, k.jsx)(R, { ref: e }),
      ],
    }),
  });
});
export { z as default };
