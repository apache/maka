import { o as e, r as t } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as n, t as r } from "./vendor-react.CV1S_bb1.js";
import {
  Ar as i,
  Br as a,
  C as o,
  Er as s,
  Hi as c,
  Ii as l,
  J as u,
  Kt as d,
  Or as f,
  Vt as p,
  Xr as m,
  Yi as h,
  dr as g,
  nn as ee,
  oi as _,
  or as v,
  q as y,
  rr as b,
  rt as x,
  yr as S,
} from "./vendor-antd.QfSgOu5e.js";
import { t as C } from "./Button-Docou5u1.js";
import { D as w, F as T, ft as E, j as D, x as O } from "./index.B_LPe2F7.js";
import { t as k } from "./ListPage-Dda3HptU.js";
var A = e(n(), 1);
p();
var j = (e = {}) =>
    T(`post`, `/agent-microapp/promptTemplate/findListByCondition`, e),
  M = (e = {}) =>
    T(`post`, `/agent-microapp/promptLabel/findListByCondition`, e),
  N = (e = {}) => T(`post`, `/agent-microapp/promptLabel/create`, e),
  P = (e = {}) => T(`post`, `/agent-microapp/promptTemplate/deleteById`, e),
  F = (e = {}) => T(`post`, `/agent-microapp/promptTemplate/create`, e),
  I = (e = {}) => T(`post`, `/agent-microapp/promptTemplate/update`, e),
  L = (e = {}) => T(`post`, `/agent-microapp/promptTemplate/findById`, e),
  R = { form_container: `_form_container_1b5gt_1` },
  z = r(),
  { TextArea: B } = a,
  V = (0, A.forwardRef)(
    ({ open: e = !1, onSuccess: t, onAddLabelSuccess: n }, r) => {
      let [i, a] = (0, A.useState)(e),
        [o, s] = (0, A.useState)(),
        c = () => {
          a(!1);
        },
        l = (e) => {
          (a(!0), s(e));
        };
      return (
        (0, A.useImperativeHandle)(r, () => ({ open: l, close: c }), []),
        i &&
          (0, z.jsx)(H, {
            open: i,
            promptWordId: o,
            onClose: c,
            onSuccess: t,
            onAddLabelSuccess: n,
          })
      );
    },
  ),
  H = (0, A.memo)(
    ({
      open: e = !1,
      onClose: t,
      promptWordId: n,
      onSuccess: r,
      onAddLabelSuccess: i,
    }) => {
      let [a] = S.useForm(),
        { userInfo: o } = D(),
        [s, c] = (0, A.useState)(!1),
        l = (0, A.useMemo)(() => n === void 0, [n]),
        u = async () => {
          try {
            (await a.validateFields(), a.submit());
          } catch (e) {
            console.log(e);
          }
        },
        d = async (e) => {
          let i = {
              ...e,
              tenantCode: o?.tenant?.tenantCode,
              promptLabel: e?.promptLabel?.join(`,`),
            },
            a = { 0: () => I({ ...i, promptId: n }), 1: () => F(i) };
          try {
            c(!0);
            let e = await a[Number(l)]();
            if (e?.errCode !== 0) return v.error(e?.msg);
            (v.success(`成功`), t(), r?.());
          } catch (e) {
            console.log(e);
          } finally {
            c(!1);
          }
        },
        f = async () => {
          c(!0);
          let e = await L({ promptId: n });
          (a.setFieldsValue({
            ...e?.data,
            promptLabel: e?.data?.promptLabel?.split(`,`),
          }),
            c(!1));
        };
      return (
        (0, A.useEffect)(() => {
          e && !l && f();
        }, [n, e]),
        (0, z.jsx)(b, {
          open: e,
          width: `35vw`,
          onCancel: t,
          onOk: u,
          okButtonProps: { loading: s },
          title: `${l ? `创建` : `编辑`}提示词`,
          children: (0, z.jsx)(g, {
            spinning: s,
            children: (0, z.jsx)(S, {
              form: a,
              layout: `vertical`,
              onFinish: d,
              wrapperCol: { span: 24 },
              className: R.form_container,
              children: (0, z.jsx)(U, { onAddLabelSuccess: i }),
            }),
          }),
        })
      );
    },
  ),
  U = (0, A.memo)(({ onAddLabelSuccess: e }) => {
    let t = (0, A.useRef)(null),
      [n, r] = (0, A.useState)(!1),
      [i, s] = (0, A.useState)(``),
      [c, u] = (0, A.useState)([]),
      d = async () => {
        let e = (await M())?.data?.map((e) => ({
          value: e.labelName,
          label: e.labelName,
        }));
        u(e);
      },
      f = (e) => {
        s(e.target.value);
      },
      p = (e) =>
        (0, z.jsxs)(z.Fragment, {
          children: [
            e,
            (0, z.jsx)(m, {
              style: { margin: `8px 0`, borderColor: `#f0f0f0` },
            }),
            (0, z.jsxs)(`div`, {
              style: { width: `100%`, display: `flex`, gap: `0 12px` },
              children: [
                (0, z.jsx)(a, {
                  ref: t,
                  maxLength: 8,
                  value: i,
                  style: { width: `80%` },
                  placeholder: `输入标签名称`,
                  onChange: f,
                  onKeyDown: (e) => e.stopPropagation(),
                }),
                (0, z.jsx)(h, {
                  loading: n,
                  type: `primary`,
                  icon: (0, z.jsx)(o, {}),
                  onClick: g,
                  children: `新增标签`,
                }),
              ],
            }),
          ],
        }),
      g = async (t) => {
        t.preventDefault();
        let n = c.some((e) => e.value === i);
        if (!i?.length) return v.error(`请输入标签名称`);
        if (n) return v.error(`标签已存在`);
        try {
          r(!0);
          let t = await N({ labelName: i });
          if (t?.errCode !== 0) return v.error(t?.msg);
          (s(``), d(), e?.());
        } catch (e) {
          console.log(e);
        } finally {
          r(!1);
        }
      };
    return (
      (0, A.useEffect)(() => {
        d();
      }, []),
      (0, z.jsxs)(z.Fragment, {
        children: [
          (0, z.jsx)(S.Item, {
            label: `提示词名称`,
            name: `promptName`,
            rules: [{ required: !0, message: `请输入提示词名称!` }],
            children: (0, z.jsx)(a, {
              placeholder: `请输入提示词名称`,
              maxLength: 20,
            }),
          }),
          (0, z.jsx)(S.Item, {
            label: `提示词描述`,
            name: `description`,
            rules: [{ required: !0, message: `请输入提示词描述!` }],
            children: (0, z.jsx)(a, {
              placeholder: `请输入提示词描述`,
              maxLength: 50,
            }),
          }),
          (0, z.jsx)(S.Item, {
            label: `提示词`,
            name: `promptContent`,
            rules: [{ required: !0, message: `请输入提示词!` }],
            children: (0, z.jsx)(B, {
              rows: 4,
              placeholder: `请输入提示词`,
              maxLength: 1e4,
            }),
          }),
          (0, z.jsx)(S.Item, {
            label: `标签`,
            name: `promptLabel`,
            children: (0, z.jsx)(l, {
              options: c,
              mode: `multiple`,
              maxCount: 5,
              dropdownRender: p,
            }),
          }),
        ],
      })
    );
  }),
  W = (0, A.memo)(V),
  G = async (e) => {
    if (navigator.clipboard && navigator.permissions)
      await navigator.clipboard.writeText(e);
    else {
      let t = document.createElement(`textArea`);
      ((t.value = e),
        (t.style.width = 0),
        (t.style.position = `fixed`),
        (t.style.left = `-9999px`),
        document.body.appendChild(t),
        t.select(),
        document.execCommand(`copy`),
        document.body.removeChild(t));
    }
  },
  K = `${window.location.origin}/agentpaas/promptTemplate/findById`,
  q = [
    { label: `编辑`, key: `0` },
    { label: `删除`, key: `1`, style: { color: `red` } },
  ],
  J = {
    form: `_form_1wldg_1`,
    "config-text": `_config-text_1wldg_9`,
    container: `_container_1wldg_12`,
    content: `_content_1wldg_17`,
    "toolbar-tabs-header": `_toolbar-tabs-header_1wldg_30`,
    "basic-list": `_basic-list_1wldg_33`,
    "max-height": `_max-height_1wldg_36`,
    "content-space": `_content-space_1wldg_40`,
    item: `_item_1wldg_45`,
    label_container: `_label_container_1wldg_54`,
    label_name: `_label_name_1wldg_57`,
    operate: `_operate_1wldg_68`,
    text_content: `_text_content_1wldg_71`,
    copy: `_copy_1wldg_80`,
    check_bg: `_check_bg_1wldg_89`,
    "prompt-content": `_prompt-content_1wldg_92`,
    empty: `_empty_1wldg_117`,
    "prompt-preview-drawer": `_prompt-preview-drawer_1wldg_120`,
    "preview-label": `_preview-label_1wldg_125`,
    "preview-content": `_preview-content_1wldg_131`,
    "preview-actions": `_preview-actions_1wldg_143`,
  },
  Y = t({
    PromptWordLibraryFormItems: () => Q,
    PromptWordList: () => $,
    default: () => Z,
  });
p();
var { confirm: X } = b,
  Z = () => {
    let [e] = S.useForm(),
      { userInfo: t } = D(),
      n = E(w.PROMPT_WORD_LIBRARY_EDIT, `any`),
      r = E(w.PROMPT_WORD_LIBRARY_DELETE, `any`),
      a = (0, A.useRef)(null),
      o = (0, A.useRef)(),
      [s, c] = (0, A.useState)(!1),
      [l, u] = (0, A.useState)(Date.now()),
      [p, m] = (0, A.useState)(null),
      [g, b] = (0, A.useState)({}),
      T = () => {
        a.current?.open();
      },
      M = (0, A.useCallback)(
        (e) => ({
          ...e,
          promptLabel: e?.promptLabel?.length
            ? e.promptLabel.join(`,`)
            : void 0,
        }),
        [],
      ),
      N = (0, A.useCallback)(() => {
        b(M(e.getFieldsValue()));
      }, [M, e]),
      F = (0, A.useCallback)(() => {
        o.current?.reload();
      }, []),
      I = (0, A.useCallback)(
        (e) => {
          X({
            title: `确定要删除该提示词吗?`,
            icon: (0, z.jsx)(y, {}),
            onOk: async () => {
              let t = await P({ promptId: e });
              if (t?.errCode !== 0) return v.error(t?.msg);
              (v.success(`删除成功`), F());
            },
          });
        },
        [F],
      ),
      L = (0, A.useCallback)((e) => {
        a.current?.open(e);
      }, []),
      R = (0, A.useCallback)((e) => {
        m(e);
      }, []),
      B = (0, A.useCallback)(() => {
        m(null);
      }, []),
      V = (0, A.useCallback)(() => {
        p?.promptContent && (G(p.promptContent), v.success(`复制成功`));
      }, [p]),
      H = (0, A.useCallback)(async () => {
        try {
          c(!0);
          let e =
            (await j({ ...g, tenantCode: t?.tenant?.tenantCode }))?.data || [];
          return { data: { records: e, total: e.length } };
        } catch (e) {
          return (console.log(e), { data: { records: [], total: 0 } });
        } finally {
          c(!1);
        }
      }, [g, t?.tenant?.tenantCode]),
      U = (0, A.useMemo)(
        () => [
          { title: `标题`, dataIndex: `promptName`, width: 220, ellipsis: !0 },
          {
            title: `概述`,
            dataIndex: `description`,
            width: 260,
            ellipsis: !0,
            render: (e, t) =>
              (0, z.jsx)(d.Text, {
                style: { maxWidth: 260 },
                ellipsis: { tooltip: t.description },
                children: t.description || `-`,
              }),
          },
          {
            title: `类型`,
            dataIndex: `promptType`,
            width: 160,
            ellipsis: !0,
            render: (e, t) => O[t.promptType] || `-`,
          },
          {
            title: `标签`,
            dataIndex: `promptLabel`,
            width: 220,
            render: (e, t) => {
              let n = t.promptLabel;
              if (!n || typeof n != `string`) return `-`;
              let r = n
                .split(/[,，]+/u)
                .map((e) => e.trim())
                .filter(Boolean);
              return r.length === 0
                ? `-`
                : (0, z.jsx)(f, {
                    size: [0, 4],
                    wrap: !0,
                    children: r.map((e, t) =>
                      (0, z.jsx)(ee, { children: e }, `${t}-${e}`),
                    ),
                  });
            },
          },
          {
            title: `创建人`,
            dataIndex: `createBy`,
            width: 160,
            ellipsis: !0,
            render: (e, t) => t.createBy || `-`,
          },
          {
            title: `操作`,
            dataIndex: `option`,
            valueType: `option`,
            width: 220,
            fixed: `right`,
            actionButtons: (e) => {
              let t = [];
              return (
                t.push({ key: `view`, label: `查看`, onClick: () => R(e) }),
                n &&
                  t.push({
                    key: `edit`,
                    label: `编辑`,
                    onClick: () => L(e.promptId),
                  }),
                r &&
                  t.push({
                    key: `delete`,
                    label: `删除`,
                    onClick: () => I(e.promptId),
                  }),
                t
              );
            },
          },
        ],
        [I, L, R, r, n],
      );
    return (
      (0, A.useEffect)(() => {
        N();
      }, [N]),
      q.filter((e) => (e ? (e.key === `0` ? n : e.key === `1` ? r : !0) : !1)),
      (0, z.jsxs)(z.Fragment, {
        children: [
          (0, z.jsx)(k, {
            title: `提示词库`,
            extra: (0, z.jsx)(C, {
              type: `primary`,
              permissions: w.PROMPT_WORD_LIBRARY_CREATE,
              onClick: T,
              children: `新增提示词`,
            }),
            columns: U,
            rowKey: `promptId`,
            actionRef: o,
            search: !1,
            pagination: !1,
            serialNumber: !1,
            api: H,
            tableProps: {
              params: g,
              loading: s,
              apiDataMap: { listPath: `data.records`, totalPath: `data.total` },
              className: J[`prompt-word-table`],
            },
            filter: (0, z.jsxs)(_, {
              children: [
                (0, z.jsx)(S, {
                  form: e,
                  layout: `inline`,
                  onFinish: (e) => {
                    b(M(e));
                  },
                  labelCol: { span: 5 },
                  wrapperCol: { span: 19 },
                  children: (0, z.jsxs)(`div`, {
                    className: J.form,
                    children: [
                      (0, z.jsx)(Q, {}, l),
                      (0, z.jsx)(h, {
                        loading: s,
                        type: `primary`,
                        htmlType: `submit`,
                        style: { flexShrink: 0 },
                        children: `查询`,
                      }),
                    ],
                  }),
                }),
                (0, z.jsxs)(`p`, {
                  className: J[`config-text`],
                  children: [`访问接口：`, K],
                }),
              ],
            }),
          }),
          (0, z.jsx)(W, {
            ref: a,
            onSuccess: async () => {
              F();
            },
            onAddLabelSuccess: () => {
              u(Date.now());
            },
          }),
          (0, z.jsx)(i, {
            title: p?.promptName || `查看提示词`,
            placement: `right`,
            width: 520,
            open: !!p,
            onClose: B,
            destroyOnClose: !0,
            children: (0, z.jsxs)(`div`, {
              className: J[`prompt-preview-drawer`],
              children: [
                (0, z.jsx)(`div`, {
                  className: J[`preview-label`],
                  children: `模板内容`,
                }),
                (0, z.jsx)(`div`, {
                  className: J[`preview-content`],
                  children: p?.promptContent || `-`,
                }),
                (0, z.jsx)(`div`, {
                  className: J[`preview-actions`],
                  children: (0, z.jsx)(h, {
                    type: `primary`,
                    icon: (0, z.jsx)(x, {}),
                    disabled: !p?.promptContent,
                    onClick: V,
                    children: `复制`,
                  }),
                }),
              ],
            }),
          }),
        ],
      })
    );
  },
  Q = (0, A.memo)(() => {
    let [e, t] = (0, A.useState)([]),
      n = async () => {
        let e = (await M())?.data?.map((e) => ({
          value: e.labelName,
          label: e.labelName,
        }));
        t(e);
      };
    return (
      (0, A.useEffect)(() => {
        n();
      }, []),
      (0, z.jsxs)(z.Fragment, {
        children: [
          (0, z.jsx)(S.Item, {
            label: `名称`,
            name: `promptName`,
            children: (0, z.jsx)(a, { placeholder: `请输入名称` }),
          }),
          (0, z.jsx)(S.Item, {
            label: `描述`,
            name: `description`,
            children: (0, z.jsx)(a, { placeholder: `请输入描述` }),
          }),
          (0, z.jsx)(S.Item, {
            label: `提示词`,
            name: `promptContent`,
            children: (0, z.jsx)(a, { placeholder: `请输入提示词` }),
          }),
          (0, z.jsx)(S.Item, {
            label: `标签`,
            name: `promptLabel`,
            children: (0, z.jsx)(l, {
              placeholder: `请选择标签`,
              options: e,
              mode: `multiple`,
              style: { minWidth: 160 },
            }),
          }),
        ],
      })
    );
  }),
  $ = (0, A.memo)(
    ({
      list: e,
      checkItem: t,
      action: n = !0,
      menuItems: r = [],
      onCheckItem: i,
      onMenuClick: a,
    }) => {
      let o = (e, t) => {
        (e.stopPropagation(), G(t), v.success(`复制成功`));
      };
      return (0, z.jsxs)(z.Fragment, {
        children: [
          (0, z.jsx)(f, {
            direction: `vertical`,
            className: J[`content-space`],
            children: e.map((e, c) =>
              (0, z.jsxs)(
                `div`,
                {
                  id: `item`,
                  className: `${J.item} ${e.promptId === t?.promptId ? J.check_bg : ``}`,
                  onClick: () => i?.(e),
                  children: [
                    (0, z.jsxs)(`div`, {
                      className: J.label_container,
                      children: [
                        (0, z.jsx)(`p`, {
                          className: J.label_name,
                          children: e.promptName,
                        }),
                        (0, z.jsxs)(`div`, {
                          className: J.operate,
                          children: [
                            `（ID： `,
                            e.promptId,
                            `）`,
                            (0, z.jsx)(x, { onClick: (t) => o(t, e.promptId) }),
                          ],
                        }),
                      ],
                    }),
                    (0, z.jsx)(`p`, {
                      className: J.text_content,
                      children: e.promptContent,
                    }),
                    n &&
                      !!r.length &&
                      (0, z.jsx)(s, {
                        menu: { items: r, onClick: (t) => a?.(t, e.promptId) },
                        trigger: [`click`],
                        rootClassName: J.dropdown,
                        getPopupContainer: () => document.body,
                        children: (0, z.jsx)(`a`, {
                          onClick: (e) => e.stopPropagation(),
                          children: (0, z.jsx)(`div`, {
                            className: J.copy,
                            children: (0, z.jsx)(u, {
                              style: { fontSize: `24px` },
                            }),
                          }),
                        }),
                      }),
                  ],
                },
                c,
              ),
            ),
          }),
          !!t?.promptContent?.length &&
            (0, z.jsxs)(`div`, {
              className: J[`prompt-content`],
              children: [
                (0, z.jsx)(`div`, {
                  className: J.text_content,
                  children: t?.promptContent,
                }),
                t?.promptLabel &&
                  t.promptLabel.split(`,`).filter((e) => e.trim()).length > 0 &&
                  (0, z.jsx)(`ul`, {
                    className: J.label_container,
                    children: t.promptLabel
                      .split(`,`)
                      .map((e, t) => (0, z.jsx)(`li`, { children: e }, t)),
                  }),
              ],
            }),
          !e?.length && (0, z.jsx)(c, { className: J.empty }),
        ],
      });
    },
  );
export { U as a, K as i, $ as n, F as o, Y as r, j as s, Q as t };
