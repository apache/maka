import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { n as r, p as i } from "./client-BfElcTb7.js";
var a = e(t(), 1),
  o = n(),
  s = i(),
  c = s + `/agent/wiki/`,
  l = window.location.origin.includes(`localhost`) ? c : s + `/agent/wiki/`,
  u = () =>
    (0, o.jsx)(`iframe`, {
      src: (0, a.useMemo)(() => {
        let e = r.getToken() || ``;
        return `${l}${l.includes(`?`) ? `&` : `?`}embed=1&token=${encodeURIComponent(e)}`;
      }, []),
      title: `Wiki 知识库`,
      allow: `clipboard-write; clipboard-read`,
      style: {
        width: `100%`,
        height: `100%`,
        border: `none`,
        display: `block`,
      },
    });
export { u as default };
