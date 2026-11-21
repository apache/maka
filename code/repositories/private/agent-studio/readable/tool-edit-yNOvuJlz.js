import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  $ as r,
  Br as i,
  Ii as a,
  Kr as o,
  Or as s,
  Vt as c,
  Yi as l,
  cn as u,
  ht as d,
  oi as f,
  or as p,
  po as m,
  rr as h,
  s as g,
  un as _,
  wr as ee,
  yr as v,
} from "./vendor-antd.QfSgOu5e.js";
import { t as y } from "./CodeEditor-DKK_tsYs.js";
import { J as te, Y as ne } from "./index.B_LPe2F7.js";
import { t as b } from "./DetailLayout-139jNxZs.js";
import { a as re, m as ie, n as ae, y as oe } from "./page-config-BZC948Vm.js";
var x = e(m(), 1);
c();
var S = e(t(), 1),
  C = n(),
  { TextArea: w } = i,
  se = ({ form: e, initialValues: t }) =>
    (0, C.jsx)(f, {
      title: `基础信息`,
      children: (0, C.jsxs)(v, {
        form: e,
        layout: `vertical`,
        initialValues: t,
        children: [
          (0, C.jsx)(v.Item, {
            name: `toolNameCn`,
            label: `工具名称`,
            rules: [{ required: !0, message: `请输入工具名称` }],
            children: (0, C.jsx)(i, {
              placeholder: `请输入中文名称`,
              maxLength: 32,
              showCount: !0,
            }),
          }),
          (0, C.jsx)(v.Item, {
            name: `toolName`,
            label: `ID`,
            rules: [
              { required: !0, message: `请输入ID` },
              {
                pattern: /^[a-zA-Z0-9_-]+$/,
                message: `仅支持英文字母、数字、下划线和中划线`,
              },
            ],
            children: (0, C.jsx)(i, {
              placeholder: `仅支持英文字母、数字、下划线和中划线`,
              maxLength: 32,
              showCount: !0,
            }),
          }),
          (0, C.jsx)(v.Item, {
            name: `toolDesc`,
            label: `描述`,
            children: (0, C.jsx)(w, {
              rows: 3,
              placeholder: `请输入`,
              maxLength: 200,
              showCount: !0,
            }),
          }),
          (0, C.jsx)(v.Item, {
            name: `isOpen`,
            label: `是否启用`,
            required: !0,
            valuePropName: `checked`,
            children: (0, C.jsx)(_, {
              checkedChildren: `启用`,
              unCheckedChildren: `禁用`,
            }),
          }),
        ],
      }),
    });
c();
var { TextArea: T } = i,
  E = [
    { label: `字符串类型 (string)`, value: `string` },
    { label: `数字类型 (number)`, value: `number` },
    { label: `整数类型 (integer)`, value: `integer` },
    { label: `布尔类型 (boolean)`, value: `boolean` },
    { label: `数组类型 (array)`, value: `array` },
    { label: `对象类型 (object)`, value: `object` },
  ],
  ce = ({
    form: e,
    visible: t,
    limitToBasicFields: n,
    showRequiredField: r,
    showDefaultField: s,
    resolvedParamType: c,
    onValuesChange: l,
  }) =>
    t
      ? (0, C.jsx)(f, {
          title: `参数信息`,
          children: (0, C.jsxs)(v, {
            form: e,
            layout: `vertical`,
            onValuesChange: l,
            children: [
              (0, C.jsx)(v.Item, {
                name: `name`,
                label: `名称`,
                rules: [
                  { required: !0, message: `名称不能为空` },
                  {
                    pattern: /^[a-zA-Z0-9_]+$/,
                    message: `只能填写字母、数字、下划线`,
                  },
                ],
                children: (0, C.jsx)(i, { maxLength: 50 }),
              }),
              (0, C.jsx)(v.Item, {
                name: `type`,
                label: `类型`,
                children: (0, C.jsx)(a, { options: E }),
              }),
              !n &&
                (0, C.jsx)(v.Item, {
                  name: `desc`,
                  label: `描述`,
                  rules: [{ required: !0, message: `请输入参数描述信息` }],
                  children: (0, C.jsx)(T, {
                    rows: 2,
                    placeholder: `请输入参数描述信息`,
                    maxLength: 100,
                  }),
                }),
              r &&
                (0, C.jsx)(v.Item, {
                  name: `required`,
                  label: `是否必填`,
                  valuePropName: `checked`,
                  children: (0, C.jsx)(_, {
                    checkedChildren: `必填`,
                    unCheckedChildren: `可选`,
                  }),
                }),
              s &&
                (0, C.jsx)(v.Item, {
                  name: `defaultValue`,
                  label: `默认值`,
                  extra: `可选：为此参数设置默认值`,
                  children:
                    c === `boolean`
                      ? (0, C.jsx)(a, {
                          options: [
                            { label: `true`, value: !0 },
                            { label: `false`, value: !1 },
                          ],
                        })
                      : c === `number` || c === `integer`
                        ? (0, C.jsx)(o, { style: { width: `100%` } })
                        : (0, C.jsx)(i, { placeholder: `请输入默认值` }),
                }),
            ],
          }),
        })
      : null;
c();
var le = ({
    treeData: e,
    selectedKey: t,
    expandedKeys: n,
    canAddProperty: r,
    onAddParam: i,
    onAddProperty: a,
    onSelectNode: o,
    onExpand: c,
    onDeleteNode: d,
  }) => {
    let p = (0, S.useMemo)(() => D(e), [e]);
    return (0, C.jsxs)(f, {
      title: `参数结构`,
      children: [
        (0, C.jsxs)(s, {
          style: { marginBottom: 12 },
          children: [
            (0, C.jsx)(l, {
              type: `primary`,
              onClick: i,
              children: `添加参数`,
            }),
            r ? (0, C.jsx)(l, { onClick: a, children: `添加属性` }) : null,
          ],
        }),
        (0, C.jsx)(u, {
          showLine: !0,
          treeData: p,
          selectedKeys: t ? [t] : [],
          expandedKeys: n,
          onSelect: (e, t) => {
            o(t?.node?.key || ``);
          },
          onExpand: (e) => {
            c(e.map((e) => e.toString()));
          },
          titleRender: (e) => O(e, d),
        }),
      ],
    });
  },
  D = (e) =>
    e.map((e) => ({
      title: e.title,
      key: e.key,
      children: e.children ? D(e.children) : void 0,
    })),
  O = (e, t) =>
    e.key === `root`
      ? typeof e.title == `function`
        ? e.title(e)
        : e.title
      : (0, C.jsxs)(s, {
          style: { width: `100%`, justifyContent: `space-between` },
          children: [
            (0, C.jsx)(`span`, {
              children: typeof e.title == `function` ? e.title(e) : e.title,
            }),
            (0, C.jsx)(l, {
              type: `text`,
              icon: (0, C.jsx)(r, {}),
              size: `small`,
              onClick: (n) => {
                (n.stopPropagation(), t(e.key));
              },
              title: `删除`,
            }),
          ],
        }),
  k = {
    "template-card-content": `_template-card-content_khvij_1`,
    "template-buttons": `_template-buttons_khvij_6`,
    "template-btn": `_template-btn_khvij_9`,
    active: `_active_khvij_13`,
    tips: `_tips_khvij_16`,
    "tip-item": `_tip-item_khvij_23`,
    editor: `_editor_khvij_29`,
  },
  A = [
    {
      key: `json-body`,
      label: `JSON请求体`,
      color: `#2f80ed`,
      code: `{
      "requestTemplate": {
        "url": "https://api.example.com/endpoint",
        "method": "POST",
        "headers": [
          {
            "key": "Content-Type",
            "value": "application/json"
          },
          {
            "key": "Authorization",
            "value": "Bearer your key"
          }
        ],
        "argsToJsonBody": true
      },
      "responseTemplate": {
        "responseBody": "{{.}}"
      }
    }`,
    },
    {
      key: `url-params`,
      label: `URL参数`,
      color: `#9b51e0`,
      code: `{
    "requestTemplate": {
      "url": "https://api.example.com/endpoint",
      "method": "GET",
      "headers": [
        {
        "key": "Authorization",
        "value": "Bearer your key"
        }
      ],
      "argsToUrlParam": true
      },
      "responseTemplate": {
        "responseBody": "{{.}}"
      }
    }`,
    },
    {
      key: `form-data`,
      label: `表单数据`,
      color: `#27ae60`,
      code: `{
      "requestTemplate": {
        "url": "https://api.example.com/endpoint",
        "method": "POST",
        "headers": [
          {
            "key": "Content-Type",
            "value": "application/x-www-form-urlencoded"
          },
          {
            "key": "Authorization",
            "value": "Bearer your key"
          }
        ],
        "argsToFormBody": true
      },
      "responseTemplate": {
        "responseBody": "{{.}}"
      }
    }`,
    },
    {
      key: `custom-body`,
      label: `自定义请求体`,
      color: `#f2994a`,
      code: `{
      "requestTemplate": {
        "url": "https://api.example.com/endpoint",
        "method": "POST",
        "headers": [
          {
            "key": "Content-Type",
            "value": "application/json"
          },
          {
            "key": "Authorization",
            "value": "Bearer your key"
          }
        ],
        "body": {
 "query": "{{.args.query}}",
 "limit": "{{.args.limit}}"
}
      },
      "responseTemplate": {
        "responseBody": "{{.}}"
      }
    }`,
    },
    {
      key: `path-param`,
      label: `参数位置-Path`,
      color: `#eb5757`,
      code: `{
      "requestTemplate": {
        "url": "https://api.example.com/endpoint",
        "method": "GET",
        "headers": [
          {
            "key": "Authorization",
            "value": "Bearer your key"
          }
        ]
      },
      "responseTemplate": {
        "responseBody": "{{.}}"
      },
      "argsPosition": {
        "NewArg1": "path"
      }
    }`,
    },
  ],
  j = `json-body`,
  ue = A.find((e) => e.key === `json-body`)?.code || ``,
  M = (e) => A.find((t) => t.key === e);
c();
var N = (e) => {
    try {
      return JSON.stringify(JSON.parse(e || `{}`));
    } catch {
      return (e || ``).trim();
    }
  },
  P = (e) => {
    let t = N(e),
      n = A.find((e) => N(e.code) === t);
    return n ? n.key : null;
  },
  de = ({ script: e, onScriptChange: t }) => {
    let [n, r] = (0, S.useState)(j);
    (0, S.useEffect)(() => {
      let t = P(e);
      t && r(t);
    }, [e]);
    let i = (0, S.useMemo)(() => {
        try {
          return JSON.stringify(JSON.parse(e || `{}`), null, 2);
        } catch {
          return e;
        }
      }, [e]),
      a = (0, S.useMemo)(() => M(n), [n])?.label || `协议模板`,
      o = (t) => P(e) !== t,
      c = (e) => {
        let n = M(e);
        n &&
          (o(e)
            ? h.confirm({
                title: `确认切换模板`,
                content: `切换模板将覆盖现有配置，是否继续？`,
                okText: `确认`,
                cancelText: `取消`,
                onOk: () => {
                  (r(e), t(n.code));
                },
              })
            : (r(e), t(n.code)));
      };
    return (0, C.jsxs)(f, {
      title: `协议转换配置`,
      children: [
        (0, C.jsxs)(`div`, {
          className: k[`template-card-content`],
          children: [
            (0, C.jsx)(`div`, {
              className: k[`template-buttons`],
              children: (0, C.jsx)(s, {
                wrap: !0,
                children: A.map((e) =>
                  (0, C.jsx)(
                    l,
                    {
                      className: (0, x.default)(
                        k[`template-btn`],
                        k[`btn-${e.key}`],
                        { [k.active]: n === e.key },
                      ),
                      variant: `outlined`,
                      style: { color: e.color, borderColor: e.color },
                      size: `small`,
                      onClick: () => c(e.key),
                      children: e.label,
                    },
                    e.key,
                  ),
                ),
              }),
            }),
            (0, C.jsxs)(`div`, {
              className: k.tips,
              children: [
                (0, C.jsxs)(`div`, {
                  className: k[`tip-item`],
                  children: [
                    (0, C.jsx)(d, {}),
                    (0, C.jsx)(`span`, {
                      children: `点击按钮快速生成对应类型的配置模板，包含完整的请求和响应配置`,
                    }),
                  ],
                }),
                (0, C.jsxs)(`div`, {
                  className: k[`tip-item`],
                  children: [
                    (0, C.jsx)(g, {}),
                    (0, C.jsx)(`span`, {
                      children: `参数位置模式：通过 argsPosition 对象指定每个参数在请求中的位置（支持 query/path/header/cookie/body）`,
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
        (0, C.jsx)(v, {
          layout: `vertical`,
          className: k.editor,
          children: (0, C.jsx)(v.Item, {
            label: a,
            children: (0, C.jsx)(y, {
              value: i,
              language: `json`,
              width: `100%`,
              onChange: t,
            }),
          }),
        }),
      ],
    });
  },
  fe = { content: `_content_1v4xl_1` },
  F = `root`,
  I = (e = `string`) => ({
    name: ``,
    type: e,
    desc: ``,
    required: !1,
    defaultValue: ``,
  }),
  L = (e = `k`) => `${e}-${Date.now()}-${Math.floor(Math.random() * 1e3)}`,
  R = (e, t = `string`, n = `param`) => {
    let r = I(t);
    return (
      (r.name = e),
      {
        title: `${e}（${t}）`,
        key: L(n),
        placeholderName: e,
        children: [],
        meta: r,
      }
    );
  },
  z = () => ({
    title: `参数列表（object）`,
    key: F,
    children: [],
    isRoot: !0,
    placeholderName: `参数列表`,
  }),
  B = (e) => {
    if (!e) return `参数`;
    let t = e.indexOf(`（`);
    return t > -1 ? e.slice(0, t) : e;
  },
  V = (e, t) => {
    for (let n of e) {
      if (n.key === t) return n;
      if (n.children) {
        let e = V(n.children, t);
        if (e) return e;
      }
    }
    return null;
  },
  H = (e, t, n = null) => {
    for (let r of e) {
      if (r.key === t) return n;
      if (r.children?.length) {
        let e = H(r.children, t, r);
        if (e) return e;
      }
    }
    return null;
  },
  U = (e, t) => {
    if (!e.meta?.name) return null;
    let n = e.meta.type || `string`,
      r = {
        type: n,
        description: e.meta.desc || ``,
        default: e.meta.defaultValue ?? ``,
      };
    if (n === `object`) {
      let n = {};
      (e.children?.forEach((e) => {
        let r = U(e, t);
        r && (n[r.name] = r.schema);
      }),
        (r.properties = n));
    }
    if (n === `array`) {
      let n = e.children && e.children.length > 0 ? U(e.children[0], t) : null;
      n && (r.items = n.schema);
    }
    return (
      e.meta.required && t.add(e.meta.name),
      { schema: r, name: e.meta.name }
    );
  },
  pe = (e) => {
    let t = e.find((e) => e.key === F);
    if (!t?.children || t.children.length === 0)
      return JSON.stringify({ type: `object`, properties: {}, required: [] });
    let n = new Set(),
      r = {};
    return (
      t.children.forEach((e) => {
        let t = U(e, n);
        t && (r[t.name] = t.schema);
      }),
      JSON.stringify({ type: `object`, properties: r, required: Array.from(n) })
    );
  },
  W = (e = {}, t = []) => Object.entries(e).map(([e, n]) => G(e, n, t)),
  G = (e, t = {}, n = []) => {
    let r = t.type || `string`,
      i = R(e, r),
      a = typeof t.required == `boolean` ? t.required : void 0,
      o = Array.isArray(n) ? n.includes(e) : !1;
    if (
      ((i.meta = {
        name: e,
        type: r,
        desc: t.description || ``,
        required: a === void 0 ? o : a,
        defaultValue: t.default ?? ``,
      }),
      (i.title = `${e}（${r}）`),
      r === `object`)
    )
      i.children = W(t.properties || {}, t.required || []);
    else if (r === `array`) {
      let e = t.items;
      if (e) i.children = [G(e.name || e.title || `item`, e, [])];
      else {
        let e = R(`item`, `string`, `item`);
        ((e.meta = {
          ...(e.meta || I(`string`)),
          name: `item`,
          type: `string`,
        }),
          (e.title = `item（string）`),
          (i.children = [e]));
      }
    } else i.children = [];
    return i;
  },
  me = (e) => {
    if (!e) return [z()];
    try {
      let t = JSON.parse(e);
      if (!t || t.type !== `object`) return [z()];
      let n = z();
      return ((n.children = W(t.properties || {}, t.required || [])), [n]);
    } catch (e) {
      return (console.warn(`解析 inputSchema 失败:`, e), [z()]);
    }
  },
  he = (e) => {
    let t = new Set(),
      n = (e) => {
        e.forEach((e) => {
          (t.add(e.key), e.children?.length && n(e.children));
        });
      };
    return (n(e), Array.from(t));
  },
  ge = (e, t) => {
    if (!(e == null || e === ``))
      switch (t) {
        case `string`:
          return String(e);
        case `number`:
        case `integer`: {
          let n = Number(e);
          return isNaN(n) ? void 0 : t === `integer` ? Math.floor(n) : n;
        }
        case `boolean`:
          if (typeof e == `boolean`) return e;
          if (typeof e == `string`) {
            let t = e.toLowerCase();
            if (t === `true`) return !0;
            if (t === `false`) return !1;
          }
          return !!e;
        case `array`:
        case `object`:
          return;
        default:
          return e;
      }
  };
c();
var K = ({ scene: e }) => {
  let [t] = v.useForm(),
    [n] = v.useForm(),
    r = ne(),
    { state: i } = te(),
    a = ae({ scene: e }),
    o = i?.id,
    s = i?.mcpServerId,
    c = i?.httpToMcpEnabled,
    l = i?.checkTabs || `configMcpTool`,
    u = typeof s == `number` ? s : Number(s) || 0,
    [d, f] = (0, S.useState)(ue),
    [m, g] = (0, S.useState)([z()]),
    [_, y] = (0, S.useState)(``),
    [x, w] = (0, S.useState)([F]),
    [T, E] = (0, S.useState)(!1),
    [D, O] = (0, S.useState)(`{}`),
    [k, A] = (0, S.useState)(u),
    [j, M] = (0, S.useState)(!1),
    [N, P] = (0, S.useState)(!1),
    L = v.useWatch(`type`, t);
  ((0, S.useEffect)(() => {}, [!0]),
    (0, S.useEffect)(() => {
      if (!o) {
        A(u);
        return;
      }
      (async () => {
        P(!0);
        try {
          let e = await ie(o);
          if (e.code === 0 && e.data) {
            let r = e.data;
            (n.setFieldsValue({
              toolName: r.toolName || ``,
              toolNameCn: r.toolNameCn || ``,
              toolDesc: r.toolDesc || ``,
              isOpen: r.isOpen === 1,
            }),
              A(
                (typeof r.mcpServerId == `number`
                  ? r.mcpServerId
                  : Number(r.mcpServerId) || 0) || u,
              ),
              f(r.responseTemplate),
              O(r.outputSchema || `{}`));
            let i = me(r.inputSchema);
            (g(i), w(he(i)), y(``), E(!1), t.resetFields());
          } else p.error(e.message || `获取工具详情失败`);
        } catch (e) {
          console.error(`获取工具详情失败:`, e);
        } finally {
          P(!1);
        }
      })();
    }, [o, u]));
  let U = () => {
      (y(``), E(!1), t.resetFields());
    },
    W = (e) => {
      let t = Array.isArray(e) ? e : [e];
      w((e) => {
        let n = new Set(e);
        return (t.filter(Boolean).forEach((e) => n.add(e)), Array.from(n));
      });
    },
    G = () => {
      let e = [...m],
        n = e.find((e) => e.key === F);
      if (!n) return;
      let r = R(`newArg${(n.children?.length || 0) + 1}`, `string`, `param`);
      ((n.children = (n.children || []).concat(r)),
        g(e),
        W([F, r.key]),
        y(r.key),
        E(!0),
        t.setFieldsValue(r.meta || I()));
    },
    K = () => {
      if (!_) return;
      let e = [...m],
        n = V(e, _);
      if (!n || n.meta?.type !== `object`) return;
      let r = R(`property${(n.children?.length || 0) + 1}`, `string`, `prop`);
      ((n.children = n.children ? n.children.concat(r) : [r]),
        g(e),
        W([n.key, r.key]),
        y(r.key),
        E(!0),
        t.setFieldsValue(r.meta || I()));
    },
    _e = (e) => {
      if (!e || e === `root`) {
        U();
        return;
      }
      if (e === _ && T) {
        U();
        return;
      }
      let n = V(m, e);
      n && ((n.meta ||= I()), y(e), E(!0), t.setFieldsValue(n.meta));
    },
    ve = (e, t) => {
      if (t === `array`) {
        let t = R(`item`, `string`, `item`);
        ((e.children = [t]), W([e.key, t.key]));
      } else if (t === `object`) {
        if (!e.children || e.children.length === 0) {
          let t = R(`property1`, `string`, `prop`);
          ((e.children = [t]), W([e.key, t.key]));
        }
      } else e.children = [];
    },
    ye = (e, n) => {
      if (!_) return;
      let r = [...m],
        i = V(r, _);
      if (!i) return;
      let a = i.meta || I(),
        o = a.type;
      if (e.type && e.type !== o) {
        let r = ge(a.defaultValue, e.type);
        ((n.defaultValue = r), t.setFieldsValue({ defaultValue: r }));
      }
      ((i.meta = { ...a, ...n }),
        (i.title = `${i.meta?.name?.trim() || i.placeholderName || B(i.title)}（${i.meta?.type || `string`}）`),
        e.type &&
          e.type !== o &&
          (ve(i, e.type),
          [`array`, `object`].includes(e.type) &&
            ((i.meta.defaultValue = void 0),
            t.setFieldsValue({ defaultValue: void 0 }))),
        g(r));
    },
    be = (e) => {
      e !== `root` &&
        h.confirm({
          title: `确认删除`,
          content: `确定要删除此项及其所有子项吗？`,
          okText: `确认`,
          okType: `primary`,
          onOk: () => {
            let t = [...m];
            q(t, e) && (g(t), (_ && V(t, _)) || U());
          },
        });
    },
    q = (e, t) => {
      for (let n = 0; n < e.length; n++) {
        if (e[n].key === t) return (e.splice(n, 1), !0);
        let r = e[n].children;
        if (r && q(r, t)) return !0;
      }
      return !1;
    },
    J = _ ? V(m, _) : null,
    Y = _ ? H(m, _) : null,
    xe = Y?.meta?.type === `object`,
    Se = J?.meta?.type === `object`,
    X = Y?.meta?.type === `array`,
    Z = L || J?.meta?.type || `string`,
    Ce = !X && ![`array`, `object`].includes(Z),
    we = !X && !xe,
    Te = (e) => e.meta?.name?.trim() || e.placeholderName || B(e.title),
    Q = (e = [], t) => {
      for (let n of e) {
        let e = n.meta,
          r = Te(n);
        if (!e) return `请完善参数 ${r} 的信息`;
        if (!e.name?.trim()) return `请填写参数 ${r} 的名称`;
        if (t !== `array` && !e.desc?.trim()) return `请填写参数 ${r} 的描述`;
        let i = e.type || `string`;
        if (i === `object` || i === `array`) {
          let e = Q(n.children || [], i);
          if (e) return e;
        }
      }
      return null;
    },
    Ee = () => {
      let e = m.find((e) => e.key === F);
      if (!e?.children?.length) return !0;
      let t = Q(e.children, `object`);
      return t ? (p.error(t), !1) : !0;
    },
    De = async () => {
      if (T)
        try {
          await t.validateFields();
        } catch {
          return;
        }
      if (Ee()) {
        M(!0);
        try {
          let e = await n.validateFields(),
            t = pe(m),
            r = (() => {
              try {
                return JSON.stringify(JSON.parse(d || `{}`));
              } catch {
                return d || `{}`;
              }
            })(),
            i = {
              toolName: e.toolName,
              toolNameCn: e.toolNameCn,
              toolDesc: e.toolDesc,
              isOpen: +!!e.isOpen,
              mcpServerId: k || 0,
              inputSchema: t,
              outputSchema: D || `{}`,
              responseTemplate: r,
            };
          console.log(`payload=============`, i);
          let a;
          ((a = o ? await oe({ ...i, id: o }) : await re(i)),
            a.code === 0 &&
              (p.success(o ? `工具更新成功` : `工具创建成功`), $()));
        } catch (e) {
          console.error(`操作失败:`, e);
        } finally {
          M(!1);
        }
      }
    },
    $ = () => {
      r(a.routes.mcpEdit, { state: { id: s, checkTabs: l } });
    };
  return (0, C.jsx)(b, {
    title: o ? `编辑MCP工具` : `新建MCP工具`,
    showBack: !0,
    onBack: $,
    closeButtonText: `取消`,
    submitButtonText: o ? `更新` : `立即新建`,
    showSubmitButton: !0,
    contentClassName: fe.content,
    submitLoading: j,
    onSubmit: De,
    contentLoading: N,
    children: (0, C.jsxs)(ee, {
      vertical: !0,
      gap: 16,
      children: [
        (0, C.jsx)(se, {
          form: n,
          initialValues: { toolName: ``, toolDesc: ``, isOpen: !0 },
        }),
        (0, C.jsx)(le, {
          treeData: m,
          selectedKey: _,
          expandedKeys: x,
          canAddProperty: !!Se,
          onAddParam: G,
          onAddProperty: K,
          onSelectNode: _e,
          onExpand: w,
          onDeleteNode: be,
        }),
        (0, C.jsx)(ce, {
          form: t,
          visible: T,
          limitToBasicFields: !!X,
          showRequiredField: !!we,
          showDefaultField: !!Ce,
          resolvedParamType: Z,
          onValuesChange: (e, t) => ye(e, t),
        }),
        c && (0, C.jsx)(de, { script: d, onScriptChange: (e) => f(e) }),
      ],
    }),
  });
};
export { K as default };
