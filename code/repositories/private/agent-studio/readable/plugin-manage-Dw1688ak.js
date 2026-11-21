import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  Ei as i,
  Er as a,
  Hi as o,
  Vt as s,
  oi as c,
  or as l,
  rr as u,
  wr as d,
} from "./vendor-antd.QfSgOu5e.js";
import { t as f } from "./Icon-BCAHkjHa.js";
import { t as p } from "./TooltipEllipsis-4_dXZz0S.js";
import { t as m } from "./CardList-_VjNd1BT.js";
import { t as h } from "./Button-Docou5u1.js";
import { t as g } from "./drop-CiF4TSIV.js";
import {
  D as _,
  L as v,
  Ot as y,
  Tt as b,
  Y as x,
  ft as S,
} from "./index.B_LPe2F7.js";
import {
  D as C,
  E as w,
  f as T,
  y as E,
} from "./intelligentEngine-BhRFRjx8.js";
import { t as D } from "./ListLayout-B8lj_6O3.js";
import { t as O } from "./search-DZiSM-T-.js";
import { t as k } from "./mcp-version-icon-IPj4W7_O.js";
import { n as A, t as j } from "./PluginForm-icNwBkLH.js";
var M = e(t(), 1);
s();
var N = {
    Draft: `Draft`,
    Pending: `Pending`,
    Published: `Published`,
    Unpublished: `Unpublished`,
    Rejected: `Rejected`,
    Other: `Other`,
  },
  P = {
    [N.Draft]: { color: `warning`, text: `未上架` },
    [N.Pending]: { color: `processing`, text: `审核中` },
    [N.Published]: { color: `success`, text: `已上架` },
    [N.Unpublished]: { color: `error`, text: `已下架` },
    [N.Rejected]: { color: `error`, text: `已驳回` },
  },
  F = {
    normal: {
      typeName: `常规插件`,
      api: {},
      routes: {},
      ui: {
        typeLabel: `常规插件`,
        showVersion: !1,
        typeLabelStyle: { background: `#E9F5FF`, color: `#3A749F` },
      },
      fieldMapping: {
        compName: `compName`,
        compId: `compId`,
        compStatus: `compStatus`,
        description: `description`,
        picUrl: `picUrl`,
      },
      statusMapping: {
        4: N.Draft,
        2: N.Pending,
        1: N.Published,
        5: N.Unpublished,
        3: N.Rejected,
      },
    },
    mcp: {
      typeName: `MCP服务`,
      api: {},
      routes: {},
      ui: {
        typeLabel: `MCP服务`,
        showVersion: !0,
        typeLabelStyle: { background: `#F3EFFF`, color: `#62519F` },
      },
      fieldMapping: {
        compName: `mcpServerName`,
        compId: `id`,
        compStatus: `status`,
        description: `desc`,
        picUrl: `iconUrl`,
      },
      statusMapping: {
        1: N.Draft,
        2: N.Published,
        3: N.Unpublished,
        4: N.Other,
      },
    },
  },
  I = (e, t) => {
    let n = F[t]?.fieldMapping,
      r = F[t]?.statusMapping;
    return e.map((e) => {
      let t = { ...e };
      return (
        Object.entries(n).forEach(([n, r]) => {
          t[n] = e[r];
        }),
        r && t.compStatus in r && (t.compStatus = r[t.compStatus]),
        t
      );
    });
  },
  L = {
    "plugin-card": `_plugin-card_19tee_1`,
    "plugin-card-id": `_plugin-card-id_19tee_35`,
    "plugin-card-dropdown": `_plugin-card-dropdown_19tee_38`,
    "plugin-card-status": `_plugin-card-status_19tee_42`,
    "plugin-card-header": `_plugin-card-header_19tee_51`,
    "plugin-card-icon": `_plugin-card-icon_19tee_59`,
    "plugin-card-header-info": `_plugin-card-header-info_19tee_68`,
    "plugin-card-name": `_plugin-card-name_19tee_75`,
    "plugin-card-meta-icon": `_plugin-card-meta-icon_19tee_81`,
    "plugin-card-description": `_plugin-card-description_19tee_88`,
    "plugin-card-footer": `_plugin-card-footer_19tee_97`,
    "plugin-card-version": `_plugin-card-version_19tee_106`,
    "plugin-card-dropdown-trigger": `_plugin-card-dropdown-trigger_19tee_126`,
    "plugin-card-dropdown-menu": `_plugin-card-dropdown-menu_19tee_135`,
  },
  R = n(),
  z = (0, M.memo)(({ item: e, permissions: t, onMenuClick: n, onClick: r }) => {
    let {
        compName: o,
        compId: s,
        compStatus: l,
        description: u,
        picUrl: d = y,
        severVersion: m,
      } = e || {},
      h = P[String(l)],
      _ = S(t.edit || ``, `any`),
      v = S(t.publish || ``, `any`),
      b = S(t.delete || ``, `any`),
      x = S(t.unpublish || ``, `any`),
      C = (0, M.useCallback)(() => {
        r?.(e);
      }, [e, r]),
      w = (0, M.useCallback)(
        (t) => {
          n({ ...t, item: e });
        },
        [e, n],
      ),
      T = (0, M.useMemo)(
        () =>
          [
            ...(l !== `Published` && l !== `Pending`
              ? [
                  _ ? { label: `编辑`, key: `Edit` } : null,
                  v ? { label: `上架`, key: `Shelve` } : null,
                  b ? { label: `删除`, key: `Delete`, danger: !0 } : null,
                ]
              : []),
            ...(l === `Published`
              ? [x ? { label: `下架`, key: `Down` } : null]
              : []),
          ].filter(Boolean),
        [b, _, v, x, l],
      );
    return (0, R.jsxs)(
      c,
      {
        hoverable: !0,
        className: L[`plugin-card`],
        styles: { body: { padding: 0, overflow: `hidden`, border: `none` } },
        onClick: C,
        children: [
          h
            ? (0, R.jsx)(`div`, {
                className: L[`plugin-card-status`],
                children: (0, R.jsx)(i, { status: h.color, text: h.text }),
              })
            : null,
          (0, R.jsxs)(`div`, {
            className: L[`plugin-card-header`],
            children: [
              d
                ? (0, R.jsx)(f, {
                    src: d,
                    fbSrc: y,
                    size: 40,
                    className: L[`plugin-card-icon`],
                    alt: o,
                  })
                : null,
              (0, R.jsx)(`div`, {
                className: L[`plugin-card-header-info`],
                children: (0, R.jsx)(p, {
                  className: L[`plugin-card-name`],
                  children: o,
                }),
              }),
            ],
          }),
          (0, R.jsx)(p, {
            className: L[`plugin-card-description`],
            maxLines: 1,
            children: u || `-`,
          }),
          (0, R.jsx)(`div`, {
            className: L[`plugin-card-footer`],
            children: m
              ? (0, R.jsxs)(`div`, {
                  className: L[`plugin-card-version`],
                  children: [
                    (0, R.jsx)(`img`, {
                      src: k,
                      alt: ``,
                      className: L[`plugin-card-meta-icon`],
                    }),
                    (0, R.jsx)(`span`, { children: m }),
                  ],
                })
              : null,
          }),
          T.length > 0
            ? (0, R.jsx)(a, {
                className: L[`plugin-card-dropdown`],
                overlayClassName: L[`plugin-card-dropdown-menu`],
                trigger: [`hover`],
                menu: { items: T, onClick: w },
                children: (0, R.jsx)(`span`, {
                  className: L[`plugin-card-dropdown-trigger`],
                  onClick: (e) => e.stopPropagation(),
                  children: (0, R.jsx)(f, { src: g, size: 28 }),
                }),
              })
            : null,
        ],
      },
      s,
    );
  });
s();
var B = (0, M.memo)(
  ({
    searchValue: e = ``,
    onSearchChange: t,
    createPermission: n,
    onCreated: i,
  }) =>
    (0, R.jsxs)(d, {
      align: `center`,
      gap: 12,
      children: [
        (0, R.jsx)(r, {
          allowClear: !0,
          value: e,
          onChange: t,
          placeholder: `搜索插件名称`,
          prefix: (0, R.jsx)(`img`, { src: O, width: 16, alt: `` }),
          style: { width: `176px`, height: `32px` },
        }),
        (0, R.jsx)(j, {
          record: void 0,
          disabled: !1,
          callback: i,
          children: (0, R.jsx)(h, {
            type: `primary`,
            permissions: n,
            children: `新建常规插件`,
          }),
        }),
      ],
    }),
);
s();
var V = { nodes: [], edges: [] },
  H = (e) => {
    let t = x(),
      [n, r] = (0, M.useState)({ interfaceDependency: { ...V } }),
      [i, a] = (0, M.useState)(!1),
      [o, s] = (0, M.useState)(!1),
      c = (0, M.useCallback)(
        async (t, n) => {
          try {
            let r = await (t === `delete` ? T : E)(n);
            if (r?.errCode === 0 || r?.code === 0)
              return (await e(), l.success(`操作成功`), !0);
            l.error(r?.message);
          } catch (e) {
            console.error(`${t}常规插件失败:`, e);
          }
          return !1;
        },
        [e],
      ),
      d = (0, M.useCallback)(async (e) => {
        try {
          let t = await w({ id: e.compId });
          t?.errCode === 0 && (r(t.data), s(!0));
        } catch (e) {
          console.error(`编辑常规插件失败:`, e);
        }
      }, []),
      f = (0, M.useCallback)(
        (e) => {
          u.confirm({
            title: `确定删除该插件?`,
            onOk: () => c(`delete`, { compId: e.compId }),
          });
        },
        [c],
      ),
      p = (0, M.useCallback)(
        (e) => {
          u.confirm({
            title: `下架插件`,
            content: `下架插件后，配置智能体时将无法使用该插件，请谨慎操作！`,
            onOk: () => c(`down`, { compId: e.compId }),
          });
        },
        [c],
      ),
      m = (0, M.useCallback)(async () => {
        a(!0);
      }, []);
    return {
      currentData: n,
      onLineOpen: i,
      setOnlineOpen: a,
      pluginFormOpen: o,
      setPluginFormOpen: s,
      onMenuClick: (0, M.useCallback)(
        async ({ key: e, item: t, domEvent: n }) => {
          (n?.stopPropagation?.(), r(t));
          let i = { Edit: d, Delete: f, Down: p, Shelve: m }[e];
          if (!i) {
            console.warn(`未知操作: ${e}`);
            return;
          }
          await i(t);
        },
        [f, p, d, m],
      ),
      openDetail: (0, M.useCallback)(
        (e) => {
          t(b.AGENT_PLUGIN_DETAIL, { state: { id: e.compId } });
        },
        [t],
      ),
    };
  },
  U = 36,
  W = () => {
    let [e, t] = (0, M.useState)(``),
      [n, r] = (0, M.useState)(1),
      [i, a] = (0, M.useState)([]),
      [o, s] = (0, M.useState)(0),
      [c, l] = (0, M.useState)(`idle`),
      u = (0, M.useRef)(``),
      d = (0, M.useRef)(!1),
      f = (0, M.useCallback)(async (e = {}) => {
        if (d.current) return;
        let t = e?.pageNum ?? 1,
          n = e?.compName === void 0 ? u.current : e.compName;
        (e?.compName !== void 0 && (u.current = e.compName),
          t === 1 && a([]),
          (d.current = !0),
          l(t === 1 ? `initial` : `more`));
        try {
          let {
            data: e,
            errCode: i,
            code: o,
          } = await C({
            pageNum: t,
            pageSize: U,
            compName: n,
            releaseChannel: 0,
          });
          if ((i === 0 || o === 0) && e) {
            let n = e.records || e.data || [],
              i = e.total || e.totalSize || 0,
              o = e.pageNum || t;
            if (n.length) {
              let e = I(n, `normal`);
              (r(o), s(i), a((t) => (o === 1 ? e : [...t, ...e])));
            } else o === 1 && (a([]), r(1), s(0));
          } else (r(1), s(0), a([]));
        } catch (e) {
          (console.error(`获取常规插件列表失败:`, e), r(1), s(0), a([]));
        } finally {
          (l(`idle`), (d.current = !1));
        }
      }, []),
      p = (0, M.useMemo)(
        () => v((e) => f({ pageNum: 1, compName: e }), 600),
        [f],
      );
    ((0, M.useEffect)(
      () => () => {
        p.abort?.();
      },
      [p],
    ),
      (0, M.useEffect)(() => {
        f({ pageNum: 1, compName: `` });
      }, [f]));
    let m = (0, M.useCallback)(
        (e) => {
          let n = e?.target?.value ?? ``;
          (t(n), p(n));
        },
        [p],
      ),
      h = (0, M.useCallback)(async () => {
        n * U < o && (await f({ pageNum: n + 1 }));
      }, [n, o, f]),
      g = (0, M.useCallback)(async () => {
        await f({ pageNum: 1 });
      }, [f]);
    return {
      searchValue: e,
      pageList: i,
      isInitialLoading: c === `initial`,
      isLoadingMore: c === `more`,
      hasMore: i.length < o,
      changeSearch: m,
      handleLoadMore: h,
      refreshList: g,
    };
  },
  G = {
    scene: `app`,
    title: `插件管理`,
    visibleTypes: [`normal`],
    defaultType: `normal`,
    permissions: {
      create: _.PLUGIN_MANAGE_CREATE,
      edit: _.PLUGIN_MANAGE_EDIT,
      delete: _.PLUGIN_MANAGE_DELETE,
      publish: _.PLUGIN_MANAGE_PUBLISH,
      unpublish: _.PLUGIN_MANAGE_UNPUBLISH,
      authPolicy: _.PLUGIN_MANAGE_AUTH_POLICY,
      authPolicyView: _.APP_PLUGIN_AUTH_POLICY_VIEW,
      authPolicyEdit: _.APP_PLUGIN_AUTH_POLICY_EDIT,
      authPolicyDelete: _.APP_PLUGIN_AUTH_POLICY_DELETE,
      mcpToolView: _.MCP_TOOL_VIEW,
      mcpToolEdit: _.MCP_TOOL_EDIT,
      mcpToolEnable: _.MCP_TOOL_ENABLE,
      mcpToolDisable: _.MCP_TOOL_DISABLE,
      mcpToolDelete: _.MCP_TOOL_DELETE,
    },
    routes: {
      list: b.AGENT_PLUGIN_MANAGE,
      authPolicy: b.AGENT_PLUGIN_AUTH_POLICY,
      authPolicyDetail: b.AGENT_PLUGIN_AUTH_POLICY_DETAIL,
      mcpEdit: b.AGENT_PLUGIN_EDIT_MCP,
      toolEdit: b.AGENT_PLUGIN_EDIT_TOOL,
      toolDetails: b.AGENT_PLUGIN_TOOL_DETAILS,
      mcpDetails: b.AGENT_PLUGIN_MCP_DETAILS,
    },
  },
  K = {
    scene: `solution`,
    title: `MCP服务`,
    visibleTypes: [`mcp`],
    defaultType: `mcp`,
    permissions: {
      create: _.MCP_SERVICE_PLUGIN_MANAGE_CREATE,
      edit: _.MCP_SERVICE_PLUGIN_MANAGE_EDIT,
      delete: _.MCP_SERVICE_PLUGIN_MANAGE_DELETE,
      publish: _.MCP_SERVICE_PLUGIN_MANAGE_PUBLISH,
      unpublish: _.MCP_SERVICE_PLUGIN_MANAGE_UNPUBLISH,
      authPolicy: _.MCP_SERVICE_PLUGIN_MANAGE_AUTH_POLICY,
      authPolicyView: _.MCP_SERVICE_AUTH_POLICY_VIEW,
      authPolicyEdit: _.MCP_SERVICE_AUTH_POLICY_EDIT,
      authPolicyDelete: _.MCP_SERVICE_AUTH_POLICY_DELETE,
      mcpToolView: _.MCP_SERVICE_TOOL_VIEW,
      mcpToolEdit: _.MCP_SERVICE_TOOL_EDIT,
      mcpToolEnable: _.MCP_SERVICE_TOOL_ENABLE,
      mcpToolDisable: _.MCP_SERVICE_TOOL_DISABLE,
      mcpToolDelete: _.MCP_SERVICE_TOOL_DELETE,
    },
    routes: {
      list: b.AGENT_MCP_SERVICE,
      authPolicy: b.AGENT_MCP_AUTH_POLICY,
      authPolicyDetail: b.AGENT_MCP_AUTH_POLICY_DETAIL,
      mcpEdit: b.AGENT_MCP_EDIT_MCP,
      toolEdit: b.AGENT_MCP_EDIT_TOOL,
      toolDetails: b.AGENT_MCP_TOOL_DETAILS,
      mcpDetails: b.AGENT_MCP_MCP_DETAILS,
    },
  },
  q = (e) => {
    let t = e?.scene === `solution` ? K : G;
    return {
      ...t,
      ...e,
      permissions: { ...t.permissions, ...e?.permissions },
      routes: { ...t.routes, ...e?.routes },
      visibleTypes: e?.visibleTypes || t.visibleTypes,
      defaultType: e?.defaultType || t.defaultType,
    };
  },
  J = {
    "plugin-container": `_plugin-container_ws57u_1`,
    "plugin-header": `_plugin-header_ws57u_4`,
  };
s();
var Y = (0, M.memo)((e) => {
  let t = (0, M.useMemo)(() => q({ ...e, scene: `app` }), [e]),
    {
      searchValue: n,
      pageList: r,
      isInitialLoading: i,
      isLoadingMore: a,
      hasMore: s,
      changeSearch: c,
      handleLoadMore: l,
      refreshList: u,
    } = W(),
    {
      currentData: d,
      onLineOpen: f,
      setOnlineOpen: p,
      pluginFormOpen: h,
      setPluginFormOpen: g,
      onMenuClick: _,
      openDetail: v,
    } = H(u);
  return (0, R.jsxs)(R.Fragment, {
    children: [
      (0, R.jsx)(D, {
        mode: `card`,
        items: [],
        title: `插件管理`,
        tip: {
          content: `管理工作流可调用的插件工具，为流程编排与任务执行提供扩展能力。`,
          type: `info`,
        },
        extra: (0, M.useMemo)(
          () =>
            (0, R.jsx)(B, {
              searchValue: n,
              onSearchChange: c,
              createPermission: t.permissions.create,
              onCreated: v,
            }),
          [c, v, t.permissions.create, n],
        ),
        headerClassName: J[`plugin-header`],
        children: (0, R.jsx)(m, {
          skeleton: { loading: i, count: 8 },
          scrollLoad: {
            enabled: !0,
            hasMore: s,
            onLoadMore: l,
            loadingMore: a,
          },
          emptyContent: (0, R.jsx)(o, {
            image: o.PRESENTED_IMAGE_SIMPLE,
            style: { margin: `auto` },
          }),
          children: r.map((e) =>
            (0, R.jsx)(
              z,
              {
                item: e,
                permissions: t.permissions,
                onMenuClick: _,
                onClick: v,
              },
              e.compId,
            ),
          ),
        }),
      }),
      f
        ? (0, R.jsx)(A, {
            open: f,
            setOpen: p,
            id: d?.compId,
            callBack: () => {
              u();
            },
            paramData: d.interfaceDependency,
            pluginInfo: d,
          })
        : null,
      (0, R.jsx)(j, {
        type: `Edit`,
        record: d,
        disabled: !1,
        callback: v,
        open: h,
        onOpenChange: g,
      }),
    ],
  });
});
export { Y as default };
