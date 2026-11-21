import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Kt as r,
  Or as i,
  Qr as a,
  Vt as o,
  dr as s,
  hn as c,
  oi as l,
  or as u,
  wr as d,
} from "./vendor-antd.QfSgOu5e.js";
import { a as f } from "./auth-policy-BpcySR2d.js";
import { J as p, Y as m } from "./index.B_LPe2F7.js";
import { t as h } from "./DetailLayout-139jNxZs.js";
import { c as g, n as _, r as v, t as y } from "./constants-BEKOYWwy.js";
var b = e(t(), 1);
o();
var x = `BASIC`,
  S = `APIKEY`,
  C = `OAUTH`,
  w = `BEARER`,
  T = (...e) => e,
  E = [
    {
      key: `baseInfo`,
      title: `基础信息`,
      children: [
        { key: `strategyName`, label: `鉴权名称` },
        { key: `id`, label: `鉴权ID` },
        { key: `type`, label: `鉴权方式` },
        {
          key: `credentials`,
          label: `鉴权凭证`,
          children: [
            {
              key: [`basicConfig`, `username`],
              label: `Username`,
              visibleTypes: T(x),
            },
            {
              key: [`basicConfig`, `password`],
              label: `Password`,
              visibleTypes: T(x),
            },
            {
              key: [`apiKeyConfig`, `addTo`],
              label: `添加位置`,
              visibleTypes: T(S),
            },
            { key: [`apiKeyConfig`, `key`], label: `Key`, visibleTypes: T(S) },
            {
              key: [`apiKeyConfig`, `value`],
              label: `Value`,
              visibleTypes: T(S),
            },
            {
              key: [`bearerConfig`, `token`],
              label: `Token`,
              visibleTypes: T(w),
            },
            {
              key: [`oauth2Config`, `acessTtokenKey`],
              label: `Access Token Key`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `acessTtoken`],
              label: `Access Token`,
              visibleTypes: T(C),
            },
          ],
        },
        {
          key: `newTokenConfig`,
          label: `配置新Token`,
          children: [
            {
              key: [`oauth2Config`, `grantType`],
              label: `授权模式`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `authUrl`],
              label: `Auth URL`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `accessTokenUrl`],
              label: `Access Token URL`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `callbackUrl`],
              label: `Callback URL`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `clientId`],
              label: `Client ID`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `clientSecret`],
              label: `Client Secret`,
              visibleTypes: T(C),
            },
          ],
        },
        {
          key: `useTokenConfig`,
          label: `配置如何使用Token`,
          children: [
            {
              key: [`oauth2Config`, `addTo`],
              label: `添加位置`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `headerName`],
              label: `Authorization Header 名称`,
              visibleTypes: T(C),
            },
            {
              key: [`oauth2Config`, `scheme`],
              label: `HTTP Authorization 前缀`,
              visibleTypes: T(C),
            },
          ],
        },
      ],
    },
  ],
  D = (e) => e == null || e === ``,
  O = (e, t) => {
    let n = e.find((e) => e.value === t);
    return n ? n.label : D(t) ? `` : String(t);
  },
  k = (e, t) => {
    if (e)
      return (Array.isArray(t) ? t : [t]).reduce(
        (e, t) => (e == null ? e : e[t]),
        e,
      );
  },
  A = [24, 16],
  j = {
    type: (e) => O(y, e),
    "apiKeyConfig.addTo": (e) => O(_, e),
    "oauth2Config.addTo": (e) => O(_, e),
    "oauth2Config.grantType": (e) => O(v, e),
    "basicConfig.password": (e) => {
      if (D(e)) return ``;
      let t = String(e);
      return t.length ? `*`.repeat(t.length) : ``;
    },
  },
  M = {
    "detail-page-label": `_detail-page-label_7jr72_1`,
    "detail-page-value": `_detail-page-value_7jr72_5`,
    "auth-policy-detail": `_auth-policy-detail_7jr72_8`,
  },
  N = n(),
  P = () => {
    let e = p(),
      t = m(),
      n = e.state?.id,
      [o, _] = (0, b.useState)(!1),
      [v, y] = (0, b.useState)(null),
      x = (0, b.useCallback)(async () => {
        if (n) {
          _(!0);
          try {
            let e = await f({ id: n });
            if (e.code === 0) {
              y(e.data);
              return;
            }
            u.error(e.message ?? `获取鉴权策略详情失败`);
          } catch (e) {
            (u.error(`获取鉴权策略详情失败`), console.error(e));
          } finally {
            _(!1);
          }
        }
      }, [n]);
    (0, b.useEffect)(() => {
      x();
    }, [x]);
    let S = v?.type?.toString().toUpperCase(),
      C = (e) => {
        let t = k(v ?? void 0, e),
          n = j[g(e)],
          r = n ? n(t) : t;
        if (Array.isArray(r)) {
          let e = r.map((e) => (D(e) ? `--` : String(e)));
          return e.some((e) => e !== `--`) ? e : [`--`];
        }
        return D(r) ? `--` : String(r);
      },
      w = (e) =>
        Array.isArray(e)
          ? (0, N.jsx)(i, {
              direction: `vertical`,
              size: 4,
              children: e.map((e, t) => (0, N.jsx)(r.Text, { children: e }, t)),
            })
          : (0, N.jsx)(r.Text, {
              className: M[`detail-page-value`],
              children: e,
            }),
      T = (e) =>
        !e.visibleTypes || e.visibleTypes.length === 0
          ? !0
          : S
            ? e.visibleTypes.includes(S)
            : !1,
      O = (e) => {
        if (!T(e)) return null;
        if (!Array.isArray(e.children)) {
          let t = C(e.key);
          return (0, N.jsx)(
            a,
            {
              span: 6,
              children: (0, N.jsx)(i, {
                direction: `vertical`,
                size: 8,
                style: { width: `100%` },
                children: (0, N.jsxs)(d, {
                  children: [
                    (0, N.jsxs)(r.Text, { children: [e.label, `：`] }),
                    w(t),
                  ],
                }),
              }),
            },
            g(e.key),
          );
        }
        let t = e.children.map(O).filter(Boolean);
        return !t || t.length === 0
          ? null
          : (0, N.jsx)(
              a,
              {
                span: 24,
                children: (0, N.jsxs)(i, {
                  direction: `vertical`,
                  size: 8,
                  style: { width: `100%` },
                  children: [
                    (0, N.jsx)(d, {
                      children: (0, N.jsxs)(r.Text, {
                        strong: !0,
                        className: M[`detail-page-label`],
                        children: [e.label, `：`],
                      }),
                    }),
                    (0, N.jsx)(c, { gutter: A, children: t }),
                  ],
                }),
              },
              g(e.key),
            );
      },
      P = (e) => {
        let t = e.children.map(O).filter(Boolean);
        return t.length === 0
          ? null
          : (0, N.jsx)(
              l,
              {
                title: e.title,
                children: (0, N.jsx)(c, { gutter: A, children: t }),
              },
              e.key,
            );
      },
      F = (e, t) => {
        let n = !D(e),
          r = !D(t);
        return !n && !r ? `--` : `${e ?? ``}${n && r ? ` ` : ``}${t ?? ``}`;
      };
    return (0, N.jsx)(h, {
      contentClassName: M[`auth-policy-detail`],
      title: `鉴权策略详情`,
      showBack: !0,
      onBack: () => t(-1),
      children: (0, N.jsx)(s, {
        spinning: o,
        children: (0, N.jsxs)(d, {
          gap: 16,
          vertical: !0,
          children: [
            E.map(P),
            (0, N.jsx)(l, {
              title: `其他信息`,
              children: (0, N.jsxs)(c, {
                gutter: A,
                children: [
                  (0, N.jsxs)(a, {
                    span: 6,
                    children: [
                      (0, N.jsx)(r.Text, { children: `添加人：` }),
                      (0, N.jsx)(r.Text, {
                        children: F(v?.createdBy, v?.createdTime),
                      }),
                    ],
                  }),
                  (0, N.jsxs)(a, {
                    span: 6,
                    children: [
                      (0, N.jsx)(r.Text, { children: `更新人：` }),
                      (0, N.jsx)(r.Text, {
                        children: F(v?.updatedBy, v?.updatedTime),
                      }),
                    ],
                  }),
                ],
              }),
            }),
          ],
        }),
      }),
    });
  };
export { P as default };
