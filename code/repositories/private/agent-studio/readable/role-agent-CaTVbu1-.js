import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  C as i,
  Ei as a,
  Er as o,
  Ii as s,
  Kr as c,
  Kt as l,
  Or as u,
  Pi as d,
  Vt as f,
  Xr as p,
  Yi as m,
  Z as h,
  dr as g,
  oi as _,
  or as v,
  rr as y,
  yr as b,
} from "./vendor-antd.QfSgOu5e.js";
import { t as x } from "./Icon-BCAHkjHa.js";
import { n as S } from "./src-_hjT3BN9.js";
import { n as C } from "./industry-dict-C4tk0Vz4.js";
import {
  a as w,
  f as T,
  l as ee,
  s as E,
  t as D,
  u as O,
} from "./plugin-manage-C7jNL1TC.js";
import { t as k } from "./TooltipEllipsis-4_dXZz0S.js";
import { t as A } from "./CardList-_VjNd1BT.js";
import { t as j } from "./app-Dnx7bwXT.js";
import { t as M } from "./drop-CiF4TSIV.js";
import { D as N, Tt as P, Y as F, ft as I } from "./index.B_LPe2F7.js";
import { t as L } from "./ListLayout-B8lj_6O3.js";
import { n as R, t as z } from "./version-icon-CKJPyHEt.js";
import {
  a as B,
  i as V,
  n as H,
  r as U,
  t as W,
} from "./McpSelectorModal-OPGzipAV.js";
var G = e(t(), 1);
f();
var K = {
    "plugin-upload-hint": `_plugin-upload-hint_lv45n_1`,
    "plugin-industry-select": `_plugin-industry-select_lv45n_6`,
    "plugin-icon-upload": `_plugin-icon-upload_lv45n_9`,
    "skills-form-item-label-container": `_skills-form-item-label-container_lv45n_12`,
    "skills-form-item-label": `_skills-form-item-label_lv45n_12`,
  },
  q = n(),
  J = (e) => (String(e) === `2` ? `upload` : `hub`),
  Y = ({
    open: e,
    onCancel: t,
    onOk: n,
    record: a,
    isEdit: o = !1,
    createEntry: l = `hub`,
  }) => {
    let [u] = b.useForm(),
      d = b.useWatch(`icon`, u),
      f = b.useWatch(`skills`, u),
      [p, h] = (0, G.useState)(l),
      [_, x] = (0, G.useState)(!1),
      [w, E] = (0, G.useState)({}),
      [O, k] = (0, G.useState)(``),
      [A, M] = (0, G.useState)(!1),
      [N, P] = (0, G.useState)(!1),
      [F, I] = (0, G.useState)([]),
      [L, R] = (0, G.useState)(!1),
      z = (0, G.useMemo)(
        () =>
          new Map(
            C.filter((e) => e.value).map((e) => [Number(e.value), e.label]),
          ),
        [],
      );
    ((0, G.useEffect)(() => {
      e && h(l);
    }, [l, e]),
      (0, G.useEffect)(() => {
        (async () => {
          if (e) {
            if (o && a?.pluginIdStr) {
              let e = (a.tags ?? [])
                .map((e) => {
                  let t = C.find((t) => t.label === e);
                  return t?.value ? Number(t.value) : null;
                })
                .filter((e) => e !== null);
              u.setFieldsValue({
                icon:
                  a.iconUrl ||
                  `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                pluginName: a.pluginName,
                pluginDescription: a.description ?? ``,
                tags: e,
                versionDescription: ``,
                skills: [],
              });
              try {
                P(!0);
                let e = await ee({ id: a.pluginIdStr });
                if (e?.errCode !== 0 || !e?.data) {
                  v.error(`获取 Plugin 详情失败`);
                  return;
                }
                h(J(e.data.addWay));
                let t =
                    e.data.pluginVersionDetails?.find(
                      (e) => e.inEffect === 1,
                    ) ?? e.data.pluginVersionDetails?.[0],
                  n = (t?.skills ?? []).map((e) => ({
                    id: e.skillId,
                    name: e.skillName,
                    iconUrl: e.iconUrl,
                    description: e.skillDescription,
                  }));
                (u.setFieldsValue({
                  icon:
                    e.data.iconUrl ||
                    a.iconUrl ||
                    `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                  pluginName: e.data.name ?? a.pluginName,
                  pluginNameCn: e.data.pluginNameCn ?? a.pluginNameCn,
                  pluginDescription:
                    e.data.pluginDescription ?? a.description ?? ``,
                  versionDescription: t?.description ?? ``,
                  skills: n.map((e) => ({
                    name: e.name,
                    skillId: Number(e.id),
                  })),
                  sortValue: e.data.sortValue,
                }),
                  E({ "": n }));
                return;
              } catch (e) {
                (console.error(`获取 Plugin 详情失败`, e),
                  v.error(`获取 Plugin 详情失败`));
              } finally {
                P(!1);
              }
            }
            (E({}),
              h(l),
              u.getFieldValue(`icon`) || u.setFieldValue(`icon`, j));
          }
        })();
      }, [u, o, e, a]));
    let Y = () => {
      (u.resetFields(), E({}), h(l), k(``), x(!1), t());
    };
    return (0, q.jsxs)(y, {
      title: o ? `编辑智能专家` : `新建智能专家`,
      open: e,
      onCancel: Y,
      onOk: async () => {
        try {
          let e = await u.validateFields();
          if (!o && p === `upload` && !e.path) {
            v.error(`请上传智能专家包`);
            return;
          }
          let t = (e.tags ?? [])
            .map((e) => Number(e))
            .filter(Boolean)
            .map((e) => ({ tagId: e, tagName: z.get(e) ?? String(e) }));
          if (!t[0]) {
            v.error(`请选择所属行业`);
            return;
          }
          let r = {
            icon: e.icon ?? ``,
            pluginDescription: e.pluginDescription ?? ``,
            pluginName: e.pluginName,
            skills: (e.skills ?? []).map((e) => ({
              name: e.name,
              skillId: Number(e.skillId),
            })),
            tags: t,
            versionDescription: e.versionDescription ?? ``,
            sortValue: e.sortValue ?? 0,
            path: e.path ?? ``,
            pluginNameCn: e.pluginNameCn ?? ``,
            ...(!o && F.length > 0
              ? {
                  mcps: F.map((e, t) => ({
                    mcpServiceId: e.id,
                    mcpSource: e.mcpSource,
                    mcpServerName: e.mcpServerName,
                    mcpServerNacosName: e.mcpServerNacosName,
                    mcpServerDesc: e.desc,
                    iconUrl: e.iconUrl,
                    sortValue: t + 1,
                    state: e.state,
                    tools: (e.mcpToolList || []).map((e, t) => ({
                      mcptoolsInfoId: e.id,
                      toolName: e.toolName,
                      toolDesc: e.toolDesc,
                      sortValue: t + 1,
                    })),
                  })),
                }
              : {}),
          };
          if ((M(!0), o)) {
            if (!a?.pluginIdStr) {
              v.error(`未获取到插件ID`);
              return;
            }
            let e = await T({ ...r, pluginId: a.pluginIdStr });
            if (e?.errCode === 0) {
              (v.success(`编辑 Plugin 成功`), n?.(), Y());
              return;
            }
            v.error(e?.errMessage || `编辑 Plugin 失败`);
            return;
          }
          let i = await D(r);
          if (i?.errCode === 0) {
            (v.success(`新增 Plugin 成功`), n?.(), Y());
            return;
          }
          v.error(i?.errMessage || `新增 Plugin 失败`);
        } catch (e) {
          console.error(o ? `编辑 Plugin 失败` : `新增 Plugin 失败`, e);
        } finally {
          M(!1);
        }
      },
      confirmLoading: A,
      destroyOnClose: !0,
      children: [
        (0, q.jsx)(g, {
          spinning: N,
          children: (0, q.jsxs)(b, {
            layout: `vertical`,
            form: u,
            children: [
              p === `hub`
                ? (0, q.jsx)(b.Item, {
                    label: `智能专家ID`,
                    name: `pluginName`,
                    rules: [
                      { required: !0, message: `请输入智能专家ID` },
                      {
                        pattern: /^[a-zA-Z0-9-]+$/,
                        message: `必须使用英文字符、数字、连字符（-）`,
                      },
                    ],
                    children: (0, q.jsx)(r, {
                      placeholder: `请输入智能专家ID，必须使用英文字符、数字、连字符（-）`,
                      maxLength: 50,
                      showCount: !0,
                    }),
                  })
                : (0, q.jsx)(b.Item, {
                    name: `pluginName`,
                    noStyle: !0,
                    children: (0, q.jsx)(r, { hidden: !0 }),
                  }),
              (0, q.jsx)(b.Item, {
                label: `中文名称`,
                name: `pluginNameCn`,
                rules: [{ required: !0, message: `请输入中文名称` }],
                children: (0, q.jsx)(r, {
                  placeholder: `请输入智能专家名称`,
                  maxLength: 50,
                  showCount: !0,
                }),
              }),
              (0, q.jsx)(b.Item, {
                label: `职责描述`,
                name: `pluginDescription`,
                children: (0, q.jsx)(r.TextArea, {
                  placeholder: `请输入职责描述`,
                  maxLength: 200,
                  rows: 4,
                  showCount: !0,
                }),
              }),
              (0, q.jsx)(b.Item, {
                label: `所属行业`,
                name: `tags`,
                rules: [{ required: !0, message: `请选择所属行业` }],
                className: K[`plugin-industry-select`],
                children: (0, q.jsx)(s, {
                  options: C.filter((e) => e.value),
                  mode: `multiple`,
                  placeholder: `请选择所属行业`,
                }),
              }),
              !o &&
                (0, q.jsx)(b.Item, {
                  label: `版本介绍`,
                  name: `versionDescription`,
                  children: (0, q.jsx)(r.TextArea, {
                    placeholder: `初始版本发布`,
                    maxLength: 200,
                    rows: 4,
                    showCount: !0,
                  }),
                }),
              (0, q.jsx)(S, {
                form: u,
                fieldName: `icon`,
                value: d,
                onChange: (e) => u.setFieldValue(`icon`, e),
                label: `上传照片`,
                defaultImage: j,
                generateNameFieldName: `pluginName`,
                generateDescriptionFieldName: `pluginDescription`,
                className: K[`plugin-icon-upload`],
              }),
              (0, q.jsx)(b.Item, {
                name: `skills`,
                noStyle: !0,
                children: (0, q.jsx)(r, { hidden: !0 }),
              }),
              !o &&
                p === `hub` &&
                (0, q.jsx)(U, {
                  actionSlot: (0, q.jsx)(m, {
                    type: `link`,
                    icon: (0, q.jsx)(i, {}),
                    onClick: () => x(!0),
                    children: `从原子技能市场添加`,
                  }),
                  value: f ?? [],
                  onRemove: (e) => {
                    let t = f?.filter((t) => t.name !== e) ?? [];
                    (u.setFieldValue(`skills`, t),
                      E((t) => ({
                        ...t,
                        [O]: (t[O] ?? []).filter((t) => t.name !== e),
                      })));
                  },
                }),
              (0, q.jsx)(b.Item, {
                name: `path`,
                noStyle: !0,
                children: (0, q.jsx)(r, { hidden: !0 }),
              }),
              !o && p === `upload`
                ? (0, q.jsx)(B, {
                    hintText: `（建议使用示例格式导入，支持zip压缩包，最大100M）`,
                    onUploadSuccess: (e) => {
                      u.setFieldsValue({
                        pluginName: e.pluginName,
                        path: e.path,
                      });
                    },
                  })
                : null,
              !o &&
                p === `upload` &&
                (0, q.jsx)(q.Fragment, {
                  children: (0, q.jsx)(H, {
                    actionSlot: (0, q.jsx)(m, {
                      type: `link`,
                      onClick: () => R(!0),
                      children: `添加MCP`,
                    }),
                    value: F,
                    onRemove: (e) => {
                      I((t) => t.filter((t) => t.id !== e));
                    },
                    onRemoveTool: (e, t) => {
                      I((e) =>
                        e
                          .map((e) => ({
                            ...e,
                            mcpToolList:
                              e.mcpToolList?.filter((e) => e.id !== t) || [],
                          }))
                          .filter((e) => e.mcpToolList.length > 0),
                      );
                    },
                  }),
                }),
              (0, q.jsx)(b.Item, {
                name: `sortValue`,
                label: `排序`,
                style: { marginTop: 16 },
                children: (0, q.jsx)(c, {
                  placeholder: `请输入排序值，数字整型`,
                  min: 0,
                  max: 9999,
                  precision: 0,
                  style: { width: `100%` },
                }),
              }),
            ],
          }),
        }),
        !o &&
          p === `upload` &&
          (0, q.jsx)(W, {
            visible: L,
            onClose: () => R(!1),
            selectedMcps: F,
            onConfirm: (e) => {
              (I((t) => {
                let n = t.map((e) => ({
                  ...e,
                  mcpToolList: [...(e.mcpToolList || [])],
                }));
                for (let t of e) {
                  let e = n.findIndex((e) => e.id === t.id);
                  if (e >= 0) {
                    let r = new Set(n[e].mcpToolList.map((e) => e.id));
                    for (let i of t.mcpToolList || [])
                      r.has(i.id) || n[e].mcpToolList.push(i);
                  } else
                    n.push({ ...t, mcpToolList: [...(t.mcpToolList || [])] });
                }
                return n;
              }),
                R(!1));
            },
            onRemove: (e) => {
              I((t) =>
                t
                  .map((t) => ({
                    ...t,
                    mcpToolList:
                      t.mcpToolList?.filter(
                        (t) => String(t.id) !== String(e.id),
                      ) || [],
                  }))
                  .filter((e) => e.mcpToolList.length > 0),
              );
            },
            onRemoveBatch: (e) => {
              let t = new Set(e.map((e) => String(e.id)));
              I((e) =>
                e
                  .map((e) => ({
                    ...e,
                    mcpToolList:
                      e.mcpToolList?.filter((e) => !t.has(String(e.id))) || [],
                  }))
                  .filter((e) => e.mcpToolList.length > 0),
              );
            },
          }),
        (0, q.jsx)(V, {
          open: _,
          defaultCheckedIds: w[O] ?? [],
          onCancel: () => {
            (x(!1), k(``));
          },
          onOk: (e) => {
            (E((t) => ({ ...t, [O]: e })),
              u.setFieldValue(
                `skills`,
                e.map((e) => ({ name: e.name, skillId: Number(e.id) })),
              ),
              x(!1),
              k(``));
          },
        }),
      ],
    });
  },
  X = {
    "plugin-card": `_plugin-card_igl2b_1`,
    "plugin-card-id": `_plugin-card-id_igl2b_17`,
    "plugin-card-dropdown": `_plugin-card-dropdown_igl2b_20`,
    "plugin-header": `_plugin-header_igl2b_34`,
    "plugin-card-header": `_plugin-card-header_igl2b_37`,
    "plugin-card-header-info": `_plugin-card-header-info_igl2b_43`,
    "plugin-card-icon": `_plugin-card-icon_igl2b_50`,
    "plugin-card-title": `_plugin-card-title_igl2b_58`,
    "plugin-card-meta": `_plugin-card-meta_igl2b_68`,
    "plugin-card-meta-icon": `_plugin-card-meta-icon_igl2b_74`,
    "plugin-card-subtext": `_plugin-card-subtext_igl2b_78`,
    "plugin-card-status": `_plugin-card-status_igl2b_88`,
    "plugin-card-description": `_plugin-card-description_igl2b_98`,
    "plugin-card-footer": `_plugin-card-footer_igl2b_122`,
    "plugin-card-footer-left": `_plugin-card-footer-left_igl2b_130`,
    "created-by": `_created-by_igl2b_138`,
    "created-by-icon": `_created-by-icon_igl2b_146`,
    "plugin-card-footer-version-icon": `_plugin-card-footer-version-icon_igl2b_147`,
    "created-by-text": `_created-by-text_igl2b_151`,
    "plugin-card-footer-version": `_plugin-card-footer-version_igl2b_147`,
    "plugin-card-footer-divider": `_plugin-card-footer-divider_igl2b_168`,
    "plugin-card-footer-tag": `_plugin-card-footer-tag_igl2b_176`,
    "plugin-card-dropdown-trigger": `_plugin-card-dropdown-trigger_igl2b_199`,
    "ant-dropdown-open": `_ant-dropdown-open_igl2b_204`,
    "plugin-card-dropdown-menu": `_plugin-card-dropdown-menu_igl2b_208`,
  };
f();
var te = ({ bindSkillCount: e, bindMcpCount: t }) =>
    (0, q.jsxs)(q.Fragment, {
      children: [
        e != null &&
          e > 0 &&
          (0, q.jsxs)(q.Fragment, {
            children: [e, `个技能Skill`, t ? `·` : ``],
          }),
        t != null &&
          t > 0 &&
          (0, q.jsxs)(q.Fragment, { children: [t, `个MCP工具`] }),
      ],
    }),
  Z = () => {
    let e = F(),
      [t, n] = (0, G.useState)(``),
      [r, i] = (0, G.useState)(),
      [c, f] = (0, G.useState)(``),
      [g, b] = (0, G.useState)([]),
      [S, T] = (0, G.useState)(!1),
      [ee, D] = (0, G.useState)(`hub`),
      [j, B] = (0, G.useState)(null),
      [V, H] = (0, G.useState)(1),
      [U, W] = (0, G.useState)(36),
      [K, J] = (0, G.useState)(0),
      [Z, Q] = (0, G.useState)(`idle`),
      ne = I(N.INDUSTRY_PLUGIN_MANAGE_DETAIL),
      re = I(N.INDUSTRY_PLUGIN_MANAGE_DETAIL),
      ie = I(N.INDUSTRY_PLUGIN_MANAGE_DETAIL),
      ae = I(N.INDUSTRY_PLUGIN_MANAGE_DETAIL),
      $ = (0, G.useCallback)(
        async (e) => {
          let t = e?.pageNum ?? V,
            n = e?.pluginNameCn === void 0 ? c : e.pluginNameCn,
            i = C.find((t) => t.value === (e?.filterIndustry ?? r))?.label;
          e?.pluginNameCn !== void 0 && f(e.pluginNameCn);
          let a = t === 1 ? `initial` : `more`;
          (t === 1 && b([]), Q(a));
          let o = {
            pageNum: t,
            pageSize: U.toString(),
            tagName: i,
            searchKey: n || ``,
          };
          try {
            let { data: e, errCode: t } = await O(o);
            if (t === 0 && e) {
              let { records: t, total: n, size: r, current: i } = e;
              (H(i),
                W(r),
                J(n),
                b((e) => (i === 1 ? t || [] : [...e, ...(t || [])])));
            } else (H(1), W(10), J(0), b([]));
          } catch (e) {
            (console.error(`获取列表失败:`, e), H(1), W(10), J(0), b([]));
          } finally {
            Q(`idle`);
          }
        },
        [V, U, c, r],
      );
    (0, G.useEffect)(() => {
      $({ pageNum: 1 });
    }, []);
    let oe = (e) => {
        n(e);
      },
      se = (0, G.useCallback)(
        (e) => {
          (f(e), $({ pageNum: 1, pluginNameCn: e }));
        },
        [$],
      ),
      ce = (0, G.useCallback)(
        (e) => {
          (i(e), $({ pageNum: 1, filterIndustry: e }));
        },
        [$],
      ),
      le = (0, G.useCallback)(async () => {
        V * U < K && (await $({ pageNum: V + 1 }));
      }, [V, U, K, $]),
      ue = () => {
        (T(!1), B(null), D(`hub`));
      },
      de = async (e, t) => {
        let n = e.pluginIdStr || ``;
        if (!n) {
          v.error(`未获取到插件ID`);
          return;
        }
        let r = t ? `上架` : `下架`,
          i = await E({ pluginId: n, enable: t });
        if (i?.errCode === 0 && i?.data?.success !== !1) {
          (v.success(i.data?.message || `${r}成功`), $({ pageNum: 1 }));
          return;
        }
        let a = i?.data?.message || i?.errMessage || `${r}失败`;
        if (t) {
          v.error(a);
          return;
        }
        y.error({ title: `${r}失败`, content: a, okText: `确定` });
      },
      fe = {
        Detail: (t) => {
          e(P.AGENT_ROLE_AGENT_DETAIL, { state: t });
        },
        Edit: (e) => {
          (D(`hub`), B(e), T(!0));
        },
        Delete: (e) => {
          y.confirm({
            title: `删除`,
            content: `确认删除该智能专家？删除后不可恢复。`,
            onOk: async () => {
              let t = e.pluginIdStr || ``;
              if (!t) {
                v.error(`未获取到插件ID`);
                return;
              }
              try {
                let e = await w({ pluginId: t });
                e?.errCode === 0 &&
                  (v.success(e.data?.message || `删除成功`), $({ pageNum: 1 }));
              } catch (e) {
                e?.data && v.error(e?.data || `删除失败`);
              }
            },
          });
        },
        Publish: (e) => {
          de(e, !0);
        },
        Unpublish: (e) => {
          y.confirm({
            title: `下架`,
            content: `确认下架该智能专家？下架后在智能体市场不再展示。`,
            onOk: async () => {
              await de(e, !1);
            },
            cancelText: `取消`,
            okText: `确认`,
          });
        },
      },
      pe = Z === `initial`,
      me = Z === `more`,
      he = g.length < K,
      ge = {
        1: { text: `已上架`, status: `success` },
        0: { text: `未上架`, status: `default` },
      };
    return (0, q.jsxs)(L, {
      mode: `card`,
      title: `智能专家`,
      tip: {
        content: `管理数字智能专家，为它们分配原子技能和 MCP 工具，组建业务团队。`,
        type: `info`,
      },
      activeKey: t,
      onChange: oe,
      search: {
        value: c,
        onChange: se,
        placeholder: `搜索智能专家`,
        width: 200,
      },
      extra: (0, q.jsxs)(
        u,
        {
          size: 8,
          children: [
            (0, q.jsx)(s, {
              placeholder: `请选择行业`,
              style: { width: 160 },
              value: r,
              onChange: ce,
              options: [{ value: ``, label: `全部` }, ...C],
            }),
            (0, q.jsx)(o, {
              menu: {
                items: [
                  { key: `upload`, label: `+ 上传智能专家包` },
                  { key: `hub`, label: `+ 从原子技能市场添加` },
                ],
                onClick: ({ key: e, domEvent: t }) => {
                  (t?.stopPropagation(),
                    B(null),
                    D(e === `upload` ? `upload` : `hub`),
                    T(!0));
                },
              },
              trigger: [`click`, `hover`],
              children: (0, q.jsxs)(m, {
                type: `primary`,
                children: [`新建智能专家 `, (0, q.jsx)(h, {})],
              }),
            }),
          ],
        },
        `solution-plugin-manage-extra`,
      ),
      headerClassName: X[`plugin-header`],
      children: [
        (0, q.jsx)(A, {
          skeleton: { loading: pe, count: 8 },
          scrollLoad: {
            enabled: !0,
            hasMore: he,
            onLoadMore: le,
            loadingMore: me,
          },
          children: (g || []).map((t) => {
            let n = (t?.tags || [])[0],
              r = !!t.createdBy,
              i = !!t.version,
              s = !!n,
              c =
                (t.bindSkillCount != null && t.bindSkillCount > 0) ||
                (t.bindMcpCount != null && t.bindMcpCount > 0),
              u = (0, q.jsx)(te, {
                bindSkillCount: t.bindSkillCount,
                bindMcpCount: t.bindMcpCount,
              });
            return (0, q.jsxs)(
              _,
              {
                hoverable: !0,
                className: X[`plugin-card`],
                onClick: () => {
                  e(P.AGENT_ROLE_AGENT_DETAIL, { state: t });
                },
                children: [
                  (0, q.jsxs)(`div`, {
                    className: X[`plugin-card-header`],
                    children: [
                      (0, q.jsx)(`img`, {
                        src:
                          t.iconUrl ||
                          `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                        className: X[`plugin-card-icon`],
                        alt: t.pluginNameCn,
                      }),
                      (0, q.jsxs)(`div`, {
                        className: X[`plugin-card-header-info`],
                        children: [
                          (0, q.jsx)(l.Text, {
                            className: X[`plugin-card-title`],
                            children: t.pluginNameCn,
                          }),
                          c
                            ? (0, q.jsx)(d, {
                                title: u,
                                children: (0, q.jsx)(`div`, {
                                  className: X[`plugin-card-meta`],
                                  children: (0, q.jsx)(l.Text, {
                                    className: X[`plugin-card-subtext`],
                                    children: u,
                                  }),
                                }),
                              })
                            : null,
                        ],
                      }),
                      (0, q.jsx)(a, {
                        status: ge[t.status ?? 0]?.status,
                        text: ge[t.status ?? 0]?.text,
                        className: X[`plugin-card-status`],
                      }),
                    ],
                  }),
                  (0, q.jsx)(k, {
                    maxLines: 1,
                    className: X[`plugin-card-description`],
                    children: t.description || `-`,
                  }),
                  t.pluginName
                    ? (0, q.jsxs)(l.Text, {
                        className: X[`plugin-card-id`],
                        copyable: {
                          text: t.pluginName,
                          tooltips: [`复制`, `已复制`],
                        },
                        onClick: (e) => e.stopPropagation(),
                        children: [`ID：`, t.pluginName],
                      })
                    : null,
                  (0, q.jsxs)(`div`, {
                    className: X[`plugin-card-footer`],
                    children: [
                      (0, q.jsxs)(`div`, {
                        className: X[`plugin-card-footer-left`],
                        children: [
                          r
                            ? (0, q.jsxs)(`div`, {
                                className: X[`created-by`],
                                children: [
                                  (0, q.jsx)(x, {
                                    src: R,
                                    size: 12,
                                    className: X[`created-by-icon`],
                                  }),
                                  (0, q.jsx)(l.Text, {
                                    className: X[`created-by-text`],
                                    children: t.createdBy,
                                  }),
                                ],
                              })
                            : null,
                          r && (i || s)
                            ? (0, q.jsx)(p, {
                                type: `vertical`,
                                className: X[`plugin-card-footer-divider`],
                              })
                            : null,
                          i
                            ? (0, q.jsxs)(`div`, {
                                className: X[`plugin-card-footer-version`],
                                children: [
                                  (0, q.jsx)(x, {
                                    src: z,
                                    size: 12,
                                    className:
                                      X[`plugin-card-footer-version-icon`],
                                  }),
                                  (0, q.jsx)(`span`, { children: t.version }),
                                ],
                              })
                            : null,
                          i && s
                            ? (0, q.jsx)(p, {
                                type: `vertical`,
                                className: X[`plugin-card-footer-divider`],
                              })
                            : null,
                          s
                            ? (0, q.jsx)(`span`, {
                                className: X[`plugin-card-footer-tag`],
                                children: n,
                              })
                            : null,
                        ],
                      }),
                      (0, q.jsx)(o, {
                        className: X[`plugin-card-dropdown`],
                        overlayClassName: X[`plugin-card-dropdown-menu`],
                        trigger: [`hover`],
                        menu: {
                          items: [
                            ie && t.status === 0
                              ? { label: `上架`, key: `Publish` }
                              : null,
                            ne && t.status === 0
                              ? { label: `编辑`, key: `Edit` }
                              : null,
                            re && t.status === 0
                              ? { label: `删除`, key: `Delete` }
                              : null,
                            ae && t.status === 1
                              ? { label: `下架`, key: `Unpublish` }
                              : null,
                          ].filter(Boolean),
                          onClick: ({ key: e, domEvent: n }) => {
                            (n?.stopPropagation(), fe[e]?.(t));
                          },
                        },
                        children: (0, q.jsx)(`span`, {
                          className: X[`plugin-card-dropdown-trigger`],
                          onClick: (e) => e.stopPropagation(),
                          children: (0, q.jsx)(x, { src: M, size: 28 }),
                        }),
                      }),
                    ],
                  }),
                ],
              },
              t.pluginIdStr,
            );
          }),
        }),
        (0, q.jsx)(Y, {
          open: S,
          record: j,
          isEdit: !!j,
          createEntry: ee,
          onCancel: ue,
          onOk: () => $({ pageNum: 1 }),
        }),
      ],
    });
  };
export { Z as default };
