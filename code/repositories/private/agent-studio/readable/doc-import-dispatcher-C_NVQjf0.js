import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Ar as r,
  Br as i,
  Er as a,
  F as o,
  Hi as s,
  Ht as c,
  Ii as l,
  K as u,
  Kr as d,
  Kt as f,
  Or as p,
  Pi as m,
  Qr as h,
  Rr as g,
  V as _,
  Vt as v,
  Yi as y,
  Z as b,
  at as x,
  b as S,
  ci as ee,
  fi as C,
  fn as te,
  gn as w,
  hn as T,
  j as E,
  or as D,
  ot as O,
  q as k,
  rr as ne,
  sa as A,
  ut as j,
  yr as M,
} from "./vendor-antd.QfSgOu5e.js";
import { _ as N, h as re, n as ie } from "./knowledge-B15iS6D5.js";
import { t as P } from "./oss-Cy14UKhC.js";
import { t as ae } from "./TooltipEllipsis-4_dXZz0S.js";
import { t as F } from "./FilePreview-Bv5227i4.js";
import {
  G as oe,
  J as se,
  K as ce,
  St as I,
  W as L,
  Y as le,
  a as R,
  m as z,
  o as B,
  s as ue,
  u as V,
} from "./index.B_LPe2F7.js";
import { t as de } from "./DetailLayout-139jNxZs.js";
import { t as H } from "./doc.api-VLu_TcYx.js";
import { n as fe } from "./SegmentEditModal-i88UFvxt.js";
import { r as pe, t as me } from "./components-CQ-Egcqn.js";
import { t as he } from "./Step3-DvfNQyiz.js";
import { r as ge, t as _e } from "./Step4-CR-3ubKb.js";
import { t as ve } from "./onDeployConfirm-LfJr7a5N.js";
var U = e(t(), 1);
v();
var W = n(),
  G = {
    modal: `_modal_1yb8n_1`,
    loading: `_loading_1yb8n_1`,
    wrapper: `_wrapper_1yb8n_19`,
    tip: `_tip_1yb8n_23`,
    header: `_header_1yb8n_27`,
    body: `_body_1yb8n_37`,
    space: `_space_1yb8n_42`,
    doc_name: `_doc_name_1yb8n_46`,
    icon: `_icon_1yb8n_49`,
    title: `_title_1yb8n_52`,
    footer: `_footer_1yb8n_55`,
  };
function ye({ total: e = [], data: t = [], closed: n, to: r, docList: i }) {
  let [o, c] = (0, U.useState)(0),
    l = [
      { title: `序号`, dataIndex: `index`, align: `center`, width: 80 },
      { title: `敏感词`, dataIndex: `word`, width: 160, tooltip: !0 },
      { title: `所属片段位置`, dataIndex: `position`, tooltip: !0 },
    ],
    u = U.useMemo(
      () => [...(i || [])].map((e, t) => ({ label: e.docName, key: t })),
      [i],
    );
  return (0, W.jsxs)(W.Fragment, {
    children: [
      (0, W.jsxs)(`div`, {
        className: G.header,
        children: [
          (0, W.jsx)(f.Title, { level: 5, children: `敏感词` }),
          (0, W.jsx)(x, { onClick: n }),
        ],
      }),
      (0, W.jsxs)(`div`, {
        className: G.body,
        children: [
          u?.length > 1
            ? (0, W.jsx)(a, {
                menu: {
                  items: u,
                  onClick: ({ key: e }) => {
                    c(Number(e));
                  },
                },
                trigger: [`click`],
                children: (0, W.jsxs)(p, {
                  className: G.space,
                  children: [
                    (0, W.jsx)(`h3`, {
                      className: G.doc_name,
                      children: i[o]?.docName,
                    }),
                    (0, W.jsx)(b, { className: G.icon }),
                  ],
                }),
              })
            : (0, W.jsx)(`h3`, { className: G.title, children: i[o]?.docName }),
          r
            ? (0, W.jsx)(f.Paragraph, {
                children: (0, W.jsx)(A, {
                  message: (0, W.jsxs)(W.Fragment, {
                    children: [
                      `当前文档存在敏感词，您可前往`,
                      ` `,
                      (0, W.jsx)(f.Link, {
                        onClick: () => r(),
                        children: `查看与编辑`,
                      }),
                      ` `,
                      `页进行修改及发布`,
                    ],
                  }),
                  type: `warning`,
                  showIcon: !0,
                  banner: !0,
                }),
              })
            : null,
          (0, W.jsxs)(f.Paragraph, {
            children: [
              `当前共检测出`,
              (0, W.jsxs)(f.Text, {
                type: `danger`,
                children: [` `, t[o].length, ` `],
              }),
              `个敏感词，`,
              e?.[o] > 0
                ? (0, W.jsxs)(W.Fragment, {
                    children: [
                      `出现`,
                      (0, W.jsxs)(f.Text, {
                        type: `danger`,
                        children: [` `, e?.[o], ` `],
                      }),
                      `次，`,
                    ],
                  })
                : ``,
              `请重新修改审查，确保文档中不包含敏感词后再发布`,
            ],
          }),
          (0, W.jsx)(
            me,
            {
              columns: l,
              dataSource: t[o],
              pagination: {
                size: `middle`,
                showSizeChanger: !1,
                showQuickJumper: !1,
              },
              locale: {
                emptyText: (0, W.jsx)(s, {
                  image: s.PRESENTED_IMAGE_SIMPLE,
                  description: `暂无数据`,
                }),
              },
            },
            o,
          ),
        ],
      }),
    ],
  });
}
function be({ docId: e, callback: t, closed: n, ids: r }) {
  let [i, a] = (0, U.useState)(!1);
  return (0, W.jsx)(`div`, {
    className: G.footer,
    children: (0, W.jsx)(y, {
      type: `primary`,
      loading: i,
      onClick: async () => {
        a(!0);
        let { code: i } = await Se(e, { _hidden: !1 }, r);
        if (i === 0) {
          (n && n(), typeof t == `function` && t());
          return;
        }
        a(!1);
      },
      children: `仍要发布`,
    }),
  });
}
async function xe(e, t = !0, n, r, i) {
  if (I(e)) return { code: -1, msg: `参数异常，请刷新重试` };
  let a = ne.confirm({
      title: null,
      icon: null,
      closable: !1,
      width: 300,
      wrapClassName: G.modal,
      zIndex: 1060,
      content: (0, W.jsxs)(`div`, {
        className: G.wrapper,
        children: [
          (0, W.jsx)(`div`, {
            className: G.loading,
            children: (0, W.jsx)(E, {}),
          }),
          (0, W.jsx)(`div`, { className: G.tip, children: `敏感词检测中···` }),
        ],
      }),
    }),
    o = i?.map((e) => e?.docId),
    s = await H.checkedSensitive({ docIds: o }, { _hidden: !0 });
  if (s.code !== 0)
    return (
      a.update({
        content: (0, W.jsxs)(W.Fragment, {
          children: [
            (0, W.jsxs)(`div`, {
              className: G.header,
              children: [
                (0, W.jsx)(f.Title, { level: 5, children: `敏感词检测结果` }),
                (0, W.jsx)(x, { onClick: () => a.destroy() }),
              ],
            }),
            (0, W.jsxs)(`div`, {
              className: G.wrapper,
              children: [
                (0, W.jsx)(f.Text, {
                  className: G.loading,
                  type: `danger`,
                  children: (0, W.jsx)(O, {}),
                }),
                (0, W.jsx)(`div`, {
                  className: G.tip,
                  children: s.msg || `敏感词检测失败，请重试`,
                }),
              ],
            }),
          ],
        }),
      }),
      { ...s }
    );
  let c = [],
    l = [],
    u = {};
  if (s?.code === 0) {
    let { data: d } = s;
    if (d?.some((e) => e?.count)) {
      c = d?.map(
        (e, t) => (
          (l[t] = 0),
          Object.keys(e?.keys).map((n, r) => {
            let i = e?.keys[n] || [];
            return (
              (l[t] += i.length),
              {
                key: String(r + 1),
                word: n,
                list: i,
                index: r + 1,
                position: i
                  .map((e) => {
                    let t = String(e);
                    return (
                      u[t] || (u[t] = []),
                      u[t].push(n),
                      `#` + `${e + 1}`.padStart(3, `0`)
                    );
                  })
                  .join(`、`),
              }
            );
          })
        ),
      );
      let s = () => {
          a && a.destroy();
        },
        f = null;
      return (
        r &&
          (f = () => {
            (s(), r({ result: c, map: u }));
          }),
        a.update({
          width: 800,
          maskClosable: !0,
          content: (0, W.jsxs)(W.Fragment, {
            children: [
              (0, W.jsx)(ye, {
                total: l,
                data: c,
                docList: i,
                closed: s,
                to: f,
              }),
              t
                ? (0, W.jsx)(be, { docId: e, callback: n, closed: s, ids: o })
                : null,
            ],
          }),
        }),
        { code: 101, result: c, total: l, map: u, modal: a }
      );
    }
  }
  if (!t)
    return (
      a.update({
        content: (0, W.jsxs)(`span`, {
          children: [
            (0, W.jsx)(j, { style: { marginRight: 8, color: `#52c41a` } }),
            `没有检测到敏感词, 正在发布`,
          ],
        }),
      }),
      new Promise((e) => {
        setTimeout(() => {
          (a.destroy(), e({ code: 0, modal: a }));
        }, 3e3);
      })
    );
  a.update({
    content: (0, W.jsxs)(`span`, {
      children: [
        (0, W.jsx)(j, { style: { marginRight: 8, color: `#52c41a` } }),
        `没有检测到敏感词, 正在发布`,
      ],
    }),
  });
  let { code: d, msg: p } = await Se(e, { _hidden: !0 }, o);
  return d === 0
    ? new Promise((e) => {
        setTimeout(() => {
          (a.destroy(), e({ code: d, modal: a }));
        }, 3e3);
      })
    : (a.update({
        closable: !0,
        content: (0, W.jsxs)(`div`, {
          className: G.wrapper,
          children: [
            (0, W.jsx)(f.Text, {
              className: G.loading,
              type: `danger`,
              children: (0, W.jsx)(O, {}),
            }),
            (0, W.jsx)(`div`, { className: G.tip, children: p }),
          ],
        }),
      }),
      { code: d, result: c, total: l, map: u, modal: a });
}
var Se = async (e, t, n) => {
    if (I(e)) return { code: -1, msg: `参数异常，请刷新重试` };
    let r = await H.deploy({ docIds: n }, { _hidden: !0 });
    return (
      r.code === 0
        ? D.success(`发布操作成功`)
        : !t && D.error(r.msg || `发布失败，请重试`),
      r
    );
  },
  Ce = { 0: `文本`, 1: `表格`, 2: `问答` };
v();
function we({ disabled: e, className: t = ``, ...n }) {
  return (0, W.jsx)(C.Group, {
    ...n,
    className: [`global-radio-box-hidden`, t].join(` `),
    disabled: e,
    children: (0, W.jsx)(T, {
      gutter: [16, 0],
      children: V.map((t) =>
        (0, W.jsx)(
          h,
          {
            span: e ? 24 : 12,
            children: (0, W.jsx)(C, {
              value: t.value,
              children: (0, W.jsxs)(T, {
                wrap: !1,
                children: [
                  (0, W.jsx)(h, {
                    className: `global-radio-icon`,
                    children: (0, W.jsx)(`img`, { src: t.icon, alt: `` }),
                  }),
                  (0, W.jsxs)(h, {
                    flex: 1,
                    children: [
                      (0, W.jsx)(f.Title, { level: 5, children: t.label }),
                      (0, W.jsx)(f.Text, { children: t.tooltip }),
                    ],
                  }),
                ],
              }),
            }),
          },
          t.value,
        ),
      ),
    }),
  });
}
function Te({ disabled: e }) {
  return (0, W.jsxs)(W.Fragment, {
    children: [
      (0, W.jsx)(M.Item, {
        noStyle: !0,
        name: `baseId`,
        children: (0, W.jsx)(i, { type: `hidden` }),
      }),
      (0, W.jsx)(M.Item, {
        name: `name`,
        label: `名称`,
        rules: [
          R.required,
          R.whitespace,
          R.textReg,
          { type: `string`, max: 10, message: `最多可输入10个字符` },
          { type: `string`, min: 3, message: `至少输入3个字符` },
        ],
        children: (0, W.jsx)(i, {
          placeholder: `3-10字以内，支持中英文、数字、中/下划线`,
        }),
      }),
      (0, W.jsx)(M.Item, {
        name: `baseType`,
        label: `类型`,
        rules: [R.selectRequired],
        children: (0, W.jsx)(l, {
          disabled: e,
          options: Object.keys(Ce).map((e) => ({
            label: Ce[e] + `类型`,
            value: Number(e),
          })),
          placeholder: `请选择类型`,
        }),
      }),
      (0, W.jsx)(M.Item, {
        name: `describe`,
        label: `描述`,
        rules: [
          R.required,
          R.whitespace,
          {
            type: `string`,
            max: 500,
            message: `已超限制字数，请删减后重新输入`,
          },
        ],
        children: (0, W.jsx)(i.TextArea, {
          className: `global-textarea-show-count`,
          placeholder: `请描述创建目的、修改内容等，500字以内`,
          showCount: { formatter: (e) => `${e?.count ?? 0}/500` },
          autoSize: { minRows: 6, maxRows: 8 },
        }),
      }),
      (0, W.jsx)(M.Item, {
        noStyle: !0,
        shouldUpdate: !0,
        children: ({ getFieldValue: t }) => {
          let n = t(`baseType`) || Object.keys(Ce)[0];
          return Number(n) === Number(Object.keys(Ce)[1])
            ? null
            : (0, W.jsxs)(M.Item, {
                label: `向量化方式`,
                required: !0,
                children: [
                  e
                    ? null
                    : (0, W.jsx)(A, {
                        message: `创建知识库后，向量化方式将不可修改`,
                        showIcon: !0,
                        type: `warning`,
                        style: { marginBottom: 10 },
                      }),
                  (0, W.jsx)(M.Item, {
                    name: `embedType`,
                    initialValue: 1,
                    noStyle: !0,
                    children: (0, W.jsx)(we, { disabled: e }),
                  }),
                ],
              });
        },
      }),
    ],
  });
}
U.memo(Te);
var K = {
  form: `_form_y13s8_2`,
  "separation-wrapper": `_separation-wrapper_y13s8_13`,
  "doc-type": `_doc-type_y13s8_24`,
  "segment-container": `_segment-container_y13s8_36`,
  "segment-result": `_segment-result_y13s8_42`,
  "segment-count": `_segment-count_y13s8_50`,
  segments: `_segments_y13s8_56`,
};
v();
var Ee = [`csv`, `xls`, `xlsx`, `zip`],
  De = `https://ai-copilot.cos.clife.cn/web-agent-paas/`,
  Oe = [
    {
      value: 0,
      label: `自动分段`,
      tooltip: `自动设置分段规则，如果不了解各参数建议选择此项`,
      icon: `${De}static/images/kg/doc_segment_type-1@2x.png`,
    },
    {
      value: 2,
      label: `按章节切片`,
      tooltip: `根据文章的章节进行切片 （仅支持PDF）`,
      icon: `${De}static/images/kg/doc_segment_type-1@2x.png`,
    },
    {
      value: 1,
      label: `自定义`,
      tooltip: `自定义分段规则，分段长度等参数。csv、xls、xlsx、zip 类型文档分段策略仍为自动分段，不支持自定义分段`,
      icon: `${De}static/images/kg/doc_segment_type-2@2x.png`,
    },
  ],
  ke = U.memo(() => {
    let e = M.useFormInstance(),
      t = M.useWatch(`segmentType`, e);
    return (0, W.jsxs)(`div`, {
      className: K[`separation-wrapper`],
      hidden: [0, 2].includes(t),
      children: [
        (0, W.jsx)(M.Item, {
          name: `docSeparator`,
          label: `分段标识符`,
          initialValue: `\\n`,
          colon: !0,
          rules: R.default.input,
          children: (0, W.jsx)(i, { placeholder: `请输入分段标识符` }),
        }),
        (0, W.jsx)(M.Item, {
          name: `minLength`,
          label: `最小切片字符数`,
          colon: !0,
          rules: [
            { required: !0, message: `请输入最小切片字符数` },
            {
              max: 1e4,
              min: 50,
              type: `number`,
              message: `最小切片字符数区间50~10000`,
            },
          ],
          children: (0, W.jsx)(d, {
            placeholder: `请输入最小切片字符数`,
            precision: 0,
          }),
        }),
        (0, W.jsx)(M.Item, {
          name: `maxLength`,
          label: `最大切片字符数`,
          colon: !0,
          rules: [
            { required: !0, message: `请输入最大切片字符数` },
            {
              max: 1e4,
              min: 50,
              type: `number`,
              message: `最大切片字符数区间50~10000`,
            },
          ],
          children: (0, W.jsx)(d, {
            placeholder: `请输入最大切片字符数`,
            precision: 0,
          }),
        }),
        (0, W.jsxs)(`div`, {
          className: `global-text-right`,
          children: [
            (0, W.jsx)(y, {
              onClick: () => {
                e.resetFields([`docSeparator`, `maxLength`, `minLength`]);
              },
              children: `重置`,
            }),
            ` `,
            (0, W.jsx)(y, {
              type: `primary`,
              htmlType: `submit`,
              children: `确认并预览`,
            }),
          ],
        }),
      ],
    });
  }),
  Ae = U.memo(() => {
    let e = M.useFormInstance(),
      t = M.useWatch(`segmentType`, e);
    return (0, W.jsxs)(`div`, {
      className: K[`separation-wrapper`],
      hidden: [0, 1].includes(t),
      children: [
        (0, W.jsx)(M.Item, {
          name: `minLength`,
          label: `最小切片字符数`,
          colon: !0,
          rules: [
            { required: !0, message: `请输入最小切片字符数` },
            {
              max: 1e4,
              min: 50,
              type: `number`,
              message: `最小切片字符数区间50~10000`,
            },
          ],
          children: (0, W.jsx)(d, {
            placeholder: `请输入最小切片字符数`,
            precision: 0,
          }),
        }),
        (0, W.jsx)(M.Item, {
          name: `maxLength`,
          label: `最大切片字符数`,
          colon: !0,
          rules: [
            { required: !0, message: `请输入最大切片字符数` },
            {
              max: 1e4,
              min: 50,
              type: `number`,
              message: `最大切片字符数区间50~10000`,
            },
          ],
          children: (0, W.jsx)(d, {
            placeholder: `请输入最大切片字符数`,
            precision: 0,
          }),
        }),
        (0, W.jsxs)(`div`, {
          className: `global-text-right`,
          children: [
            (0, W.jsx)(y, {
              onClick: () => {
                e.resetFields([`docSeparator`, `maxLength`, `minLength`]);
              },
              children: `重置`,
            }),
            ` `,
            (0, W.jsx)(y, {
              type: `primary`,
              htmlType: `submit`,
              children: `确认并预览`,
            }),
          ],
        }),
      ],
    });
  });
function je({
  docId: e,
  docName: t,
  form: n,
  isChange: r,
  docIdList: i,
  extension: a,
  platformDisabled: o,
}) {
  let [s, c] = (0, U.useState)(!1),
    u = (0, U.useRef)(),
    d = M.useWatch(`segmentType`, n),
    [p, m] = (0, U.useState)({ segment: [], count: [], isSupport: !0 }),
    g = async (t) => {
      if (!i?.length) {
        c(!1);
        return;
      }
      (L.cancel(`testSplit_${e}`), c(!0));
      try {
        let e = i.map((e) =>
            Ee.includes(e.suffix)
              ? { docId: e.docId, suffix: e.suffix, ...t, segmentType: 0 }
              : { docId: e.docId, suffix: e.suffix, ...t },
          ),
          r = await H.testSplit(e, {
            _cancelToken: `testSplit_${i[0]?.docId}`,
          });
        if (r.code === 0) {
          let { segment: t = [], is_scan: i = !1 } = r?.data?.[0] || {},
            a = Date.now(),
            o =
              r?.data
                ?.filter(Boolean)
                ?.map((t) => ({
                  ...t,
                  suffix: e?.find((e) => e.docId === t.docId)?.suffix || ``,
                  segmentType:
                    e?.find((e) => e.docId === t.docId)?.segmentType || 0,
                  type:
                    e?.find((e) => e.docId === t.docId)?.docList?.[0]?.type ||
                    0,
                })) || [];
          (console.log(o, `res`),
            n.setFieldsValue({ docList: o }),
            m({
              segment: t.map((e, t) => ({
                content: e,
                segmentOrder: t,
                segmentId: `${a}-${t}`,
                size: (e || ``).length,
                _event: !1,
              })),
              count: r?.data,
              isSupport: !i,
            }));
        }
        if (r.code === oe.CancelStatusCode) return;
      } finally {
        c(!1);
      }
    },
    _ = async () => {
      let { code: t, data: r } = await H.queryConfig({ docId: e });
      if (t === 0) {
        let e = r || {};
        ((e.docSeparator = r?.docSeparator || `\\n`),
          (e.maxLength =
            I(e?.maxLength) || e.maxLength < 50 ? 2e3 : e.maxLength),
          (e.minLength =
            I(e?.minLength) || e.minLength < 50 ? 200 : e.minLength),
          n.setFieldsValue(e),
          n.submit(),
          console.log(e));
        return;
      }
      c(!1);
    },
    v = (e) => {
      e.target.value === 0
        ? n.submit()
        : n.resetFields([`maxLength`, `minLength`]);
    };
  ((0, U.useEffect)(
    () => (
      e && i?.length && u.current !== e && ((u.current = e), c(!0), _()),
      () => {
        e && L.cancel(`testSplit_${e}`);
      }
    ),
    [e, i?.length],
  ),
    (0, U.useEffect)(() => {
      if (d !== 0) {
        let e = (n.getFieldValue(`docList`) || []).map((e) =>
          Ee.includes(e.suffix) ? e : { ...e, segmentType: d },
        );
        n.setFieldsValue({ docList: e });
      }
    }, [d]));
  let y = (t || ``).split(`.`).pop(),
    b = U.useMemo(() => o || Ee.includes(y), [o, y]);
  return (0, W.jsxs)(M, {
    name: `step_2`,
    form: n,
    className: K.form,
    disabled: b,
    wrapperCol: { span: 24 },
    labelCol: { span: 24 },
    colon: !1,
    onFinish: g,
    initialValues: { maxLength: 2e3, minLength: 200 },
    onValuesChange: () => {
      r.current = !0;
    },
    children: [
      (0, W.jsxs)(h, {
        className: `left`,
        children: [
          (0, W.jsx)(M.Item, {
            name: `segmentType`,
            initialValue: 0,
            label: (0, W.jsx)(f.Title, { level: 5, children: `分段策略` }),
            children: (0, W.jsx)(C.Group, {
              className: `global-radio-box-hidden`,
              onChange: v,
              disabled: b,
              children: (0, W.jsx)(T, {
                gutter: [0, 16],
                children: Oe.map((e) =>
                  (0, W.jsx)(
                    h,
                    {
                      span: 24,
                      children: (0, W.jsxs)(C, {
                        value: e.value,
                        disabled: e?.value === 2 && a !== `pdf`,
                        children: [
                          (0, W.jsxs)(T, {
                            wrap: !1,
                            children: [
                              (0, W.jsxs)(h, {
                                className: `global-radio-icon`,
                                "data-active": !!e.iconActive,
                                children: [
                                  (0, W.jsx)(`img`, { src: e.icon, alt: `` }),
                                  e.iconActive
                                    ? (0, W.jsx)(`img`, {
                                        src: e.iconActive,
                                        alt: ``,
                                        "data-active": `active`,
                                      })
                                    : null,
                                ],
                              }),
                              (0, W.jsxs)(h, {
                                flex: 1,
                                children: [
                                  (0, W.jsx)(f.Title, {
                                    level: 5,
                                    children: e.label,
                                  }),
                                  (0, W.jsx)(ae, {
                                    style: { color: `#606478` },
                                    children: e.tooltip,
                                  }),
                                ],
                              }),
                            ],
                          }),
                          e.value === 1 ? (0, W.jsx)(ke, {}) : null,
                          e.value === 2 ? (0, W.jsx)(Ae, {}) : null,
                        ],
                      }),
                    },
                    e.value,
                  ),
                ),
              }),
            }),
          }),
          (0, W.jsx)(M.Item, {
            name: `embedType`,
            initialValue: V[0].value,
            label: (0, W.jsx)(f.Title, { level: 5, children: `向量化方式` }),
            children: (0, W.jsx)(we, { disabled: !0 }),
          }),
          (0, W.jsx)(M.Item, {
            label: (0, W.jsx)(f.Title, { level: 5, children: `预处理文档` }),
            children: (0, W.jsxs)(f.Paragraph, {
              children: [
                (0, W.jsx)(f.Text, { type: `secondary`, children: `注：` }),
                `目前支持最大分段数为1万段，若超过限制，后续内容将会被自动截断，请选择合适的分段策略。若文件过大，请提前进行拆分处理。`,
              ],
            }),
          }),
          (0, W.jsx)(M.Item, {
            children: (0, W.jsx)(M.List, {
              name: `docList`,
              children: (e) =>
                (0, W.jsx)(`div`, {
                  className: K[`doc-type`],
                  children: e?.map((e, n) =>
                    (0, W.jsxs)(
                      `div`,
                      {
                        className: K[`segment-container`],
                        children: [
                          (0, W.jsxs)(T, {
                            wrap: !1,
                            className: K[`segment-result`],
                            children: [
                              (0, W.jsx)(h, {
                                flex: 1,
                                children: (0, W.jsx)(f.Text, {
                                  ellipsis: { tooltip: !0 },
                                  children: i?.[n]?.docName || t,
                                }),
                              }),
                              (0, W.jsxs)(h, {
                                className: K[`segment-count`],
                                children: [
                                  (0, W.jsx)(f.Text, {
                                    type: `secondary`,
                                    children: `预估分段数：`,
                                  }),
                                  p.count?.[n]?.count || 0,
                                ],
                              }),
                            ],
                          }),
                          (0, W.jsx)(M.Item, {
                            noStyle: !0,
                            name: [e.name, `type`],
                            initialValue: z[0].value,
                            colon: !0,
                            rules: [{ required: !0, message: `请选择` }],
                            children: (0, W.jsx)(l, {
                              style: { width: 120, marginBottom: `20px` },
                              options: z,
                            }),
                          }),
                        ],
                      },
                      n,
                    ),
                  ),
                }),
            }),
          }),
        ],
      }),
      (0, W.jsxs)(h, {
        className: `right`,
        children: [
          (0, W.jsx)(T, {
            align: `bottom`,
            wrap: !1,
            children: (0, W.jsx)(h, {
              children: (0, W.jsxs)(f.Title, {
                level: 5,
                style: { margin: 0 },
                children: [
                  `分段预览`,
                  ` `,
                  (0, W.jsx)(f.Text, {
                    type: `secondary`,
                    style: { fontWeight: 400 },
                    children: `\xA0 仅提供部分分段预览的提示文字（非UTF-8编码文件可能会出现乱码情况）`,
                  }),
                ],
              }),
            }),
          }),
          (0, W.jsx)(fe, {
            loading: s,
            className: K.segments,
            dataSource: p.segment,
            isSupport: p.isSupport,
          }),
        ],
      }),
    ],
  });
}
var Me = U.memo(je),
  Ne = {
    section: `_section_nfxpc_2`,
    "steps-wrapper": `_steps-wrapper_nfxpc_39`,
    tabs: `_tabs_nfxpc_48`,
    footer: `_footer_nfxpc_65`,
  };
v();
var Pe = pe,
  Fe = [
    { title: `文档上传` },
    { title: `文档分段选择` },
    { title: `文档审核` },
    { title: `处理并发布` },
  ],
  Ie = (e) =>
    e === 0
      ? 1
      : [1, 2, 3].includes(e ?? -1)
        ? 2
        : [4, 5].includes(e ?? -1)
          ? 3
          : 0,
  Le = U.memo(({ current: e, form: t, docId: n, ...r }) => {
    let i = M.useWatch(`file`, t),
      a = M.useWatch(`error`, t);
    return (0, W.jsx)(y, {
      type: `primary`,
      disabled: I(n) && e === 0 ? !i?.length || !!a : void 0,
      ...r,
      children: `下一步`,
    });
  });
function Re() {
  let e = (0, U.useRef)(null),
    { pathname: t, state: n } = se(),
    [r] = M.useForm(),
    [i] = M.useForm(),
    a = le(),
    { baseId: o, docId: s, docIdList: c, step: l } = n || {},
    u = U.useRef(!1),
    d = U.useRef(),
    f = U.useRef(n?.sensitiveWords),
    [m, h] = U.useState({}),
    [g, _] = U.useState(Ie(l)),
    [v, b] = U.useState(!1),
    [x, S] = U.useState(!1),
    [C, w] = ne.useModal(),
    T = `document_import`,
    [E, O] = U.useState([]),
    [k, A] = U.useState(!1);
  (U.useEffect(() => {
    c?.length &&
      O(
        c
          .map((e) => ({ ...e, suffix: e.docName?.split(`.`).pop() }))
          .sort((e, t) =>
            e.docId === s
              ? -1
              : t.docId === s
                ? 1
                : e.docId.localeCompare(t.docId),
          ),
      );
  }, [c, s]),
    U.useEffect(() => {
      !c?.length &&
        m.docId &&
        m.docName &&
        O([
          {
            docId: m.docId,
            docName: m.docName,
            suffix: m.docName?.split(`.`).pop(),
          },
        ]);
    }, [m.docId, m.docName, c]));
  let j = U.useCallback(
      async (e, t) => {
        (window.clearTimeout(d.current), b(!0));
        let { code: n, data: r } = await H.queryBaseInfo(
            { docId: t || s },
            { _cancelToken: T },
          ),
          i = r?.step ?? e?.step ?? 0,
          a = r?.docStatus ?? e?.docStatus ?? 0,
          o =
            ([1, 2].includes(i) && a !== 2) || (i === 4 && [0, 1].includes(a));
        if (n === 0) {
          let e = 1;
          (r?.step < 4 && (e = 1),
            r?.step === 4 && (e = r?.docStatus === 2 ? 3 : 2),
            r?.step === 5 && (e = 5),
            r?.step === 6 && (e = 4),
            (r._docState = e),
            console.log(r, `data`),
            h(r),
            A(r?.platformType === 0 && r?.docType === 0),
            !c?.length &&
              r?.docId &&
              r?.docName &&
              O([
                {
                  docId: r.docId,
                  docName: r.docName,
                  suffix: r.docName?.split(`.`).pop(),
                },
              ]));
        }
        if (E?.length && [1, 2, 3].includes(r?.step)) {
          let e = E.map((e) => e.docId);
          o = !(await H.getDocListStatus({ docIds: e }))?.data?.every(
            (e) =>
              !(
                ([1, 2].includes(e.step) && e.docStatus !== 2) ||
                (e.step === 4 && [0, 1].includes(e.docStatus))
              ),
          );
        }
        return (
          S(o),
          !o && b(!1),
          o &&
            n !== oe.CancelStatusCode &&
            (d.current = setTimeout(() => j(r || e, t), 5 * 1e3)),
          { code: n, data: r }
        );
      },
      [s, E],
    ),
    ie = async () => {
      if (!I(m.docId)) {
        _(1);
        return;
      }
      let e = null;
      try {
        e = (await r.validateFields()).file;
      } catch {
        D.warning(`所选文件格式异常，请重新选择`);
      }
      if (e && !(await P())) {
        b(!0);
        try {
          let r = new FormData();
          for (let t of e) r.append(`file`, t.originFileObj);
          let { code: i, data: s } = await N({ baseId: o, file: r });
          if (i !== 0) {
            (D.error(`文件上传失败，请重试`), b(!1));
            return;
          }
          ((u.current = !1),
            _(1),
            a(t, {
              state: { ...n, docId: s[0].docId, docIdList: s },
              replace: !0,
            }));
        } catch (e) {
          (console.error(`文件上传失败:`, e), D.error(`文件上传失败，请重试`));
        }
        b(!1);
      }
    },
    P = async (e = `当前步骤将不可撤回，确认进入下一步吗？`) =>
      new Promise((t) => {
        C.confirm({
          title: `提示`,
          width: 480,
          content: e,
          onOk: (e) => {
            (e(), t(!1));
          },
          onCancel: () => t(!0),
        });
      }),
    ae = async () => {
      if (g === 0) await ie();
      else if (g === 1) {
        try {
          let e = await i.validateFields();
          if ((await P()) || (await F(e))?.code !== 0) return;
          let t = E.map((e) => e.docId);
          if (
            (b(!0), (await re({ docIds: t?.length ? t : [s] }))?.code !== 0)
          ) {
            b(!1);
            return;
          }
          (await j(), _(2));
        } catch {
          D.warning(`请填写完整`);
        }
        b(!1);
      }
    },
    F = async (e) => {
      (b(!0), D.loading({ key: `saveTip`, content: `正在保存当前配置` }));
      let t = u.current;
      u.current = !1;
      let n = e.docList?.map((e) => ({
          docId: e.docId,
          docType: e.type,
          segmentType: e.segmentType,
        })),
        r = await H.updateConfig({ ...e, docList: n });
      return (
        r.code === 0
          ? (D.success({ key: `saveTip`, content: `保存成功` }),
            h({ ...m, ...e }))
          : (u.current = t),
        b(!1),
        r
      );
    },
    R = async () => {
      try {
        (console.log(i?.getFieldsValue(), `vvvvvvvvvvvvvvvv`),
          await F(await i.validateFields()));
      } catch {
        D.warning(`请填写完整`);
      }
    },
    z = async () => {
      if (I(m.docId)) {
        D.info(`参数异常，请刷新或退出重试`);
        return;
      }
      if (await P(`确定发布吗？`)) {
        console.log(`点击取消`);
        return;
      }
      let e = () => {
        ((u.current = !1), _(3), j());
      };
      b(!0);
      let {
        code: t,
        data: n,
        map: r,
      } = await xe(s, !0, e, null, E?.length ? E : [m]);
      if ((console.log(`>>>>>>>>`, t), t === 0)) {
        e();
        return;
      }
      (t === 101 && (f.current = { data: n, map: r }), b(!1));
    },
    B = U.useCallback(() => u.current, []),
    ue = [
      {
        key: `0`,
        label: `文档上传`,
        children: (0, W.jsx)(ge, { form: r, isChange: u, disabled: k }),
      },
      {
        key: `1`,
        label: `文档分段选择`,
        children: (0, W.jsx)(Me, {
          form: i,
          isChange: u,
          docName: m.docName,
          docId: s,
          docIdList: E,
          extension: m.extension,
          platformDisabled: k,
        }),
      },
      {
        key: `2`,
        label: `文档审核`,
        children: (0, W.jsx)(he, {
          ref: e,
          state: m,
          getInfo: j,
          sensitiveWords: f.current,
          docIdList: E,
          platformDisabled: k,
        }),
      },
      {
        key: `3`,
        label: `处理并发布`,
        children: (0, W.jsx)(_e, { state: m, docIdList: E }),
      },
    ];
  (U.useEffect(
    () => () => {
      (L.cancel(T), window.clearTimeout(d.current));
    },
    [],
  ),
    U.useEffect(
      () => (
        I(s) ||
          (b(!0),
          j().finally(() => {
            b(!1);
          })),
        () => {
          (window.clearTimeout(d.current), L.cancel(T), (f.current = null));
        }
      ),
      [s],
    ),
    U.useEffect(() => {
      if (I(m?.step)) {
        I(s) && _(0);
        return;
      }
      m.step === 0
        ? _(1)
        : [1, 2, 3].includes(m.step)
          ? _(2)
          : [4, 5].includes(m.step) && _(3);
    }, [m?.step, s]));
  let V =
    g === 3
      ? null
      : (0, W.jsx)(W.Fragment, {
          children: (0, W.jsxs)(p, {
            children: [
              v && !x
                ? (0, W.jsx)(y, { disabled: v, children: `取消` })
                : (0, W.jsx)(ce, {
                    to: -1,
                    children: (0, W.jsx)(y, { children: `取消` }),
                  }),
              g === 1
                ? (0, W.jsx)(y, {
                    type: `primary`,
                    onClick: R,
                    loading: v,
                    disabled: k,
                    children: `保存`,
                  })
                : null,
              [0, 1].includes(g)
                ? (0, W.jsx)(Le, {
                    current: g,
                    form: r,
                    docId: s,
                    onClick: ae,
                    loading: v,
                    disabled: k,
                  })
                : null,
              g === 2
                ? (0, W.jsx)(y, {
                    onClick: z,
                    type: `primary`,
                    loading: v,
                    disabled: x || k,
                    children: `确认并发布`,
                  })
                : null,
            ],
          }),
        });
  return (0, W.jsxs)(de, {
    title: `查看与编辑`,
    showBack: !0,
    footerButtons: V ? [V] : [],
    contentClassName: `${Ne.section}`,
    children: [
      (0, W.jsx)(`div`, {
        className: Ne[`steps-wrapper`],
        children: (0, W.jsx)(te, { current: g, items: Fe }),
      }),
      (0, W.jsx)(ee, {
        className: Ne.tabs,
        items: ue,
        activeKey: `${g}`,
        renderTabBar: () => (0, W.jsx)(`div`, {}),
      }),
      [0, 1].includes(g) ? (0, W.jsx)(Pe, { getWhen: B }) : null,
      w,
    ],
  });
}
var ze = U.memo(Re);
v();
var Be = ({ open: e, onClose: t }) =>
    (0, W.jsx)(r, {
      title: `文件上传说明`,
      width: 600,
      onClose: t,
      open: e,
      children: (0, W.jsxs)(f, {
        children: [
          (0, W.jsx)(f.Title, { level: 5, children: `支持文件类型及规则：` }),
          (0, W.jsxs)(f.Paragraph, {
            children: [
              (0, W.jsxs)(`p`, {
                children: [
                  (0, W.jsx)(`strong`, { children: `单文档：` }),
                  `大小≤150MB或1000页，格式支持.doc,.docx,.ppt,.pptx,.pdf`,
                ],
              }),
              (0, W.jsxs)(`p`, {
                children: [
                  (0, W.jsx)(`strong`, { children: `表格：` }),
                  `建议10MB以内，10万行以内，格式支持xls、xlsx`,
                ],
              }),
              (0, W.jsxs)(`p`, {
                children: [
                  (0, W.jsx)(`strong`, { children: `单图片：` }),
                  `大小≤20MB，最短边 > 15px，长边 < 8192px，长宽比 < 50，格式支持.png,.jpg,.jpeg,.bmp,.gif等`,
                ],
              }),
              (0, W.jsxs)(`p`, {
                children: [
                  (0, W.jsx)(`strong`, { children: `纯文本：` }),
                  `建议不要超过10MB，格式支持.md,.txt,.html`,
                ],
              }),
            ],
          }),
          (0, W.jsx)(f.Title, { level: 5, children: `注意：` }),
          (0, W.jsxs)(f.Paragraph, {
            children: [
              (0, W.jsx)(`p`, { children: `1）可同时上传50个文件` }),
              (0, W.jsx)(`p`, { children: `2）空文件无法上传` }),
              (0, W.jsx)(`p`, {
                children: `3）文件名不超过200字符，仅支持中英文、数字、空格及 . - _ ( )（ ）符号`,
              }),
              (0, W.jsx)(`p`, {
                children: `4）已上传的重复文件将自动检测并忽略，不重复上传`,
              }),
            ],
          }),
        ],
      }),
    }),
  q = {
    "step1-wrapper": `_step1-wrapper_xrsst_6`,
    left: `_left_xrsst_14`,
    "left-header": `_left-header_xrsst_25`,
    "left-body": `_left-body_xrsst_28`,
    right: `_right_xrsst_36`,
    title: `_title_xrsst_47`,
    subtitle: `_subtitle_xrsst_52`,
    "link-text": `_link-text_xrsst_58`,
    upload: `_upload_xrsst_66`,
    "preview-empty": `_preview-empty_xrsst_91`,
    "preview-area": `_preview-area_xrsst_108`,
    "preview-area-empty": `_preview-area-empty_xrsst_120`,
    "upload-icon-wrapper": `_upload-icon-wrapper_xrsst_145`,
    "upload-text": `_upload-text_xrsst_148`,
    "upload-rules": `_upload-rules_xrsst_154`,
    "upload-rule-item": `_upload-rule-item_xrsst_161`,
    "upload-rule-content": `_upload-rule-content_xrsst_164`,
    "file-list": `_file-list_xrsst_171`,
    "file-list-header": `_file-list-header_xrsst_177`,
    "clear-btn": `_clear-btn_xrsst_188`,
    "file-card": `_file-card_xrsst_192`,
    "file-card-active": `_file-card-active_xrsst_209`,
    "file-icon": `_file-icon_xrsst_213`,
    "file-main": `_file-main_xrsst_219`,
    "file-meta": `_file-meta_xrsst_224`,
    "file-name": `_file-name_xrsst_229`,
    "file-size": `_file-size_xrsst_235`,
    "file-delete": `_file-delete_xrsst_240`,
    "file-progress-row": `_file-progress-row_xrsst_252`,
    "file-progress": `_file-progress_xrsst_252`,
    "file-info-row": `_file-info-row_xrsst_266`,
    "file-status-uploading": `_file-status-uploading_xrsst_273`,
    "file-status-success": `_file-status-success_xrsst_279`,
    "file-status-error": `_file-status-error_xrsst_285`,
    "retry-btn": `_retry-btn_xrsst_291`,
  };
v();
var Ve = `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/delete.svg`,
  He = {
    doc: `file-word.svg`,
    docx: `file-word.svg`,
    ppt: `file-ppt.svg`,
    pptx: `file-ppt.svg`,
    pdf: `file-ppf.png`,
    xls: `file-excel.svg`,
    xlsx: `file-excel.svg`,
    csv: `file-excel.svg`,
    png: `file-image.png`,
    jpg: `file-image.png`,
    jpeg: `file-image.png`,
    bmp: `file-image.png`,
    gif: `file-image.png`,
    txt: `file-text.svg`,
    html: `file-text.svg`,
    md: `file-text.svg`,
  },
  Ue = (e) =>
    `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/${He[e.split(`.`).pop()?.toLowerCase() || ``] || `file-unknown.png`}`,
  We = (e) => {
    if (e === 0) return `0 B`;
    let t = 1024,
      n = [`B`, `KB`, `MB`, `GB`],
      r = e,
      i = 0;
    for (; r >= t && i < n.length - 1;) ((r /= t), i++);
    return `${Number(r.toFixed(1))} ${n[i]}`;
  },
  Ge = (0, U.memo)(
    ({
      fileList: e,
      uploadStatusMap: t,
      uploading: n,
      selectedFileUid: r,
      onSelectFile: i,
      handleClearAll: a,
      handleRemove: o,
      retryFile: s,
    }) =>
      e.length === 0
        ? null
        : (0, W.jsxs)(`div`, {
            className: q[`file-list`],
            "data-file-list": `doc`,
            children: [
              (0, W.jsx)(`div`, {
                className: q[`file-list-header`],
                children: (0, W.jsx)(y, {
                  size: `small`,
                  className: q[`clear-btn`],
                  onClick: a,
                  children: `清空列表`,
                }),
              }),
              e.map((e) => {
                let a = t.get(e.uid),
                  c = r === e.uid;
                return (0, W.jsxs)(
                  `div`,
                  {
                    className: `${q[`file-card`]} ${c ? q[`file-card-active`] : ``}`,
                    onClick: () => i?.(e),
                    children: [
                      (0, W.jsx)(`img`, {
                        src: Ue(e.name),
                        className: q[`file-icon`],
                        alt: ``,
                      }),
                      (0, W.jsxs)(`div`, {
                        className: q[`file-main`],
                        children: [
                          (0, W.jsx)(`div`, {
                            className: q[`file-meta`],
                            children: (0, W.jsx)(f.Text, {
                              className: q[`file-name`],
                              ellipsis: { tooltip: !0 },
                              children: e.name,
                            }),
                          }),
                          a?.status === `uploading` &&
                            (0, W.jsxs)(`div`, {
                              className: q[`file-progress-row`],
                              children: [
                                (0, W.jsx)(`div`, {
                                  className: q[`file-progress`],
                                  style: { width: `${a.progress}%` },
                                }),
                                (0, W.jsxs)(f.Text, {
                                  className: q[`file-status-uploading`],
                                  children: [a.progress, `%`],
                                }),
                              ],
                            }),
                          a?.status !== `uploading` &&
                            (0, W.jsxs)(`div`, {
                              className: q[`file-info-row`],
                              children: [
                                (0, W.jsx)(`span`, {
                                  className: q[`file-size`],
                                  children: We(e.size || 0),
                                }),
                                a?.status === `success` &&
                                  (0, W.jsx)(f.Text, {
                                    className: q[`file-status-success`],
                                    children: `✓ 完成`,
                                  }),
                                a?.status === `error` &&
                                  (0, W.jsxs)(W.Fragment, {
                                    children: [
                                      (0, W.jsx)(f.Text, {
                                        className: q[`file-status-error`],
                                        title: a.errorMsg,
                                        children: `✗ 失败`,
                                      }),
                                      s &&
                                        (0, W.jsx)(y, {
                                          type: `link`,
                                          size: `small`,
                                          icon: (0, W.jsx)(S, {}),
                                          className: q[`retry-btn`],
                                          onClick: () => s(e.uid),
                                          children: `重试`,
                                        }),
                                    ],
                                  }),
                              ],
                            }),
                        ],
                      }),
                      !n &&
                        (0, W.jsx)(`img`, {
                          src: Ve,
                          alt: `删除`,
                          className: q[`file-delete`],
                          onClick: () => o(e),
                        }),
                    ],
                  },
                  e.uid,
                );
              }),
            ],
          }),
  );
v();
var Ke = 150 * 1024 * 1024,
  qe = 10,
  Je = 1024 * 1024,
  Ye = async (e) => {
    let { size: t } = e,
      n = [
        [0, Math.min(Je, t)],
        [
          Math.max(0, Math.floor(t / 2) - Je / 2),
          Math.max(0, Math.floor(t / 2) + Je / 2),
        ],
        [Math.max(0, t - Je), t],
      ],
      r = await Promise.all(n.map(([t, n]) => e.slice(t, n).arrayBuffer())),
      i = r.reduce((e, t) => e + t.byteLength, 0),
      a = new Uint8Array(i),
      o = 0;
    for (let e of r) (a.set(new Uint8Array(e), o), (o += e.byteLength));
    let s = await crypto.subtle.digest(`SHA-256`, a);
    return `${t}-${Array.from(new Uint8Array(s))
      .map((e) => e.toString(16).padStart(2, `0`))
      .join(``)}`;
  },
  Xe = (e) => `.${e.split(`.`).pop()?.toLowerCase() || ``}`,
  Ze = (e) => {
    if (e === 0) return `0 B`;
    let t = 1024,
      n = [`B`, `KB`, `MB`, `GB`],
      r = e,
      i = 0;
    for (; r >= t && i < n.length - 1;) ((r /= t), i++);
    return `${Number(r.toFixed(1))} ${n[i]}`;
  },
  Qe = (e) => {
    let t = [],
      n = Xe(e.name);
    return (
      B.includes(n) ||
        t.push(`「${e.name}」不支持该文件格式，支持 ${ue.join(`、`)} 格式`),
      e.size === 0 && t.push(`「${e.name}」为空文件，无法进行处理`),
      e.size &&
        e.size > Ke &&
        t.push(
          `「${e.name}」文件大小超过150MB限制（当前 ${Ze(e.size)}），请压缩后重新上传`,
        ),
      t
    );
  },
  $e = (e) => {
    let [t, n] = (0, U.useState)([]),
      [r, i] = (0, U.useState)(!1),
      [a, o] = (0, U.useState)(new Map()),
      s = (0, U.useRef)(new Map()),
      c = (0, U.useRef)(new Map()),
      l = (0, U.useRef)(new Set()),
      d = (0, U.useRef)(0),
      f = (0, U.useRef)(0),
      p = (0, U.useRef)(null),
      m = (0, U.useRef)(new Set()),
      h = (0, U.useRef)(t);
    h.current = t;
    let g = (0, U.useRef)(a);
    g.current = a;
    let _ = (0, U.useCallback)((e, t) => {
        o((n) => {
          let r = new Map(n);
          return (r.set(e, t), r);
        });
      }, []),
      v = (0, U.useCallback)(async () => {
        p.current && (await p.current);
        let e = h.current;
        if (!e.length) return (D.warning(`请先选择文件`), { success: !1 });
        let t = ++d.current,
          n = f.current,
          r;
        ((p.current = new Promise((e) => {
          r = e;
        })),
          i(!0));
        try {
          m.current.size > 0 &&
            (await Promise.all(
              Array.from(m.current).map(
                (e) =>
                  new Promise((t) => {
                    let n = () => {
                      m.current.has(e) ? setTimeout(n, 200) : t();
                    };
                    n();
                  }),
              ),
            ));
          let i = e.filter((e) => {
            if (!e.originFileObj) return !1;
            let t = g.current.get(e.uid);
            return !t || t.status === `pending` || t.status === `error`;
          });
          if (i.length === 0) {
            let t = e.filter((e) => e.originFileObj);
            if (
              t.every((e) => g.current.get(e.uid)?.status === `success`) &&
              t.length > 0
            ) {
              let e = t.map((e) => s.current.get(e.uid)).filter(Boolean);
              return (r(!0), { success: !0, ossResults: e });
            }
            return (D.warning(`请先选择文件`), r(!1), { success: !1 });
          }
          i.forEach((e) => {
            _(e.uid, { progress: 0, status: `uploading` });
          });
          for (let e of i) {
            if (f.current !== n || d.current !== t)
              return (r(!1), { success: !1 });
            if (e.originFileObj)
              try {
                let n = await P(e.originFileObj, {
                  onProgress: (n) => {
                    d.current === t &&
                      _(e.uid, { progress: n, status: `uploading` });
                  },
                });
                if (d.current !== t) return (r(!1), { success: !1 });
                (s.current.set(e.uid, n),
                  _(e.uid, { progress: 100, status: `success` }));
              } catch (n) {
                if (d.current !== t) return (r(!1), { success: !1 });
                _(e.uid, {
                  progress: 0,
                  status: `error`,
                  errorMsg: n.message || `上传失败`,
                });
              }
          }
          let a = e.filter((e) => e.originFileObj),
            o = a.map((e) => s.current.get(e.uid)).filter(Boolean),
            c = a.filter((e) => g.current.get(e.uid)?.status === `error`);
          return d.current === t
            ? o.length === 0
              ? (D.error(`所有文件上传失败，请重试`), r(!1), { success: !1 })
              : c.length > 0
                ? (D.error(`${c.length} 个文件上传失败，请重试后再进入下一步`),
                  r(!1),
                  { success: !1 })
                : (D.success(`${o.length} 个文件上传成功`),
                  r(!0),
                  { success: !0, ossResults: o })
            : (r(!1), { success: !1 });
        } catch (e) {
          return (
            console.error(`文件上传失败:`, e),
            D.error(`文件上传失败，请重试`),
            r(!1),
            { success: !1 }
          );
        } finally {
          (d.current === t && i(!1), (p.current = null));
        }
      }, [_]),
      y = (0, U.useCallback)(
        async (e) => {
          let t = h.current.find((t) => t.uid === e);
          if (!t?.originFileObj)
            return (D.error(`找不到原始文件`), { success: !1 });
          (_(e, { progress: 0, status: `uploading` }), m.current.add(e));
          try {
            let n = await P(t.originFileObj, {
              onProgress: (t) => {
                _(e, { progress: t, status: `uploading` });
              },
            });
            return (
              s.current.set(e, n),
              _(e, { progress: 100, status: `success` }),
              D.success(`「${t.name}」重试上传成功`),
              { success: !0, ossResult: n }
            );
          } catch (n) {
            return (
              _(e, {
                progress: 0,
                status: `error`,
                errorMsg: n.message || `上传失败`,
              }),
              D.error(`「${t.name}」重试上传失败`),
              { success: !1 }
            );
          } finally {
            m.current.delete(e);
          }
        },
        [_],
      ),
      b = (0, U.useCallback)(
        (t) => {
          let r = t.fileList;
          if (r.length > qe) {
            D.warning(`单次最多上传 ${qe} 个文件，请分批上传`);
            return;
          }
          let i = [],
            a = [];
          for (let e of r) {
            if (e.originFileObj && e.status !== `removed`) {
              let t = Qe(e);
              t.length > 0 ? i.push(...t) : a.push(e);
              continue;
            }
            a.push(e);
          }
          if (i.length > 0) {
            (i.slice(0, 5).forEach((e) => {
              D.error({ content: e, key: e });
            }),
              i.length > 5 &&
                D.warning(
                  `还有 ${i.length - 5} 个文件校验失败，请检查后重新上传`,
                ),
              n(a),
              e?.(a.length > 0));
            return;
          }
          (n(r), e?.(r.length > 0));
        },
        [e],
      ),
      x = (0, U.useCallback)(
        (t) => {
          let r = h.current.filter((e) => e.uid !== t.uid);
          (n(r),
            s.current.delete(t.uid),
            c.current.delete(t.uid),
            l.current.delete(t.uid),
            e?.(r.length > 0));
        },
        [e],
      ),
      S = (0, U.useCallback)(() => !1, []);
    (0, U.useEffect)(() => {
      let r = !1;
      return (
        (async () => {
          let i = t.filter((e) => e.originFileObj && !l.current.has(e.uid));
          if (i.length === 0) return;
          let a = new Set(c.current.values()),
            o = [...t],
            s = [];
          for (let e of i)
            if (!(!e.originFileObj || r)) {
              try {
                let t = await Ye(e.originFileObj);
                a.has(t)
                  ? (s.push(e.name), (o = o.filter((t) => t.uid !== e.uid)))
                  : (c.current.set(e.uid, t), a.add(t));
              } catch {
                console.warn(`文件 Hash 计算失败，跳过重复检测:`, e.name);
              }
              l.current.add(e.uid);
            }
          r ||
            s.length === 0 ||
            (D.warning({
              content:
                s.length === 1
                  ? `「${s[0]}」已在待处理列表中，已自动跳过`
                  : `${s.length} 个文件已在待处理列表中，已自动跳过`,
              key: `duplicate-file`,
            }),
            n(o),
            e?.(o.length > 0));
        })(),
        () => {
          r = !0;
        }
      );
    }, [t, e]);
    let ee = (0, U.useCallback)(() => {
      let t =
        r || m.current.size > 0
          ? `当前有文件正在上传中，清空将终止所有上传任务并清除 ${h.current.length} 个文件，确认继续吗？`
          : `确定要清空所有 ${h.current.length} 个已选文件吗？`;
      ne.confirm({
        title: `清空文件列表`,
        icon: (0, U.createElement)(u),
        content: t,
        okText: `确认清空`,
        cancelText: `取消`,
        onOk: () => {
          (f.current++,
            d.current++,
            (p.current = null),
            m.current.clear(),
            i(!1),
            n([]),
            o(new Map()),
            s.current.clear(),
            c.current.clear(),
            l.current.clear(),
            e?.(!1));
        },
      });
    }, [r, e]);
    return {
      fileList: t,
      uploading: r,
      uploadStatusMap: a,
      accept: (0, U.useMemo)(() => B.join(`,`), []),
      beforeUpload: S,
      handleChange: b,
      handleRemove: x,
      handleClearAll: ee,
      send: v,
      retryFile: y,
    };
  };
v();
var et = 10,
  tt = 500,
  nt = `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/preview-empty.png`,
  rt = `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/preview-unsupported.png`,
  it = [
    `txt`,
    `doc`,
    `docx`,
    `ppt`,
    `pptx`,
    `pdf`,
    `zip`,
    `xlsx`,
    `xls`,
    `csv`,
    `html`,
    `md`,
  ],
  at = ({ fileList: e, selectedFileUid: t, previewCleared: n }) => {
    let [r, i] = (0, U.useState)(!1),
      a = t ? (e.find((e) => e.uid === t) ?? e[0]) : e[0];
    if (n || !a)
      return (0, W.jsxs)(W.Fragment, {
        children: [
          (0, W.jsx)(f.Title, {
            level: 5,
            className: q.title,
            children: `文档预览`,
          }),
          (0, W.jsx)(f.Paragraph, {
            className: q.subtitle,
            children: `仅提供部分分段预览的提示文字（非UTF-8编码文件可能会出现乱码情况）`,
          }),
          (0, W.jsx)(`div`, {
            className: `${q[`preview-area`]} ${q[`preview-area-empty`]}`,
            children: (0, W.jsxs)(`div`, {
              className: q[`preview-empty`],
              children: [
                (0, W.jsx)(`img`, { src: nt, alt: `选择要预览的文件` }),
                (0, W.jsx)(`p`, { children: `选择要预览的文件` }),
              ],
            }),
          }),
        ],
      });
    let o = a.name?.split(`.`).pop()?.toLowerCase();
    return o && !it.includes(o)
      ? (0, W.jsxs)(W.Fragment, {
          children: [
            (0, W.jsx)(f.Title, {
              level: 5,
              className: q.title,
              children: `文档预览`,
            }),
            (0, W.jsx)(f.Paragraph, {
              className: q.subtitle,
              children: `仅提供部分分段预览的提示文字（非UTF-8编码文件可能会出现乱码情况）`,
            }),
            (0, W.jsx)(`div`, {
              className: `${q[`preview-area`]} ${q[`preview-area-empty`]}`,
              children: (0, W.jsxs)(`div`, {
                className: q[`preview-empty`],
                children: [
                  (0, W.jsx)(`img`, {
                    src: rt,
                    alt: `当前文件格式暂不支持预览`,
                    style: { width: 87, height: 59 },
                  }),
                  (0, W.jsx)(`p`, { children: `当前文件格式暂不支持预览` }),
                ],
              }),
            }),
          ],
        })
      : (0, W.jsxs)(W.Fragment, {
          children: [
            (0, W.jsx)(f.Title, {
              level: 5,
              className: q.title,
              children: `文档预览`,
            }),
            (0, W.jsx)(f.Paragraph, {
              className: q.subtitle,
              children: `仅提供部分分段预览的提示文字（非UTF-8编码文件可能会出现乱码情况）`,
            }),
            (0, W.jsx)(`div`, {
              className: q[`preview-area`],
              children: (0, W.jsx)(F, {
                loading: r,
                onLoadingChange: i,
                file: a?.originFileObj,
                fileList: e,
                showSegmentSize: 10,
                maxStringLength: tt,
                emptyText: `选择要预览的文件`,
              }),
            }),
          ],
        });
  },
  ot = (0, U.forwardRef)(({ onFileChange: e }, t) => {
    let {
      fileList: n,
      uploading: r,
      uploadStatusMap: i,
      accept: a,
      beforeUpload: o,
      handleChange: s,
      handleRemove: l,
      handleClearAll: u,
      send: d,
      retryFile: p,
    } = $e(e);
    (0, U.useImperativeHandle)(t, () => ({ send: d, retryFile: p }), [d, p]);
    let [m, h] = (0, U.useState)(``),
      [g, _] = (0, U.useState)(!1),
      v = (0, U.useCallback)((e) => {
        (h(e.uid), _(!1));
      }, []),
      y = (0, U.useCallback)((e) => {
        e.target.closest(`[data-file-list="doc"]`) || (h(``), _(!0));
      }, []);
    (0, U.useEffect)(() => {
      n.length > 0 && !m && !g && h(n[0].uid);
    }, [n, m, g]);
    let [b, x] = (0, U.useState)(!1),
      S = (0, U.useCallback)(() => x(!0), []),
      ee = (0, U.useCallback)(() => x(!1), []);
    return (0, W.jsxs)(`div`, {
      className: q[`step1-wrapper`],
      onClick: y,
      children: [
        (0, W.jsxs)(`div`, {
          className: q.left,
          children: [
            (0, W.jsxs)(`div`, {
              className: q[`left-header`],
              children: [
                (0, W.jsx)(f.Title, {
                  level: 5,
                  className: q.title,
                  children: `文件上传`,
                }),
                (0, W.jsxs)(f.Paragraph, {
                  className: q.subtitle,
                  children: [
                    `上传文件前，请先查看`,
                    (0, W.jsx)(`span`, {
                      className: q[`link-text`],
                      onClick: S,
                      children: `《文件上传说明》`,
                    }),
                    `，按要求上传`,
                  ],
                }),
              ],
            }),
            (0, W.jsxs)(`div`, {
              className: q[`left-body`],
              children: [
                (0, W.jsxs)(c.Dragger, {
                  className: q.upload,
                  multiple: !0,
                  accept: a,
                  fileList: n,
                  beforeUpload: o,
                  onChange: s,
                  showUploadList: !1,
                  maxCount: et,
                  children: [
                    (0, W.jsx)(`div`, {
                      className: q[`upload-icon-wrapper`],
                      children: (0, W.jsx)(`img`, {
                        src: `https://ai-copilot.cos.clife.cn/web-agent-paas/static/images/kg/upload-icon.png`,
                        alt: `上传文件`,
                        width: `60`,
                        height: `60`,
                      }),
                    }),
                    (0, W.jsx)(f.Paragraph, {
                      className: q[`upload-text`],
                      children: `将文件拖到此处或点击上传`,
                    }),
                    (0, W.jsxs)(`ul`, {
                      className: q[`upload-rules`],
                      children: [
                        (0, W.jsx)(`li`, {
                          className: q[`upload-rule-item`],
                          children: (0, W.jsx)(`span`, {
                            className: q[`upload-rule-content`],
                            children: `单文档：大小≤150MB或1000页，格式支持.doc,.docx,.ppt,.pptx,.pdf`,
                          }),
                        }),
                        (0, W.jsx)(`li`, {
                          className: q[`upload-rule-item`],
                          children: (0, W.jsx)(`span`, {
                            className: q[`upload-rule-content`],
                            children: `表格：建议10MB以内，10万行以内，格式支持xls、xlsx`,
                          }),
                        }),
                        (0, W.jsx)(`li`, {
                          className: q[`upload-rule-item`],
                          children: (0, W.jsx)(`span`, {
                            className: q[`upload-rule-content`],
                            children: `单图片：大小≤20MB，最短边 > 15px，长边 < 8192px，长宽比 < 50，格式支持.png,.jpg,.jpeg,.bmp,.gif等`,
                          }),
                        }),
                        (0, W.jsx)(`li`, {
                          className: q[`upload-rule-item`],
                          children: (0, W.jsx)(`span`, {
                            className: q[`upload-rule-content`],
                            children: `纯文本：建议不要超过10MB，格式支持.md,.txt,.html`,
                          }),
                        }),
                        (0, W.jsx)(`li`, {
                          className: q[`upload-rule-item`],
                          children: (0, W.jsxs)(`span`, {
                            className: q[`upload-rule-content`],
                            children: [`最多支持（`, n.length, `/`, et, `）个`],
                          }),
                        }),
                      ],
                    }),
                  ],
                }),
                (0, W.jsx)(Ge, {
                  fileList: n,
                  uploadStatusMap: i,
                  uploading: r,
                  selectedFileUid: m,
                  onSelectFile: v,
                  handleClearAll: u,
                  handleRemove: l,
                  retryFile: p,
                }),
                (0, W.jsx)(Be, { open: b, onClose: ee }),
              ],
            }),
          ],
        }),
        (0, W.jsx)(`div`, {
          className: q.right,
          children: (0, W.jsx)(at, {
            fileList: n,
            selectedFileUid: m,
            previewCleared: g,
          }),
        }),
      ],
    });
  });
ot.displayName = `Step1`;
var st = (0, U.memo)(ot),
  J = (function (e) {
    return (
      (e[(e.Upload = 0)] = `Upload`),
      (e[(e.Segment = 1)] = `Segment`),
      (e[(e.Review = 2)] = `Review`),
      (e[(e.Publish = 3)] = `Publish`),
      e
    );
  })({}),
  Y = (function (e) {
    return (
      (e[(e.Smart = 0)] = `Smart`),
      (e[(e.Symbol = 1)] = `Symbol`),
      (e[(e.Length = 3)] = `Length`),
      (e[(e.Page = 4)] = `Page`),
      e
    );
  })({}),
  X = {
    form: `_form_1rapc_2`,
    "card-grid": `_card-grid_1rapc_6`,
    "strategy-card": `_strategy-card_1rapc_9`,
    "strategy-card-active": `_strategy-card-active_1rapc_25`,
    "strategy-header": `_strategy-header_1rapc_30`,
    "strategy-check": `_strategy-check_1rapc_36`,
    "strategy-desc": `_strategy-desc_1rapc_47`,
    "fields-panel": `_fields-panel_1rapc_54`,
    "slider-wrapper": `_slider-wrapper_1rapc_84`,
    "slider-col": `_slider-col_1rapc_89`,
    "slider-input-col": `_slider-input-col_1rapc_113`,
  };
v();
var ct = [
    {
      value: Y.Smart,
      label: `智能切分`,
      description: `在通用文档上的较优 chunk 切分方法，经过评测可在多数文档上获得较佳的检索效果`,
    },
    {
      value: Y.Length,
      label: `按长度切分`,
      description: `适合对 Token 数量有严格要求的场景，比如使用上下文长度较小的模型时。`,
    },
    {
      value: Y.Page,
      label: `按页切分`,
      description: `适合每页传达独立主题的文档，要求不同页面的内容不会混杂在同一文本切片中。`,
    },
    {
      value: Y.Symbol,
      label: `按照符号切分`,
      description: `适用于根据特定标识符区分内容的文档，根据文档文件中特殊标识符进行切分。`,
    },
  ],
  lt = [
    {
      label: `换行`,
      value: `
`,
    },
    { label: `中文句号`, value: `。` },
    { label: `英文句号`, value: `.` },
    { label: `中文叹号`, value: `！` },
    { label: `英文叹号`, value: `!` },
    { label: `中文逗号`, value: `，` },
    { label: `英文逗号`, value: `,` },
    { label: `中文分号`, value: `；` },
    { label: `英文分号`, value: `;` },
    { label: `中文问号`, value: `？` },
  ],
  Z = {
    chunkSize: [
      { required: !0, message: `请输入最大分段长度` },
      {
        validator: (e, t) => {
          if (t == null || t === ``) return Promise.resolve();
          let n = Number(t);
          return isNaN(n) || n < 10 || n > 6e3
            ? Promise.reject(Error(`分段长度区间10~6000`))
            : Promise.resolve();
        },
      },
    ],
    overlapSize: [
      { required: !0, message: `请输入分段重叠长度` },
      {
        validator: (e, t) => {
          if (t == null || t === ``) return Promise.resolve();
          let n = Number(t);
          return isNaN(n) || n < 0 || n > 1024
            ? Promise.reject(Error(`分段重叠长度区间0~1024`))
            : Promise.resolve();
        },
      },
    ],
    regexPattern: [{ required: !0, message: `请输入正则表达式` }],
    docSeparator: [{ required: !0, message: `请选择标识符` }],
  },
  Q = (0, U.memo)(() => {
    let e = M.useFormInstance(),
      t = M.useWatch(`chunkSize`, e);
    return (0, W.jsx)(M.Item, {
      name: `chunkSize`,
      label: (0, W.jsxs)(`span`, {
        children: [
          `最大分段长度`,
          (0, W.jsx)(m, {
            title: `当文本切片的字符数超过最大分段长度时，将被强制截断`,
            children: (0, W.jsx)(o, {
              style: { marginLeft: 4, color: `#999` },
            }),
          }),
        ],
      }),
      rules: Z.chunkSize,
      children: (0, W.jsxs)(`div`, {
        className: X[`slider-wrapper`],
        children: [
          (0, W.jsx)(`div`, {
            className: X[`slider-col`],
            children: (0, W.jsx)(g, {
              min: 10,
              max: 6e3,
              marks: { 10: `10`, 6e3: `6000` },
              value: t ?? 2e3,
              onChange: (t) => e.setFieldsValue({ chunkSize: t }),
            }),
          }),
          (0, W.jsx)(`div`, {
            className: X[`slider-input-col`],
            children: (0, W.jsx)(d, {
              min: 10,
              max: 6e3,
              value: t ?? 2e3,
              onChange: (t) => {
                let n = typeof t == `number` && !isNaN(t) ? t : void 0;
                e.setFields([{ name: `chunkSize`, value: n, errors: void 0 }]);
              },
              onBlur: () => {
                let t = e.getFieldValue(`chunkSize`),
                  n = Number(t);
                t != null &&
                  t !== `` &&
                  !isNaN(n) &&
                  e.setFieldsValue({
                    chunkSize: Math.max(10, Math.min(6e3, n)),
                  });
              },
            }),
          }),
        ],
      }),
    });
  });
Q.displayName = `MaxLengthField`;
var ut = (0, U.memo)(() => (0, W.jsx)(Q, {}));
ut.displayName = `SmartFields`;
var dt = (0, U.memo)(() => {
  let e = M.useFormInstance(),
    t = M.useWatch(`chunkSize`, e),
    n = M.useWatch(`overlapSize`, e);
  return (0, W.jsxs)(W.Fragment, {
    children: [
      (0, W.jsx)(M.Item, {
        name: `chunkSize`,
        label: `分段预估长度`,
        rules: Z.chunkSize,
        children: (0, W.jsxs)(`div`, {
          className: X[`slider-wrapper`],
          children: [
            (0, W.jsx)(`div`, {
              className: X[`slider-col`],
              children: (0, W.jsx)(g, {
                min: 10,
                max: 6e3,
                marks: { 10: `10`, 6e3: `6000` },
                value: t ?? 2e3,
                onChange: (t) => e.setFieldsValue({ chunkSize: t }),
              }),
            }),
            (0, W.jsx)(`div`, {
              className: X[`slider-input-col`],
              children: (0, W.jsx)(d, {
                min: 10,
                max: 6e3,
                value: t ?? 2e3,
                onChange: (t) => {
                  let n = typeof t == `number` && !isNaN(t) ? t : void 0;
                  e.setFields([
                    { name: `chunkSize`, value: n, errors: void 0 },
                  ]);
                },
                onBlur: () => {
                  let t = e.getFieldValue(`chunkSize`),
                    n = Number(t);
                  t != null &&
                    t !== `` &&
                    !isNaN(n) &&
                    e.setFieldsValue({
                      chunkSize: Math.max(10, Math.min(6e3, n)),
                    });
                },
              }),
            }),
          ],
        }),
      }),
      (0, W.jsx)(M.Item, {
        name: `overlapSize`,
        label: (0, W.jsxs)(`span`, {
          children: [
            `分段重叠长度`,
            (0, W.jsx)(m, {
              title: `当前分片与上一个分片重叠的文本长度`,
              children: (0, W.jsx)(o, {
                style: { marginLeft: 4, color: `#999` },
              }),
            }),
          ],
        }),
        rules: Z.overlapSize,
        children: (0, W.jsxs)(`div`, {
          className: X[`slider-wrapper`],
          children: [
            (0, W.jsx)(`div`, {
              className: X[`slider-col`],
              children: (0, W.jsx)(g, {
                min: 0,
                max: 1024,
                marks: { 0: `0`, 1024: `1024` },
                value: n ?? 0,
                onChange: (t) => e.setFieldsValue({ overlapSize: t }),
              }),
            }),
            (0, W.jsx)(`div`, {
              className: X[`slider-input-col`],
              children: (0, W.jsx)(d, {
                min: 0,
                max: 1024,
                value: n ?? 0,
                onChange: (t) => {
                  let n = typeof t == `number` && !isNaN(t) ? t : void 0;
                  e.setFields([
                    { name: `overlapSize`, value: n, errors: void 0 },
                  ]);
                },
                onBlur: () => {
                  let t = e.getFieldValue(`overlapSize`),
                    n = Number(t);
                  t != null &&
                    t !== `` &&
                    !isNaN(n) &&
                    e.setFieldsValue({
                      overlapSize: Math.max(0, Math.min(1024, n)),
                    });
                },
              }),
            }),
          ],
        }),
      }),
    ],
  });
});
dt.displayName = `LengthFields`;
var ft = (0, U.memo)(() => (0, W.jsx)(Q, {}));
ft.displayName = `PageFields`;
var pt = (0, U.memo)(() =>
  (0, W.jsxs)(W.Fragment, {
    children: [
      (0, W.jsx)(M.Item, {
        name: `regexPattern`,
        label: `输入正则表达式`,
        rules: Z.regexPattern,
        children: (0, W.jsx)(i, { placeholder: `请输入正则表达式` }),
      }),
      (0, W.jsx)(Q, {}),
    ],
  }),
);
pt.displayName = `RegexFields`;
var mt = (0, U.memo)(() =>
  (0, W.jsxs)(W.Fragment, {
    children: [
      (0, W.jsx)(M.Item, {
        name: `docSeparator`,
        label: `标识符选择`,
        rules: Z.docSeparator,
        children: (0, W.jsx)(l, { placeholder: `请选择标识符`, options: lt }),
      }),
      (0, W.jsx)(Q, {}),
    ],
  }),
);
mt.displayName = `SymbolFields`;
var ht = { [Y.Smart]: ut, [Y.Length]: dt, [Y.Page]: ft, [Y.Symbol]: mt },
  gt = ({ form: e, isChange: t }) => {
    let n = M.useWatch(`segmentType`, e) ?? Y.Smart,
      r = ht[n];
    return (0, W.jsxs)(M, {
      name: `step_2`,
      form: e,
      className: X.form,
      wrapperCol: { span: 24 },
      labelCol: { span: 24 },
      colon: !1,
      initialValues: {
        segmentType: Y.Smart,
        chunkSize: 2e3,
        overlapSize: 0,
        docSeparator: `
`,
      },
      onValuesChange: () => {
        t.current = !0;
      },
      children: [
        (0, W.jsx)(M.Item, {
          name: `segmentType`,
          noStyle: !0,
          children: (0, W.jsx)(`input`, { type: `hidden` }),
        }),
        (0, W.jsx)(T, {
          gutter: [16, 16],
          className: X[`card-grid`],
          children: ct.map((t) => {
            let r = n === t.value;
            return (0, W.jsx)(
              h,
              {
                span: 6,
                children: (0, W.jsxs)(`div`, {
                  className: `${X[`strategy-card`]} ${r ? X[`strategy-card-active`] : ``}`,
                  onClick: () => e.setFieldsValue({ segmentType: t.value }),
                  children: [
                    (0, W.jsxs)(`div`, {
                      className: X[`strategy-header`],
                      children: [
                        (0, W.jsx)(f.Text, { strong: !0, children: t.label }),
                        r &&
                          (0, W.jsx)(`div`, {
                            className: X[`strategy-check`],
                            children: `✓`,
                          }),
                      ],
                    }),
                    (0, W.jsx)(f.Text, {
                      type: `secondary`,
                      className: X[`strategy-desc`],
                      children: t.description,
                    }),
                  ],
                }),
              },
              t.value,
            );
          }),
        }),
        (0, W.jsx)(`div`, {
          className: X[`fields-panel`],
          children: (0, W.jsx)(r, {}),
        }),
      ],
    });
  };
gt.displayName = `Step2`;
var $ = {
  result: `_result_1ce8c_2`,
  extra: `_extra_1ce8c_5`,
  "list-group": `_list-group_1ce8c_10`,
  "list-group-column": `_list-group-column_1ce8c_18`,
  "segment-info": `_segment-info_1ce8c_24`,
  "info-row": `_info-row_1ce8c_28`,
  "info-label": `_info-label_1ce8c_33`,
  loader: `_loader_1ce8c_40`,
  pulse: `_pulse_1ce8c_1`,
  "i-1": `_i-1_1ce8c_53`,
  "i-2": `_i-2_1ce8c_57`,
  "i-3": `_i-3_1ce8c_62`,
  "i-4": `_i-4_1ce8c_67`,
  "i-5": `_i-5_1ce8c_72`,
};
v();
var _t = () =>
    (0, W.jsxs)(`div`, {
      className: $.loader,
      children: [
        (0, W.jsx)(`i`, { className: $[`i-1`] }),
        (0, W.jsx)(`i`, { className: $[`i-2`] }),
        (0, W.jsx)(`i`, { className: $[`i-3`] }),
        (0, W.jsx)(`i`, { className: $[`i-4`] }),
        (0, W.jsx)(`i`, { className: $[`i-5`] }),
      ],
    }),
  vt = {
    [Y.Smart]: `智能切分`,
    [Y.Symbol]: `按照符号切分`,
    [Y.Length]: `按长度切分`,
    [Y.Page]: `按页切分`,
  },
  yt = 5,
  bt = (0, U.memo)(({ state: e, docIdList: t = [] }) => {
    let n = le(),
      r = [3, 5].includes(e?._docState ?? -1),
      i = t?.length ? t : [];
    return (0, W.jsx)(w, {
      className: $.result,
      status: r ? `success` : `info`,
      icon: r ? void 0 : (0, W.jsx)(_t, {}),
      title: (0, W.jsx)(f.Text, {
        strong: !0,
        children: r ? `文档已发布` : `文档发布中`,
      }),
      subTitle: r
        ? `文档成功发布完毕，您可以在列表中找到它`
        : `文档索引建立完成后，您可以在列表中找到它`,
      extra: (0, W.jsxs)(`div`, {
        className: $.extra,
        children: [
          (0, W.jsx)(`div`, {
            className: `${$[`list-group`]} ${i.length > yt ? `` : $[`list-group-column`]}`,
            children: i.map((e) =>
              (0, W.jsx)(
                A,
                {
                  showIcon: !0,
                  icon: (0, W.jsx)(_, {}),
                  message: (0, W.jsx)(f.Text, {
                    ellipsis: { tooltip: !0 },
                    children: e.docName,
                  }),
                  type: `info`,
                },
                e.docId,
              ),
            ),
          }),
          (0, W.jsxs)(`div`, {
            className: $[`segment-info`],
            children: [
              (0, W.jsxs)(`div`, {
                className: $[`info-row`],
                children: [
                  (0, W.jsx)(`span`, {
                    className: $[`info-label`],
                    children: `分段策略：`,
                  }),
                  (0, W.jsx)(`span`, {
                    children: vt[e?.segmentType ?? 0] ?? `智能切分`,
                  }),
                ],
              }),
              e?.segmentType === 1 &&
                e?.docSeparator &&
                (0, W.jsxs)(`div`, {
                  className: $[`info-row`],
                  children: [
                    (0, W.jsx)(`span`, {
                      className: $[`info-label`],
                      children: `分段标识符：`,
                    }),
                    (0, W.jsx)(`span`, { children: e.docSeparator }),
                  ],
                }),
              e?.maxLength != null &&
                (0, W.jsxs)(`div`, {
                  className: $[`info-row`],
                  children: [
                    (0, W.jsx)(`span`, {
                      className: $[`info-label`],
                      children: `段落长度：`,
                    }),
                    (0, W.jsx)(`span`, { children: e.maxLength }),
                  ],
                }),
            ],
          }),
          (0, W.jsx)(y, {
            type: `primary`,
            block: !0,
            onClick: () => n(-1),
            children: `前往文档列表 →`,
          }),
        ],
      }),
    });
  }),
  xt = {
    section: `_section_10kh8_7`,
    "steps-wrapper": `_steps-wrapper_10kh8_19`,
    tabs: `_tabs_10kh8_60`,
    "confirm-modal": `_confirm-modal_10kh8_88`,
  };
v();
var St = [
    { title: `文档上传` },
    { title: `文档分段选择` },
    { title: `文档审核` },
    { title: `处理并发布` },
  ],
  Ct = `document_import_oss`,
  wt = (0, U.memo)(() => {
    let e = le(),
      { pathname: t, state: n } = se(),
      { baseId: r, docId: i, docIdList: a, step: o } = n || {},
      s = (e) =>
        e === 0
          ? J.Segment
          : [1, 2, 3].includes(e ?? -1)
            ? J.Review
            : [4, 5].includes(e ?? -1)
              ? J.Publish
              : J.Upload,
      c = (0, U.useRef)(null),
      [l] = M.useForm(),
      u = (0, U.useRef)(!1),
      d = (0, U.useRef)(),
      f = (0, U.useRef)([]),
      m = (0, U.useRef)(null),
      [h, g] = (0, U.useState)(i ? s(o) : J.Upload),
      [_, v] = (0, U.useState)(!1),
      [b, x] = (0, U.useState)(!1),
      [S, C] = (0, U.useState)({}),
      [w, T] = (0, U.useState)(i),
      [E, O] = (0, U.useState)(a || []),
      [A, j] = ne.useModal();
    (0, U.useEffect)(() => {
      a?.length &&
        O(
          a
            .map((e) => ({ ...e, suffix: e.docName?.split(`.`).pop() }))
            .sort((e, t) =>
              e.docId === w
                ? -1
                : t.docId === w
                  ? 1
                  : e.docId.localeCompare(t.docId),
            ),
        );
    }, [a, w]);
    let N = (0, U.useCallback)(
        async (e = `当前步骤将不可撤回，确认进入下一步吗？`) =>
          new Promise((t) => {
            A.confirm({
              title: `提示`,
              icon: (0, W.jsx)(k, {}),
              closable: !1,
              width: 480,
              content: (0, W.jsx)(`div`, {
                style: { padding: 8 },
                children: e,
              }),
              onOk: (e) => {
                (e(), t(!1));
              },
              onCancel: () => t(!0),
            });
          }),
        [A],
      ),
      P = (0, U.useCallback)(
        async (e, t) => {
          (window.clearTimeout(d.current), v(!0));
          let n = t || w;
          if (!n) return (v(!1), { code: -1, data: null });
          let { code: r, data: i } = await H.queryBaseInfo(
              { docId: n },
              { _cancelToken: Ct },
            ),
            a = i?.step ?? e?.step ?? 0,
            o = i?.docStatus ?? e?.docStatus ?? 0,
            s =
              ([1, 2].includes(a) && o !== 2) ||
              (a === 4 && [0, 1].includes(o));
          if (r === 0) {
            let e = 1;
            (i?.step < 4 && (e = 1),
              i?.step === 4 && (e = i?.docStatus === 2 ? 3 : 2),
              i?.step === 5 && (e = 5),
              i?.step === 6 && (e = 4),
              (i._docState = e),
              C(i));
          }
          if (E?.length > 1 && [1, 2, 3].includes(i?.step)) {
            let e = E.map((e) => e.docId);
            s = !(await H.getDocListStatus({ docIds: e }))?.data?.every(
              (e) =>
                !(
                  ([1, 2].includes(e.step) && e.docStatus !== 2) ||
                  (e.step === 4 && [0, 1].includes(e.docStatus))
                ),
            );
          }
          return (
            x(s),
            !s && v(!1),
            s && (d.current = setTimeout(() => P(i || e, t), 5 * 1e3)),
            { code: r, data: i }
          );
        },
        [w, E],
      );
    ((0, U.useEffect)(
      () => (
        I(w) || (v(!0), P().finally(() => v(!1))),
        () => {
          (window.clearTimeout(d.current), L.cancel(Ct));
        }
      ),
      [w],
    ),
      (0, U.useEffect)(() => {
        if (I(S?.step)) {
          I(w) && g(J.Upload);
          return;
        }
        S.step === 0
          ? g(J.Segment)
          : [1, 2, 3].includes(S.step)
            ? g(J.Review)
            : [4, 5].includes(S.step) && g(J.Publish);
      }, [S?.step, w]));
    let ae = async () => {
        if (!I(w)) return (g(1), !0);
        v(!0);
        try {
          let e = await c.current?.send();
          return !e?.success || !e.ossResults?.length
            ? !1
            : ((f.current = e.ossResults), (u.current = !1), !0);
        } catch (e) {
          return (
            console.error(`文件上传失败:`, e),
            D.error(`文件上传失败，请重试`),
            !1
          );
        } finally {
          v(!1);
        }
      },
      F = (0, U.useCallback)(async () => {
        if (!I(w)) {
          g(2);
          return;
        }
        let i;
        try {
          i = await l.validateFields();
        } catch {
          D.warning(`请填写完整`);
          return;
        }
        if (!f.current.length) {
          D.error(`文件不存在，请重新上传`);
          return;
        }
        if (!(await N())) {
          v(!0);
          try {
            let { code: a, data: o } = await ie({
              baseId: r,
              fileDetails: f.current.map((e) => ({
                ossKey: e.ossKey,
                fileName: e.fileName,
                totalSpace: e.size,
                ...i,
              })),
            });
            if (a !== 0) {
              D.error(`创建文档记录失败`);
              return;
            }
            let s = (o?.docIds || []).map((e, t) => ({
                docId: String(e),
                docName: f.current[t]?.fileName || ``,
                suffix: f.current[t]?.fileName?.split(`.`).pop(),
              })),
              c = s[0]?.docId;
            if (!c) {
              D.error(`创建文档记录失败`);
              return;
            }
            if ((await re({ docIds: s.map((e) => e.docId) }))?.code !== 0)
              return;
            ((u.current = !1),
              (f.current = []),
              e(t, { state: { ...n, docId: c, docIdList: s }, replace: !0 }),
              O(s),
              g(2),
              T(c));
          } catch (e) {
            (console.error(`创建文档记录失败:`, e),
              D.error(`创建文档记录失败，请重试`));
          } finally {
            v(!1);
          }
        }
      }, [w, r, l, e, t, n, N]),
      oe = (0, U.useCallback)(async () => {
        if (I(w)) {
          D.info(`参数异常，请刷新或退出重试`);
          return;
        }
        if (await N(`确定发布吗？`)) return;
        let e = () => {
          ((u.current = !1), g(3), P());
        };
        v(!0);
        let {
          code: t,
          result: n,
          map: r,
        } = await ve(w, !0, e, void 0, E?.length ? E : [S]);
        if (t === 0) {
          e();
          return;
        }
        (t === 101 && (m.current = { result: n, map: r }), v(!1));
      }, [w, E, S, N, P]),
      ce = (0, U.useCallback)(async () => {
        if (h === J.Upload) {
          if (await N()) return;
          (await ae()) && g(J.Segment);
        } else h === J.Segment && (await F());
      }, [h, N, ae, F]),
      R = (0, U.useCallback)(() => {
        e(-1);
      }, [e]);
    (0, U.useEffect)(
      () => () => {
        (L.cancel(Ct), window.clearTimeout(d.current));
      },
      [],
    );
    let z = [
        { key: `0`, label: `文档上传`, children: (0, W.jsx)(st, { ref: c }) },
        {
          key: `1`,
          label: `文档分段选择`,
          children: (0, W.jsx)(gt, { form: l, isChange: u }),
        },
        {
          key: `2`,
          label: `文档审核`,
          children: (0, W.jsx)(he, {
            state: S,
            getInfo: P,
            docIdList: E,
            sensitiveWords: m.current,
            platformDisabled: !1,
          }),
        },
        {
          key: `3`,
          label: `处理并发布`,
          children: (0, W.jsx)(bt, { state: S, docIdList: E }),
        },
      ],
      B =
        h === 3
          ? []
          : [
              (0, W.jsxs)(
                p,
                {
                  children: [
                    (0, W.jsx)(y, {
                      onClick: R,
                      disabled: _ && !b,
                      children: `取消`,
                    }),
                    [0, 1].includes(h) &&
                      (0, W.jsx)(y, {
                        type: `primary`,
                        onClick: ce,
                        loading: _,
                        children: `下一步`,
                      }),
                    h === 2 &&
                      (0, W.jsx)(y, {
                        type: `primary`,
                        loading: _,
                        disabled: b,
                        onClick: oe,
                        children: `确认并发布`,
                      }),
                  ],
                },
                `footer`,
              ),
            ];
    return (0, W.jsxs)(de, {
      title: `知识导入`,
      showBack: !0,
      onBack: R,
      showFooter: B.length > 0,
      footerButtons: B,
      contentClassName: xt.section,
      children: [
        (0, W.jsx)(`div`, {
          className: xt[`steps-wrapper`],
          children: (0, W.jsx)(te, { current: h, items: St }),
        }),
        (0, W.jsx)(ee, {
          className: xt.tabs,
          items: z,
          activeKey: String(h),
          renderTabBar: () => (0, W.jsx)(W.Fragment, {}),
        }),
        j,
      ],
    });
  }),
  Tt = U.memo(() => {
    let { state: e } = se();
    return e?.platformType === 1 ? (0, W.jsx)(wt, {}) : (0, W.jsx)(ze, {});
  });
export { Tt as default };
