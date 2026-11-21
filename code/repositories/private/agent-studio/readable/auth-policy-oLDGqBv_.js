import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  G as i,
  Ii as a,
  Or as o,
  Pi as s,
  Vt as c,
  Yi as l,
  nn as u,
  oi as d,
  or as f,
  rr as p,
  tr as m,
  yr as h,
} from "./vendor-antd.QfSgOu5e.js";
import { t as g } from "./url-action-BsTcWDLi.js";
import {
  a as _,
  l as v,
  r as y,
  s as b,
  t as x,
  u as S,
} from "./auth-policy-BpcySR2d.js";
import { J as C, Tt as w, Y as T } from "./index.B_LPe2F7.js";
import { t as E } from "./ListPage-Dda3HptU.js";
import {
  a as D,
  c as O,
  i as k,
  l as A,
  n as j,
  o as M,
  r as N,
  s as P,
  t as F,
} from "./constants-BEKOYWwy.js";
var I = e(t(), 1);
c();
var L = { "tooltip-content": `_tooltip-content_1o91k_1` },
  R = { variableLocation: `requestContext`, variableName: `` },
  z = n(),
  B = [
    { label: `requestContext`, value: `requestContext` },
    { label: `requestBody`, value: `requestBody` },
  ],
  V = (0, I.forwardRef)((e, t) => {
    let {
        inputType: n = `text`,
        defaultLocation: o = R.variableLocation,
        onChange: c,
        onExpressionInsert: l,
        disabled: u,
        ...d
      } = e,
      [p, g] = (0, I.useState)(!1),
      [_, v] = (0, I.useState)(!1),
      [y, b] = (0, I.useState)(!1),
      [x, S] = (0, I.useState)(!1),
      [C] = h.useForm(),
      w = () => C.getFieldsError().some(({ errors: e }) => e.length > 0),
      T = (0, I.useCallback)(() => {
        (C.resetFields(),
          C.setFieldsValue({ variableLocation: o, variableName: `` }));
      }, [C, o]);
    (0, I.useEffect)(() => {
      T();
    }, [T]);
    let E = (e) => {
        (!e && w()) || (b(e), e || T());
      },
      D = () => {
        (b(!1), T());
      },
      O = (e) => {
        (c?.({ target: { value: e } }), l?.(e));
      },
      k = async () => {
        try {
          let e = await C.validateFields();
          S(!0);
          let { variableLocation: t, variableName: n } = e;
          (O(`{{${t}.${n}}}`), b(!1), T());
        } catch (e) {
          if (e?.errorFields) return;
          let t = e instanceof Error ? e.message : `插入失败，请重试`;
          f.error(t);
        } finally {
          S(!1);
        }
      },
      A = !u && (p || _ || y),
      j = (0, I.useMemo)(
        () =>
          (0, z.jsxs)(h, {
            form: C,
            requiredMark: !1,
            initialValues: { ...R, variableLocation: o },
            style: { marginTop: 24 },
            children: [
              (0, z.jsx)(h.Item, {
                label: `变量位置`,
                name: `variableLocation`,
                rules: [{ required: !0, message: `请选择变量位置` }],
                children: (0, z.jsx)(a, {
                  options: B,
                  placeholder: `请选择`,
                  allowClear: !0,
                }),
              }),
              (0, z.jsx)(h.Item, {
                label: `变量名称`,
                name: `variableName`,
                rules: [{ required: !0, message: `请输入变量名称` }],
                children: (0, z.jsx)(r, {
                  placeholder: `请输入`,
                  autoComplete: `off`,
                  maxLength: 50,
                  showCount: !0,
                  allowClear: !0,
                }),
              }),
            ],
          }),
        [C, o],
      ),
      M = A
        ? (0, z.jsx)(s, {
            title: (0, z.jsxs)(`div`, {
              className: L[`tooltip-content`],
              children: [`插入动态值`, (0, z.jsx)(`br`, {}), `生成表达式`],
            }),
            children: (0, z.jsx)(m, {
              placement: `right`,
              open: y,
              onOpenChange: E,
              title: `插入动态值`,
              description: j,
              trigger: `click`,
              okText: `插入`,
              cancelText: `取消`,
              icon: null,
              okButtonProps: { loading: x },
              onConfirm: k,
              onCancel: D,
              children: (0, z.jsx)(`span`, {
                style: {
                  display: `inline-flex`,
                  alignItems: `center`,
                  color: `var(--ant-color-primary)`,
                  cursor: `pointer`,
                },
                children: (0, z.jsx)(i, {
                  size: 15,
                  style: { color: `#BCBFCD` },
                }),
              }),
            }),
          })
        : null;
    return (0, z.jsx)(`div`, {
      onMouseEnter: () => g(!0),
      onMouseLeave: () => g(!1),
      children: (0, z.jsx)(r, {
        ref: t,
        ...d,
        disabled: u,
        suffix: M,
        type: n,
        autoComplete: `new-password`,
        onChange: c,
        onFocus: (e) => {
          (v(!0), d.onFocus?.(e));
        },
        onBlur: (e) => {
          (v(!1), d.onBlur?.(e));
        },
      }),
    });
  });
((V.displayName = `DynamicValueInput`), c());
var H = [
    [`oauth2Config`, `grantType`],
    [`oauth2Config`, `authUrl`],
    [`oauth2Config`, `accessTokenUrl`],
    [`oauth2Config`, `callbackUrl`],
    [`oauth2Config`, `clientId`],
    [`oauth2Config`, `clientSecret`],
    [`oauth2Config`, `addTo`],
    [`oauth2Config`, `headerName`],
    [`oauth2Config`, `scheme`],
  ],
  U = (e) => (e == null ? !0 : typeof e == `string` ? e.trim() === `` : !1),
  W = (e) => (Array.isArray(e) ? e.join(`.`) : String(e)),
  G = ({
    value: e,
    onChange: t,
    tokenTypeOptions: n = k,
    onTokenFetched: i,
    inputPlaceholder: s = `请输入`,
    disabled: c,
  }) => {
    let u = h.useFormInstance(),
      [d, p] = (0, I.useState)(!1),
      [m, g] = (0, I.useState)(!1),
      _ = n?.[0]?.value,
      y = e?.key ?? _,
      b = h.useWatch(`oauth2Config`, u),
      x = (0, I.useCallback)(() => {
        let e = H.filter((e) => U(u.getFieldValue(e))),
          t = new Set(e.map(W));
        return (
          u.setFields(
            H.map((e) => ({
              name: e,
              errors: t.has(W(e)) ? [`请完善该信息`] : [],
            })),
          ),
          e
        );
      }, [u]);
    (0, I.useEffect)(() => {
      m && x().length === 0 && g(!1);
    }, [m, b, x]);
    let S = (n) => {
        t?.({ key: y, token: e?.token, ...n });
      },
      C = (e) => {
        S({ key: e });
      },
      w = (e) => {
        S({ token: e.target.value });
      },
      T = async () => {
        if (x().length > 0)
          return (g(!0), f.error(`请先完善OAuth2配置后再获取Token`), null);
        try {
          await u.validateFields(H);
        } catch {
          return null;
        }
        let { oauth2Config: e = {} } = u.getFieldsValue(!0);
        return e;
      };
    return (0, z.jsxs)(o.Compact, {
      children: [
        (0, z.jsx)(a, {
          value: y,
          onChange: C,
          options: n,
          placeholder: `请选择`,
          style: { width: 140 },
          disabled: c,
        }),
        (0, z.jsx)(r, {
          value: e?.token,
          onChange: w,
          placeholder: s,
          autoComplete: `off`,
          style: { width: 313 },
          disabled: c,
        }),
        (0, z.jsx)(l, {
          type: `primary`,
          style: { width: 85 },
          onClick: async () => {
            let t = e?.key ?? _;
            try {
              p(!0);
              let e = await T();
              if (!e) return;
              let n = (
                await v({
                  accessTokenUrl: e.accessTokenUrl?.trim() ?? ``,
                  acessTtokenKey:
                    e?.oauthTokenConfig?.key?.trim() ?? `Access token`,
                  addTo: e.addTo ?? ``,
                  authUrl: e.authUrl?.trim() ?? ``,
                  callbackUrl: e.callbackUrl?.trim() ?? ``,
                  clientId: e.clientId?.trim() ?? ``,
                  clientSecret: e.clientSecret?.trim() ?? ``,
                  grantType: e.grantType ?? ``,
                  headerName: e.headerName?.trim() ?? ``,
                  scheme: e.scheme?.trim() ?? ``,
                })
              ).data?.token;
              (S({ key: t, token: n }), i?.(n));
            } catch (e) {
              let t =
                e instanceof Error ? e.message : `获取 Token 失败，请稍后重试`;
              f.error(t);
            } finally {
              p(!1);
            }
          },
          loading: d,
          disabled: c,
          children: `获取Token`,
        }),
      ],
    });
  };
c();
var K = {
    BASIC: [
      {
        kind: `section`,
        key: `basic-auth-credentials`,
        title: `鉴权凭证：`,
        required: !0,
        children: [
          {
            name: [`basicConfig`, `username`],
            label: `Username：`,
            rules: [A(`请输入Username`)],
            render: () =>
              (0, z.jsx)(V, { placeholder: `请输入`, autoComplete: `off` }),
          },
          {
            name: [`basicConfig`, `password`],
            label: `Password：`,
            rules: [A(`请输入Password`)],
            render: () =>
              (0, z.jsx)(V, {
                placeholder: `请输入`,
                autoComplete: `off`,
                inputType: `password`,
              }),
          },
        ],
      },
    ],
    APIKEY: [
      {
        kind: `section`,
        key: `apikey-auth-credentials`,
        title: `鉴权凭证：`,
        required: !0,
        children: [
          {
            name: [`apiKeyConfig`, `addTo`],
            label: `添加位置：`,
            rules: [A(`请选择添加位置`)],
            render: () =>
              (0, z.jsx)(a, {
                placeholder: `请选择`,
                options: j,
                allowClear: !0,
              }),
          },
          {
            name: [`apiKeyConfig`, `key`],
            label: `Key：`,
            rules: [A(`请输入Key`)],
            render: () =>
              (0, z.jsx)(V, { placeholder: `请输入`, autoComplete: `off` }),
          },
          {
            name: [`apiKeyConfig`, `value`],
            label: `Value：`,
            rules: [A(`请输入Value`)],
            render: () =>
              (0, z.jsx)(V, { placeholder: `请输入`, autoComplete: `off` }),
          },
        ],
      },
    ],
    BEARER: [
      {
        kind: `section`,
        key: `bearer-auth-credentials`,
        title: `鉴权凭证：`,
        required: !0,
        children: [
          {
            name: [`bearerConfig`, `token`],
            label: `Token：`,
            rules: [A(`请输入Token`)],
            render: () =>
              (0, z.jsx)(V, { placeholder: `请输入`, autoComplete: `off` }),
          },
        ],
      },
    ],
    OAUTH: [
      {
        kind: `section`,
        key: `oauth2-auth-credentials`,
        title: `鉴权凭证：`,
        required: !0,
        children: [
          {
            name: [`oauth2Config`, `oauthTokenConfig`],
            label: `Token：`,
            rules: [A(`请输入Token`)],
            render: () => (0, z.jsx)(G, { tokenTypeOptions: k }),
          },
        ],
      },
      {
        kind: `section`,
        key: `oauth2-new-token`,
        title: `配置新Token：`,
        children: [
          {
            name: [`oauth2Config`, `grantType`],
            label: `授权模式：`,
            render: () =>
              (0, z.jsx)(a, {
                placeholder: `请选择`,
                options: N,
                allowClear: !0,
              }),
          },
          {
            name: [`oauth2Config`, `authUrl`],
            label: `Auth URL：`,
            render: () =>
              (0, z.jsx)(r, { placeholder: `请输入`, autoComplete: `off` }),
          },
          {
            name: [`oauth2Config`, `accessTokenUrl`],
            label: `Access Token URL：`,
            render: () =>
              (0, z.jsx)(r, { placeholder: `请输入`, autoComplete: `off` }),
          },
          {
            name: [`oauth2Config`, `callbackUrl`],
            label: `Callback URL：`,
            render: () =>
              (0, z.jsx)(r, { placeholder: `请输入`, autoComplete: `off` }),
          },
          {
            name: [`oauth2Config`, `clientId`],
            label: `Client ID：`,
            render: () =>
              (0, z.jsx)(r, { placeholder: `请输入`, autoComplete: `off` }),
          },
          {
            name: [`oauth2Config`, `clientSecret`],
            label: `Client Secret：`,
            render: () =>
              (0, z.jsx)(r, { placeholder: `请输入`, autoComplete: `off` }),
          },
        ],
      },
      {
        kind: `section`,
        key: `oauth2-use-token`,
        title: `配置如何使用Token：`,
        required: !0,
        children: [
          {
            name: [`oauth2Config`, `addTo`],
            label: `添加位置：`,
            rules: [A(`请选择添加位置`)],
            render: () =>
              (0, z.jsx)(a, {
                placeholder: `请选择`,
                options: j,
                allowClear: !0,
              }),
          },
          {
            name: [`oauth2Config`, `headerName`],
            label: `Authorization Header 名称：`,
            rules: [A(`请输入Authorization Header 名称`)],
            render: () =>
              (0, z.jsx)(r, { placeholder: `请输入`, autoComplete: `off` }),
          },
          {
            name: [`oauth2Config`, `scheme`],
            label: `HTTP Authorization 前缀：`,
            rules: [A(`请输入HTTP Authorization 前缀`)],
            render: () =>
              (0, z.jsx)(r, { placeholder: `请输入`, autoComplete: `off` }),
          },
        ],
      },
    ],
  },
  q = {
    "policy-form": `_policy-form_5oct6_1`,
    "policy-form-section-card": `_policy-form-section-card_5oct6_1`,
  };
c();
var J = ({
  open: e,
  mode: t,
  initialValues: n,
  confirmLoading: i,
  onCancel: o,
  onSubmit: s,
}) => {
  let [c] = h.useForm(),
    [l, u] = (0, I.useState)(!1),
    m = (0, I.useMemo)(() => P(), []),
    g = (0, I.useCallback)(async () => {
      let e = n?.id;
      if (e) {
        u(!0);
        try {
          let t = await _({ id: e });
          if (t.code === 0) {
            c.setFieldsValue(D(t.data));
            return;
          }
          f.error(t.message ?? `获取鉴权策略详情失败`);
        } catch (e) {
          console.error(e);
        } finally {
          u(!1);
        }
      }
    }, [c, n]);
  (0, I.useEffect)(() => {
    if (!e) {
      c.resetFields();
      return;
    }
    t === `edit` && g();
  }, [e, t, c, g]);
  let v = (h.useWatch(`type`, c) || (n?.type ?? `BASIC`) || `BASIC`)
      .toString()
      .toUpperCase(),
    y = (e, t = !1) => {
      let n = O(e.name);
      return (0, z.jsx)(
        h.Item,
        {
          name: e.name,
          label: e.label,
          rules: e.rules,
          labelCol: { span: 24 },
          wrapperCol: { span: 24 },
          colon: !1,
          children: e.render(),
        },
        n,
      );
    },
    b = (e) => {
      let t = Array.isArray(e.children) && e.children.length > 0;
      return (0, z.jsx)(
        h.Item,
        {
          label: e.title,
          required: e.required,
          colon: !1,
          labelCol: { span: 24 },
          wrapperCol: { span: 24 },
          children: t
            ? (0, z.jsx)(d, {
                bordered: !1,
                className: q[`policy-form-section-card`],
                children: e.children.map((e) => y(e, !0)),
              })
            : null,
        },
        e.key,
      );
    };
  return (0, z.jsx)(p, {
    title: t === `create` ? `新增鉴权` : `编辑鉴权`,
    open: e,
    onCancel: o,
    onOk: async () => {
      await s({ ...M(await c.validateFields()), id: n?.id }, { mode: t });
    },
    destroyOnClose: !0,
    width: 632,
    confirmLoading: i,
    loading: l,
    okText: `保存`,
    children: (0, z.jsxs)(h, {
      form: c,
      initialValues: m,
      preserve: !1,
      layout: `vertical`,
      name: `policy-form`,
      wrapperCol: { flex: `1` },
      labelAlign: `right`,
      className: q[`policy-form`],
      children: [
        (0, z.jsx)(h.Item, {
          name: `strategyName`,
          label: `鉴权名称`,
          rules: [A(`请输入鉴权名称`)],
          children: (0, z.jsx)(r, {
            placeholder: `请输入`,
            maxLength: 32,
            showCount: !0,
          }),
        }),
        (0, z.jsx)(h.Item, {
          name: `type`,
          label: `鉴权方式`,
          rules: [A(`请选择鉴权方式`)],
          children: (0, z.jsx)(a, { placeholder: `请选择`, options: F }),
        }),
        K[v]?.map((e) => b(e)),
      ],
    }),
  });
};
c();
var Y = ({
  actionPermissions: e,
  detailRoute: t = w.AGENT_PLUGIN_AUTH_POLICY_DETAIL,
}) => {
  let n = (0, I.useRef)(null),
    r = T(),
    { state: i } = C(),
    [a, o] = (0, I.useState)({ open: !1, mode: `create` }),
    [c, d] = (0, I.useState)(!1),
    m = (0, I.useMemo)(() => i?.action === g.OPEN_ADD_AUTH_POLICY, [i?.action]);
  (0, I.useEffect)(() => {
    i?.action === g.OPEN_ADD_AUTH_POLICY && _();
  }, [i]);
  let h = [
      {
        title: `鉴权名称`,
        width: 180,
        ellipsis: !0,
        dataIndex: `strategyName`,
      },
      {
        title: `鉴权ID`,
        width: 120,
        ellipsis: !0,
        copyable: !0,
        dataIndex: `id`,
        search: !1,
      },
      {
        title: `鉴权方式`,
        dataIndex: `type`,
        width: 120,
        ellipsis: !0,
        valueType: `select`,
        fieldProps: { options: F },
        render: (e, t) => {
          let n = F.find((e) => e.value === t.type);
          return (0, z.jsx)(u, { color: n?.color, children: n?.label });
        },
      },
      {
        title: `添加时间`,
        width: 180,
        ellipsis: !0,
        dataIndex: `createdTime`,
        search: !1,
      },
      {
        title: `操作`,
        dataIndex: `option`,
        valueType: `option`,
        width: 150,
        actionButtonsMax: 3,
        actionButtons: (t) => [
          {
            key: `view`,
            menuCode: e?.view || `app_plugin_auth_policy_view`,
            label: `查看`,
            onClick: () => v(t),
          },
          {
            key: `edit`,
            menuCode: e?.edit || `app_plugin_auth_policy_edit`,
            label: `编辑`,
            onClick: () => D(t),
          },
          {
            key: `delete`,
            menuCode: e?.delete || `app_plugin_auth_policy_delete`,
            label: t?.referenced
              ? (0, z.jsx)(s, {
                  placement: `top`,
                  title: `该鉴权引用中，不能删除`,
                  children: (0, z.jsx)(`span`, {
                    style: {
                      color: `rgba(0, 0, 0, 0.25)`,
                      cursor: `not-allowed`,
                    },
                    children: `删除`,
                  }),
                })
              : `删除`,
            onClick: () => {
              t?.referenced || k(t);
            },
          },
        ],
      },
    ],
    _ = () => {
      o({ open: !0, mode: `create` });
    },
    v = (e) => {
      r(t, { state: { id: e.id } });
    },
    D = (e) => {
      o({ open: !0, mode: `edit`, record: e });
    },
    O = async (e) => {
      try {
        (await y({ id: e })).code === 0 &&
          (f.success(`删除成功`), n.current?.reload());
      } catch (e) {
        console.error(e);
      }
    },
    k = (e) => {
      p.confirm({
        title: `确认要删除该鉴权吗？`,
        content: `删除后不能恢复，需谨慎操作！`,
        onOk: () => {
          (console.log(e), O(e.id));
        },
      });
    },
    A = (e) => {
      let { oauth2Config: t = {} } = e;
      return {
        ...e,
        oauth2Config: {
          ...t,
          acessTtoken: t?.oauthTokenConfig?.token,
          acessTtokenKey: t?.oauthTokenConfig?.key,
        },
      };
    },
    j = { edit: S, create: x },
    M = async (e, t) => {
      d(!0);
      try {
        let i = A(e),
          a = j[t.mode];
        (await a(i)).code === 0 &&
          (f.success(`操作成功`), N(), n.current?.reload(), m && r(-1));
      } finally {
        d(!1);
      }
    },
    N = () => {
      o((e) => ({ ...e, open: !1, record: void 0 }));
    };
  return (0, z.jsxs)(z.Fragment, {
    children: [
      (0, z.jsx)(E, {
        title: `鉴权策略`,
        showBack: !0,
        onBack: () => r(-1),
        extra: (0, z.jsx)(
          l,
          { type: `primary`, onClick: _, children: `新建鉴权` },
          `add`,
        ),
        actionRef: n,
        rowKey: `id`,
        columns: h,
        api: b,
        apiDataMap: { listPath: `data`, totalPath: `totalSize` },
      }),
      (0, z.jsx)(J, {
        open: a.open,
        mode: a.mode,
        initialValues: a.record,
        confirmLoading: c,
        onCancel: N,
        onSubmit: M,
      }),
    ],
  });
};
export { Y as default };
