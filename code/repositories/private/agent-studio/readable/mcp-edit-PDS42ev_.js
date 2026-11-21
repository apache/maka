import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  C as i,
  Hi as a,
  Ii as o,
  Kt as s,
  Mi as c,
  Pi as l,
  S as u,
  Vt as d,
  Xr as f,
  Yi as p,
  ct as m,
  dr as h,
  oi as g,
  or as _,
  pt as v,
  rr as y,
  wr as b,
} from "./vendor-antd.QfSgOu5e.js";
import { t as x } from "./url-action-BsTcWDLi.js";
import { c as S, i as C, n as w, o as T } from "./auth-policy-BpcySR2d.js";
import { t as E } from "./AgentTable-DMLUccn2.js";
import { J as D, Y as O, ft as k } from "./index.B_LPe2F7.js";
import { t as A } from "./DetailLayout-139jNxZs.js";
import { t as j } from "./search-DZiSM-T-.js";
import {
  c as M,
  d as N,
  g as P,
  l as F,
  n as I,
  p as L,
  r as R,
  s as z,
  u as B,
} from "./page-config-BZC948Vm.js";
import { t as V } from "./MCPPluginForm-Dg3e6KFT.js";
import { n as H } from "./config-CqdrcT5J.js";
import { t as U } from "./ToolDetails-C8Z0MIw5.js";
var W = e(t(), 1);
d();
var G = n(),
  K = (e) => [
    { title: `名称`, dataIndex: `toolName`, search: !1 },
    { title: `描述`, dataIndex: `toolDesc`, search: !1 },
    {
      title: `操作`,
      valueType: `option`,
      render: (t, n) =>
        (0, G.jsx)(p, {
          type: `link`,
          style: { padding: 0 },
          onClick: () => e(n),
          children: `查看`,
        }),
    },
  ],
  q = {
    "tool-import-container": `_tool-import-container_47a62_1`,
    "tool-import-footer": `_tool-import-footer_47a62_7`,
  };
d();
var J = ({ mcpServerId: e, onCancel: t, onSave: n }) => {
    let r = (0, W.useRef)(),
      [i, a] = (0, W.useState)([]),
      [s, c] = (0, W.useState)({}),
      [l, u] = (0, W.useState)([]),
      [d, f] = (0, W.useState)(!1),
      [m, h] = (0, W.useState)(),
      [g, v] = (0, W.useState)(!1),
      [b, x] = (0, W.useState)(),
      [S, C] = (0, W.useState)(),
      [w, T] = (0, W.useState)(!1);
    ((0, W.useEffect)(() => {
      (async () => {
        f(!0);
        try {
          let e =
            (await N({}))?.data?.map((e) => ({
              label: e.name,
              value: String(e.id),
            })) || [];
          (u(e), h((t) => t ?? e[0].value));
        } catch (e) {
          console.error(`获取来源列表失败:`, e);
        } finally {
          f(!1);
        }
      })();
    }, []),
      (0, W.useEffect)(() => {
        (a([]), c({}));
      }, [m]));
    let D = async (e) => {
        let t = e?.source;
        if (!t) return { success: !0, data: [], total: 0 };
        try {
          let e = await L({ mcpServerId: t });
          return e.code === 0
            ? { success: !0, data: e.data || [], total: e.data?.length || 0 }
            : { success: !1, data: [], total: 0 };
        } catch (e) {
          return (
            console.error(`获取列表失败:`, e),
            { success: !1, data: [], total: 0 }
          );
        }
      },
      O = {
        selectedRowKeys: i,
        preserveSelectedRowKeys: !0,
        onChange: (e, t) => {
          (a(e),
            c((n) => {
              let r = { ...n };
              return (
                t.forEach(
                  ({
                    toolName: e,
                    toolDesc: t,
                    inputSchema: n,
                    outputSchema: i,
                    isOpen: a,
                    mcpServerId: o,
                    responseTemplate: s,
                    source: c,
                  }) => {
                    r[e] = {
                      inputSchema: n,
                      isOpen: a,
                      mcpServerId: o,
                      outputSchema: i,
                      responseTemplate: s,
                      toolDesc: t,
                      toolName: e,
                      source: c,
                    };
                  },
                ),
                Object.keys(r).forEach((t) => {
                  e.includes(t) || delete r[t];
                }),
                r
              );
            }));
        },
      },
      k = () => {
        (a([]), c({}), t?.());
      },
      A = async () => {
        let t = Object.values(s);
        (console.log(`已保存的选择项：`, t), T(!0));
        try {
          let r = { id: e, mcptoolsAddRequestList: t };
          (console.log(`params==============`, r),
            (await R(r)).code === 0 && (_.success(`保存成功`), n?.(t)));
        } catch (e) {
          console.error(`保存失败:`, e);
        } finally {
          T(!1);
        }
      },
      j = (e) => {
        console.log(`recordItem==============`, e);
        let t = e?.id !== void 0 && e.id !== null ? String(e.id) : void 0,
          n =
            typeof e?.id == `number`
              ? e.id
              : e?.id && !Number.isNaN(Number(e.id))
                ? Number(e.id)
                : void 0;
        (x(t),
          C({
            id: n,
            toolName: e.toolName,
            toolDesc: e.toolDesc,
            source: e.source,
            isOpen: e.isOpen,
          }),
          v(!0));
      },
      M = () => {
        (v(!1), x(void 0), C(void 0));
      },
      P = (e) => {
        (h(e), r.current?.reload());
      };
    return (0, G.jsxs)(`div`, {
      className: q[`tool-import-container`],
      children: [
        (0, G.jsx)(E, {
          rowKey: `toolName`,
          actionRef: r,
          request: D,
          columns: K(j),
          params: { source: m },
          pagination: !1,
          rowSelection: O,
          search: !1,
          toolBarRender: () => [
            (0, G.jsxs)(
              `div`,
              {
                children: [
                  `来源：`,
                  (0, G.jsx)(o, {
                    style: { width: 220 },
                    loading: d,
                    value: m,
                    options: l,
                    placeholder: `请选择来源`,
                    onChange: P,
                  }),
                ],
              },
              `sourceSelect`,
            ),
          ],
        }),
        (0, G.jsxs)(`div`, {
          className: q[`tool-import-footer`],
          children: [
            (0, G.jsx)(p, {
              style: { marginRight: 8 },
              onClick: k,
              children: `取消`,
            }),
            (0, G.jsx)(p, {
              type: `primary`,
              onClick: A,
              loading: w,
              children: `保存`,
            }),
          ],
        }),
        (0, G.jsx)(y, {
          title: `工具详情`,
          open: g,
          onCancel: M,
          footer: null,
          width: 960,
          destroyOnClose: !0,
          styles: {
            body: { padding: 0, maxHeight: `70vh`, overflowY: `auto` },
          },
          children: g && (0, G.jsx)(U, { open: g, toolId: b, record: S }),
        }),
      ],
    });
  },
  Y = {
    "popover-content": `_popover-content_1fneg_1`,
    "popover-content-header": `_popover-content-header_1fneg_1`,
    "search-input": `_search-input_1fneg_4`,
    "option-status": `_option-status_1fneg_11`,
    "option-status-spin": `_option-status-spin_1fneg_14`,
    "option-list": `_option-list_1fneg_19`,
    "option-item": `_option-item_1fneg_28`,
    "option-item-active": `_option-item-active_1fneg_40`,
    divider: `_divider_1fneg_43`,
    "add-auth-policy-btn": `_add-auth-policy-btn_1fneg_47`,
    "popover-link": `_popover-link_1fneg_59`,
    "popover-link-text": `_popover-link-text_1fneg_62`,
    "caret-icon": `_caret-icon_1fneg_65`,
    "caret-icon-rotated": `_caret-icon-rotated_1fneg_70`,
    "mcp-popover": `_mcp-popover_1fneg_73`,
  };
d();
var X = { id: 0, strategyName: `不需要鉴权` },
  ee = ({
    label: e = `鉴权方式`,
    onChange: t,
    tooltip: n = `MCP工具的统一鉴权方式`,
    searchPlaceholder: o = `搜索`,
    onSearchChange: d,
    extraContent: g,
    onAddGroup: _,
    mcpServerId: y,
    changeLoading: x = !1,
  }) => {
    let [C, w] = (0, W.useState)(!1),
      [E, D] = (0, W.useState)(``),
      [O, k] = (0, W.useState)(!1),
      [A, M] = (0, W.useState)([]),
      [N, P] = (0, W.useState)(),
      F = async () => {
        try {
          let e = await T({ mcpServerId: y });
          if (e.code !== 0) return;
          e.data
            ? P({ id: e.data.id, strategyName: e.data.strategyName })
            : P(X);
        } catch (e) {
          console.error(`getAuthPolicyByServerIdApi error`, e);
        }
      };
    (0, W.useEffect)(() => {
      F();
    }, [y]);
    let I = (e) => {
        let t = e.target.value;
        (D(t), d?.(t));
      },
      L = (0, W.useCallback)(async (e) => {
        k(!0);
        try {
          let t = await S({ strategyName: e?.trim() ?? `` });
          if (t?.code === 0) {
            let e = [X, ...(t?.data || [])];
            (M(e), P((t) => (t && e.some((e) => e.id === t.id) ? t : X)));
          } else M([X]);
        } catch (e) {
          (console.error(`getAuthPolicyListApi error:`, e), M([X]));
        } finally {
          k(!1);
        }
      }, []);
    (0, W.useEffect)(() => {
      let e = setTimeout(() => L(E), 300);
      return () => clearTimeout(e);
    }, [L, E]);
    let R = (e) => {
        x || (P(e), w(!1), t?.(e));
      },
      z = (e) => {
        x || w(e);
      },
      B = (0, W.useMemo)(() => N?.strategyName || ``, [N?.strategyName]),
      V = (0, G.jsxs)(G.Fragment, {
        children: [
          (0, G.jsxs)(`div`, {
            className: Y[`popover-content`],
            children: [
              (0, G.jsx)(`div`, {
                className: Y[`popover-content-header`],
                children: (0, G.jsx)(r, {
                  className: Y[`search-input`],
                  allowClear: !0,
                  prefix: (0, G.jsx)(`img`, { src: j, width: 16 }),
                  placeholder: o,
                  onChange: I,
                }),
              }),
              O
                ? (0, G.jsx)(`div`, {
                    className: Y[`option-status`],
                    children: (0, G.jsx)(h, {
                      size: `small`,
                      className: Y[`option-status-spin`],
                    }),
                  })
                : A.length
                  ? (0, G.jsx)(`div`, {
                      className: Y[`option-list`],
                      children: A.map((e) => {
                        let t = N?.id === e.id;
                        return (0, G.jsxs)(
                          `div`,
                          {
                            className: `${Y[`option-item`]} ${t ? Y[`option-item-active`] : ``}`,
                            onClick: () => R(e),
                            children: [
                              (0, G.jsx)(s.Text, {
                                style: { color: `var(--text-color-primary)` },
                                children: e.strategyName,
                              }),
                              t && (0, G.jsx)(m, {}),
                            ],
                          },
                          e.id,
                        );
                      }),
                    })
                  : (0, G.jsx)(`div`, {
                      className: Y[`option-status`],
                      children: (0, G.jsx)(a, {
                        image: a.PRESENTED_IMAGE_SIMPLE,
                        description: `暂无数据`,
                      }),
                    }),
              g,
            ],
          }),
          (0, G.jsx)(f, { className: Y.divider }),
          (0, G.jsx)(p, {
            type: `link`,
            icon: (0, G.jsx)(i, {}),
            onClick: _,
            className: Y[`add-auth-policy-btn`],
            children: `去添加鉴权`,
          }),
        ],
      });
    return (0, G.jsxs)(b, {
      align: `center`,
      gap: 4,
      children: [
        (0, G.jsx)(s.Text, { children: e }),
        (0, G.jsx)(l, {
          title: n,
          children: (0, G.jsx)(u, { style: { fontSize: 11 } }),
        }),
        (0, G.jsx)(s.Text, { children: `：` }),
        (0, G.jsx)(h, {
          spinning: x,
          size: `small`,
          children: (0, G.jsx)(c, {
            placement: `bottom`,
            trigger: `click`,
            content: V,
            open: C,
            onOpenChange: z,
            arrow: !1,
            overlayClassName: Y[`mcp-popover`],
            children: (0, G.jsxs)(b, {
              align: `center`,
              gap: 4,
              className: Y[`popover-link`],
              children: [
                (0, G.jsx)(s.Text, {
                  className: Y[`popover-link-text`],
                  children: B,
                }),
                (0, G.jsx)(v, {
                  className: `${Y[`caret-icon`]} ${C ? Y[`caret-icon-rotated`] : ``}`,
                }),
              ],
            }),
          }),
        }),
      ],
    });
  },
  te = (e) => [
    { title: `工具名称`, dataIndex: `toolNameCn`, key: `toolNameCn` },
    { title: `ID`, dataIndex: `toolName`, key: `toolName` },
    {
      title: `描述`,
      dataIndex: `toolDesc`,
      key: `toolDesc`,
      ellipsis: !0,
      width: 200,
    },
    {
      title: `创建来源`,
      dataIndex: `source`,
      key: `source`,
      render: (e, t) => H[t.source || 1],
    },
    {
      title: `状态`,
      dataIndex: `isOpen`,
      hideInSearch: !0,
      valueEnum: {
        0: { text: `禁用`, status: `Error` },
        1: { text: `启用`, status: `Success` },
      },
    },
    {
      title: `操作`,
      dataIndex: `option`,
      valueType: `option`,
      fixed: `right`,
      actionButtons: (t) => {
        let n = [
          {
            key: `view`,
            label: `查看`,
            menuCode: e?.permissions?.view || `mcp_tool_view`,
            onClick: () => e?.onView?.(t),
          },
          {
            key: `edit`,
            label: `编辑`,
            menuCode: e?.permissions?.edit || `mcp_tool_edit`,
            onClick: () => e?.onEdit?.(t),
          },
        ];
        if (t.isOpen)
          n.push({
            key: `disable`,
            label: `禁用`,
            menuCode: e?.permissions?.disable || `mcp_tool_disable`,
            onClick: () => e?.onDisable?.(t),
          });
        else {
          let r = [
            {
              key: `enable`,
              label: `启用`,
              menuCode: e?.permissions?.enable || `mcp_tool_enable`,
              onClick: () => e?.onEnable?.(t),
            },
            {
              key: `delete`,
              label: `删除`,
              menuCode: e?.permissions?.delete || `mcp_tool_delete`,
              onClick: () => e?.onDelete?.(t),
            },
          ];
          n.push(...r);
        }
        return n;
      },
    },
  ],
  Z = {
    "mcp-edit": `_mcp-edit_188uq_1`,
    "mcp-edit-container": `_mcp-edit-container_188uq_6`,
  };
d();
var Q = ({ scene: e }) => {
  let t = O(),
    n = D(),
    { state: r } = n,
    i = I({ scene: e }),
    a = r?.id,
    o = (0, W.useRef)(),
    s = (0, W.useRef)(null),
    [c, l] = (0, W.useState)(!1),
    [u, d] = (0, W.useState)(!1),
    [f, m] = (0, W.useState)(r?.checkTabs || `basicInfo`),
    [v, b] = (0, W.useState)(),
    [S, T] = (0, W.useState)(!1),
    [j, N] = (0, W.useState)(!1),
    [L, R] = (0, W.useState)(!1),
    H = k(i.permissions.mcpToolEdit || ``, `any`);
  ((0, W.useEffect)(() => {
    r?.checkTabs !== f &&
      t(n.pathname, { replace: !0, state: { ...r, checkTabs: f } });
  }, [f, n.pathname, t, r]),
    (0, W.useEffect)(() => {
      f === `configMcpTool` && o.current && o.current.reload();
    }, [f, a]));
  let U = async () => {
    T(!0);
    try {
      let e = await B(a);
      e.code === 0 ? b(e.data) : _.error(e.message || `获取MCP详情失败`);
    } catch (e) {
      console.error(`getMcpDetailApi error`, e);
    } finally {
      T(!1);
    }
  };
  (0, W.useEffect)(() => {
    if (!a) {
      b(void 0);
      return;
    }
    U();
  }, [a]);
  let K = async (e) => {
      if ((console.log(`id`, a), !a))
        return { data: [], success: !0, total: 0 };
      N(!0);
      try {
        let { current: t, pageSize: n } = e,
          r = await P({ mcpServerId: a, pageSize: n, pageNum: t });
        return r.code === 0
          ? {
              data: r?.data?.list || [],
              success: !0,
              total: r?.data?.total || 0,
            }
          : { data: [], success: !1, total: 0 };
      } catch {
        return { data: [], success: !1, total: 0 };
      } finally {
        N(!1);
      }
    },
    q = (e) => {
      m(e);
    },
    Y = () => {
      d(!1);
    },
    X = () => {
      (d(!1), o.current?.reload());
    },
    Q = () => {
      if (!v?.mcpType) {
        _.warning(`请先完善并保存MCP基础信息`);
        return;
      }
      t(i.routes.toolEdit, {
        state: {
          mcpServerId: a,
          mcpType: v.mcpType,
          checkTabs: `configMcpTool`,
          httpToMcpEnabled: v?.httpToMcpEnabled,
        },
      });
    },
    ne = (e) => {
      t(i.routes.toolDetails, { state: { id: e.id, mcpServerId: a } });
    },
    re = (e) => {
      t(i.routes.toolEdit, {
        state: {
          id: e.id,
          mcpServerId: a,
          mcpType: v?.mcpType,
          checkTabs: `configMcpTool`,
          httpToMcpEnabled: v?.httpToMcpEnabled,
        },
      });
    },
    ie = async (e) => {
      N(!0);
      try {
        let t = await F({ id: e.id });
        t.code === 0
          ? (_.success(`启用成功`), o.current?.reload())
          : _.error(t.message);
      } catch (e) {
        (_.error(`启用失败`), console.log(`enableToolApi error`, e));
      } finally {
        N(!1);
      }
    },
    ae = async (e) => {
      N(!0);
      try {
        console.log(`record`, e);
        let t = await M({ id: e.id });
        t.code === 0
          ? (_.success(`禁用成功`), o.current?.reload())
          : _.error(t.message);
      } catch (e) {
        (_.error(`禁用失败`), console.log(`disableToolApi error`, e));
      } finally {
        N(!1);
      }
    },
    oe = (e) => {
      y.confirm({
        title: `确认删除`,
        content: `确定要删除此工具吗？`,
        okText: `确认`,
        okType: `primary`,
        onOk: () => se(e),
      });
    },
    se = async (e) => {
      try {
        console.log(`record`, e);
        let t = await z({ id: e.id });
        t.code === 0 ? o.current?.reload() : _.error(t.message);
      } catch (e) {
        console.log(`deleteToolApi error`, e);
      }
    },
    $ = () => {
      t(i.routes.list, { state: { checkTabs: `mcp` } });
    },
    ce = async () => {
      try {
        let e = await C({ mcpServerId: a });
        e.code === 0 ? _.success(`设置成功`) : _.error(e.message);
      } catch (e) {
        console.error(`deleteAuthPolicyRelateApi error`, e);
      }
    },
    le = async (e) => {
      try {
        let t = await w({ mcpServerId: a, stategyId: e });
        t.code === 0 ? _.success(`设置成功`) : _.error(t.message);
      } catch (e) {
        console.error(`addAuthPolicyRelateApi error`, e);
      }
    };
  return (0, G.jsxs)(A, {
    className: Z[`mcp-edit`],
    headerItems: [
      { key: `basicInfo`, label: `基本信息` },
      { key: `configMcpTool`, label: `配置MCP工具` },
    ],
    headerActiveKey: f,
    onTabsChange: q,
    title: `编辑MCP服务`,
    showBack: !0,
    onBack: $,
    contentClassName: Z[`mcp-edit-container`],
    showSubmitButton: f === `basicInfo`,
    submitButtonText: `保存`,
    onSubmit: () => s.current?.submit(),
    submitLoading: c,
    children: [
      (0, G.jsx)(g, {
        styles: {
          body: {
            padding: f === `basicInfo` ? `40px 128px` : 0,
            height: `100%`,
          },
        },
        style: { boxShadow: `none`, height: `100%` },
        bordered: !1,
        className: Z[`mcp-edit-card`],
        children:
          f === `basicInfo`
            ? (0, G.jsx)(h, {
                spinning: S || c,
                wrapperClassName: Z[`mcp-edit-form`],
                children: (0, G.jsx)(V, {
                  ref: s,
                  type: `Edit`,
                  id: a,
                  detail: v,
                  detailLoading: S,
                  onSubmitSuccess: $,
                  onCancel: $,
                  showFormActions: !1,
                  onSubmitLoadingChange: l,
                }),
              })
            : (0, G.jsx)(E, {
                columns: te({
                  onView: (e) => ne(e),
                  onEdit: (e) => re(e),
                  onEnable: (e) => ie(e),
                  onDisable: (e) => ae(e),
                  onDelete: (e) => oe(e),
                  permissions: {
                    view: i.permissions.mcpToolView,
                    edit: i.permissions.mcpToolEdit,
                    enable: i.permissions.mcpToolEnable,
                    disable: i.permissions.mcpToolDisable,
                    delete: i.permissions.mcpToolDelete,
                  },
                }),
                search: !1,
                request: K,
                rowKey: `id`,
                actionRef: o,
                loading: j,
                pagination: { pageSize: 10 },
                serialNumber: !1,
                toolBarRender: () =>
                  f === `configMcpTool` && H
                    ? [
                        (0, G.jsx)(
                          p,
                          {
                            type: `primary`,
                            onClick: Q,
                            disabled: !v?.mcpType || S,
                            children: `新建`,
                          },
                          `create`,
                        ),
                      ]
                    : [],
                options: !1,
                headerTitle: (0, G.jsx)(ee, {
                  mcpServerId: a,
                  onChange: async (e) => {
                    R(!0);
                    try {
                      e?.id === 0 ? await ce() : await le(e?.id);
                    } finally {
                      R(!1);
                    }
                  },
                  changeLoading: L,
                  onAddGroup: () =>
                    t(i.routes.authPolicy, {
                      state: { action: x.OPEN_ADD_AUTH_POLICY },
                    }),
                }),
                scrollY: { type: `flex` },
              }),
      }),
      (0, G.jsx)(y, {
        title: `批量导入MCP工具`,
        width: 960,
        destroyOnClose: !0,
        footer: null,
        open: u,
        onCancel: Y,
        children: (0, G.jsx)(J, { mcpServerId: a, onCancel: Y, onSave: X }),
      }),
    ],
  });
};
export { Q as default };
