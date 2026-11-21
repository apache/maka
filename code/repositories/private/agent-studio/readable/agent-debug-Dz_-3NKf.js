import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { Vt as r, dr as i } from "./vendor-antd.QfSgOu5e.js";
import { n as a, p as o } from "./client-BfElcTb7.js";
import { ut as s } from "./index.B_LPe2F7.js";
var c = e(t(), 1);
r();
var l = n(),
  u = o(),
  d = u,
  f = window.location.origin.includes(`localhost`)
    ? d
    : u + `/agent/kit/agentic-console/`,
  p = `${f.replace(/\/$/, ``)}/stream-settings/`,
  m = ({ url: e, title: t }) => {
    let [n, r] = (0, c.useState)(!0);
    return (0, l.jsxs)(`div`, {
      style: { position: `relative` },
      children: [
        n &&
          (0, l.jsx)(`div`, {
            style: {
              display: `flex`,
              justifyContent: `center`,
              alignItems: `center`,
              height: 280,
            },
            children: (0, l.jsx)(i, {}),
          }),
        (0, l.jsx)(`iframe`, {
          src: e,
          title: t,
          allow: `clipboard-write; clipboard-read`,
          onLoad: () => r(!1),
          style: {
            width: `100%`,
            height: `50vh`,
            minHeight: 280,
            border: `none`,
            display: n ? `none` : `block`,
          },
        }),
      ],
    });
  },
  h = () => {
    let e = (0, c.useRef)(null),
      t = (0, c.useMemo)(() => {
        let e = a.getToken() || ``;
        return `${f}${f.includes(`?`) ? `&` : `?`}token=${encodeURIComponent(e)}`;
      }, []),
      n = (0, c.useCallback)((e) => {
        let t = e.data;
        if (t?.type) {
          if (t.type === `hiui:open-modal`) {
            let { title: e, url: n, width: r = 680 } = t.payload,
              { open: i } = s.getState();
            i({
              title: e,
              width: r,
              successTip: ``,
              children: c.createElement(m, { url: n, title: e }),
              onOk: () =>
                new Promise((e) => {
                  document
                    .querySelector(`iframe[title="配置请求参数"]`)
                    ?.contentWindow?.postMessage(
                      { type: `hiui:modal-ok` },
                      `*`,
                    );
                  let t = (r) => {
                    r.data?.type === `stream-settings-saved` &&
                      (window.removeEventListener(`message`, t),
                      clearTimeout(n),
                      document
                        .querySelector(`iframe[title="应用调试控制台"]`)
                        ?.contentWindow?.postMessage(r.data, `*`),
                      e({ code: 0 }));
                  };
                  window.addEventListener(`message`, t);
                  let n = setTimeout(() => {
                    (window.removeEventListener(`message`, t), e({ code: 0 }));
                  }, 2e3);
                }),
            });
          }
          if (t.type === `hiui:close-modal`) {
            let { close: e } = s.getState();
            e();
          }
        }
      }, []);
    return (
      (0, c.useEffect)(
        () => (
          window.addEventListener(`message`, n),
          () => window.removeEventListener(`message`, n)
        ),
        [n],
      ),
      (0, l.jsxs)(l.Fragment, {
        children: [
          (0, l.jsx)(`iframe`, {
            src: p,
            "aria-hidden": `true`,
            tabIndex: -1,
            style: {
              position: `absolute`,
              width: 0,
              height: 0,
              border: `none`,
              opacity: 0,
              pointerEvents: `none`,
            },
          }),
          (0, l.jsx)(`iframe`, {
            ref: e,
            src: t,
            title: `应用调试控制台`,
            style: {
              width: `100%`,
              height: `100%`,
              border: `none`,
              display: `block`,
            },
          }),
        ],
      })
    );
  };
export { h as default };
