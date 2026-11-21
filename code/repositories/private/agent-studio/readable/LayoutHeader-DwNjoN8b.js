import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { Br as r, Or as i, Vt as a, Xr as o } from "./vendor-antd.QfSgOu5e.js";
import { t as s } from "./isArray-CeA54qlt.js";
import { t as c } from "./debounce-DLVkj6TJ.js";
import { O as l } from "./index.B_LPe2F7.js";
var u = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAABOtJREFUWEfFlltsVGUQx/8zZ7flYoNCgFSMJsgDQRMSq8YLKgRDognxATl0l4tUhN3tbre2WC6JmFUJYsAC2/Zsq5QasbvLIioG8UFijZIYvDxoylUSEkBp5aJy7XbP+cacYgm0Z+kWSvhez3wzv/l/M2eGcJsP3eb4yAlgXVPTne70oCIRKRLINBIqFFAhBJ3EOAbBEQX5EnC1/v3XyF8jkSlmron1CbChrnkKiIIEPANgBJAVOkPAMQFtVZpmvOrTj+YCkRVgfUPqXs3KLBeQ/7IjOUpErST4GsSHLRef0CwzD8L3WVATSfA0gAcADANwDsyh9LnObVVV8y5cD8QRILopNZI6zLigy6lioh1grFVpa384POesk8PqWGqMG/KYiBUB8CCAM2Aywn7Pin4BXM7cbBTgWTtrJi14qv3AzkgkonKRtKEhNSxtmZUAqgAMZtCyzg4tWlmpX3K630uBGqM5JqCXAWmDaBXhYPGnuQS+2qapqWnQ+Ut5bwsoTKB/iGlRyF+8vU8Au+CI6BsAHUw8MxQo3tHf4N32dXWpO0w2V5KgHKDDQ/OHPLRgwQvnevq7ooDdanwpfyMBM5jok1PtB2flKns2yIaGzYVpS2sFMFyAheWl3o1ZAWrrE1OVkiQgF1ljPeTz7LnR7K++FzWSVYBaBWA3TJceDusnr/5+RYGaWHyJCFYT4SvJKE+2au8vVG19/HElSNn3mKCH/N4fHAGiseZdEJrKQEWo1Lu+v4GyP4PdFZkUQNOI6ZUyv6fRWQEjvleACUw8/WaKryeIiFCNkdgMwmyAVoRLPSudFTASZwC5S9yuh8sX6r8MlAK2n2gsvhaCxUQwygLeYJYniLdBMJoZT/R8p5uFqTHiUQHKwLw+7C+ucASoNeI/K6CIiT2hQHHyZoN2329paXH9tr89SVAzQHgtHPC+5wwQi29VgheFsLo84F0+UACxWGpMRky7Cx4hprllfs8WR4ANRvwlAj4A8JNJLr0yoP8xEBC19c3PK0XNAP5kBT0U8u7NApAqYpgpAUYQaQvKArO2DQhAXaJRkZSQ4PM8V8Ecn2/6RUeASKTFNXxU20pAlgJozddck3w+/d8bhehqv1hyEiDfAjCZMdmpuK+ZhvYoZsu0/90FAN4qGJx+p6SkpONGIKINyfthKfvfP5kIO0+3H5ruNFt6jeNofXIelFpnz3KC1LG43wwG9fO5QnRl/v6WsbDUhwAmgfCj5uL5wYXF+5189AJYs+ajofkF7mVQ8jqATiHEBrH1rs8390QuEFEj8ZStHiCTuwYb47mgz/s9EUlOAN1GtUZiqQCVAhnVtV6BVzOr3W5y7Vu0aObZbod2nx84cHK0RZmJsHiGIplvzx07cyapCvlnf3c98KxLaXV1anDeEDVNKVkLyDi7kEBog8g+CJ0Eo40EeQp8N0EVApjw/0KaIcIuZt5gKRmvKXwWDHqOZYPocy1vbNxecD59YRYBs0EYB8E9Ds4yAH4nwUHSsOZU26E9I0aPXyKiVhFojwZtfmmpfrBfT9DT2N6UudMcJ6AJolBIJIVC3AlRx4noOJnS6nYXHOnu82gs9SjE3AxgLBG2n2736JEI9Vps+1Qgl8LLZlMT+/hJEf7CXsmYsTjk91b3tL2lAHawmliiQoAKKLwRDnrs1rzm3HKAvhS87QD/AUYjAj8XZ7yzAAAAAElFTkSuQmCC`;
a();
var d = e(t()),
  f = n(),
  p = 300,
  m = ({
    config: e,
    value: t,
    onChange: n,
    placeholder: i = `搜索`,
    prefix: a,
    allowClear: o = !0,
    debounceDelay: s = p,
    filterComposition: l = !0,
    onPressEnter: m,
    width: h = 300,
    height: g = 32,
  }) => {
    let _ = e?.value === void 0 ? t : e.value,
      v = e?.onChange || n,
      y = e?.placeholder || i,
      b = e?.prefix === void 0 ? (a === void 0 ? u : a) : e.prefix,
      x = e?.allowClear === void 0 ? o : e.allowClear,
      S = e?.debounceDelay === void 0 ? s : e.debounceDelay,
      C = e?.filterComposition === void 0 ? l : e.filterComposition,
      [w, T] = (0, d.useState)(_ || ``),
      [E, D] = (0, d.useState)(!1),
      O = (0, d.useRef)(v),
      k = (0, d.useRef)(S),
      A = (0, d.useRef)(_);
    ((0, d.useEffect)(() => {
      _ !== void 0 && A.current !== _ && (T(_), (A.current = _));
    }, [_]),
      (0, d.useEffect)(() => {
        ((O.current = v), (k.current = S));
      }, [v, S]));
    let j = (0, d.useRef)(null);
    (0, d.useEffect)(
      () => (
        j.current && j.current.cancel(),
        k.current === 0
          ? (j.current = null)
          : O.current
            ? (j.current = c((e, t) => {
                O.current?.(e, t);
              }, k.current))
            : (j.current = null),
        () => {
          j.current?.cancel();
        }
      ),
      [S],
    );
    let M = (0, d.useCallback)(() => {
        D(!0);
      }, []),
      N = (0, d.useCallback)((e) => {
        D(!1);
        let t = e.currentTarget.value;
        (T(t), j.current ? j.current(t, e) : O.current && O.current(t, e));
      }, []);
    return (0, f.jsx)(r, {
      allowClear: x,
      value: w,
      onChange: (0, d.useCallback)(
        (e) => {
          let t = e.target.value;
          (T(t),
            !(C && E) &&
              (j.current ? j.current(t, e) : O.current && O.current(t, e)));
        },
        [C, E],
      ),
      onPressEnter: m,
      onCompositionStart: M,
      onCompositionEnd: N,
      placeholder: y,
      prefix:
        typeof b == `string`
          ? (0, f.jsx)(`img`, { src: b, width: 16, alt: `search` })
          : b,
      style: { width: h, height: g },
    });
  };
m.displayName = `SearchInput`;
var h = (0, d.memo)(m),
  g = {
    header: `_header_tz0pc_1`,
    "segmented-tabs": `_segmented-tabs_tz0pc_13`,
    "segmented-tabs-block": `_segmented-tabs-block_tz0pc_18`,
    "segmented-group": `_segmented-group_tz0pc_21`,
    "segmented-item": `_segmented-item_tz0pc_26`,
    "segmented-item-disabled": `_segmented-item-disabled_tz0pc_35`,
    "segmented-item-selected": `_segmented-item-selected_tz0pc_35`,
    "segmented-item-label": `_segmented-item-label_tz0pc_49`,
    body: `_body_tz0pc_57`,
  },
  _ = {
    small: { height: 24, padding: `2px`, fontSize: 12 },
    middle: { height: 30, padding: `3px`, fontSize: 14 },
    large: { height: 36, padding: `4px`, fontSize: 16 },
  },
  v = ({
    items: e,
    defaultActiveKey: t,
    activeKey: n,
    onChange: r,
    title: i,
    subTitle: a,
    showBack: o,
    onBack: s,
    extra: c,
    size: u = `middle`,
    block: p = !1,
    className: m,
    bodyClassName: h,
    headerClassName: v,
    segmentedClassName: y,
    extraClassName: b,
    style: x,
    tip: S,
  }) => {
    let C = (0, d.useRef)(n !== void 0);
    C.current = n !== void 0;
    let w = (0, d.useMemo)(() => t ?? e[0]?.key ?? ``, [t, e]),
      [T, E] = (0, d.useState)(() => w),
      D = C.current ? (n ?? ``) : T;
    ((0, d.useEffect)(() => {
      C.current && n !== void 0 && n !== T && E(n);
    }, [n, T]),
      (0, d.useEffect)(() => {
        !C.current && w && w !== T && E(w);
      }, [w]));
    let O = (0, d.useMemo)(() => e?.find((e) => e.key === D) || null, [D, e]),
      k = (0, d.useCallback)(
        (e) => {
          (C.current || E(e), r?.(e));
        },
        [r],
      ),
      A = _[u],
      j = (0, d.useCallback)(
        (e, t, n) => {
          !t && !n && k(e);
        },
        [k],
      ),
      M = (0, d.useMemo)(
        () =>
          !e || e.length === 0
            ? (0, f.jsx)(`div`, {})
            : (0, f.jsx)(`div`, {
                className: [
                  p
                    ? `${g[`segmented-tabs`]} ${g[`segmented-tabs-block`]}`
                    : g[`segmented-tabs`],
                  y,
                ]
                  .filter(Boolean)
                  .join(` `),
                style: {
                  padding: A.padding,
                  height: `calc(${A.height}px + ${A.padding} * 2)`,
                },
                children: (0, f.jsx)(`div`, {
                  className: g[`segmented-group`],
                  style: { height: `${A.height}px`, gap: A.padding },
                  children: e.map((e) => {
                    let t = e.key === D,
                      n = !!e.disabled;
                    return (0, f.jsx)(
                      `div`,
                      {
                        className: [
                          g[`segmented-item`],
                          t ? g[`segmented-item-selected`] : ``,
                          n ? g[`segmented-item-disabled`] : ``,
                        ]
                          .filter(Boolean)
                          .join(` `),
                        style: {
                          fontSize: `${A.fontSize}px`,
                          height: `${A.height}px`,
                          lineHeight: `${A.height}px`,
                        },
                        onClick: () => j(e.key, n, t),
                        children: (0, f.jsx)(`span`, {
                          className: g[`segmented-item-label`],
                          children: e.label,
                        }),
                      },
                      e.key,
                    );
                  }),
                }),
              }),
        [e, D, A, p, y, j],
      ),
      N = (0, d.useMemo)(() => {
        let e = h ? `${g.body} ${h}` : g.body;
        return (0, f.jsxs)(d.Fragment, {
          children: [
            (0, f.jsxs)(`div`, {
              className: v ? `${g.header} ${v}` : g.header,
              children: [
                i &&
                  (0, f.jsx)(l, {
                    title: i,
                    subTitle: a,
                    showBack: o,
                    onBack: s,
                    tip: S,
                    marginBottom: 0,
                    style: { marginBottom: 0 },
                  }),
                M,
                (0, f.jsx)(`div`, { className: b, children: c }),
              ],
            }),
            O?.children &&
              (0, f.jsx)(`div`, { className: e, children: O.children }),
          ],
        });
      }, [i, a, o, s, M, c, O?.children, h, v, b]);
    return m || x
      ? (0, f.jsx)(`div`, { className: m, style: x, children: N })
      : N;
  },
  y = { "layout-header": `_layout-header_1fvgp_1` };
a();
var b = ({
  title: e,
  subTitle: t,
  showBack: n,
  onBack: r,
  style: a,
  className: c,
  items: l,
  defaultActiveKey: u,
  activeKey: p,
  onChange: m,
  size: g,
  block: _,
  bodyClassName: b,
  extra: x,
  search: S,
  headerClassName: C,
  segmentedClassName: w,
  extraClassName: T,
  tip: E,
}) =>
  (0, f.jsx)(v, {
    title: e,
    subTitle: t,
    showBack: n,
    onBack: r,
    extra: (0, d.useMemo)(() => {
      let e = S?.before || null,
        t = !!S,
        n = !!x,
        r = !!e,
        a = !r && !n ? 300 : 176,
        s = S?.width ?? a;
      if (!r && !t && !n) return;
      if (r && !t && !n) return e;
      if (!r && t && !n)
        return (0, f.jsx)(h, { config: S, width: s, height: 32 });
      if (!r && !t && n) return x;
      let c = [];
      return (
        e &&
          (c.push(e),
          (t || n) &&
            c.push(
              (0, f.jsx)(
                o,
                { type: `vertical`, style: { height: 20, margin: `0 16px` } },
                `divider`,
              ),
            )),
        t &&
          c.push((0, f.jsx)(h, { config: S, width: s, height: 32 }, `search`)),
        x && c.push(x),
        (0, f.jsx)(i, { align: `center`, size: 8, split: !1, children: c })
      );
    }, [S, x]),
    tip: E,
    items: l || [],
    defaultActiveKey: u,
    activeKey: p,
    onChange: m,
    size: g,
    block: _,
    bodyClassName: b,
    headerClassName: C,
    segmentedClassName: w,
    extraClassName: T,
    className: c + ` ${y[`layout-header`]} `,
    style: {
      ...a,
      paddingBottom:
        a?.paddingBottom ?? (!(s(l) && l.length) && !x && !S ? 16 : 0),
    },
  });
b.displayName = `LayoutHeader`;
var x = (0, d.memo)(b);
export { v as n, h as r, x as t };
