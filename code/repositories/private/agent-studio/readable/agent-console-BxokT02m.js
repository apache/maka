import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import { Vt as r, Yi as i, or as a } from "./vendor-antd.QfSgOu5e.js";
import { n as o } from "./client-BfElcTb7.js";
import { Pt as s, j as c } from "./index.B_LPe2F7.js";
var l = e(t(), 1);
r();
var u = `84845`,
  d = (e) => {
    let t = document.createElement(`a`);
    ((t.href = e),
      (t.target = `_blank`),
      (t.rel = `noopener noreferrer`),
      document.body.appendChild(t),
      t.click(),
      document.body.removeChild(t));
  },
  f = (e) => {
    let t =
        window.location.hostname === `localhost` ||
        window.location.hostname === `127.0.0.1`,
      n = e.includes(`localhost`) || e.includes(`127.0.0.1`);
    if (!t || !n) return e;
    try {
      let t = new URL(e, window.location.origin);
      return (
        (t.host = window.location.host),
        (t.protocol = window.location.protocol),
        t.toString()
      );
    } catch {
      return e;
    }
  },
  p = async (e) => {
    if (!(await o.getSessionRoleList({ appCodes: `84845` }))?.length)
      throw Error(`无权访问观测平台，请检查应用权限`);
    let t = e?.tenant?.tenantCode,
      n = e?.org?.orgCode;
    if (!t || !n) throw Error(`未获取到当前租户/机构信息，请刷新后重试`);
    let { redirectUrl: r } = await o.getTicketBySwitch({
      appCode: u,
      tenantCode: t,
      orgCode: n,
    });
    if (!r) throw Error(`该应用暂未录入登录回调地址，请联系管理员`);
    d(f(r));
  },
  m = {
    "agent-console-page": `_agent-console-page_bn4mv_1`,
    "page-header": `_page-header_bn4mv_8`,
    "page-title": `_page-title_bn4mv_15`,
    "page-tag": `_page-tag_bn4mv_23`,
    content: `_content_bn4mv_34`,
    panel: `_panel_bn4mv_42`,
    "enter-btn": `_enter-btn_bn4mv_50`,
    description: `_description_bn4mv_55`,
  },
  h = n(),
  g = s(() => {
    let [e, t] = (0, l.useState)(!1),
      { userInfo: n } = c(),
      r = (0, l.useCallback)(async () => {
        if (!e) {
          t(!0);
          try {
            await p(n);
          } catch (e) {
            let t =
              e instanceof Error ? e.message : `跳转观测平台失败，请稍后重试`;
            (a.error(t), console.error(`[AgentConsole] 跳转失败:`, e));
          } finally {
            t(!1);
          }
        }
      }, [e, n]);
    return (0, h.jsxs)(`div`, {
      className: m[`agent-console-page`],
      children: [
        (0, h.jsxs)(`div`, {
          className: m[`page-header`],
          children: [
            (0, h.jsx)(`h1`, {
              className: m[`page-title`],
              children: `Agent观测`,
            }),
            (0, h.jsx)(`span`, {
              className: m[`page-tag`],
              children: `自主规划智能体调用观测`,
            }),
          ],
        }),
        (0, h.jsx)(`div`, {
          className: m.content,
          children: (0, h.jsxs)(`div`, {
            className: m.panel,
            children: [
              (0, h.jsx)(i, {
                type: `primary`,
                className: m[`enter-btn`],
                loading: e,
                onClick: r,
                children: `进入观测平台`,
              }),
              (0, h.jsx)(`p`, {
                className: m.description,
                children: `基于 Langfuse 提供的智能体可观测性能力：将 "系统提示词分层"、"todo.md进度锚点"、"上下文智能压缩" 与 "Sub-Agent冲突检测" 等全量桥接上报至 Langfuse 遥测网关。通过 Session ID (会话组) 与 Trace ID (长程轨迹) 追踪每一轮智能体决策链，评估响应质量。`,
              }),
            ],
          }),
        }),
      ],
    });
  });
export { g as default };
