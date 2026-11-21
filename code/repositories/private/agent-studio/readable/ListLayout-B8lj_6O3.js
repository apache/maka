import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { po as r } from "./vendor-antd.QfSgOu5e.js";
import { t as i } from "./LayoutHeader-DwNjoN8b.js";
var a = e(t()),
  o = e(r()),
  s = {
    "list-base-container": `_list-base-container_152ic_1`,
    "card-list-layout": `_card-list-layout_152ic_93`,
    "card-base-container": `_card-base-container_152ic_101`,
    "toolbar-content": `_toolbar-content_152ic_109`,
    "toolbar-tabs-header": `_toolbar-tabs-header_152ic_118`,
    "card-border-bottom": `_card-border-bottom_152ic_128`,
    "toolbar-extra": `_toolbar-extra_152ic_131`,
  },
  c = n(),
  l = ({
    title: e,
    subTitle: t,
    showBack: n,
    onBack: r,
    extra: a,
    items: l = [],
    defaultActiveKey: u,
    activeKey: d,
    onChange: f,
    size: p,
    block: m,
    search: h,
    children: g,
    mode: _,
    basicListClassName: v,
    className: y,
    headerClassName: b,
    bodyClassName: x,
    segmentedClassName: S,
    extraClassName: C,
    tip: w,
    style: T,
  }) => {
    let E = !(l && l.length > 0) && _ === `list`,
      D = _ === `card`;
    return (0, c.jsxs)(c.Fragment, {
      children: [
        (0, c.jsx)(i, {
          title: e,
          subTitle: t,
          tip: w,
          className: (0, o.default)(s[`toolbar-content`], y),
          headerClassName: (0, o.default)(
            b,
            s[`toolbar-tabs-header`],
            E && s[`list-border-bottom`],
            D && s[`card-border-bottom`],
          ),
          bodyClassName: (0, o.default)(x, s[`layout-body`]),
          segmentedClassName: (0, o.default)(S, s[`toolbar-tabs`]),
          extraClassName: (0, o.default)(C, s[`toolbar-extra`]),
          showBack: n,
          onBack: r,
          extra: a,
          search: h,
          items: l,
          defaultActiveKey: u,
          activeKey: d,
          onChange: f,
          size: p,
          block: m,
          style: { ...T, ...(_ === `list` ? { paddingBottom: 0 } : null) },
        }),
        _ === `card`
          ? (0, c.jsx)(`div`, {
              className: `${s[`card-base-container`]} ${v || ``}`,
              "data-ref": `card-base-container`,
              children: g,
            })
          : (0, c.jsx)(`div`, {
              className: `${s[`list-base-container`]} ${v || ``}`,
              "data-ref": `list-base-container`,
              children: g,
            }),
      ],
    });
  };
l.displayName = `ListLayout`;
var u = (0, a.memo)(l);
export { u as t };
