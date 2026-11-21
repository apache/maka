import { o as e, r as t } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as n, t as r } from "./vendor-react.CV1S_bb1.js";
import {
  $ as i,
  Ai as a,
  Br as o,
  C as s,
  D as c,
  Gi as l,
  Ht as u,
  Kt as d,
  O as f,
  Pi as p,
  U as m,
  Vt as h,
  Y as g,
  Yi as _,
  _r as v,
  ci as y,
  dr as b,
  fi as x,
  it as S,
  lr as C,
  mr as w,
  nn as T,
  oi as E,
  or as D,
  rr as O,
  sa as k,
  tn as A,
  w as j,
  wr as M,
  yr as N,
} from "./vendor-antd.QfSgOu5e.js";
import {
  a as P,
  i as ee,
  n as F,
  r as I,
  t as te,
} from "./AICreateLoading-B3iChyVb.js";
import { t as L } from "./fileUtils-BjWnOXhL.js";
import { t as R } from "./industry-dict-C4tk0Vz4.js";
import { r as z } from "./agent-C0JAlTor.js";
import { t as ne } from "./imageValidator-CtF8BWgw.js";
import { r as B, s as V } from "./request-Cb6e7tFu.js";
import { i as re, n as ie, o as ae, t as oe } from "./micro-app-DNjru_4h.js";
import { v as se } from "./model-management-Cogr2EZi.js";
import { r as ce } from "./layouts-81g1VrIu.js";
import { t as le } from "./Select-BVLhUCvL.js";
import { t as ue } from "./Text-uTTksjIP.js";
import { t as de } from "./TextArea-BMhByJVA.js";
import { t as fe } from "./EditableTable-D2dj5guV.js";
import { t as pe } from "./TooltipEllipsis-4_dXZz0S.js";
import { t as me } from "./RadioFormPanel-C_EoliyO.js";
import { t as he } from "./app-Dnx7bwXT.js";
import {
  Dt as ge,
  J as _e,
  Nt as H,
  Tt as U,
  Y as ve,
  _t as ye,
  ct as be,
  lt as xe,
} from "./index.B_LPe2F7.js";
import { t as Se } from "./antd-img-crop.esm-Nzm_08Eq.js";
var Ce = (e) =>
    Array.isArray(e)
      ? e
      : typeof e == `string`
        ? e.split(`,`).filter(Boolean)
        : [],
  we = (e) =>
    e
      ? Array.isArray(e) && e.length > 0 && typeof e[0] == `object`
        ? e.map((e) => String(e.tagId)).filter(Boolean)
        : Array.isArray(e)
          ? e
          : typeof e == `string`
            ? e.split(`,`).filter(Boolean)
            : []
      : [],
  Te = (e, t) => {
    let n = new Map(t.map((e) => [e.id, e]));
    return e.map((e) => {
      let t = n.get(e);
      return t ? { tagId: e, tagName: t.name } : { tagId: e };
    });
  },
  Ee = /^1[3-9]\d{9}$/,
  De = /^\d{3}-\d{8}|\d{4}-\d{7}$/,
  Oe = (e) => Ee.test(e),
  ke = (e) => De.test(e),
  Ae = (e) => Ee.test(e) || De.test(e),
  je = (e = {}) => {
    let { type: t = `phoneOrTel`, message: n, required: r = !1 } = e,
      i =
        n ||
        {
          phone: `请输入正确的手机号`,
          tel: `请输入正确的座机号`,
          phoneOrTel: `请输入正确的手机号或者座机号`,
        }[t];
    return {
      validator: (e, n) => {
        if ((!r && (!n || !n.trim())) || (r && (!n || !n.trim())))
          return Promise.resolve();
        let a = !1;
        switch (t) {
          case `phone`:
            a = Oe(n);
            break;
          case `tel`:
            a = ke(n);
            break;
          case `phoneOrTel`:
            a = Ae(n);
            break;
          default:
            a = !1;
        }
        return a ? Promise.resolve() : Promise.reject(Error(i));
      },
    };
  },
  Me = (e = 225) => ({
    type: `string`,
    max: e,
    message: `最多可输入${e}个字符`,
  }),
  Ne = (e) => V({ url: `${B}/microApp/copy`, method: `post`, data: e }),
  Pe = (e) =>
    V({ url: `${B}/microAppVersion/copyVersion`, method: `post`, data: e }),
  Fe = (e) => V({ url: `${B}/microApp/deleteById`, method: `post`, data: e }),
  Ie = (e) =>
    V({ url: `${B}/microAppVersion/deleteById`, method: `post`, data: e }),
  Le = (e) =>
    V({ url: `${B}/microAppVersion/disable`, method: `post`, data: e }),
  Re = (e) =>
    V({ url: `${B}/microAppVersion/enable`, method: `post`, data: e }),
  ze = (e) =>
    V({ url: `${B}/microApp/findMicroAppPage`, method: `post`, data: e }),
  Be = (e) =>
    V({ url: `${B}/microAppVersion/create`, method: `post`, data: e }),
  Ve = (e) =>
    V({ url: `${B}/microAppVersion/getVersionPage`, method: `post`, data: e }),
  He = (e) =>
    V({
      url: `${B}/microAppVersion/getMicroAppVersionSdk`,
      method: `post`,
      data: e,
    }),
  Ue = (e) =>
    V({
      url: `${B}/microAppVersion/saveOrUpdateMicroAppVersionSdk`,
      method: `post`,
      data: e,
    }),
  We = (e) => V({ url: `${B}/file/uploadFile`, method: `post`, data: e });
h();
var W = e(n()),
  Ge = (e = ge.LLM) => {
    let [t, n] = (0, W.useState)([]),
      [r, i] = (0, W.useState)(!1),
      a = (0, W.useCallback)(async () => {
        i(!0);
        try {
          n(
            (
              await ye({
                treeFormat: !0,
                bizType: e,
                pageIndex: 1,
                pageRows: 1e3,
              })
            )?.data?.list || [],
          );
        } catch (e) {
          (console.error(`Failed to load homing tags:`, e),
            D.error(`加载标签数据失败`));
        } finally {
          i(!1);
        }
      }, [e]);
    (0, W.useEffect)(() => {
      a();
    }, [a]);
    let o = (0, W.useMemo)(() => {
      let e = new Map(),
        n = (t) => {
          t.forEach((t) => {
            (e.set(String(t.tagId), t), t.children && n(t.children));
          });
        };
      return (n(t), e);
    }, [t]);
    return {
      rawData: t,
      loading: r,
      tagsMap: o,
      getTagsByIds: (0, W.useCallback)(
        (e) =>
          e
            .map((e) => {
              let t = o.get(e);
              return t ? { id: String(t.tagId), name: t.tagName } : null;
            })
            .filter(Boolean),
        [o],
      ),
      refetch: a,
    };
  },
  G = {
    "create-agent": `_create-agent_xm1j3_1`,
    "ai-create-btn": `_ai-create-btn_xm1j3_76`,
    "ai-create-btn-loading": `_ai-create-btn-loading_xm1j3_86`,
    "avatar-uploader-text": `_avatar-uploader-text_xm1j3_92`,
    "avatar-divider": `_avatar-divider_xm1j3_97`,
    "run-mode-box": `_run-mode-box_xm1j3_102`,
    "run-mode-item": `_run-mode-item_xm1j3_109`,
    "run-mode-desc": `_run-mode-desc_xm1j3_114`,
    "run-mode-single-item": `_run-mode-single-item_xm1j3_119`,
    "run-mode-select-item": `_run-mode-select-item_xm1j3_122`,
    "avatar-gallery-item": `_avatar-gallery-item_xm1j3_125`,
    "avatar-gallery-mask": `_avatar-gallery-mask_xm1j3_134`,
    "avatar-image": `_avatar-image_xm1j3_137`,
    "action-icon": `_action-icon_xm1j3_159`,
    "action-select-circle": `_action-select-circle_xm1j3_167`,
    "avatar-selected-badge": `_avatar-selected-badge_xm1j3_180`,
    "tabal-op-btn": `_tabal-op-btn_xm1j3_195`,
  };
h();
var K = r(),
  Ke = W.memo(
    ({
      iconList: e,
      selectedUrl: t,
      onSelect: n,
      onDelete: r,
      onGenerate: a,
      onStopGenerate: o,
      loading: s,
      disabled: c,
      hasName: l,
    }) => {
      let u = e.length < 5,
        [d, f] = (0, W.useState)(!1),
        [h, g] = (0, W.useState)(``);
      return (0, K.jsxs)(K.Fragment, {
        children: [
          (0, K.jsxs)(M, {
            gap: 16,
            align: `center`,
            wrap: `wrap`,
            children: [
              e.map((e) => {
                let a = e.url === t;
                return (0, K.jsxs)(
                  `div`,
                  {
                    className: `${G[`avatar-gallery-item`]} ${a ? G[`avatar-gallery-item-selected`] : ``}`,
                    onClick: () => {
                      c || !e.url || n(a ? `` : e.url);
                    },
                    children: [
                      (0, K.jsx)(v, {
                        src: e.url,
                        width: 60,
                        height: 60,
                        preview: {
                          visible: !1,
                          src: h,
                          onVisibleChange: (e) => {
                            (f(e), e || g(``));
                          },
                        },
                        className: G[`avatar-image`],
                      }),
                      (0, K.jsxs)(`div`, {
                        className: G[`avatar-gallery-mask`],
                        onClick: (e) => e.stopPropagation(),
                        children: [
                          (0, K.jsx)(m, {
                            className: G[`action-icon`],
                            onClick: (t) => {
                              (t.stopPropagation(), g(e.url || ``), f(!0));
                            },
                          }),
                          !c &&
                            (0, K.jsx)(i, {
                              className: G[`action-icon`],
                              onClick: (t) => {
                                (t.stopPropagation(), r(e.uid));
                              },
                            }),
                          !a &&
                            !c &&
                            (0, K.jsx)(`div`, {
                              className: G[`action-select-circle`],
                              onClick: (t) => {
                                (t.stopPropagation(), e.url && n(e.url));
                              },
                            }),
                        ],
                      }),
                      a &&
                        (0, K.jsx)(`div`, {
                          className: G[`avatar-selected-badge`],
                          children: `✓`,
                        }),
                    ],
                  },
                  e.uid,
                );
              }),
              u &&
                (0, K.jsx)(`div`, {
                  className: G[`ai-create-btn`],
                  children: s
                    ? (0, K.jsx)(p, {
                        title: `点击停止生成`,
                        children: (0, K.jsx)(`div`, {
                          onClick: o,
                          style: {
                            cursor: `pointer`,
                            position: `relative`,
                            width: 60,
                            height: 60,
                          },
                          children: (0, K.jsx)(`img`, {
                            src: `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/AICreateLoading-DBcK1A0c.gif`,
                            className: G[`ai-create-btn-loading`],
                            alt: `loading`,
                            style: { width: `100%`, height: `100%` },
                          }),
                        }),
                      })
                    : (0, K.jsx)(p, {
                        title: `输入名称和描述后，点击自动生成头像`,
                        children:
                          l && !c
                            ? (0, K.jsx)(`img`, {
                                src: `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/AI-create-CCGhteeY.png`,
                                onClick: a,
                                alt: `generate`,
                                style: {
                                  cursor: `pointer`,
                                  width: 60,
                                  height: 60,
                                },
                              })
                            : (0, K.jsx)(`img`, {
                                src: `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/AI-create-dis-CWYi5dBK.png`,
                                style: {
                                  cursor: `no-drop`,
                                  width: 60,
                                  height: 60,
                                },
                                alt: `disabled`,
                              }),
                      }),
                }),
            ],
          }),
          (0, K.jsx)(v, {
            width: 0,
            height: 0,
            src: h,
            style: { display: `none` },
            preview: {
              visible: d,
              src: h,
              onVisibleChange: (e) => {
                f(e);
              },
            },
          }),
        ],
      });
    },
  );
h();
var qe = ({ disabled: e }) => {
    let t = (0, W.useRef)(),
      [n, r] = (0, W.useState)([`start`]),
      i = (0, W.useMemo)(
        () => [
          {
            title: `姓名`,
            dataIndex: `name`,
            formItemProps: { rules: [{ required: !0, message: `请输入姓名` }] },
            fieldProps: { maxLength: 20 },
          },
          {
            title: `联系方式`,
            dataIndex: `phone`,
            formItemProps: { rules: [je({ type: `phoneOrTel` })] },
            fieldProps: {
              maxLength: 12,
              placeholder: `请输入正确的手机号或者座机号`,
            },
          },
          {
            title: `职位`,
            dataIndex: `position`,
            formItemProps: { rules: [{ required: !0, message: `请输入职位` }] },
          },
          {
            title: `操作`,
            valueType: `option`,
            width: `18%`,
            render: () => null,
          },
        ],
        [],
      );
    return (0, K.jsx)(N.Item, {
      noStyle: !0,
      shouldUpdate: !0,
      children: ({ getFieldValue: a }) =>
        (0, K.jsx)(fe, {
          rowKey: `id`,
          style: { width: 534, margin: 0, padding: 0 },
          recordCreatorProps: !1,
          name: `relationDetailList`,
          actionRef: t,
          headerTitle: `联系人`,
          columns: i,
          loading: !1,
          editable: {
            type: `multiple`,
            editableKeys: n,
            onChange: r,
            deleteText: (0, K.jsx)(f, {
              style: { position: `relative`, top: 1 },
              className: G[`tabal-op-btn`],
            }),
            actionRender: (n, r, i) => {
              if (e) return [];
              let o = a(`relationDetailList`) || [];
              return [
                (0, K.jsx)(
                  j,
                  {
                    className: G[`tabal-op-btn`],
                    onClick: () => {
                      t.current?.addEditRecord?.({ id: P() });
                    },
                  },
                  `add`,
                ),
                o.length > 1 ? i.delete : null,
              ].filter(Boolean);
            },
          },
        }),
    });
  },
  Je = ({ agentType: e, agentStyleOptions: t }) => {
    let n = t.find((t) => t.value === e),
      r = n?.label || ``,
      i = n?.tips || ``;
    return (0, K.jsxs)(`div`, {
      children: [
        (0, K.jsxs)(`p`, {
          style: {
            fontSize: 16,
            fontWeight: 600,
            marginTop: 0,
            marginBottom: 10,
          },
          children: [`新建`, r],
        }),
        (0, K.jsx)(`p`, {
          style: {
            fontSize: 14,
            color: `#7B7D85`,
            marginTop: 0,
            marginBottom: 32,
          },
          children: i,
        }),
      ],
    });
  },
  Ye = () =>
    (0, K.jsx)(`div`, {
      className: `avatar-uploader-up-btn`,
      children: (0, K.jsx)(g, {}),
    });
h();
var Xe = W.memo(
    ({
      type: e,
      agentType: t,
      agentStyleOptions: n,
      runModeArr: r,
      fieldConfig: i,
      avatarUrl: a,
      microAppName: s,
      loading: c,
      disabled: l,
      form: u,
      iconList: d,
      onAgentTypeChange: f,
      onAvatarChange: p,
      onCreateIcon: m,
      onDeleteIcon: h,
      onStopGenerate: g,
    }) => {
      let {
        microAppName: _,
        description: v,
        avatar: y,
        runMode: b,
        department: S,
        contact: C,
        industry: w,
      } = i;
      return (0, K.jsxs)(me, {
        form: u,
        options: n,
        value: t,
        onChange: f,
        fieldName: `agentStyle`,
        fieldLabel: `模式:`,
        disabled: e === `Edit`,
        children: [
          e !== `Edit` &&
            (0, K.jsx)(Je, { agentType: t, agentStyleOptions: n }),
          (0, K.jsx)(ue, {
            name: `id`,
            noStyle: !0,
            fieldProps: { hidden: !0 },
          }),
          _?.show !== !1 &&
            (0, K.jsx)(ue, {
              name: `microAppName`,
              label: _?.label ?? `Agent名称`,
              placeholder: _?.placeholder ?? `请输入名称`,
              wrapperCol: { span: 24 },
              rules: _?.required
                ? [
                    {
                      required: !0,
                      message: `请输入${_?.label ?? `Agent名称`}`,
                    },
                  ]
                : [],
              fieldProps: { showCount: !0, maxLength: 32 },
            }),
          v?.show !== !1 &&
            (0, K.jsx)(de, {
              name: `description`,
              label: v?.label ?? `描述`,
              placeholder: v?.placeholder ?? `请输入`,
              wrapperCol: { span: 24 },
              rules: v?.required
                ? [{ required: !0, message: `请输入${v?.label ?? `描述`}` }]
                : [],
              fieldProps: { showCount: !0, maxLength: v?.maxLength ?? 200 },
            }),
          y?.show !== !1 &&
            (0, K.jsx)(N.Item, {
              label: y?.label ?? `上传照片`,
              required: y?.required,
              children: (0, K.jsxs)(M, {
                vertical: !0,
                gap: 8,
                children: [
                  (0, K.jsxs)(M, {
                    align: `center`,
                    gap: 16,
                    children: [
                      (0, K.jsx)(N.Item, {
                        name: `avatar`,
                        noStyle: !0,
                        rules: y?.required
                          ? [{ required: !0, message: `请上传图片` }]
                          : [],
                        children: (0, K.jsx)(o, { hidden: !0 }),
                      }),
                      (0, K.jsx)(Se, {
                        beforeCrop: (e) => ne(e).valid,
                        children: (0, K.jsx)(ee, {
                          value: a,
                          onChange: p,
                          disabled: l,
                          maxCount: 1,
                          acceptTypes: [`image/jpeg`, `image/jpg`, `image/png`],
                          maxSize: 1 * 1024 * 1024,
                          name: `avatar`,
                          onRemove: () => u.resetFields([`avatar`]),
                          uploadProps: {
                            listType: `picture-card`,
                            className: `avatar-uploader`,
                            showUploadList: { showPreviewIcon: !1 },
                            children: (0, K.jsx)(Ye, {}),
                          },
                        }),
                      }),
                      (0, K.jsx)(`div`, { className: G[`avatar-divider`] }),
                      (0, K.jsx)(Ke, {
                        iconList: d,
                        selectedUrl: a,
                        onSelect: (e) => p(e),
                        onDelete: h,
                        onGenerate: m,
                        onStopGenerate: g,
                        loading: c,
                        disabled: l,
                        hasName: !!s,
                      }),
                    ],
                  }),
                  (0, K.jsx)(`div`, {
                    className: G[`avatar-uploader-text`],
                    children: `支持PNG、JPG格式，不超过1MB，建议比例1:1 ，比例超限自动裁剪`,
                  }),
                ],
              }),
            }),
          b?.show &&
            (0, K.jsx)(N.Item, {
              name: `runMode`,
              label: b.label ?? `新建方式`,
              rules: b.required
                ? [
                    {
                      required: !0,
                      message: b.label ? `请选择${b.label}` : `请选择新建方式`,
                    },
                  ]
                : [],
              children: (0, K.jsx)(x.Group, {
                disabled: e === `Edit`,
                name: `runMode`,
                className: G[`run-mode-box`],
                children: r?.map((e) =>
                  (0, K.jsxs)(
                    `div`,
                    {
                      className: G[`run-mode-item`],
                      children: [
                        (0, K.jsx)(
                          x,
                          { value: e.modeType, children: e.name },
                          e.modeType,
                        ),
                        (0, K.jsx)(`span`, {
                          className: G[`run-mode-desc`],
                          children: e.desc,
                        }),
                      ],
                    },
                    e.modeType,
                  ),
                ),
              }),
            }),
          w?.show &&
            (0, K.jsx)(le, {
              options: w.options ?? R,
              rules: w.required
                ? [
                    {
                      required: !0,
                      message: w.label ? `请选择${w.label}` : `请选择所属行业`,
                    },
                  ]
                : [],
              name: `profession`,
              label: w.label ?? `所属行业`,
              wrapperCol: { span: 24 },
              fieldProps: {
                showSearch: !0,
                placeholder: w.placeholder ?? `请选择所属行业`,
              },
            }),
          S?.show &&
            (0, K.jsx)(ue, {
              rules: S.required
                ? [{ required: !0, message: `请输入部门` }]
                : [],
              disabled: !0,
              name: `department`,
              label: S.label ?? `部门`,
              wrapperCol: { span: 24 },
              fieldProps: {},
            }),
          C?.show && (0, K.jsx)(qe, { disabled: l }),
        ],
      });
    },
  ),
  q = {
    microAppName: {
      show: !0,
      required: !0,
      label: `Agent名称`,
      placeholder: `请输入名称`,
    },
    description: {
      show: !0,
      required: !1,
      label: `描述`,
      placeholder: `请输入`,
      maxLength: 200,
    },
    avatar: { show: !0, required: !1, label: `上传照片` },
    runMode: { show: !1, required: !1, label: `新建方式` },
    profession: {
      show: !1,
      required: !1,
      label: `所属行业`,
      placeholder: `请选择所属行业`,
    },
    department: { show: !1, required: !1, label: `部门` },
    contact: { show: !1, required: !1, label: `联系人` },
    industry: {
      show: !1,
      required: !1,
      label: `所属行业`,
      placeholder: `请选择所属行业`,
    },
  },
  J = [
    {
      label: `工作流`,
      value: z.WORKFLOW,
      description: `通过画布自定义编排工作流`,
      icon: `workflow`,
      tips: `通过画布自定义编排工作流，实现复杂的业务逻辑处理，支持多种节点类型和条件分支，适用于自动化任务处理场景。`,
      fieldConfig: q,
      runMode: 4,
      nextRoute: U.AGENT_WORKFLOW,
    },
    {
      label: `标准智能体`,
      value: z.AGENT,
      description: `构建智能体，连接插件、知识等`,
      icon: `base-agent`,
      tips: `构建智能体，连接知识、数据与服务，强大的RAG、MCP、插件记忆及组件能力，适配多种模型，适用于智能助理型、对话型场景。`,
      fieldConfig: q,
      runMode: 5,
      nextRoute: U.AGENT_STANDARD_AGENT,
    },
    {
      label: `超级智能体`,
      value: z.SUPER_AGENT,
      description: `根据使用场景，可以添加技能skill、绑定plugin等`,
      tips: `根据使用场景，可以添加技能skill、绑定plugin等`,
      disabled: !1,
      icon: `multi-agent`,
      runMode: 6,
      nextRoute: U.AGENT_SUPER_AGENT,
      fieldConfig: {
        ...q,
        microAppName: {
          ...q.microAppName,
          placeholder: `请输入Agent名称，如：柳州政务智能助理`,
        },
        description: {
          ...q.description,
          required: !0,
          placeholder: `请描述该智能体Team的功能定位和适用场景，如：面向柳州市政务工作人员的一站式智能助理，整合法律援助、政务咨询、民政服务等多项专业能力`,
        },
        industry: { ...q.industry, show: !0, required: !0 },
      },
    },
    {
      label: `多智能体`,
      value: z.MULTI_AGENT,
      description: `多智能体高效协作`,
      disabled: !0,
      icon: `multi-agent-disabled`,
      runMode: 7,
      fieldConfig: {
        ...q,
        description: { ...q.description, required: !0 },
        avatar: { ...q.avatar, required: !0 },
        runMode: { ...q.runMode, show: !0, required: !0 },
        profession: { ...q.profession, show: !0, required: !0 },
        department: { ...q.department, show: !0, required: !0 },
        contact: { ...q.contact, show: !0, required: !0 },
      },
    },
  ],
  Ze = () => [{ id: `start` }],
  Qe = `https://meiye.cos.clife.cn/material/T000000/209e1407eeb1485fa761eaf7aacff8ac.png`,
  $e = (e) => ({
    agentStyle: z.WORKFLOW,
    runMode: 0,
    profession: 6,
    department: e || ``,
    relationDetailList: Ze(),
    avatar: Qe,
  }),
  et = (e, t) => ({
    microAppName: e.templateName,
    profession: e.profession,
    description: e.description,
    department: t || ``,
    id: e.id,
    agentStyle: z.WORKFLOW,
    runMode: 0,
    relationDetailList: Ze(),
    avatar: e.iconUrl ? Qe : [],
  }),
  tt = (e, t) => {
    let n = e.runMode ?? 0,
      r = n > 1 ? n : 1,
      i = n > 1 ? null : n || 0;
    return {
      formValues: {
        microAppName: e.microAppName,
        profession: e.profession,
        description: e.description,
        relationDetailList: e.relationDetailList,
        microAppId: e.microAppId,
        agentStyle: r,
        runMode: i ?? void 0,
        avatar:
          e.picUrl ||
          `https://meiye.cos.clife.cn/material/T000000/209e1407eeb1485fa761eaf7aacff8ac.png`,
      },
      agentStyle: r,
      runModeValue: i ?? 0,
      runModeOptions: n > 1 ? [] : [t[n || 0]],
    };
  },
  nt = (e, t, n) => {
    let r = { ...e };
    switch (t) {
      case `Quick`:
        ((r.type = 1), (r.microAppTemplateId = n?.id));
        break;
      case `Create`:
        r.type = 2;
        break;
      default:
        r.microAppId = n?.microAppId;
        break;
    }
    let i = J.find((e) => e.value === r.agentStyle);
    return (
      i?.runMode === void 0
        ? r.agentStyle > 1 && (r.runMode = r.agentStyle)
        : (r.runMode = i.runMode),
      delete r.agentStyle,
      { payload: r, nextRoute: i?.nextRoute ?? U.AGENT_LOW_CODE_CHAT }
    );
  };
h();
var rt = async (e, t, n, r, i, a, o) => {
    console.log(`===>>> handleSubmit`, e);
    let s = e.avatar;
    if (!s || typeof s != `string`) return (D.error(`请上传图片`), !1);
    ((e.picUrl =
      s ||
      `https://meiye.cos.clife.cn/material/T000000/209e1407eeb1485fa761eaf7aacff8ac.png`),
      delete e?.avatar);
    let { payload: c, nextRoute: l } = nt(e, t, n);
    try {
      let { success: e, data: n } =
        (t === `Edit` ? await ae(c) : await oe(c)) || {};
      if (e) {
        if (t === `Edit`)
          return (a?.(), D.success(`修改成功`), i?.(c.microAppName), !0);
        let e = { ...n };
        (a?.(), o?.(), D.success(`添加成功`), i?.());
        let s = window.location.href?.split(`#`)[0];
        window.history.replaceState({}, ``, s + `#` + U.AGENT_WORKFLOW);
        let u = l ?? U.AGENT_LOW_CODE_CHAT;
        return (
          setTimeout(() => {
            r(u, {
              replace: !0,
              state: { ...c, ...e, graphType: c.runMode || 0 },
            });
          }, 0),
          !0
        );
      }
    } catch {
      console.log(`err`);
    }
    return !1;
  },
  it = async (e, t, n, r) => {
    if (e === `Quick` && t)
      return {
        values: et(t, n?.org?.orgCode),
        agentStyle: z.WORKFLOW,
        runModeOptions: r,
      };
    if (e === `Edit` && t) {
      let { errCode: e, data: i } = await re({ id: t.microAppId });
      if (e === 0 && i) {
        let { formValues: e, agentStyle: t, runModeOptions: n } = tt(i, r);
        return { values: e, agentStyle: t, runModeOptions: n };
      }
      return {
        values: $e(n?.org?.orgName),
        agentStyle: z.WORKFLOW,
        runModeOptions: r,
      };
    }
    return {
      values: $e(n?.org?.orgName),
      agentStyle: z.WORKFLOW,
      runModeOptions: r,
    };
  },
  at = async (e, t, n, r, i, a, o) => {
    if (!e || !t) {
      D.warning(`请输入名称和描述`);
      return;
    }
    if (n.length >= 5) {
      D.warning(`最多生成5张图片`);
      return;
    }
    a(!0);
    try {
      let a = await ie({ name: e, desc: t });
      if (o?.aborted) return;
      if (a.errCode === 0 && a.data?.length) {
        let e = a.data[0],
          t = { uid: P(), status: `done`, url: e, name: `AI生成图片` };
        (r([...n, t]), i(e));
      }
    } catch (e) {
      console.error(`Generate icon failed:`, e);
    } finally {
      o?.aborted || a(!1);
    }
  };
h();
var ot = W.memo(
  (0, W.forwardRef)(
    (
      {
        type: e = `Create`,
        record: t,
        disabled: n,
        children: r,
        callback: i,
        showModal: a,
        setShowAddModal: o,
      },
      s,
    ) => {
      (0, W.useImperativeHandle)(s, () => ({
        open: () => {
          p(!0);
        },
        close: () => {
          p(!1);
        },
      }));
      let c = ve(),
        u = _e().state,
        { userInfo: d } = be(),
        [f, p] = (0, W.useState)(!1),
        [m, h] = (0, W.useState)(!1),
        [g, _] = (0, W.useState)(!1),
        [v, y] = (0, W.useState)(!1),
        b = (0, W.useRef)(!1),
        x = (0, W.useRef)(null),
        [S, C] = (0, W.useState)(z.WORKFLOW),
        [w, T] = (0, W.useState)(
          J.filter((e) => e.fieldConfig.runMode?.show).map((e) => ({
            modeType: e.runMode,
            name: e.label,
            desc: e.description || ``,
            icon: e.icon || ``,
          })),
        ),
        [E, D] = (0, W.useState)([]),
        [O] = N.useForm(),
        k = N.useWatch(`microAppName`, O),
        A = N.useWatch(`avatar`, O),
        j = (0, W.useMemo)(
          () =>
            J.map((t) =>
              t.value === 3 ? { ...t, disabled: e === `Quick` } : t,
            ),
          [e],
        ),
        M = (0, W.useMemo)(
          () => j.find((e) => e.value === S)?.fieldConfig || J[0]?.fieldConfig,
          [j, S],
        );
      ((0, W.useEffect)(() => {
        u?.openModal && p(!0);
      }, [u?.openModal]),
        (0, W.useEffect)(() => {
          typeof a == `boolean` && p(a);
        }, [a]));
      let P = (0, W.useCallback)(() => {
          (O.resetFields(),
            h(!1),
            y(!1),
            (b.current = !1),
            D([]),
            T(
              J.filter((e) => e.fieldConfig.runMode?.show).map((e) => ({
                modeType: e.runMode,
                name: e.label,
                desc: e.description || ``,
                icon: e.icon || ``,
              })),
            ));
        }, [O]),
        ee = (0, W.useCallback)(
          async (n) => {
            if (
              (p(n),
              u?.openModal &&
                c(U.AGENT_APP_MANAGE, {
                  state: { openModal: !1 },
                  replace: !0,
                }),
              n)
            ) {
              if (b.current || v) return;
              ((b.current = !0), h(!0), y(!1));
              try {
                let {
                  values: n,
                  agentStyle: r,
                  runModeOptions: i,
                } = await it(
                  e,
                  t,
                  d,
                  J.filter((e) => e.fieldConfig.runMode?.show).map((e) => ({
                    modeType: e.runMode,
                    name: e.label,
                    desc: e.description || ``,
                    icon: e.icon || ``,
                  })),
                );
                (C(r), T(i), O.setFieldsValue(n), y(!0));
              } finally {
                (h(!1), (b.current = !1));
              }
            } else (o?.(!1), P());
          },
          [e, t, d, u, c, O, o, P, v],
        ),
        F = (0, W.useCallback)(
          async (n) => {
            h(!0);
            try {
              return await rt(n, e, t, c, i, () => p(!1), P);
            } finally {
              h(!1);
            }
          },
          [e, t, c, i, P],
        ),
        I = (0, W.useCallback)(
          (e) => {
            O.setFieldValue(
              `avatar`,
              e ||
                `https://meiye.cos.clife.cn/material/T000000/209e1407eeb1485fa761eaf7aacff8ac.png`,
            );
          },
          [O],
        ),
        te = (0, W.useCallback)(() => {
          let { microAppName: e, description: t } = O.getFieldsValue([
            `microAppName`,
            `description`,
          ]);
          x.current && x.current.abort();
          let n = new AbortController();
          ((x.current = n),
            at(
              e || ``,
              t || ``,
              E,
              D,
              (e) => {
                O.setFieldValue(`avatar`, e);
              },
              _,
              n.signal,
            ));
        }, [O, E]),
        L = (0, W.useCallback)(() => {
          ((x.current &&= (x.current.abort(), null)), _(!1));
        }, []),
        R = (0, W.useCallback)(
          (e) => {
            let t = E.filter((t) => t.uid !== e);
            D(t);
            let n = E.find((t) => t.uid === e),
              r = O.getFieldValue(`avatar`);
            n &&
              n.url === r &&
              (t.length > 0
                ? O.setFieldValue(`avatar`, t[t?.length - 1]?.url)
                : O.setFieldValue(`avatar`, Qe));
          },
          [E, O],
        ),
        ne = (0, W.useMemo)(
          () =>
            e === `Edit`
              ? { ...H, body: { ...H?.body, padding: `0` } }
              : { ...H, body: { ...H?.body, padding: `0 0 0 24px` } },
          [e],
        );
      return (0, K.jsx)(ce, {
        title: e === `Edit` ? `编辑Agent` : `新建Agent`,
        layout: `vertical`,
        form: O,
        loading: m,
        onFinish: F,
        wrapperCol: { span: 24 },
        modalProps: {
          forceRender: !0,
          okText: e === `Edit` ? `确定` : `立即新建`,
          onCancel: () => p(!1),
          styles: ne,
        },
        width: e === `Edit` ? 600 : 900,
        open: f,
        trigger: r,
        onOpenChange: ee,
        disabled: n,
        className: G[`create-agent`],
        initialValues: { relationDetailList: [{ id: `start` }] },
        scrollToFirstError: !0,
        children:
          m && !v
            ? (0, K.jsx)(l, {
                active: !0,
                paragraph: { rows: 8 },
                style: { padding: `28px 26px 24px 28px` },
              })
            : (0, K.jsx)(Xe, {
                type: e,
                agentType: S,
                agentStyleOptions: j,
                runModeArr: w,
                fieldConfig: M,
                avatarUrl: A,
                microAppName: k || ``,
                loading: g,
                disabled: n,
                form: O,
                iconList: E,
                onAgentTypeChange: C,
                onAvatarChange: I,
                onCreateIcon: te,
                onDeleteIcon: R,
                onStopGenerate: L,
              }),
      });
    },
  ),
);
ot.displayName = `CreateAgent`;
var Y = {
  tabs: `_tabs_h922v_1`,
  radio: `_radio_h922v_28`,
  upload: `_upload_h922v_36`,
  textarea: `_textarea_h922v_79`,
  btn: `_btn_h922v_85`,
};
h();
function st({ value: e, onChange: t, ...n }) {
  let r = (0, W.useMemo)(() => (e ? [e] : []), [e]),
    a = (e) => {
      (console.log(e), t?.(e?.fileList[0]));
    },
    o = {
      className: Y.upload,
      maxCount: 1,
      name: `files`,
      multiple: !1,
      beforeUpload: () => !1,
      itemRender: (t, n, r, a) =>
        r.map((t) => {
          let n = t && t.size > 0 ? L(t?.size) : null;
          return (0, K.jsxs)(
            `div`,
            {
              className: `ant-upload-list-item ant-upload-list-item-done`,
              children: [
                (0, K.jsx)(`div`, {
                  className: `ant-upload-icon`,
                  children: (0, K.jsx)(c, {}),
                }),
                (0, K.jsx)(`a`, {
                  rel: `noopener noreferrer`,
                  className: `ant-upload-list-item-name`,
                  title: t?.name,
                  children: t?.name,
                }),
                (0, K.jsxs)(`span`, {
                  className: `ant-upload-list-item-actions`,
                  children: [
                    (0, K.jsx)(`span`, {
                      children:
                        e?.fileSize || (n ? [n.num, n.unit].join(``) : ``),
                    }),
                    `\xA0\xA0`,
                    (0, K.jsx)(_, {
                      icon: (0, K.jsx)(i, {}),
                      size: `small`,
                      type: `text`,
                      onClick: a.remove,
                    }),
                  ],
                }),
              ],
            },
            t.uid,
          );
        }),
    };
  return (0, K.jsx)(u.Dragger, {
    ...n,
    ...o,
    fileList: r,
    onChange: a,
    children: (0, K.jsxs)(`p`, {
      className: `ant-upload-text`,
      children: [
        (0, K.jsx)(S, {}),
        ` 将SDK文件拖到此处或`,
        (0, K.jsx)(d.Link, { children: `点击上传` }),
      ],
    }),
  });
}
h();
var X = (0, W.memo)(
  (0, W.forwardRef)(
    ({ prefix: e, data: t, microAppVersionId: n, configType: r }, i) => {
      let [a, s] = (0, W.useState)(!1),
        [c, l] = (0, W.useState)({}),
        u = N.useFormInstance(),
        d = [
          { label: `SDK`, value: 1 },
          { label: `链接地址`, value: 2 },
        ],
        {
          sdkFileNameField: f,
          sdkFileUrlField: p,
          sdkFileSizeField: m,
          typeField: h,
          fileField: g,
          remarkField: _,
          linkField: v,
        } = (0, W.useMemo)(
          () => ({
            sdkFileNameField: `${e}SdkFileName`,
            sdkFileUrlField: `${e}SdkFileUrl`,
            sdkFileSizeField: `${e}SdkFileSize`,
            typeField: `${e}AddWay`,
            fileField: `${e}File`,
            remarkField: `${e}Remark`,
            linkField: `${e}LinkUrl`,
          }),
          [e],
        ),
        y = () => {
          u.validateFields([g, v]);
        },
        S = async () => {
          try {
            let e = await u.validateFields([h, g, v, _]),
              i = {
                microAppVersionId: n,
                configType: r,
                [h]: e[h],
                [_]: e[_],
                [v]: e[v],
              },
              a = {};
            if (e[h] === 1) {
              t && (i[v] = c[v]);
              let n = e[g];
              if ((console.log(`>>>file`, n), !n.url)) {
                s(!0);
                let t = new FormData();
                t.append(`file`, n.originFileObj);
                let r = await We(t);
                if (r.success) {
                  let { fileUrl: t, fileName: n, fileSize: i } = r.data;
                  u.setFieldsValue({
                    [g]: {
                      url: t,
                      uid: e[g].uid,
                      name: n,
                      status: `done`,
                      fileSize: i,
                    },
                  });
                } else return (s(!1), D.error(`SDK上传失败，请重试`), !1);
              }
              let r = u.getFieldValue(g);
              ((a = { [f]: r.name, [p]: r.url, [m]: r.fileSize }),
                console.log(a));
            } else a = c || {};
            ((i[f] = a[f]), (i[p] = a[p]), (i[m] = a[m]), console.log(i));
            let o = await Ue(i);
            return o.success
              ? (l((e) => ({ ...e, ...i })), D.success(`操作成功`), s(!1), !0)
              : (D.error(o.errMessage || `操作失败`), s(!1), !1);
          } catch (e) {
            return (
              console.log(e),
              D.error(e?.errMessage || `操作失败`),
              s(!1),
              !1
            );
          }
        },
        C = () => (c && (c[p] || c[v]) ? `更新` : `提交`);
      return (
        (0, W.useImperativeHandle)(i, () => ({ submit: S, getButtonText: C })),
        (0, W.useEffect)(() => {
          if (!t) return;
          let e = [h, _, v],
            n = { [h]: t[h] || 1, [_]: t[_], [v]: t[v] };
          (t[p] &&
            (n[g] = {
              url: t[p],
              uid: t[p],
              name: t[f],
              status: `done`,
              fileSize: t[m],
            }),
            u.setFieldsValue(n),
            l([...e, p, f, m].reduce((e, n) => ((e[n] = t[n]), e), {})));
        }, [t, e]),
        (0, K.jsxs)(b, {
          spinning: a,
          children: [
            (0, K.jsx)(N.Item, {
              noStyle: !0,
              shouldUpdate: !0,
              children: ({ getFieldsValue: e }) => {
                let t = e();
                return c &&
                  ((t[h] === 2 && c[h] === 2 && c[v] && c[v] === t[v]) ||
                    (t[h] === 1 && c[h] === 1 && t[g] && c[p] === t[g].url))
                  ? (0, K.jsx)(k, {
                      type: `success`,
                      message: `在线版本`,
                      banner: !0,
                      style: { marginBottom: `10px` },
                    })
                  : (0, K.jsx)(K.Fragment, {});
              },
            }),
            (0, K.jsxs)(N.Item, {
              required: !0,
              label: `添加方式`,
              children: [
                (0, K.jsx)(N.Item, {
                  noStyle: !0,
                  name: h,
                  initialValue: 1,
                  children: (0, K.jsx)(x.Group, {
                    options: d,
                    className: Y.radio,
                    onChange: y,
                  }),
                }),
                (0, K.jsx)(N.Item, {
                  noStyle: !0,
                  shouldUpdate: (e, t) => e[h] !== t[h],
                  children: ({ getFieldValue: e }) => {
                    let t = e(h);
                    return (0, K.jsxs)(K.Fragment, {
                      children: [
                        (0, K.jsx)(`div`, {
                          hidden: t !== 1,
                          children: (0, K.jsx)(N.Item, {
                            noStyle: !0,
                            name: g,
                            rules: [
                              { required: t === 1, message: `选择SDK文件` },
                            ],
                            children: (0, K.jsx)(st, {}),
                          }),
                        }),
                        (0, K.jsx)(`div`, {
                          hidden: t === 1,
                          children: (0, K.jsx)(N.Item, {
                            noStyle: !0,
                            name: v,
                            rules: [
                              {
                                required: t === 2,
                                message: `请输入SDK访问链接地址`,
                              },
                              Me(300),
                            ],
                            children: (0, K.jsx)(o, {
                              placeholder: `请输入SDK访问链接地址`,
                              onPressEnter: (e) => {
                                (console.log(e), e.preventDefault());
                              },
                              showCount: {
                                formatter: (e) => `${e?.count ?? 0}/300`,
                              },
                            }),
                          }),
                        }),
                      ],
                    });
                  },
                }),
              ],
            }),
            (0, K.jsx)(N.Item, {
              label: `描述`,
              name: _,
              rules: [Me(1e4)],
              children: (0, K.jsx)(o.TextArea, {
                placeholder: `请描述SDK的用途或接入SDK的关键环节`,
                className: Y.textarea,
                style: { maxWidth: `100%` },
                autoSize: { minRows: 15, maxRows: 15 },
                showCount: { formatter: (e) => `${e?.count ?? 0}/10000` },
              }),
            }),
          ],
        })
      );
    },
  ),
);
((X.displayName = `FormItemComponent`), h());
var ct = (0, W.forwardRef)((e, t) => {
  let { width: n = 888, title: r = `添加SDK`, afterClose: i } = e,
    [a, o] = (0, W.useState)(!1),
    [s, c] = (0, W.useState)(``),
    [l, u] = (0, W.useState)(),
    [d, f] = (0, W.useState)(!0),
    [p, m] = (0, W.useState)(`ios`),
    [h, g] = (0, W.useState)(!1),
    [_, v] = (0, W.useState)(`提交`),
    x = (0, W.useRef)(null),
    S = (0, W.useRef)(null),
    C = (0, W.useRef)(null),
    w = (0, W.useRef)(null),
    T = (e) => {
      (c(e), o(!0), m(`ios`), v(`提交`), k(e));
    },
    E = () => {
      (o(!1), c(``), u(void 0), m(`ios`), g(!1));
    },
    D = () => {
      i?.();
    },
    k = async (e) => {
      f(!0);
      try {
        let { success: t, data: n } = await He({
          microAppVersionId: e,
          configType: 1,
        });
        t &&
          (console.log(n),
          u(n),
          setTimeout(() => {
            j();
          }, 0));
      } catch (e) {
        console.error(e);
      }
      f(!1);
    },
    A = async () => {
      let e = { ios: x, android: S, web: C, miniApps: w }[p];
      if (e?.current) {
        g(!0);
        try {
          (await e.current.submit()) && E();
        } finally {
          g(!1);
        }
      }
    },
    j = () => {
      let e = { ios: x, android: S, web: C, miniApps: w }[p];
      e?.current ? v(e.current.getButtonText()) : v(`提交`);
    },
    M = (e) => {
      (m(e),
        setTimeout(() => {
          j();
        }, 0));
    };
  (0, W.useImperativeHandle)(t, () => ({ open: T, close: E }));
  let P = [
    {
      label: `iOS`,
      key: `ios`,
      children: (0, K.jsx)(X, {
        ref: x,
        prefix: `ios`,
        data: l,
        microAppVersionId: s,
        configType: 1,
      }),
    },
    {
      label: `Android`,
      key: `android`,
      children: (0, K.jsx)(X, {
        ref: S,
        prefix: `android`,
        data: l,
        microAppVersionId: s,
        configType: 2,
      }),
    },
    {
      label: `Web`,
      key: `web`,
      children: (0, K.jsx)(X, {
        ref: C,
        prefix: `web`,
        data: l,
        microAppVersionId: s,
        configType: 3,
      }),
    },
    {
      label: `小程序`,
      key: `miniApps`,
      children: (0, K.jsx)(X, {
        ref: w,
        prefix: `miniApps`,
        data: l,
        microAppVersionId: s,
        configType: 4,
      }),
    },
  ];
  return (0, K.jsx)(O, {
    title: r,
    open: a,
    onCancel: E,
    onOk: A,
    afterClose: D,
    width: n,
    destroyOnClose: !0,
    confirmLoading: h,
    okText: _,
    children:
      a &&
      s &&
      (0, K.jsx)(b, {
        spinning: d,
        children: (0, K.jsx)(
          N,
          {
            layout: `vertical`,
            children: (0, K.jsx)(y, {
              animated: !0,
              className: Y.tabs,
              items: P,
              activeKey: p,
              onChange: M,
            }),
          },
          s,
        ),
      }),
  });
});
ct.displayName = `SDKModal`;
var lt = (0, W.memo)(ct),
  ut = (0, W.memo)(({ permissions: e = `0`, mode: t = `any`, children: n }) =>
    xe(e, t) ? (0, K.jsx)(K.Fragment, { children: n }) : null,
  );
ut.displayName = `AuthWrapper`;
var dt = {
  "model-card": `_model-card_mw6o3_5`,
  "model-desc": `_model-desc_mw6o3_14`,
};
h();
var { Text: Z } = d,
  ft = (0, W.memo)(({ data: e, onClick: t, hoverable: n = !0, className: r }) =>
    (0, K.jsx)(E, {
      hoverable: n && !!t,
      className: `${dt[`model-card`]} ${r || ``}`,
      onClick: () => t?.(e),
      styles: { body: { padding: `16px` } },
      children: (0, K.jsxs)(M, {
        vertical: !0,
        gap: 12,
        children: [
          (0, K.jsxs)(M, {
            align: `center`,
            gap: 12,
            children: [
              (0, K.jsx)(a, {
                style: { backgroundColor: `#ff8c00`, flexShrink: 0 },
                size: 48,
                shape: `square`,
                children: e.supplierName?.substring(0, 2).toUpperCase() || `AI`,
              }),
              (0, K.jsxs)(M, {
                vertical: !0,
                flex: 1,
                style: { minWidth: 0 },
                children: [
                  (0, K.jsx)(pe, {
                    copyable: !0,
                    title: e.modelName,
                    maxLines: 1,
                    children: (0, K.jsx)(Z, {
                      strong: !0,
                      style: { fontSize: 14 },
                      children: e.modelName,
                    }),
                  }),
                  (0, K.jsx)(Z, {
                    type: `secondary`,
                    style: { fontSize: 12, marginTop: 4 },
                    children: e.supplierName,
                  }),
                ],
              }),
            ],
          }),
          (0, K.jsx)(pe, {
            className: dt[`model-desc`],
            title: e.description || `暂无描述`,
            maxLines: 2,
            children: (0, K.jsx)(Z, {
              type: `secondary`,
              style: { fontSize: 12, lineHeight: `18px` },
              children: e.description || `暂无描述`,
            }),
          }),
          e.labels &&
            e.labels.length > 0 &&
            (0, K.jsxs)(M, {
              gap: 8,
              wrap: `wrap`,
              align: `center`,
              children: [
                e.labels
                  .slice(0, 3)
                  .map((e) =>
                    (0, K.jsx)(
                      T,
                      {
                        color: `blue`,
                        style: { margin: 0, fontSize: 12 },
                        children: e.tagName,
                      },
                      e.tagId,
                    ),
                  ),
                e.labels.length > 3 &&
                  (0, K.jsxs)(Z, {
                    type: `secondary`,
                    style: { fontSize: 12 },
                    children: [`+`, e.labels.length - 3],
                  }),
              ],
            }),
        ],
      }),
    }),
  ),
  pt = {
    "card-content": `_card-content_du3rs_7`,
    "card-pagination": `_card-pagination_du3rs_15`,
  },
  mt = (e) => {
    let { tags: t, contextRanges: n, ...r } = e,
      i = { ...r };
    return (
      t && t.length > 0 && (i.modelTags = t.join(`,`)),
      n && n.length > 0 && (i.contextRanges = n.join(`,`)),
      i
    );
  },
  ht = (function (e) {
    return ((e.TABLE = `table`), (e.CARD = `card`), e);
  })({}),
  gt = (e) => {
    let {
        storageKey: t,
        defaultViewType: n = `table`,
        onViewTypeChange: r,
      } = e,
      [i, a] = (0, W.useState)(() => sessionStorage.getItem(t) || n);
    return {
      viewType: i,
      setViewType: (0, W.useCallback)(
        (e) => {
          (a(e), sessionStorage.setItem(t, e), r?.(e));
        },
        [t, r],
      ),
      isTableView: i === `table`,
      isCardView: i === `card`,
    };
  };
h();
var _t = (0, W.memo)(
  (0, W.forwardRef)((e, t) => {
    let {
        filters: n,
        onDataChange: r,
        renderCard: i,
        initialPage: a = 1,
        initialPageSize: o = 20,
        grid: s = { gutter: 16, xs: 1, sm: 2, md: 3, lg: 4, xl: 4, xxl: 4 },
      } = e,
      [c, l] = (0, W.useState)(!1),
      [u, d] = (0, W.useState)([]),
      [f, p] = (0, W.useState)({ current: a, pageSize: o, total: 0 }),
      m = (0, W.useRef)(null),
      [h, g] = (0, W.useState)(`auto`),
      _ = (0, W.useRef)(!0),
      v = (0, W.useRef)(``);
    (0, W.useEffect)(() => {
      let e = () => {
        if (!m.current) return;
        let e = m.current.getBoundingClientRect().top,
          t = window.innerHeight - e - 88;
        g(Math.max(t, 200));
      };
      (e(), window.addEventListener(`resize`, e));
      let t = setTimeout(e, 100);
      return () => {
        (window.removeEventListener(`resize`, e), clearTimeout(t));
      };
    }, []);
    let y = (0, W.useCallback)(
      async (e, t) => {
        l(!0);
        try {
          let i = await se({ pageNum: e, pageSize: t, ...mt(n) });
          if (!i?.success) {
            (D.error(i?.msg || `加载数据失败`),
              d([]),
              p({ current: e, pageSize: t, total: 0 }));
            return;
          }
          let a = i?.data?.records || [];
          (d(a),
            p({ current: e, pageSize: t, total: i?.data?.total || 0 }),
            r?.(a));
        } catch (n) {
          (console.error(`加载模型列表失败:`, n),
            D.error(`加载数据失败，请稍后重试`),
            d([]),
            p({ current: e, pageSize: t, total: 0 }));
        } finally {
          l(!1);
        }
      },
      [n, r],
    );
    return (
      (0, W.useImperativeHandle)(
        t,
        () => ({
          reload: () => y(f.current, f.pageSize),
          reloadAndRest: () => y(1, f.pageSize),
          reset: () => y(1, f.pageSize),
        }),
        [y, f],
      ),
      (0, W.useEffect)(() => {
        (y(a, o), (_.current = !1));
      }, []),
      (0, W.useEffect)(() => {
        if (_.current) return;
        let e = JSON.stringify(n);
        v.current !== e && ((v.current = e), y(1, f.pageSize));
      }, [n]),
      (0, K.jsxs)(K.Fragment, {
        children: [
          (0, K.jsx)(`div`, {
            className: pt[`card-content`],
            ref: m,
            style: { height: h, overflowY: `auto`, padding: `16px` },
            children: (0, K.jsx)(b, {
              spinning: c,
              children: (0, K.jsx)(C, {
                rowKey: `modelId`,
                grid: s,
                dataSource: u,
                renderItem: (e) => (0, K.jsx)(C.Item, { children: i(e) }),
              }),
            }),
          }),
          (0, K.jsx)(`div`, {
            className: pt[`card-pagination`],
            children: (0, K.jsx)(w, {
              current: f.current,
              pageSize: f.pageSize,
              total: f.total,
              onChange: (e, t) => {
                y(e, t);
              },
              showSizeChanger: !0,
              showQuickJumper: !0,
              showTotal: (e) => `共 ${e} 条`,
              pageSizeOptions: [`10`, `20`, `50`, `100`],
            }),
          }),
        ],
      })
    );
  }),
);
_t.displayName = `ModelCardList`;
var Q = {
  "trigger-container": `_trigger-container_6c4zo_1`,
  "trigger-button": `_trigger-button_6c4zo_7`,
  "modal-body": `_modal-body_6c4zo_11`,
  "modal-content": `_modal-content_6c4zo_14`,
  "tabs-container": `_tabs-container_6c4zo_18`,
  tabs: `_tabs_6c4zo_18`,
  "content-container": `_content-container_6c4zo_38`,
  "empty-text": `_empty-text_6c4zo_43`,
  "group-list": `_group-list_6c4zo_47`,
  "group-container": `_group-container_6c4zo_50`,
  "group-title": `_group-title_6c4zo_53`,
  "tags-container": `_tags-container_6c4zo_58`,
  "empty-group-text": `_empty-group-text_6c4zo_63`,
  "checkable-tag": `_checkable-tag_6c4zo_66`,
  "selected-area-container": `_selected-area-container_6c4zo_70`,
  "selected-label": `_selected-label_6c4zo_75`,
  "selected-area-scroll": `_selected-area-scroll_6c4zo_79`,
  "footer-container": `_footer-container_6c4zo_87`,
  tag: `_tag_6c4zo_58`,
};
h();
var vt = (0, W.memo)(
  ({
    treeData: e,
    activeTab: t,
    onTabChange: n,
    activeNode: r,
    selectedIds: i,
    onTagToggle: a,
  }) => {
    let { token: o } = A.useToken(),
      s = (0, W.useRef)(null);
    return (
      (0, W.useEffect)(() => {
        s.current && (s.current.scrollTop = 0);
      }, [t]),
      (0, K.jsxs)(K.Fragment, {
        children: [
          (0, K.jsx)(`div`, {
            className: Q[`tabs-container`],
            style: { display: e?.length ? `flex` : `none` },
            children: (0, K.jsx)(y, {
              activeKey: t,
              onChange: n,
              items: e?.map((e) => ({
                key: String(e.tagId),
                label: e.tagName,
              })),
              className: Q.tabs,
            }),
          }),
          (0, K.jsx)(`div`, {
            className: Q[`content-container`],
            ref: s,
            children: r
              ? (0, K.jsx)(`div`, {
                  children:
                    !r.children || r.children.length === 0
                      ? (0, K.jsx)(`div`, {
                          className: Q[`empty-text`],
                          style: { color: o.colorTextDescription },
                          children: `暂无标签`,
                        })
                      : (0, K.jsx)(`div`, {
                          className: Q[`group-list`],
                          children: r.children.map((e) =>
                            (0, K.jsxs)(
                              `div`,
                              {
                                className: Q[`group-container`],
                                children: [
                                  (0, K.jsx)(`div`, {
                                    className: Q[`group-title`],
                                    style: { color: o.colorTextHeading },
                                    children: e.tagName,
                                  }),
                                  (0, K.jsxs)(`div`, {
                                    className: Q[`tags-container`],
                                    children: [
                                      e.children?.map((e) => {
                                        let t = String(e.tagId),
                                          n = i.includes(t);
                                        return (0, K.jsx)(
                                          T.CheckableTag,
                                          {
                                            checked: n,
                                            onChange: () => a(t),
                                            className: Q[`checkable-tag`],
                                            style: {
                                              border: n
                                                ? `1px solid ${o.colorPrimary}`
                                                : `1px solid ${o.colorBorder}`,
                                            },
                                            children: e.tagName,
                                          },
                                          t,
                                        );
                                      }),
                                      (!e.children ||
                                        e.children.length === 0) &&
                                        (0, K.jsx)(`span`, {
                                          className: Q[`empty-group-text`],
                                          style: {
                                            color: o.colorTextDescription,
                                          },
                                          children: `暂无选项`,
                                        }),
                                    ],
                                  }),
                                ],
                              },
                              String(e.tagId),
                            ),
                          ),
                        }),
                })
              : (0, K.jsx)(`div`, {
                  className: Q[`empty-text`],
                  style: { color: o.colorTextDescription },
                  children: `暂无标签`,
                }),
          }),
        ],
      })
    );
  },
);
h();
var yt = (0, W.memo)(({ selectedTags: e, onRemove: t }) => {
  let { token: n } = A.useToken();
  return (0, K.jsxs)(`div`, {
    className: Q[`selected-area-container`],
    style: { borderTop: `1px solid ${n.colorSplit}` },
    children: [
      (0, K.jsx)(`span`, {
        className: Q[`selected-label`],
        children: `已选择:`,
      }),
      (0, K.jsx)(`div`, {
        className: Q[`selected-area-scroll`],
        children: e.map((e) =>
          (0, K.jsx)(
            T,
            {
              closable: !0,
              onClose: (n) => {
                (n.preventDefault(), t(e.id));
              },
              className: Q.tag,
              children: e.name,
            },
            e.id,
          ),
        ),
      }),
    ],
  });
});
h();
var bt = (0, W.memo)(
  ({ selectedTags: e, disabled: t, onRemove: n, onOpen: r }) =>
    (0, K.jsxs)(`div`, {
      className: Q[`trigger-container`],
      children: [
        e.map((e) =>
          (0, K.jsx)(
            T,
            {
              closeIcon: !t,
              onClose: (t) => {
                (t.preventDefault(), n(e.id));
              },
              className: Q.tag,
              children: e.name,
            },
            e.id,
          ),
        ),
        !t &&
          (0, K.jsx)(_, {
            type: `link`,
            icon: (0, K.jsx)(s, {}),
            onClick: r,
            className: Q[`trigger-button`],
            children: `添加`,
          }),
      ],
    }),
);
h();
var xt = ({
    value: e,
    onChange: t,
    disabled: n,
    maxCount: r = 6,
    tagsData: i,
    modalOnly: a = !1,
    open: o,
    onCancel: s,
  }) => {
    let c = Ge(),
      { rawData: l, getTagsByIds: u } = i || c,
      [d, f] = (0, W.useState)(!1),
      p = a ? (o ?? !1) : d,
      [m, h] = (0, W.useState)([]),
      [g, v] = (0, W.useState)(``),
      y = (0, W.useMemo)(() => Ce(e), [e]),
      b = (0, W.useMemo)(() => l.find((e) => String(e.tagId) === g), [l, g]),
      x = (0, W.useMemo)(() => u(y), [y, u]),
      S = (0, W.useMemo)(() => u(m), [m, u]);
    ((0, W.useEffect)(() => {
      l.length > 0 && !g && v(String(l[0]?.tagId));
    }, [l, g]),
      (0, W.useEffect)(() => {
        p && h(y);
      }, [p]));
    let C = (0, W.useCallback)(
        (e) => {
          if (n) return;
          let t = m.includes(e),
            i;
          if (t) i = m.filter((t) => t !== e);
          else {
            if (m.length >= r) {
              D.warning(`最多选择${r}个标签`);
              return;
            }
            i = [...m, e];
          }
          h(i);
        },
        [n, m, r],
      ),
      w = (0, W.useCallback)(() => {
        (t?.(m), a ? s?.() : f(!1));
      }, [t, m, a, s]),
      T = (0, W.useCallback)(() => {
        (a ? s?.() : f(!1), h(y));
      }, [a, s, y]),
      E = (0, W.useMemo)(
        () =>
          (0, K.jsxs)(`div`, {
            className: Q[`footer-container`],
            children: [
              (0, K.jsx)(_, { onClick: T, children: `取消` }),
              (0, K.jsx)(_, { type: `primary`, onClick: w, children: `保存` }),
            ],
          }),
        [T, w],
      ),
      k = (0, W.useCallback)(
        (e) => {
          t?.(y.filter((t) => t !== e));
        },
        [t, y],
      ),
      A = (0, W.useCallback)(() => {
        f(!0);
      }, []);
    return (0, K.jsxs)(K.Fragment, {
      children: [
        !a &&
          (0, K.jsx)(bt, {
            selectedTags: x,
            disabled: n,
            onRemove: k,
            onOpen: A,
          }),
        (0, K.jsx)(O, {
          title: `选择标签`,
          open: p,
          onCancel: T,
          footer: E,
          width: 800,
          classNames: { body: Q[`modal-body`] },
          destroyOnClose: !0,
          children: (0, K.jsxs)(`div`, {
            className: Q[`modal-content`],
            children: [
              (0, K.jsx)(vt, {
                treeData: l,
                activeTab: g,
                onTabChange: v,
                activeNode: b,
                selectedIds: m,
                onTagToggle: C,
              }),
              (0, K.jsx)(yt, { selectedTags: S, onRemove: C }),
            ],
          }),
        }),
      ],
    });
  },
  St = {
    "label-select-wrapper": `_label-select-wrapper_wfekv_5`,
    "tags-container": `_tags-container_wfekv_8`,
    "tag-item": `_tag-item_wfekv_15`,
    "add-button": `_add-button_wfekv_18`,
  };
h();
var Ct = ({
    value: e,
    onChange: t,
    disabled: n,
    maxCount: r = 6,
    returnFullObject: i = !1,
  }) => {
    let [a, o] = (0, W.useState)(!1),
      c = Ge(),
      { loading: l, getTagsByIds: u } = c,
      d = (0, W.useMemo)(() => we(e), [e]),
      f = (0, W.useMemo)(() => u(d), [d, u]),
      p = (0, W.useCallback)(
        (e) => {
          if (n) return;
          let r = d.filter((t) => t !== e);
          if (i) {
            let e = u(r);
            t?.(Te(r, e));
          } else t?.(r);
        },
        [n, d, t, i, u],
      ),
      m = (0, W.useCallback)(
        (e) => {
          if (e.length > r) {
            D.warning(`最多选择${r}个标签`);
            return;
          }
          if (i) {
            let n = u(e);
            t?.(Te(e, n));
          } else t?.(e);
          o(!1);
        },
        [t, r, i, u],
      ),
      h = (0, W.useCallback)(() => {
        o(!0);
      }, []),
      g = (0, W.useCallback)(() => {
        o(!1);
      }, []);
    return (0, K.jsxs)(`div`, {
      className: St[`label-select-wrapper`],
      children: [
        (0, K.jsxs)(`div`, {
          className: St[`tags-container`],
          children: [
            f.map((e) =>
              (0, K.jsx)(
                T,
                {
                  closable: !n,
                  onClose: () => p(e.id),
                  className: St[`tag-item`],
                  children: e.name,
                },
                e.id,
              ),
            ),
            (0, K.jsx)(_, {
              type: `dashed`,
              size: `small`,
              icon: (0, K.jsx)(s, {}),
              className: St[`add-button`],
              onClick: h,
              disabled: n || l,
              children: `添加标签`,
            }),
          ],
        }),
        (0, K.jsx)(xt, {
          value: d,
          onChange: m,
          disabled: n,
          maxCount: r,
          tagsData: c,
          modalOnly: !0,
          open: a,
          onCancel: g,
        }),
      ],
    });
  },
  $ = {
    "image-upload-form-item": `_image-upload-form-item_1anl9_1`,
    "avatar-uploader-up-btn": `_avatar-uploader-up-btn_1anl9_42`,
    "avatar-uploader": `_avatar-uploader_1anl9_42`,
    "avatar-divider": `_avatar-divider_1anl9_65`,
    "avatar-uploader-text": `_avatar-uploader-text_1anl9_70`,
    "ai-create-btn": `_ai-create-btn_1anl9_75`,
    "ai-create-btn-loading": `_ai-create-btn-loading_1anl9_85`,
    "avatar-gallery-item": `_avatar-gallery-item_1anl9_91`,
    "avatar-gallery-mask": `_avatar-gallery-mask_1anl9_100`,
    "avatar-image": `_avatar-image_1anl9_103`,
    "action-icon": `_action-icon_1anl9_125`,
    "action-select-circle": `_action-select-circle_1anl9_133`,
    "avatar-selected-badge": `_avatar-selected-badge_1anl9_146`,
    "avatar-gallery-item-selected": `_avatar-gallery-item-selected_1anl9_161`,
  };
h();
var wt = ({
  iconList: e,
  selectedUrl: t,
  onSelect: n,
  onDelete: r,
  onGenerate: a,
  onStopGenerate: o,
  loading: s,
  disabled: c,
  hasName: l,
  generateHint: u = `输入名称和描述后，点击自动生成头像`,
}) => {
  let d = e.length < 5,
    [f, h] = (0, W.useState)(!1),
    [g, _] = (0, W.useState)(``);
  return (0, K.jsxs)(K.Fragment, {
    children: [
      (0, K.jsxs)(M, {
        gap: 16,
        align: `center`,
        wrap: `wrap`,
        children: [
          e.map((e) => {
            let a = e.url === t;
            return (0, K.jsxs)(
              `div`,
              {
                className: `${$[`avatar-gallery-item`]} ${a ? $[`avatar-gallery-item-selected`] : ``}`,
                onClick: () => {
                  c || !e.url || n(a ? `` : e.url);
                },
                children: [
                  (0, K.jsx)(v, {
                    src: e.url,
                    width: 60,
                    height: 60,
                    preview: {
                      visible: !1,
                      src: g,
                      onVisibleChange: (e) => {
                        (h(e), e || _(``));
                      },
                    },
                    className: $[`avatar-image`],
                  }),
                  (0, K.jsxs)(`div`, {
                    className: $[`avatar-gallery-mask`],
                    onClick: (e) => e.stopPropagation(),
                    children: [
                      (0, K.jsx)(m, {
                        className: $[`action-icon`],
                        onClick: (t) => {
                          (t.stopPropagation(), _(e.url || ``), h(!0));
                        },
                      }),
                      !c &&
                        (0, K.jsx)(i, {
                          className: $[`action-icon`],
                          onClick: (t) => {
                            (t.stopPropagation(), r(e.uid));
                          },
                        }),
                      !a &&
                        !c &&
                        (0, K.jsx)(`div`, {
                          className: $[`action-select-circle`],
                          onClick: (t) => {
                            (t.stopPropagation(), e.url && n(e.url));
                          },
                        }),
                    ],
                  }),
                  a
                    ? (0, K.jsx)(`div`, {
                        className: $[`avatar-selected-badge`],
                        children: `✓`,
                      })
                    : null,
                ],
              },
              e.uid,
            );
          }),
          d
            ? (0, K.jsx)(`div`, {
                className: $[`ai-create-btn`],
                children: s
                  ? (0, K.jsx)(p, {
                      title: `点击停止生成`,
                      children: (0, K.jsx)(`div`, {
                        onClick: o,
                        style: {
                          position: `relative`,
                          width: 60,
                          height: 60,
                          cursor: `pointer`,
                        },
                        children: (0, K.jsx)(`img`, {
                          src: te,
                          className: $[`ai-create-btn-loading`],
                          alt: `loading`,
                          style: { width: `100%`, height: `100%` },
                        }),
                      }),
                    })
                  : (0, K.jsx)(p, {
                      title: u,
                      children:
                        l && !c
                          ? (0, K.jsx)(`img`, {
                              src: F,
                              onClick: a,
                              alt: `generate`,
                              style: {
                                width: 60,
                                height: 60,
                                cursor: `pointer`,
                              },
                            })
                          : (0, K.jsx)(`img`, {
                              src: I,
                              alt: `disabled`,
                              style: {
                                width: 60,
                                height: 60,
                                cursor: `no-drop`,
                              },
                            }),
                    }),
              })
            : null,
        ],
      }),
      (0, K.jsx)(v, {
        width: 0,
        height: 0,
        src: g,
        style: { display: `none` },
        preview: {
          visible: f,
          src: g,
          onVisibleChange: (e) => {
            h(e);
          },
        },
      }),
    ],
  });
};
h();
var Tt = 1 * 1024 * 1024,
  Et = [`image/jpeg`, `image/jpg`, `image/png`],
  Dt = `支持PNG、JPG格式，不超过1MB，建议比例1:1 ，比例超限自动裁剪`,
  Ot = `microAppName`,
  kt = `description`,
  At = 5,
  jt = ({
    form: e,
    fieldName: t,
    label: n = `上传照片`,
    required: r = !1,
    requiredMessage: i = `请上传图片`,
    value: a,
    defaultImage: s = he,
    onChange: c,
    disabled: l,
    uploadName: u = `avatar`,
    hint: d = Dt,
    onRemove: f,
    acceptTypes: p = Et,
    maxSize: m = Tt,
    generateNameFieldName: h = Ot,
    generateDescriptionFieldName: _ = kt,
    iconList: v,
    selectedUrl: y,
    onSelect: b,
    onDelete: x,
    onGenerate: S,
    onStopGenerate: C,
    loading: w,
    hasName: T,
    className: E,
    generateHint: O = `输入名称和描述后，点击自动生成头像`,
    showAiGenerate: k = !0,
  }) => {
    let A = a || (s === null ? void 0 : s),
      j = N.useWatch(h, e),
      [F, I] = (0, W.useState)(v ?? []),
      [te, L] = (0, W.useState)(!1),
      R = (0, W.useRef)(null);
    ((0, W.useEffect)(() => {
      v !== void 0 && I(v);
    }, [v]),
      (0, W.useEffect)(
        () => () => {
          (R.current?.abort(), (R.current = null));
        },
        [],
      ));
    let z = (0, W.useCallback)(
        (n) => {
          (c(n), e.validateFields([t]).catch(() => void 0));
        },
        [t, e, c],
      ),
      B = (0, W.useCallback)(() => {
        if (C) {
          C();
          return;
        }
        (R.current?.abort(), (R.current = null), L(!1));
      }, [C]),
      V = (0, W.useCallback)(() => {
        (B(), f?.(), z(s === null ? void 0 : s));
      }, [s, z, B, f]),
      re = (0, W.useCallback)(
        (e) => {
          if (b) {
            b(e);
            return;
          }
          z(e || (s === null ? void 0 : s));
        },
        [s, z, b],
      ),
      ae = (0, W.useCallback)(
        (e) => {
          if (x) {
            x(e);
            return;
          }
          let t = F.filter((t) => t.uid !== e);
          I(t);
          let n = F.find((t) => t.uid === e),
            r = y ?? a;
          n?.url &&
            n.url === r &&
            z(t[t.length - 1]?.url || (s === null ? void 0 : s));
        },
        [s, z, F, x, y, a],
      ),
      oe = (0, W.useCallback)(async () => {
        if (S) {
          S();
          return;
        }
        let t = e.getFieldValue(h),
          n = e.getFieldValue(_);
        if (!t || !n) {
          D.warning(`请输入名称和描述`);
          return;
        }
        if (F.length >= At) {
          D.warning(`最多生成5张图片`);
          return;
        }
        R.current?.abort();
        let r = new AbortController();
        ((R.current = r), L(!0));
        try {
          let e = await ie({ name: t, desc: n });
          if (r.signal.aborted) return;
          if (e.errCode === 0 && e.data?.length) {
            let t = e.data[0];
            (I([
              ...F,
              { uid: P(), status: `done`, url: t, name: `AI生成图片` },
            ]),
              z(t));
            return;
          }
          D.error(e.errMessage || `自动生成头像失败`);
        } catch (e) {
          r.signal.aborted ||
            (console.error(`Generate icon failed:`, e),
            D.error(`自动生成头像失败`));
        } finally {
          (R.current === r && (R.current = null), r.signal.aborted || L(!1));
        }
      }, [e, _, h, z, F, S]);
    return (0, K.jsx)(N.Item, {
      label: n,
      required: r,
      className: E,
      children: (0, K.jsxs)(M, {
        vertical: !0,
        gap: 8,
        className: $[`image-upload-form-item`],
        children: [
          (0, K.jsxs)(M, {
            align: `center`,
            gap: 16,
            children: [
              (0, K.jsx)(N.Item, {
                name: t,
                noStyle: !0,
                rules: r ? [{ required: !0, message: i }] : [],
                children: (0, K.jsx)(o, { hidden: !0 }),
              }),
              (0, K.jsx)(Se, {
                beforeCrop: (e) =>
                  ne(e, { acceptTypes: [...p], maxSize: m }).valid,
                children: (0, K.jsx)(ee, {
                  value: A,
                  onChange: z,
                  disabled: l,
                  maxCount: 1,
                  acceptTypes: p,
                  maxSize: m,
                  name: u,
                  onRemove: V,
                  uploadProps: {
                    listType: `picture-card`,
                    className: $[`avatar-uploader`],
                    showUploadList: { showPreviewIcon: !1 },
                    children: (0, K.jsx)(`div`, {
                      className: $[`avatar-uploader-up-btn`],
                      children: (0, K.jsx)(g, {}),
                    }),
                  },
                }),
              }),
              k &&
                (0, K.jsxs)(K.Fragment, {
                  children: [
                    (0, K.jsx)(`div`, { className: $[`avatar-divider`] }),
                    (0, K.jsx)(wt, {
                      iconList: F,
                      selectedUrl: y ?? a,
                      onSelect: re,
                      onDelete: ae,
                      onGenerate: oe,
                      onStopGenerate: B,
                      loading: w ?? te,
                      disabled: l,
                      hasName: T ?? !!j,
                      generateHint: O,
                    }),
                  ],
                }),
            ],
          }),
          d
            ? (0, K.jsx)(`div`, {
                className: $[`avatar-uploader-text`],
                children: d,
              })
            : null,
        ],
      }),
    });
  },
  Mt = t({ CreateAgent: () => ot });
export {
  Re as _,
  ht as a,
  ut as c,
  Be as d,
  Ne as f,
  Le as g,
  Ie as h,
  _t as i,
  lt as l,
  Fe as m,
  jt as n,
  gt as o,
  Pe as p,
  Ct as r,
  ft as s,
  Mt as t,
  ot as u,
  ze as v,
  Ve as y,
};
