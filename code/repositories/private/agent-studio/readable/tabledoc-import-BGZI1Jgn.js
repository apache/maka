import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  Ht as i,
  Ii as a,
  K as o,
  Kt as s,
  Pi as c,
  Qr as l,
  V as u,
  Vt as d,
  Yi as f,
  ci as p,
  dr as m,
  fn as h,
  gn as g,
  ni as _,
  or as ee,
  q as v,
  rr as y,
  sa as b,
  yr as x,
} from "./vendor-antd.QfSgOu5e.js";
import { t as S } from "./FilePreview-Bv5227i4.js";
import {
  J as C,
  Y as w,
  c as T,
  m as E,
  o as D,
  s as O,
} from "./index.B_LPe2F7.js";
import { t as k } from "./DetailLayout-139jNxZs.js";
import { t as A } from "./doc.api-VLu_TcYx.js";
import { i as j, n as M, t as N } from "./Step4-CR-3ubKb.js";
import {
  a as P,
  c as te,
  i as F,
  n as I,
  o as L,
  r as R,
  s as z,
  t as B,
} from "./Step3-CdSeCYTf.js";
var V = e(t(), 1);
d();
var H = {
    form: `_form_1gv0n_2`,
    "file-input": `_file-input_1gv0n_10`,
    upload: `_upload_1gv0n_16`,
    typography: `_typography_1gv0n_25`,
    icon: `_icon_1gv0n_29`,
    typography_text: `_typography_text_1gv0n_38`,
    "alert-wrapper": `_alert-wrapper_1gv0n_58`,
    "alert-percent": `_alert-percent_1gv0n_83`,
  },
  U = n(),
  W = 500,
  G = [`CSV`, `XLS`, `XLSX`, `PPT`, `PPTX`, `HTML`],
  K = T.filter((e) => G.includes(e.label))
    .map(({ value: e }) => `.${e}`)
    .join(`,`),
  q = O.filter((e) => G.includes(e)).join(`、`),
  J = ({ value: e, onChange: t, ...n }) => {
    let r = (e) => {
      t?.(e.fileList);
    };
    return (0, U.jsxs)(U.Fragment, {
      children: [
        (0, U.jsxs)(i.Dragger, {
          ...n,
          className: H.upload,
          maxCount: 1,
          showUploadList: !1,
          fileList: e,
          accept: K,
          beforeUpload: () => !1,
          onChange: r,
          multiple: !0,
          children: [
            (0, U.jsx)(s.Paragraph, {
              className: H.typography,
              children: (0, U.jsx)(`i`, { className: H.icon }),
            }),
            (0, U.jsx)(s.Paragraph, {
              className: H.typography_text,
              children: `将文件拖到此处或点击上传`,
            }),
            (0, U.jsxs)(s.Paragraph, {
              children: [
                `支持Excel、CSV格式文件，单个文件不超过`,
                j.tableDefault,
                `MB，每次仅支持上传一个文件`,
              ],
            }),
          ],
        }),
        (0, U.jsx)(M, { file: e, onChange: t }),
      ],
    });
  },
  ne = (0, V.forwardRef)(({ onFileChange: e }, t) => {
    let { pathname: n, state: i } = C(),
      a = w(),
      [o] = x.useForm(),
      c = x.useWatch(`file`, o),
      [u, d] = (0, V.useState)(!1),
      f = (e, t) => {
        let n = ``;
        for (let e = 0; e < t?.length; e++) {
          let r = (t[e]?.name || ``).split(`.`).pop();
          if (t[e] && !D.includes(`.${r}`)) {
            n = `请选择正确的${q}`;
            break;
          }
          if (t[e]?.size === 0) {
            n = `文件内容为空，请重新选择`;
            break;
          }
          let i = j[r] || j.tableDefault,
            a = i * 1024 * 1024;
          if (t[e]?.size > a) {
            n = `上传文件超过${i}M，请拆分后重新上传`;
            break;
          }
        }
        return n ? Promise.reject(n) : Promise.resolve();
      },
      p = async (e) => {
        let t = new FormData();
        t.append(`file`, e.file?.[0]?.originFileObj);
        let r = await te({ file: t, baseId: i?.baseId }, {}),
          o = r?.code;
        return (
          o ||
            a(n, {
              state: {
                ...i,
                record: { ...r?.data, step: 0 },
                ...r?.data,
                docList: [r?.data],
              },
              replace: !0,
            }),
          Promise.resolve({ success: !!o })
        );
      },
      m = async () => await p(await o.validateFields()),
      h = async (t) => {
        try {
          (await o.validateFields(), e?.(t));
        } catch {
          e?.([]);
        }
      };
    return (
      (0, V.useImperativeHandle)(t, () => ({ send: m }), []),
      (0, V.useEffect)(() => {
        h(c);
      }, [c]),
      (0, U.jsxs)(x, {
        form: o,
        name: `step_1`,
        className: H.form,
        onFinish: p,
        children: [
          (0, U.jsxs)(l, {
            className: `left`,
            children: [
              (0, U.jsx)(s.Title, { level: 5, children: `文件上传` }),
              (0, U.jsx)(x.Item, {
                name: `progress`,
                noStyle: !0,
                initialValue: 0,
                children: (0, U.jsx)(r, { type: `hidden` }),
              }),
              (0, U.jsx)(x.Item, {
                name: `file`,
                className: H[`file-input`],
                rules: [
                  { required: !0, message: `请选择文件` },
                  { validator: f },
                ],
                children: (0, U.jsx)(J, {}),
              }),
            ],
          }),
          (0, U.jsx)(l, {
            className: `right`,
            children: (0, U.jsx)(S, {
              loading: u,
              onLoadingChange: d,
              file: c?.[0]?.originFileObj,
              fileList: c,
              showSegmentSize: 10,
              maxStringLength: W,
              emptyText: `请先在左侧上传文件后可进行文档预览`,
              onError: (e) => o.setFieldsValue({ error: e }),
              title: (0, U.jsx)(s.Title, { level: 5, children: `文档预览` }),
            }),
          }),
        ],
      })
    );
  }),
  re = V.memo(ne),
  Y = {
    container: `_container_e77ac_1`,
    row: `_row_e77ac_7`,
    title: `_title_e77ac_16`,
    required: `_required_e77ac_19`,
    typography: `_typography_e77ac_26`,
    doc: `_doc_e77ac_30`,
    icon: `_icon_e77ac_40`,
    doc_select: `_doc_select_e77ac_43`,
  },
  X = {
    container: `_container_arl2t_1`,
    checkbox_group: `_checkbox_group_arl2t_6`,
  };
d();
var ie = (0, V.memo)(({ value: e, onChange: t }) => {
  let [n, i] = V.useState(e || []),
    a = (e) => {
      let r = n || [];
      (r?.forEach((t, n) => {
        e.includes(t.tableColumnId)
          ? (r[n] = { ...t, indexColumn: P.isIndex })
          : (r[n] = { ...t, indexColumn: P.noIndex });
      }),
        i([...r]),
        t?.([...r]));
    },
    o = (e, r) => {
      let a = n || [];
      ((a[r] = { ...a[r], columnName: e.target?.value }),
        i([...a]),
        t?.([...a]));
    },
    s = (0, V.useMemo)(
      () => n?.filter((e) => !!e?.indexColumn)?.map((e) => e?.tableColumnId),
      [n],
    );
  return (
    (0, V.useEffect)(() => {
      i(e || []);
    }, [e]),
    (0, U.jsx)(`div`, {
      className: `${X.container}`,
      children: (0, U.jsx)(_.Group, {
        onChange: a,
        value: s,
        className: X.checkbox_group,
        children: e?.map((e, t) =>
          (0, U.jsx)(
            _,
            {
              value: e?.tableColumnId,
              children: (0, U.jsx)(r, {
                defaultValue: e?.columnName,
                onChange: (e) => o(e, t),
                showCount: !0,
                maxLength: 30,
              }),
            },
            e?.tableColumnId,
          ),
        ),
      }),
    })
  );
});
d();
var Z = E.filter((e) => e.label !== `知识图谱`),
  ae = (0, V.forwardRef)(({ docInfo: e }, t) => {
    let [n] = x.useForm(),
      [r, i] = (0, V.useState)(!1),
      l = async (e) => {
        let t = e?.cloumns?.map(
          ({ tableColumnId: e, indexColumn: t, columnName: n }) => ({
            tableColumnId: e,
            indexColumn: t,
            columnName: n,
          }),
        );
        return await z(t);
      },
      d = async (t) => {
        let n = (
          await Promise.all([
            l(t),
            A.updateConfig({
              docList: [{ docId: e?.docId, docType: t.docType }],
            }),
          ])
        )?.every((e) => !e?.code);
        return Promise.resolve({ success: n });
      },
      f = async () => await d(await n.validateFields()),
      p = async () => await f(),
      h = async () => {
        i(!0);
        let t = (await L({ docId: e?.docId || 0 }))?.data || [];
        (t?.some((e) => e?.indexColumn === P.isIndex) ||
          (t[0] = { ...t?.[0], indexColumn: P.isIndex }),
          n?.setFieldValue(`cloumns`, t),
          i(!1));
      };
    return (
      (0, V.useImperativeHandle)(t, () => ({ send: f, sendNext: p }), [
        e?.docId,
      ]),
      (0, V.useEffect)(() => {
        e?.docId && h();
      }, [e?.docId]),
      (0, U.jsx)(`div`, {
        className: Y.container,
        children: (0, U.jsxs)(x, {
          form: n,
          onFinish: d,
          initialValues: { docType: e?.docType || Z[0].value },
          children: [
            (0, U.jsxs)(`div`, {
              className: Y.row,
              children: [
                (0, U.jsx)(m, { spinning: r }),
                (0, U.jsxs)(`div`, {
                  className: Y.title,
                  children: [
                    (0, U.jsxs)(`p`, {
                      className: Y.required,
                      children: [
                        `检索列：`,
                        (0, U.jsx)(c, {
                          title: `用户Query会和选中字段的内容做关键字匹配`,
                          children: (0, U.jsx)(o, {}),
                        }),
                      ],
                    }),
                    (0, U.jsx)(`p`, {
                      className: Y.required,
                      children: `列名：`,
                    }),
                  ],
                }),
                (0, U.jsx)(x.Item, {
                  name: `cloumns`,
                  children: (0, U.jsx)(ie, {}),
                }),
              ],
            }),
            (0, U.jsx)(s.Title, {
              level: 5,
              className: Y.typography,
              children: `预处理文档`,
            }),
            (0, U.jsxs)(`div`, {
              className: Y.doc,
              children: [
                (0, U.jsxs)(`span`, {
                  children: [
                    (0, U.jsx)(u, { className: Y.icon }),
                    ` `,
                    e?.docName,
                  ],
                }),
                (0, U.jsx)(x.Item, {
                  name: `docType`,
                  noStyle: !0,
                  children: (0, U.jsx)(a, {
                    className: Y.doc_select,
                    options: Z,
                  }),
                }),
              ],
            }),
          ],
        }),
      })
    );
  }),
  oe = V.memo(ae),
  Q = {
    result: `_result_ksabi_2`,
    extra: `_extra_ksabi_5`,
    "list-group": `_list-group_ksabi_10`,
    "list-group-column": `_list-group-column_ksabi_18`,
    title: `_title_ksabi_41`,
    loader: `_loader_ksabi_51`,
    l1: `_l1_ksabi_1`,
    "i-1": `_i-1_ksabi_64`,
    "i-2": `_i-2_ksabi_68`,
    "i-3": `_i-3_ksabi_73`,
    "i-4": `_i-4_ksabi_78`,
    "i-5": `_i-5_ksabi_83`,
  };
d();
var se = V.memo(({ docInfo: e, getInfo: t }) => {
    let n = w(),
      r = (0, V.useRef)(),
      i = (0, V.useMemo)(
        () =>
          [R.ProcessingCompleted].includes(e?.docStatus || R.Unprocessed) &&
          e?.step === F.Release,
        [e],
      ),
      a = async () => {
        r.current = setInterval(() => {
          t?.();
        }, 1e3);
      };
    return (
      V.useEffect(() => {
        if ((a(), e?.step === F.Fail)) {
          clearInterval(r.current);
          return;
        }
        return (
          i && clearInterval(r.current),
          () => {
            clearInterval(r.current);
          }
        );
      }, [e]),
      e?.step === F.Fail
        ? (0, U.jsx)(g, {
            className: Q.result,
            status: `error`,
            title: `文档发布失败`,
            extra: (0, U.jsxs)(`div`, {
              className: Q.extra,
              children: [
                (0, U.jsx)(`div`, {
                  className: `${Q[`list-group`]}}`,
                  children: (0, U.jsx)(b, {
                    showIcon: !0,
                    icon: (0, U.jsx)(u, {}),
                    message: (0, U.jsx)(s.Text, {
                      ellipsis: { tooltip: !0 },
                      children: e?.docName,
                    }),
                    type: `info`,
                  }),
                }),
                (0, U.jsx)(f, {
                  type: `primary`,
                  block: !0,
                  onClick: () => {
                    n(-1);
                  },
                  children: `前往文档列表 →`,
                }),
              ],
            }),
          })
        : (0, U.jsx)(N, {
            state: { ...e, _docState: i ? I.Published : I.Publishing },
            isShowSegmentInfo: !1,
          })
    );
  }),
  $ = { "steps-wrapper": `_steps-wrapper_1dhr9_2`, tabs: `_tabs_1dhr9_11` };
d();
var ce = () => {
  let e = w(),
    {
      pathname: t,
      state: { step: n, ...r },
    } = C(),
    i = (0, V.useRef)(null),
    a = (0, V.useRef)(null),
    o = (0, V.useRef)(null),
    [s, c] = V.useState(0),
    [l, u] = (0, V.useState)(!1),
    [d, m] = (0, V.useState)(!1),
    [g, _] = (0, V.useState)({}),
    [b, x] = y.useModal(),
    S = () => {
      let o = { 0: i.current?.send, 1: a.current?.sendNext },
        c = b.confirm({
          title: `提示`,
          icon: (0, U.jsx)(v, {}),
          content: `当前步骤将不可撤回，确认进入下一步吗？`,
          onOk: async () => {
            (u(!0),
              (await o[s]())?.success &&
                (D(), n && e(t, { state: { ...r }, replace: !0 })),
              u(!1),
              c.destroy());
          },
          onCancel() {
            console.log(`Cancel`);
          },
        });
    },
    T = async () => {
      (u(!0), (await a.current?.send())?.success && ee.info(`保存成功`), u(!1));
    },
    E = async () => {
      let e = b.confirm({
        title: `提示`,
        icon: (0, U.jsx)(v, {}),
        content: `确定要发布吗？`,
        onOk: async () => {
          (u(!0),
            (await o.current?.send())?.success && D(),
            u(!1),
            e.destroy());
        },
        onCancel() {
          console.log(`Cancel`);
        },
      });
    },
    D = V.useCallback(async () => {
      if (!r?.docId) return;
      let e = (await A.queryBaseInfo({ docId: r.docId }, {}))?.data || {},
        t = 1;
      switch (e?.step) {
        case F.UploadStatus:
          c(0);
          break;
        case F.Segmentation:
        case F.Label:
        case F.DocumentReview:
          (e?.docStatus === R.ProcessingCompleted && (t = 2), c(t));
          break;
        case F.Release:
        case F.ReleasedAndUnderRevision:
          c(3);
          break;
        case F.Fail:
          c(3);
          break;
        default:
          break;
      }
      (n && c(Number(n)), _({ ...e }));
    }, [r.docId, g, n]),
    O = [
      {
        key: `0`,
        title: `文档上传`,
        label: ``,
        children: (0, U.jsx)(re, {
          ref: i,
          onFileChange: (e) => {
            m(!!e?.length);
          },
        }),
      },
      {
        key: `1`,
        title: `表结构配置`,
        label: ``,
        children: (0, U.jsx)(oe, { docInfo: g, ref: a }),
      },
      {
        key: `2`,
        title: `预览`,
        label: ``,
        children: (0, U.jsx)(B, { getInfo: D, docInfo: g, ref: o }),
      },
      {
        key: `3`,
        title: `处理并发布`,
        label: ``,
        children: (0, U.jsx)(se, { getInfo: D, docInfo: g }),
      },
    ];
  return (
    (0, V.useEffect)(() => {
      r?.docId && D();
    }, [r?.docId, n]),
    (0, U.jsxs)(k, {
      title: `查看与编辑表结构配置`,
      showBack: !0,
      onBack: () => e(-1),
      footerButtons: (0, V.useMemo)(() => {
        let t = [];
        return (
          [3].includes(Number(s)) ||
            t.push(
              (0, U.jsx)(
                f,
                { onClick: () => e(-1), children: `取消` },
                `cancel`,
              ),
            ),
          [1].includes(Number(s)) &&
            t.push(
              (0, U.jsx)(
                f,
                { type: `primary`, onClick: T, loading: l, children: `保存` },
                `save`,
              ),
            ),
          [0, 1].includes(Number(s)) &&
            t.push(
              (0, U.jsx)(
                f,
                {
                  type: `primary`,
                  onClick: S,
                  loading: l,
                  disabled: s === 0 && !d,
                  children: `下一步`,
                },
                `next`,
              ),
            ),
          [2].includes(Number(s)) &&
            t.push(
              (0, U.jsx)(
                f,
                {
                  type: `primary`,
                  loading: l,
                  onClick: E,
                  children: `确定并发布`,
                },
                `release`,
              ),
            ),
          t.length > 0 ? t : void 0
        );
      }, [s, l, d, e, T, S, E]),
      footerAlign: `right`,
      children: [
        (0, U.jsx)(`div`, {
          className: $[`steps-wrapper`],
          children: (0, U.jsx)(h, { current: s, items: O }),
        }),
        (0, U.jsx)(p, {
          className: $.tabs,
          items: O,
          activeKey: String(s),
          renderTabBar: () => (0, U.jsx)(U.Fragment, {}),
        }),
        x,
      ],
    })
  );
};
export { ce as default };
