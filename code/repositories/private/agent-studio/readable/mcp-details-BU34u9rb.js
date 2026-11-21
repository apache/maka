import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Kt as r,
  Or as i,
  Qr as a,
  Vt as o,
  ci as s,
  hn as c,
  oi as l,
  wr as u,
} from "./vendor-antd.QfSgOu5e.js";
import { t as d } from "./AgentTable-DMLUccn2.js";
import { J as f, Y as p } from "./index.B_LPe2F7.js";
import { t as m } from "./DetailLayout-139jNxZs.js";
import { f as h, n as g } from "./page-config-BZC948Vm.js";
import { n as _ } from "./config-CqdrcT5J.js";
import { n as v, t as y } from "./utils-CafLu4oJ.js";
var b = e(t(), 1);
o();
var x = () => [
    { title: `参数名称`, dataIndex: `paramName`, search: !1 },
    { title: `参数描述`, dataIndex: `paramDesc`, search: !1 },
    { title: `参数类型`, dataIndex: `paramType`, search: !1 },
    { title: `必填`, dataIndex: `paramRequired`, search: !1 },
  ],
  S = () => [
    { title: `参数名称`, dataIndex: `paramCode`, search: !1 },
    { title: `参数描述`, dataIndex: `paramName`, search: !1 },
    { title: `参数类型`, dataIndex: `paramType`, search: !1 },
  ],
  C = {
    "mcp-details": `_mcp-details_tf2u5_1`,
    name: `_name_tf2u5_4`,
    "app-type": `_app-type_tf2u5_9`,
    description: `_description_tf2u5_21`,
    "tool-info": `_tool-info_tf2u5_25`,
    "tool-info-label": `_tool-info-label_tf2u5_28`,
    "mcp-icon": `_mcp-icon_tf2u5_31`,
  },
  w = n(),
  T = ({ scene: e }) => {
    let t = p(),
      n = f(),
      o = g({ scene: e }),
      { id: T } = n.state,
      [E, D] = (0, b.useState)(`1`),
      [O, k] = (0, b.useState)({}),
      [A, j] = (0, b.useState)(!1);
    (0, b.useEffect)(() => {
      M();
    }, [T]);
    let M = async () => {
        j(!0);
        try {
          let e = await h(T);
          e.code === 0 &&
            (k(e.data), D(String(e.data?.mcpToolList?.[0]?.id || ``)));
        } catch (e) {
          console.error(`获取MCP服务详情失败`, e);
        } finally {
          j(!1);
        }
      },
      N = () =>
        (O?.mcpToolList || []).map((e) => ({
          label: e.toolName,
          toolNameCn: e.toolNameCn,
          key: String(e.id || ``),
          closable: !1,
          source: _[e.source || 1],
          toolDesc: e.toolDesc,
          inputSchema: y(e.inputSchema),
          outputSchema: v(e.outputSchema),
        })),
      P = () => N().find((e) => e.key === E);
    return (0, w.jsx)(m, {
      contentClassName: C[`mcp-details`],
      title: `MCP服务详情`,
      showBack: !0,
      showCloseButton: !1,
      onBack: () => t(o.routes.list, { state: { checkTabs: `mcp` } }),
      children: (0, w.jsxs)(i, {
        direction: `vertical`,
        size: 16,
        style: { width: `100%` },
        children: [
          (0, w.jsx)(l, {
            loading: A,
            children: (0, w.jsxs)(u, {
              align: `center`,
              gap: 17,
              children: [
                (0, w.jsx)(`img`, {
                  src: O?.iconUrl,
                  alt: O?.mcpServerName,
                  className: C[`mcp-icon`],
                }),
                (0, w.jsxs)(u, {
                  vertical: !0,
                  gap: 10,
                  flex: 1,
                  children: [
                    (0, w.jsxs)(u, {
                      align: `center`,
                      gap: 8,
                      children: [
                        (0, w.jsx)(r.Text, {
                          className: C.name,
                          children: O?.mcpServerName,
                        }),
                        (0, w.jsxs)(r.Text, {
                          type: `secondary`,
                          className: C[`mcp-card-id`],
                          copyable: {
                            text: O?.mcpServerNacosName,
                            tooltips: [`复制`, `已复制`],
                          },
                          onClick: (e) => e.stopPropagation(),
                          children: [`ID：`, O?.mcpServerNacosName],
                        }),
                      ],
                    }),
                    (0, w.jsx)(r.Text, {
                      className: C.description,
                      children: O?.desc,
                    }),
                  ],
                }),
              ],
            }),
          }),
          (O?.mcpToolList || []).length > 0 &&
            (0, w.jsxs)(l, {
              title: `工具`,
              loading: A,
              children: [
                (0, w.jsxs)(`div`, {
                  className: C[`tool-info`],
                  children: [
                    `鉴权策略：`,
                    (0, w.jsx)(r.Text, {
                      children:
                        O?.mcpStrategyResponse?.strategyName || `不需要鉴权`,
                    }),
                  ],
                }),
                (0, w.jsx)(s, {
                  defaultActiveKey: `1`,
                  items: N(),
                  onChange: D,
                  activeKey: E,
                  hideAdd: !0,
                }),
                (0, w.jsxs)(i, {
                  direction: `vertical`,
                  size: 24,
                  style: { width: `100%` },
                  children: [
                    (0, w.jsxs)(c, {
                      gutter: 16,
                      className: C[`tool-info`],
                      children: [
                        (0, w.jsx)(a, {
                          span: 6,
                          children: (0, w.jsxs)(u, {
                            align: `flex-start`,
                            children: [
                              (0, w.jsx)(`span`, {
                                className: C[`tool-info-label`],
                                children: `ID：`,
                              }),
                              (0, w.jsx)(r.Text, { children: P()?.label }),
                            ],
                          }),
                        }),
                        P()?.toolNameCn &&
                          (0, w.jsx)(a, {
                            span: 6,
                            children: (0, w.jsxs)(u, {
                              align: `flex-start`,
                              children: [
                                (0, w.jsx)(`span`, {
                                  className: C[`tool-info-label`],
                                  children: `工具名称：`,
                                }),
                                (0, w.jsx)(r.Text, {
                                  children: P()?.toolNameCn,
                                }),
                              ],
                            }),
                          }),
                        (0, w.jsx)(a, {
                          span: 6,
                          children: (0, w.jsxs)(u, {
                            align: `flex-start`,
                            children: [
                              (0, w.jsx)(`span`, {
                                className: C[`tool-info-label`],
                                children: `工具描述：`,
                              }),
                              (0, w.jsx)(r.Text, { children: P()?.toolDesc }),
                            ],
                          }),
                        }),
                        (0, w.jsx)(a, {
                          span: 6,
                          children: (0, w.jsxs)(u, {
                            align: `flex-start`,
                            children: [
                              (0, w.jsx)(`span`, {
                                className: C[`tool-info-label`],
                                children: `接入类型：`,
                              }),
                              (0, w.jsx)(r.Text, { children: P()?.source }),
                            ],
                          }),
                        }),
                      ],
                    }),
                    (0, w.jsx)(r.Text, { strong: !0, children: `输入参数` }),
                    (0, w.jsx)(d, {
                      columns: x(),
                      search: !1,
                      rowKey: `rowKey`,
                      dataSource: P()?.inputSchema || [],
                      expandable: {
                        defaultExpandAllRows: !0,
                        indentSize: 20,
                        rowExpandable: (e) => !!e.children?.length,
                      },
                      pagination: !1,
                    }),
                    (0, w.jsx)(r.Text, { strong: !0, children: `输出参数` }),
                    (0, w.jsx)(d, {
                      columns: S(),
                      search: !1,
                      rowKey: `rowKey`,
                      dataSource: P()?.outputSchema || [],
                      expandable: {
                        defaultExpandAllRows: !0,
                        indentSize: 20,
                        childrenColumnName: `children`,
                        rowExpandable: (e) => !!e.children?.length,
                      },
                      pagination: !1,
                    }),
                  ],
                }),
              ],
            }),
        ],
      }),
    });
  };
export { T as default };
