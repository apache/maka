import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  Hi as i,
  Ii as a,
  Jt as o,
  K as s,
  Kt as c,
  Or as l,
  Qr as u,
  Vt as d,
  Yi as f,
  dr as p,
  fi as m,
  hn as h,
  nn as g,
  or as _,
  rr as v,
  sa as y,
  wr as b,
  yr as x,
} from "./vendor-antd.QfSgOu5e.js";
import { n as S } from "./client-BfElcTb7.js";
import { t as C } from "./debounce-DLVkj6TJ.js";
import { t as w } from "./dateUtils-BwspljNz.js";
import { t as T } from "./url-action-BsTcWDLi.js";
import { n as E, r as D } from "./numberUtils-Bo2mH4mp.js";
import {
  g as O,
  i as k,
  l as A,
  t as j,
  u as M,
} from "./knowledge-B15iS6D5.js";
import { t as N } from "./knowledge-model-config-2k16YL5C.js";
import { t as P } from "./cloneDeep-CEBYuDXu.js";
import { t as F } from "./AgentTable-DMLUccn2.js";
import { t as ee } from "./TooltipEllipsis-4_dXZz0S.js";
import { t as te } from "./RadioFormPanel-C_EoliyO.js";
import {
  D as I,
  F as ne,
  Nt as re,
  St as L,
  Tt as R,
  Y as ie,
  a as z,
  ct as ae,
  q as oe,
  u as se,
} from "./index.B_LPe2F7.js";
import { t as ce } from "./ListLayout-B8lj_6O3.js";
import { t as le } from "./components2-DnLGrzOm.js";
d();
var B = e(t(), 1),
  V = n(),
  H = ({ agentType: e, agentStyleOptions: t, isAdd: n }) => {
    let r = (0, B.useMemo)(
        () => t.find((t) => t.value === e)?.label || ``,
        [e, t],
      ),
      i = (0, B.useMemo)(
        () => t.find((t) => t.value === e)?.tips || ``,
        [e, t],
      );
    return (0, V.jsxs)(`div`, {
      children: [
        (0, V.jsxs)(`p`, {
          style: {
            fontSize: 16,
            fontWeight: 600,
            marginTop: 0,
            marginBottom: 10,
          },
          children: [n ? `新建` : `编辑`, r],
        }),
        (0, V.jsx)(`p`, {
          style: {
            fontSize: 14,
            color: `#7B7D85`,
            marginTop: 0,
            marginBottom: 24,
          },
          children: i,
        }),
      ],
    });
  };
H.displayName = `FormHeaderMemo`;
var U = B.memo(H),
  W = { 0: `文本`, 1: `表格`, 2: `问答`, 3: `音视频` },
  ue = [
    { label: `全部类型`, value: null },
    ...Object.keys(W).map((e) => ({ label: W[e], value: Number(e) })),
  ],
  G = [
    {
      label: `文本知识库`,
      value: 0,
      icon: `text-knowledge`,
      description: `新建文本，丰富知识来源`,
      tips: `对新建的文本进行学习，并基于文本进行作答。`,
    },
    {
      label: `表格知识库`,
      value: 1,
      icon: `table-knowledge`,
      description: `新建表格，提升回答标准性`,
      tips: `将对导入的表格进行学习，并基于表格进行作答。`,
    },
    {
      label: `问答知识库`,
      value: 2,
      icon: `question-knowledge`,
      description: `新建问答，提升回答准确性`,
      tips: `将对导入的问答进行学习，并基于问题进行作答。`,
    },
    {
      label: `音视频知识库`,
      value: 3,
      icon: `audio-video-knowledge`,
      description: `支持音频转写、视频抽帧和时间段溯源`,
      tips: `支持会议录音、培训音频和操作视频入库，可按时间段溯源回答。`,
    },
  ],
  K = Number(Object.keys(W)[2]),
  q = { 3: `仅自己可见`, 2: `授权可见`, 1: `公开` },
  J = [
    {
      label: q[3],
      value: 3,
      tips: `当前账号可查看和管理、上级仅可查看、同级与下级不可查看；`,
    },
    {
      label: q[2],
      value: 2,
      tips: `当前账号可查看和管理、上级与授权的下级可查看、同级不可查看；`,
    },
    {
      label: q[1],
      value: 1,
      tips: `当前账号可查看和管理、上级与所有下级可查看、同级不可查看；`,
    },
  ],
  Y = {
    total: `_total_ricam_3`,
    body: `_body_ricam_9`,
    "delete-tip": `_delete-tip_ricam_12`,
    "list-box": `_list-box_ricam_15`,
    wrapper: `_wrapper_ricam_34`,
    item: `_item_ricam_37`,
    icon: `_icon_ricam_50`,
    type: `_type_ricam_68`,
    "text-type": `_text-type_ricam_77`,
    "table-type": `_table-type_ricam_81`,
    "audio-video-type": `_audio-video-type_ricam_85`,
    table: `_table_ricam_81`,
    content: `_content_ricam_95`,
    title: `_title_ricam_98`,
    description: `_description_ricam_103`,
    config: `_config_ricam_116`,
    controls: `_controls_ricam_136`,
    more: `_more_ricam_143`,
    "grant-codes": `_grant-codes_ricam_154`,
    "knowledge-list": `_knowledge-list_ricam_160`,
    "knowledge-list-base-type-tag": `_knowledge-list-base-type-tag_ricam_163`,
    "knowledge-list-table": `_knowledge-list-table_ricam_175`,
    "tag-structure-header": `_tag-structure-header_ricam_232`,
    "header-actions": `_header-actions_ricam_235`,
  },
  de = [
    { label: `租户`, value: 1 },
    { label: `机构`, value: 2 },
  ],
  fe = {
    "text-embedding-v3": {
      dimension: 1536,
      multiLang: !0,
      normalized: !0,
      scene: `商业化成熟稳定`,
    },
    "text-embedding-v4": {
      dimension: 1536,
      multiLang: !0,
      normalized: !0,
      scene: `新一代模型，效果更优，推荐默认`,
    },
  },
  pe = {
    "qwen3-rerank": {
      type: `Qwen LLM底座`,
      feature: `支持 100+语种和长文本，Query+Docs 相关性排序`,
      scene: `通用检索排序、多语种场景`,
    },
  },
  X = {
    NAME_MIN_LENGTH: 3,
    NAME_MAX_LENGTH: 10,
    DESCRIPTION_MAX_LENGTH: 500,
    DEFAULT_ACCESS_SCOPE: 3,
    DEFAULT_ACCESS_TYPE: 1,
    DEFAULT_EMBED_TYPE: 1,
    RESTRICTED_ACCESS_SCOPE: 2,
  };
function me({ disabled: e, className: t = ``, ...n }) {
  let r = (0, B.useMemo)(() => (e ? 24 : 12), [e]),
    i = (0, B.useMemo)(
      () => [`global-radio-box-hidden`, t].filter(Boolean).join(` `),
      [t],
    );
  return (0, V.jsx)(m.Group, {
    ...n,
    className: i,
    disabled: e,
    children: (0, V.jsx)(h, {
      gutter: [16, 0],
      children: se.map((e) =>
        (0, V.jsx)(
          u,
          {
            span: r,
            children: (0, V.jsx)(m, {
              value: e.value,
              children: (0, V.jsxs)(h, {
                wrap: !1,
                children: [
                  (0, V.jsx)(u, {
                    className: `global-radio-icon`,
                    children: (0, V.jsx)(`img`, { src: e.icon, alt: e.label }),
                  }),
                  (0, V.jsxs)(u, {
                    flex: 1,
                    children: [
                      (0, V.jsx)(c.Title, { level: 5, children: e.label }),
                      (0, V.jsx)(c.Text, { children: e.tooltip }),
                    ],
                  }),
                ],
              }),
            }),
          },
          e.value,
        ),
      ),
    }),
  });
}
var he = (0, B.forwardRef)(function (
  {
    disabled: e,
    form: t,
    orgList: n,
    tenantList: i,
    tenantCode: s,
    baseType: l,
    platformType: u,
    open: d,
  },
  f,
) {
  let p = x.useWatch(`baseType`, t),
    h = l ?? p ?? t.getFieldValue(`baseType`) ?? 0,
    _ = x.useWatch(`accessScope`, t) ?? X.DEFAULT_ACCESS_SCOPE,
    v = x.useWatch(`accessType`, t) ?? X.DEFAULT_ACCESS_TYPE,
    S = (0, B.useCallback)(
      (e) => {
        t.setFieldsValue({ accessType: e, grantIdentifiers: [], authOrgs: [] });
      },
      [t],
    ),
    C = (0, B.useCallback)(
      (e) => {
        t.setFieldsValue({
          accessScope: e,
          ...(e === X.RESTRICTED_ACCESS_SCOPE ? {} : { grantIdentifiers: [] }),
        });
      },
      [t],
    ),
    w = (0, B.useMemo)(() => {
      let e = i.length === 1;
      return i.map((t) => ({
        label: t.tenantName,
        value: t.tenantCode,
        disabled: e || t.tenantCode === s,
      }));
    }, [i, s]),
    T = (0, B.useMemo)(
      () =>
        J.map((e) => ({
          ...e,
          label: (0, V.jsx)(b, {
            align: `center`,
            children: (0, V.jsx)(`span`, {
              style: { marginRight: 4 },
              children: e.label,
            }),
          }),
          value: e.value,
        })),
      [],
    ),
    E = (0, B.useMemo)(
      () => (n.length === 1 ? n.map((e) => ({ ...e, disabled: !0 })) : n),
      [n],
    ),
    D = (0, B.useMemo)(() => Number(h) === 0 && u === 0, [h, u]),
    O = (0, B.useMemo)(() => {
      let e = Number(h);
      return e === 1 || e === 2 || D;
    }, [h, D]),
    k = (0, B.useMemo)(() => {
      let e = Number(h);
      return (e === 0 && !D) || e === 3;
    }, [h, D]),
    A = N((e) => e.config),
    j = N((e) => e.fetchConfig);
  (0, B.useEffect)(() => {
    j();
  }, [j]);
  let M = A?.embeddingModels ?? [],
    P = A?.rerankModels ?? [];
  (0, B.useEffect)(() => {
    if (e || !k || !A) return;
    let n =
        t.getFieldValue([`knowledge`, `embeddingModel`]) ||
        t.getFieldValue(`embeddingModel`),
      r =
        t.getFieldValue([`knowledge`, `rerankModel`]) ||
        t.getFieldValue(`rerankModel`),
      i = {};
    (!n && M[0] && (i.embeddingModel = M[0]),
      !r && P[1] && (i.rerankModel = P[1]),
      Object.keys(i).length && t.setFieldsValue(i));
  }, [e, k, A, M, P, t, d]);
  let F = !D;
  return (0, V.jsxs)(te, {
    form: t,
    options: G,
    defaultValue: l,
    disabled: e,
    fieldRules: [z.selectRequired],
    fieldName: `baseType`,
    fieldLabel: `类型`,
    children: [
      (0, V.jsx)(U, { agentType: h, agentStyleOptions: G, isAdd: !e }),
      (0, V.jsx)(x.Item, {
        noStyle: !0,
        name: `baseId`,
        children: (0, V.jsx)(r, { type: `hidden` }),
      }),
      (0, V.jsx)(x.Item, {
        name: `name`,
        label: `名称`,
        rules: [
          z.required,
          z.whitespace,
          z.textReg,
          {
            type: `string`,
            max: X.NAME_MAX_LENGTH,
            message: `最多可输入${X.NAME_MAX_LENGTH}个字符`,
          },
          {
            type: `string`,
            min: X.NAME_MIN_LENGTH,
            message: `至少输入${X.NAME_MIN_LENGTH}个字符`,
          },
        ],
        children: (0, V.jsx)(r, {
          placeholder: `${X.NAME_MIN_LENGTH}-${X.NAME_MAX_LENGTH}字以内，支持中英文、数字、中/下划线`,
          showCount: {
            formatter: (e) => `${e?.count ?? 0}/${X.NAME_MAX_LENGTH}`,
          },
        }),
      }),
      (0, V.jsx)(x.Item, {
        name: `describe`,
        label: `描述`,
        rules: [
          z.required,
          z.whitespace,
          {
            type: `string`,
            max: X.DESCRIPTION_MAX_LENGTH,
            message: `已超限制字数，请删减后重新输入`,
          },
        ],
        children: (0, V.jsx)(r.TextArea, {
          className: `global-textarea-show-count`,
          placeholder: `请描述创建目的、修改内容等，${X.DESCRIPTION_MAX_LENGTH}字以内`,
          showCount: {
            formatter: (e) => `${e?.count ?? 0}/${X.DESCRIPTION_MAX_LENGTH}`,
          },
          autoSize: { minRows: 6, maxRows: 8 },
        }),
      }),
      F &&
        (0, V.jsxs)(x.Item, {
          label: `权限设置`,
          className: Y[`grant-codes`],
          children: [
            (0, V.jsx)(x.Item, {
              name: `accessType`,
              label: `权限类型`,
              initialValue: X.DEFAULT_ACCESS_TYPE,
              style: { marginBottom: 0 },
              children: (0, V.jsx)(m.Group, {
                disabled: e,
                onChange: (e) => S(e.target.value),
                options: de,
              }),
            }),
            (0, V.jsx)(x.Item, {
              label: `谁可以看`,
              name: `accessScope`,
              initialValue: X.DEFAULT_ACCESS_SCOPE,
              style: { marginBottom: 0 },
              children: (0, V.jsx)(m.Group, {
                disabled: e,
                onChange: (e) => C(e.target.value),
                options: T,
              }),
            }),
            _ === X.RESTRICTED_ACCESS_SCOPE
              ? (0, V.jsx)(x.Item, {
                  name: `grantIdentifiers`,
                  label: `权限范围`,
                  rules: [
                    {
                      required: !0,
                      message: `请选择授权${v === 1 ? `用户` : `机构`}`,
                    },
                  ],
                  style: { marginBottom: 0 },
                  noStyle: !0,
                  children:
                    v === 1
                      ? (0, V.jsx)(a, {
                          mode: `multiple`,
                          disabled: e,
                          allowClear: !0,
                          showSearch: !0,
                          optionFilterProp: `children`,
                          placeholder: `请选择授权用户`,
                          options: w,
                          style: { paddingLeft: 70 },
                          filterOption: (e, t) =>
                            (t?.label ?? ``)
                              .toLowerCase()
                              .includes(e.toLowerCase()),
                        })
                      : (0, V.jsx)(o, {
                          disabled: e,
                          treeData: E,
                          multiple: !0,
                          treeCheckable: !0,
                          treeCheckStrictly: !0,
                          treeDefaultExpandAll: !0,
                          showCheckedStrategy: o.SHOW_ALL,
                          style: { paddingLeft: 70 },
                          fieldNames: { label: `orgName`, value: `orgId` },
                          placeholder: `请选择授权机构`,
                        }),
                })
              : null,
          ],
        }),
      O
        ? (0, V.jsxs)(x.Item, {
            label: `向量化方式`,
            required: !0,
            children: [
              !e &&
                (0, V.jsx)(y, {
                  message: `创建知识库后，向量化方式将不可修改`,
                  showIcon: !0,
                  type: `warning`,
                  style: { marginBottom: 10 },
                }),
              (0, V.jsx)(x.Item, {
                name: `embedType`,
                initialValue: X.DEFAULT_EMBED_TYPE,
                noStyle: !0,
                children: (0, V.jsx)(me, { disabled: e }),
              }),
            ],
          })
        : null,
      k
        ? (0, V.jsxs)(V.Fragment, {
            children: [
              (0, V.jsx)(x.Item, {
                label: `向量模型`,
                required: !0,
                children: (0, V.jsx)(x.Item, {
                  name: `embeddingModel`,
                  noStyle: !0,
                  rules: [{ required: !0, message: `请选择向量模型` }],
                  children: (0, V.jsx)(a, {
                    placeholder: `请选择向量模型`,
                    optionLabelProp: `label`,
                    disabled: e,
                    children: M.map((e) => {
                      let t = fe[e];
                      return (0, V.jsxs)(
                        a.Option,
                        {
                          value: e,
                          label: e,
                          children: [
                            (0, V.jsxs)(`div`, {
                              style: {
                                display: `flex`,
                                alignItems: `center`,
                                justifyContent: `space-between`,
                              },
                              children: [
                                (0, V.jsx)(`span`, { children: e }),
                                t
                                  ? (0, V.jsxs)(`span`, {
                                      children: [
                                        t.dimension
                                          ? (0, V.jsxs)(g, {
                                              color: `blue`,
                                              children: [t.dimension, `维`],
                                            })
                                          : null,
                                        t.multiLang &&
                                          (0, V.jsx)(g, {
                                            color: `green`,
                                            children: `多语种`,
                                          }),
                                        t.normalized &&
                                          (0, V.jsx)(g, {
                                            color: `orange`,
                                            children: `归一化`,
                                          }),
                                      ],
                                    })
                                  : null,
                              ],
                            }),
                            t?.scene
                              ? (0, V.jsx)(c.Text, {
                                  type: `secondary`,
                                  style: { fontSize: 12 },
                                  children: t.scene,
                                })
                              : null,
                          ],
                        },
                        e,
                      );
                    }),
                  }),
                }),
              }),
              (0, V.jsx)(x.Item, {
                label: `排序模型`,
                required: !0,
                children: (0, V.jsx)(x.Item, {
                  name: `rerankModel`,
                  noStyle: !0,
                  rules: [{ required: !0, message: `请选择排序模型` }],
                  children: (0, V.jsx)(a, {
                    placeholder: `请选择排序模型`,
                    optionLabelProp: `label`,
                    disabled: e,
                    children: P.map((e) => {
                      let t = pe[e];
                      return (0, V.jsxs)(
                        a.Option,
                        {
                          value: e,
                          label: e,
                          children: [
                            (0, V.jsxs)(`div`, {
                              style: {
                                display: `flex`,
                                alignItems: `center`,
                                justifyContent: `space-between`,
                              },
                              children: [
                                (0, V.jsx)(`span`, { children: e }),
                                t?.type
                                  ? (0, V.jsx)(g, {
                                      color: `purple`,
                                      children: t.type,
                                    })
                                  : null,
                              ],
                            }),
                            t?.feature
                              ? (0, V.jsx)(c.Text, {
                                  type: `secondary`,
                                  style: { fontSize: 12 },
                                  children: t.feature,
                                })
                              : null,
                            t?.scene
                              ? (0, V.jsxs)(c.Text, {
                                  type: `secondary`,
                                  style: { fontSize: 12 },
                                  children: [`适用场景：`, t.scene],
                                })
                              : null,
                          ],
                        },
                        e,
                      );
                    }),
                  }),
                }),
              }),
            ],
          })
        : null,
    ],
  });
});
d();
var Z = { WIDTH: 896, SET_FIELDS_VALUE_DELAY: 0 },
  Q = (0, B.forwardRef)(
    ({ onSuccess: e, orgList: t, tenantList: n, tenantCode: r }, i) => {
      let [a] = x.useForm(),
        [o, s] = (0, B.useState)(!1),
        [c, l] = (0, B.useState)(void 0),
        [u, d] = (0, B.useState)(void 0),
        [f, m] = (0, B.useState)(0),
        [h, g] = (0, B.useState)(!1),
        y = (0, B.useRef)(null),
        b = (0, B.useCallback)(async () => {
          try {
            let t = await a.validateFields();
            g(!0);
            let n = { ...t };
            if (
              (n.grantIdentifiers &&
                Array.isArray(n.grantIdentifiers) &&
                (n.grantIdentifiers = n.grantIdentifiers.map((e) =>
                  typeof e == `object` && e ? e.value || e : String(e),
                )),
              c?.baseId)
            ) {
              let t = await O({
                baseId: c.baseId,
                name: n.name,
                describe: n.describe,
                baseType: n.baseType,
                accessScope: n.accessScope,
                accessType: n.accessType,
                embedType: n.embedType,
                embeddingModelName: n.embeddingModel,
                rerankModelName: n.rerankModel,
                grantIdentifiers: n.grantIdentifiers,
              });
              t.code === 0
                ? (_.success(`编辑成功`),
                  a.resetFields(),
                  s(!1),
                  l(void 0),
                  e?.())
                : _.error(t.msg || `操作失败`);
            } else {
              let t = n.baseType ?? 0,
                r = +(t === 0 || t === 3),
                i = await j({
                  name: n.name,
                  describe: n.describe,
                  baseType: t,
                  platformType: r,
                  accessScope: n.accessScope ?? 3,
                  accessType: n.accessType ?? 1,
                  embedType: n.embedType,
                  embeddingModelName: n.embeddingModel,
                  rerankModelName: n.rerankModel,
                  rerankMode: n.rerankMode,
                  grantIdentifiers: n.grantIdentifiers,
                });
              i.code === 0
                ? (_.success(`创建成功`),
                  a.resetFields(),
                  s(!1),
                  l(void 0),
                  d(void 0),
                  e?.())
                : _.error(i.msg || `操作失败`);
            }
          } catch (e) {
            if (e?.errorFields?.length > 0) {
              let t = e.errorFields[0]?.name?.[0];
              t && a.scrollToField(t);
            }
          } finally {
            g(!1);
          }
        }, [a, c, e]),
        S = (0, B.useCallback)(() => {
          (a.resetFields(), s(!1), l(void 0), d(void 0));
        }, [a]);
      (0, B.useImperativeHandle)(
        i,
        () => ({
          open: (e, t) => {
            (m((e) => e + 1), l(e), d(t), s(!0));
          },
          close: () => {
            (s(!1), l(void 0), d(void 0), a.resetFields());
          },
        }),
        [a],
      );
      let C = (0, B.useCallback)(
          (e) => {
            let { baseName: t = ``, description: n = ``, ...r } = e;
            a.setFieldsValue({ name: t, describe: n, ...r });
          },
          [a],
        ),
        w = (0, B.useCallback)(
          async (e) => {
            try {
              g(!0);
              let t = await A(e.baseId);
              t.code === 0 &&
                C({
                  ...e,
                  baseName: t.data.name || e.baseName,
                  description: t.data.describe || e.description,
                  embeddingModel: t.data.embeddingModelName,
                  rerankModel: t.data.rerankModelName,
                });
            } finally {
              g(!1);
            }
          },
          [C],
        );
      (0, B.useEffect)(() => {
        if (!o) {
          a.resetFields();
          return;
        }
        return (
          c?.baseId ? w(c) : u !== void 0 && a.setFieldsValue({ baseType: u }),
          () => {
            y.current &&= (clearTimeout(y.current), null);
          }
        );
      }, [o, c, u, a, w]);
      let T = c ? `编辑知识库` : `新建知识库`,
        E = {
          labelCol: { style: { minWidth: `100%` } },
          wrapperCol: { style: { minWidth: `100%` } },
          labelAlign: `left`,
        };
      return (0, V.jsx)(v, {
        title: T,
        open: o,
        onOk: b,
        onCancel: S,
        width: c ? 720 : Z.WIDTH,
        confirmLoading: h,
        keyboard: !1,
        okText: c ? `确定` : `立即新建`,
        styles: { body: { ...re.body, padding: c ? `0` : `0 0 0 24px` } },
        children: (0, V.jsx)(p, {
          spinning: h,
          style: { minHeight: 500 },
          children: (0, V.jsx)(x, {
            form: a,
            ...E,
            children: (0, V.jsx)(
              he,
              {
                disabled: !!c,
                form: a,
                orgList: t,
                tenantList: n,
                tenantCode: r,
                baseType: c?.baseType ?? u,
                platformType: c?.platformType,
                open: o,
              },
              f,
            ),
          }),
        }),
      });
    },
  );
Q.displayName = `CreateLibraryModal`;
var ge = e(P(), 1);
async function _e(e) {
  return ne(
    `post`,
    `/agent-microapp/microAppVersion/checkKnowledgeAssociation`,
    e,
  );
}
d();
var ve = (e) => {
    let t = e.accessScope;
    return L(t) ? `-` : J?.find((e) => e.value === t)?.label || `-`;
  },
  ye = (e) => {
    let t =
      e.updateTime ||
      e.updatedAt ||
      e.latestEditTime ||
      e.latestUpdateTime ||
      e.gmtModified ||
      e.modifyTime;
    return t ? w(t, `YYYY-MM-DD HH:mm`) : `-`;
  },
  $ = (0, B.memo)(
    ({
      loading: e,
      state: t,
      dataSource: n,
      openCreateModal: r,
      form: a,
      checkTabs: o,
    }) => {
      let u = ie(),
        d = (0, B.useRef)(),
        [f, p] = (0, B.useState)(null),
        [m, h] = v.useModal(),
        g = (0, B.useCallback)(
          (e) => {
            e.baseType === K
              ? u(R.AGENT_KNOWLEDGE_QA_DATABASE, {
                  state: { ...e, checkTabs: o },
                })
              : e.baseType === 3
                ? u(R.AGENT_KNOWLEDGE_AUDIO_VIDEO, {
                    state: { ...e, checkTabs: o },
                  })
                : u(R.AGENT_KNOWLEDGE_DOC, { state: { ...e, checkTabs: o } });
          },
          [u, o],
        ),
        y = (0, B.useCallback)(
          (e) => {
            ((t.current.name = null),
              (t.current.data = t.current.data.filter((t) => t.baseId !== e)),
              a.submit(),
              d.current?.reload(),
              d.current?.reset?.());
          },
          [t, a],
        ),
        b = (0, B.useCallback)(() => {
          ((t.current.name = null),
            (t.current.data = (0, ge.default)(t.current.data)),
            a.submit(),
            d.current?.reload(),
            d.current?.reset?.());
        }, [t, a]),
        x = (0, B.useCallback)(
          async (e) => {
            if (f) return;
            p(e.baseId);
            let t = ~~!e.isFavorite,
              n = e.baseId;
            try {
              (console.log(`[Mock] 收藏操作 - baseId: ${n}, isFavorite: ${t}`),
                _.success(t === 1 ? `收藏成功` : `取消收藏成功`),
                (e.isFavorite = t),
                b());
            } finally {
              p(null);
            }
          },
          [f, b],
        ),
        S = (0, B.useCallback)(
          async (e) => {
            let t = await _e({ baseId: e });
            if (t.errCode === 0) {
              if (t.data)
                return (
                  m.info({
                    title: `删除知识库`,
                    content: t.data,
                    closable: !0,
                    okText: `知道了`,
                  }),
                  t
                );
              let n = await k({ baseId: String(e) });
              return (n.code === 0 && (_.success(`删除成功`), y(e)), n);
            }
          },
          [m, y],
        ),
        C = (0, B.useCallback)(
          (e) => {
            m.confirm({
              title: `确认要删除该知识库吗？`,
              icon: (0, V.jsx)(s, {}),
              content: (0, V.jsx)(l, {
                direction: `vertical`,
                size: 12,
                children: (0, V.jsx)(`span`, {
                  className: Y[`delete-tip`],
                  children: `删除后不能恢复，需谨慎操作！`,
                }),
              }),
              okText: `确定`,
              cancelText: `取消`,
              onOk: () => S(e.baseId),
            });
          },
          [m, S],
        ),
        w = (0, B.useCallback)(
          async (e) => {
            let { current: t = 1, pageSize: r = 10 } = e,
              i = (t - 1) * r,
              a = i + r;
            return { data: n.slice(i, a), success: !0, total: n.length };
          },
          [n],
        ),
        T = (0, B.useMemo)(
          () => [
            {
              title: `知识库`,
              dataIndex: `baseName`,
              width: 300,
              fixed: `left`,
              ellipsis: !0,
              render: (e, t) =>
                (0, V.jsxs)(l, {
                  size: 4,
                  style: { width: `100%` },
                  children: [
                    (0, V.jsx)(ee, {
                      title: t.baseName,
                      style: { maxWidth: 180 },
                      children: t.baseName,
                    }),
                    (0, V.jsx)(`span`, {
                      className: Y[`knowledge-list-base-type-tag`],
                      children: W[t.baseType],
                    }),
                  ],
                }),
            },
            {
              title: `知识库描述`,
              dataIndex: `description`,
              width: 180,
              ellipsis: !0,
              hideInSearch: !0,
              render: (e, t) =>
                (0, V.jsx)(c.Text, {
                  ellipsis: { tooltip: t.description },
                  style: { width: 180 },
                  children: t.description,
                }),
            },
            {
              title: `授权范围`,
              dataIndex: `accessScope`,
              width: 120,
              hideInSearch: !0,
              render: (e, t) => {
                let n = ve(t);
                return n === `-` ? `-` : n;
              },
            },
            {
              title: `文档数量`,
              dataIndex: `docCount`,
              width: 120,
              hideInSearch: !0,
              render: (e, t) => (t.baseType === K ? `-` : D(t.docCount || 0)),
            },
            {
              title: `字符数`,
              dataIndex: `characterSize`,
              width: 120,
              hideInSearch: !0,
              render: (e, t) =>
                t.baseType === K ? `-` : E(t.characterSize || 0),
            },
            {
              title: `最新编辑`,
              dataIndex: `updateTime`,
              width: 160,
              hideInSearch: !0,
              render: (e, t) => ye(t),
            },
            {
              title: `操作`,
              valueType: `option`,
              width: 150,
              fixed: `right`,
              actionButtonsMax: 3,
              actionButtons: (e) => [
                {
                  key: `view`,
                  label: `查看`,
                  menuCode: I.KNOWLEDGE_VIEW,
                  onClick: (t) => {
                    (t.preventDefault(), t.stopPropagation(), g(e));
                  },
                },
                {
                  key: `edit`,
                  label: `编辑`,
                  menuCode: I.KNOWLEDGE_VIEW,
                  disabled: e.platformType !== 1 && e.baseType === 0,
                  onClick: (t) => {
                    (t.preventDefault(), t.stopPropagation(), r(e));
                  },
                },
                {
                  key: `delete`,
                  label: `删除`,
                  menuCode: I.KNOWLEDGE_FAVORITE,
                  disabled: e.platformType !== 1 && e.baseType === 0,
                  onClick: (t) => {
                    (t &&
                      typeof t.preventDefault == `function` &&
                      (t.preventDefault(), t.stopPropagation()),
                      C(e));
                  },
                },
              ],
            },
          ],
          [C, x, r, g],
        );
      (0, B.useEffect)(() => {
        (d.current?.reload(), d.current?.reset?.());
      }, [n]);
      let O = (0, V.jsx)(`div`, {
        style: { paddingTop: `1rem` },
        children: (0, V.jsx)(i, {
          description: L(t.current.name)
            ? (0, V.jsxs)(c.Text, {
                type: `secondary`,
                children: [
                  `暂无数据`,
                  t.current.data.length === 0
                    ? (0, V.jsxs)(V.Fragment, {
                        children: [
                          `，`,
                          (0, V.jsx)(c.Link, {
                            onClick: () => r(),
                            children: `新建知识库~`,
                          }),
                        ],
                      })
                    : null,
                ],
              })
            : (0, V.jsx)(c.Text, {
                type: `secondary`,
                children: `没有搜索到知识库`,
              }),
        }),
      });
      return (0, V.jsxs)(V.Fragment, {
        children: [
          (0, V.jsx)(F, {
            actionRef: d,
            rowKey: `baseId`,
            columns: T,
            request: w,
            loading: e,
            search: !1,
            scrollY: { type: `flex` },
            className: Y[`knowledge-list-table`],
            locale: { emptyText: O },
            options: { reload: !1 },
          }),
          h,
        ],
      });
    },
  );
$.displayName = `KnowledgeList`;
var be = (e, t) => {
    if (!t || !t.trim()) return e;
    let n = t.toLowerCase();
    return e.filter((e) => e.baseName.toLowerCase().includes(n));
  },
  xe = (e, t) => {
    if (!Array.isArray(e) || e.length === 0) return [];
    let n = new Set();
    return e.reduce((e, t) => {
      let r = t?.tenantCode;
      return (r && !n.has(r) && (n.add(r), e.push(t)), e);
    }, []);
  };
d();
var Se = (0, B.memo)(() => {
  let [e] = oe(),
    [t] = x.useForm(),
    [n, i] = (0, B.useState)(!1),
    [a, o] = (0, B.useState)([]),
    s = (0, B.useRef)({ data: [], name: null }),
    [c, l] = (0, B.useState)(null),
    { userInfo: u } = ae(),
    d = (0, B.useRef)(null),
    [p, m] = (0, B.useState)([]),
    [h, g] = (0, B.useState)([]),
    _ = (0, B.useCallback)(
      (e) => {
        let t = !e && c !== null ? c : void 0;
        d.current?.open(e, t);
      },
      [c],
    );
  (0, B.useEffect)(() => {
    e.get(`action`) === T.OPEN_ADD_KNOWLEDGE && _();
  }, [e]);
  let v = (0, B.useCallback)(({ name: e }) => {
      ((s.current.name = e ?? null),
        o([...(L(e) ? s.current.data : be(s.current.data, e || ``))]));
    }, []),
    y = (0, B.useCallback)(
      async (e = null) => {
        (i(!0), l(e), (s.current.name = null));
        try {
          let n = await M({ baseType: e, name: `` });
          n.code === 0 && ((s.current.data = n.data || []), t.submit());
        } finally {
          i(!1);
        }
      },
      [t],
    ),
    b = (0, B.useCallback)(async () => {
      await y(c);
    }, [y, c]),
    w = (0, B.useCallback)(async () => {
      try {
        let e = await S.getOrgList({ orgTreeFormat: !0, returnType: 2 }),
          t = await S.getTenantList({ pageRows: 1e3, pageIndex: 1 });
        (m(e || []), g(xe(t?.list || [], u?.tenant?.tenantCode) || []));
      } catch (e) {
        console.error(`获取机构列表和租户列表失败:`, e);
      }
    }, [u]);
  (0, B.useEffect)(() => {
    (y(), w());
  }, [y, w]);
  let E = (0, B.useCallback)(
      (e) => {
        (y(e), l(e));
      },
      [y],
    ),
    D = (0, B.useMemo)(
      () =>
        C((e) => {
          E(e);
        }, 500),
      [E],
    ),
    O = (0, B.useCallback)(
      (e) => {
        (l(e), i(!0), D(e));
      },
      [D],
    );
  return (
    (0, B.useEffect)(
      () => () => {
        D.cancel();
      },
      [D],
    ),
    (0, V.jsxs)(ce, {
      mode: `list`,
      title: `知识库`,
      items: (0, B.useMemo)(
        () =>
          ue.map((e) => ({
            key: e.value === null ? `all` : String(e.value),
            label: e.label,
          })),
        [],
      ),
      activeKey: c === null ? `all` : String(c),
      onChange: (0, B.useCallback)(
        (e) => {
          O(e === `all` ? null : Number(e));
        },
        [O],
      ),
      extra: (0, B.useMemo)(
        () =>
          (0, V.jsxs)(`div`, {
            className: Y[`header-actions`],
            children: [
              (0, V.jsx)(x, {
                name: `library_search`,
                layout: `inline`,
                form: t,
                onFinish: v,
                onValuesChange: () => t.submit(),
                children: (0, V.jsx)(x.Item, {
                  name: `name`,
                  noStyle: !0,
                  children: (0, V.jsx)(r, {
                    placeholder: `请输入知识库名称`,
                    allowClear: !0,
                  }),
                }),
              }),
              (0, V.jsx)(le, {
                menuCode: `1116`,
                children: (0, V.jsx)(f, {
                  type: `primary`,
                  onClick: () => _(),
                  children: `新建`,
                }),
              }),
            ],
          }),
        [t, v, _],
      ),
      children: [
        (0, V.jsx)($, {
          loading: n,
          state: s,
          dataSource: a,
          openCreateModal: _,
          form: t,
        }),
        (0, V.jsx)(Q, {
          ref: d,
          onSuccess: b,
          orgList: p,
          tenantList: h,
          tenantCode: u?.tenant?.tenantCode,
        }),
      ],
    })
  );
});
export { Se as default };
