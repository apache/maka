import "./rolldown-runtime-CMxvf4Kt.js";
import { i as e, t } from "./vendor-react.CV1S_bb1.js";
import { J as n, Y as r } from "./index.B_LPe2F7.js";
import { t as i } from "./DetailLayout-139jNxZs.js";
import { n as a } from "./page-config-BZC948Vm.js";
import { t as o } from "./ToolDetails-C8Z0MIw5.js";
e();
var s = t(),
  c = ({ scene: e }) => {
    let t = r(),
      { state: c } = n(),
      l = a({ scene: e }),
      u = c?.id;
    return (0, s.jsx)(i, {
      title: `查看工具详情`,
      showBack: !0,
      showFooter: !1,
      onBack: () => {
        t(l.routes.mcpEdit, {
          state: { id: c?.mcpServerId, checkTabs: `configMcpTool` },
        });
      },
      children: (0, s.jsx)(o, { open: !0, toolId: u }),
    });
  };
export { c as default };
