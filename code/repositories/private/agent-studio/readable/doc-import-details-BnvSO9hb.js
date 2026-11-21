import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { Vt as r, j as i, or as a } from "./vendor-antd.QfSgOu5e.js";
import { J as o, St as s, X as c, Y as l } from "./index.B_LPe2F7.js";
import { t as u } from "./doc.api-VLu_TcYx.js";
import { t as d } from "./Step3-DvfNQyiz.js";
r();
var f = e(t(), 1),
  p = n();
function m() {
  l();
  let { search: e, state: t } = o();
  c();
  let [n, r] = f.useState(),
    [m, h] = f.useState(!0),
    { baseId: g, docId: _ } = t || {},
    [v, y] = f.useState(!1),
    b = f.useCallback(async () => {
      h(!0);
      let { code: e, data: t } = await u.queryBaseInfo({ docId: _ });
      if (e === 0) {
        let e = 1;
        (t?.step < 4 && (e = 1),
          t?.step === 4 && (e = t?.docStatus === 2 ? 3 : 2),
          t?.step === 5 && (e = 5),
          t?.step === 6 && (e = 4),
          console.log(`_docState`, e),
          (t._docState = e),
          r(t),
          y(t?.platformType === 0 && t?.docType === 0));
      }
      h(!1);
    }, [_]);
  return (
    f.useEffect(() => {
      if ((console.log(`docId`, _), s(_))) {
        a.info(`参数异常，请刷新或重新进入页面`);
        return;
      }
      b();
    }, [_]),
    !n && m
      ? (0, p.jsx)(`div`, {
          className: `global-text-center`,
          children: (0, p.jsx)(i, { spin: !0 }),
        })
      : (0, p.jsx)(d, {
          state: n,
          getInfo: b,
          sensitiveWords: t?.sensitiveWords,
          platformDisabled: v,
        })
  );
}
var h = f.memo(m);
export { h as default };
