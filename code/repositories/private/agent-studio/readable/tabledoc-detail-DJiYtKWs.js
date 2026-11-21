import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { J as r, Y as i } from "./index.B_LPe2F7.js";
import { t as a } from "./DetailLayout-139jNxZs.js";
import { t as o } from "./doc.api-VLu_TcYx.js";
import { t as s } from "./Step3-CdSeCYTf.js";
var c = e(t(), 1),
  l = n(),
  u = () => {
    let e = i(),
      { state: t } = r(),
      n = t?.record,
      u = t?.docId,
      [d, f] = c.useState({}),
      p = (0, c.useCallback)(async () => {
        u &&
          f({ ...(await o.queryBaseInfo({ docId: u }, {}))?.data, record: n });
      }, [u, n]);
    return (
      (0, c.useEffect)(() => {
        u && p();
      }, [u, p]),
      (0, l.jsx)(a, {
        title: `查看与编辑表结构配置`,
        showBack: !0,
        onBack: () => e(-1),
        showFooter: !1,
        children: (0, l.jsx)(s, { docInfo: d, getInfo: p, showStatus: !0 }),
      })
    );
  };
export { u as default };
