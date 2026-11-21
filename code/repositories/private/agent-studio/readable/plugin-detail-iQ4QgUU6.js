import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  C as i,
  Kt as a,
  Or as o,
  Vt as s,
  Xr as c,
  Y as l,
  Yi as u,
  Zi as d,
  dr as f,
  nn as p,
  or as m,
  rr as h,
  un as g,
  yr as _,
} from "./vendor-antd.QfSgOu5e.js";
import { t as v } from "./navigation-CSJEEvwi.js";
import { d as y, l as b, o as x, r as S } from "./plugin-manage-C7jNL1TC.js";
import { t as C } from "./app-Dnx7bwXT.js";
import { J as w, Tt as T, Y as E } from "./index.B_LPe2F7.js";
import { t as D } from "./DetailLayout-139jNxZs.js";
import { n as O, t as k } from "./expand-list-CAdJDtkU.js";
import { t as A } from "./PluginCardIndustryTags-C8M2x0JY.js";
import {
  a as j,
  i as M,
  n as N,
  r as P,
  t as F,
} from "./McpSelectorModal-OPGzipAV.js";
var I = e(t(), 1);
s();
var L = { "version-modal-form": `_version-modal-form_j2o08_1` },
  R = n(),
  z = ({
    open: e,
    pluginId: t,
    editingVersionId: n,
    addWay: a,
    onCancel: o,
    onOk: s,
  }) => {
    let [c] = _.useForm(),
      l = !!n,
      d = a === `2`,
      p = _.useWatch(`skills`, c),
      g = _.useWatch(`path`, c),
      [v, b] = (0, I.useState)(!1),
      [x, C] = (0, I.useState)([]),
      [w, T] = (0, I.useState)(!1),
      [E, D] = (0, I.useState)(!1),
      [O, k] = (0, I.useState)([]),
      [A, z] = (0, I.useState)(!1);
    (0, I.useEffect)(() => {
      (async () => {
        if (!e) {
          (c.resetFields(), C([]));
          return;
        }
        if (!n) {
          (c.setFieldsValue({ description: ``, skills: [], path: `` }), C([]));
          return;
        }
        try {
          T(!0);
          let e = await y({ pluginVersionId: n ? String(n) : `` });
          if (e?.errCode === 0) {
            let t = (e.data?.skills ?? []).map((e) => ({
              id: e.skillId,
              name: e.skillName,
              iconUrl: e.iconUrl,
              description: e.skillDescription,
            }));
            (c.setFieldsValue({
              version: e.data?.versionCode,
              description: e.data?.description,
              path: e.data?.packageUrl ?? ``,
              skills: t.map((e) => ({ name: e.name, skillId: Number(e.id) })),
            }),
              C(t),
              e.data?.mcps?.length
                ? k(
                    e.data.mcps.map((e) => ({
                      id: e.mcpServiceId,
                      mcpServerName: e.mcpServerName,
                      mcpServerNacosName: e.mcpServerNacosName,
                      iconUrl: e.iconUrl || ``,
                      desc: e.mcpServerDesc,
                      mcpSource: e.mcpSource,
                      sortValue: e.sortValue,
                      state: e.state,
                      mcpToolList: (e.tools || []).map((e) => ({
                        id: e.mcptoolsInfoId,
                        toolName: e.toolName,
                        toolDesc: e.toolDesc,
                        sortValue: e.sortValue,
                      })),
                    })),
                  )
                : k([]));
          }
        } catch (e) {
          console.error(`获取插件版本详情失败`, e);
        } finally {
          T(!1);
        }
      })();
    }, [n, c, e]);
    let B = async () => {
        try {
          let e = await c.validateFields();
          if (d && !e.path) {
            m.error(`请上传智能专家包`);
            return;
          }
          if (!t) {
            m.error(`未获取到插件ID`);
            return;
          }
          let r = {
            pluginVersionId: n,
            pluginId: t,
            description: e.description ?? ``,
            path: d ? (e.path ?? ``) : ``,
            skills: d
              ? []
              : (e.skills ?? []).map((e) => ({
                  skillId: Number(e.skillId),
                  name: e.name,
                })),
            mcps: O.map((e, t) => ({
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
          };
          if (
            (n && (r.pluginVersionId = n), D(!0), (await S(r))?.errCode === 0)
          ) {
            (m.success(n ? `编辑版本成功` : `新增版本成功`), s(), V());
            return;
          }
          m.error(n ? `编辑版本失败` : `新增版本失败`);
        } catch (e) {
          console.error(n ? `编辑版本失败` : `新增版本失败`, e);
        } finally {
          D(!1);
        }
      },
      V = () => {
        (c.resetFields(), C([]), k([]), z(!1), b(!1), o());
      };
    return (0, R.jsxs)(R.Fragment, {
      children: [
        (0, R.jsx)(h, {
          title: l ? `编辑版本` : `新增版本`,
          open: e,
          onCancel: V,
          onOk: B,
          okText: `确认`,
          cancelText: `取消`,
          confirmLoading: E,
          destroyOnClose: !0,
          children: (0, R.jsxs)(_, {
            form: c,
            layout: `vertical`,
            className: L[`version-modal-form`],
            children: [
              (0, R.jsx)(_.Item, {
                label: `版本介绍`,
                name: `description`,
                children: (0, R.jsx)(r.TextArea, {
                  rows: 3,
                  placeholder: `初始版本发布`,
                  maxLength: 500,
                  showCount: !0,
                }),
              }),
              (0, R.jsx)(_.Item, {
                name: `skills`,
                noStyle: !0,
                children: (0, R.jsx)(r, { hidden: !0 }),
              }),
              (0, R.jsx)(_.Item, {
                name: `path`,
                noStyle: !0,
                children: (0, R.jsx)(r, { hidden: !0 }),
              }),
              (0, R.jsx)(f, {
                spinning: w,
                children: d
                  ? (0, R.jsx)(j, {
                      path: g,
                      onClear: () => {
                        (c.setFieldValue(`path`, ``),
                          c.validateFields([`path`]));
                      },
                      onUploadSuccess: (e) => {
                        (c.setFieldValue(`path`, e.path ?? ``),
                          c.validateFields([`path`]));
                      },
                    })
                  : (0, R.jsx)(P, {
                      actionSlot: (0, R.jsx)(u, {
                        type: `link`,
                        icon: (0, R.jsx)(i, {}),
                        onClick: () => b(!0),
                        children: `从原子技能市场添加`,
                      }),
                      value: p ?? [],
                      onRemove: (e) => {
                        let t = p?.filter((t) => t.name !== e) ?? [];
                        (c.setFieldValue(`skills`, t),
                          C((t) => t.filter((t) => t.name !== e)));
                      },
                    }),
              }),
              (0, R.jsx)(N, {
                actionSlot: (0, R.jsx)(u, {
                  type: `link`,
                  onClick: () => z(!0),
                  children: `添加MCP`,
                }),
                value: O,
                onRemove: (e) => {
                  k((t) => t.filter((t) => t.id !== e));
                },
                onRemoveTool: (e, t) => {
                  k((e) =>
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
            ],
          }),
        }),
        (0, R.jsx)(F, {
          visible: A,
          onClose: () => z(!1),
          selectedMcps: O,
          onConfirm: (e) => {
            (k((t) => {
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
              z(!1));
          },
          onRemove: (e) => {
            k((t) =>
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
            k((e) =>
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
        (0, R.jsx)(M, {
          open: v,
          defaultCheckedIds: x,
          onCancel: () => {
            b(!1);
          },
          onOk: (e) => {
            (C(e),
              c.setFieldValue(
                `skills`,
                e.map((e) => ({ name: e.name, skillId: Number(e.id) })),
              ),
              b(!1));
          },
        }),
      ],
    });
  },
  B = {
    "detail-page": `_detail-page_1hilk_1`,
    section: `_section_1hilk_7`,
    "section-title": `_section-title_1hilk_13`,
    "section-subtitle": `_section-subtitle_1hilk_18`,
    "section-header": `_section-header_1hilk_23`,
    "header-area": `_header-area_1hilk_32`,
    "plugin-icon": `_plugin-icon_1hilk_37`,
    "plugin-name": `_plugin-name_1hilk_43`,
    "header-info": `_header-info_1hilk_47`,
    "header-info-title": `_header-info-title_1hilk_52`,
    description: `_description_1hilk_57`,
    "resource-sub-section": `_resource-sub-section_1hilk_64`,
    "sub-section-title": `_sub-section-title_1hilk_70`,
    "sub-section-hint": `_sub-section-hint_1hilk_74`,
    "skill-row": `_skill-row_1hilk_79`,
    "skill-row-main": `_skill-row-main_1hilk_88`,
    "skill-icon": `_skill-icon_1hilk_94`,
    "skill-row-info": `_skill-row-info_1hilk_107`,
    "skill-desc": `_skill-desc_1hilk_114`,
    "skill-sub": `_skill-sub_1hilk_117`,
    "skill-sub-group": `_skill-sub-group_1hilk_125`,
    "sub-label": `_sub-label_1hilk_130`,
    "tenant-list": `_tenant-list_1hilk_135`,
    "tenant-card": `_tenant-card_1hilk_140`,
    "tenant-icon": `_tenant-icon_1hilk_149`,
    "tenant-info": `_tenant-info_1hilk_160`,
    "tenant-meta": `_tenant-meta_1hilk_166`,
    "tenant-revoke": `_tenant-revoke_1hilk_169`,
    "version-list": `_version-list_1hilk_173`,
    "version-card": `_version-card_1hilk_178`,
    "version-card-header": `_version-card-header_1hilk_184`,
    "version-no": `_version-no_1hilk_190`,
    "version-current-tag": `_version-current-tag_1hilk_194`,
    "version-card-meta": `_version-card-meta_1hilk_205`,
    "version-card-actions": `_version-card-actions_1hilk_211`,
    "version-status-text": `_version-status-text_1hilk_217`,
    "version-ref-link": `_version-ref-link_1hilk_221`,
    "version-edit-icon": `_version-edit-icon_1hilk_224`,
    "version-edit-icon-disabled": `_version-edit-icon-disabled_1hilk_232`,
    "version-changelog": `_version-changelog_1hilk_239`,
    "version-skills": `_version-skills_1hilk_244`,
    "version-skills-label": `_version-skills-label_1hilk_247`,
    "version-skills-list": `_version-skills-list_1hilk_252`,
    "vs-skill-row": `_vs-skill-row_1hilk_257`,
    "mcp-list": `_mcp-list_1hilk_266`,
    "mcp-server-panel": `_mcp-server-panel_1hilk_271`,
    "mcp-server-panel-header": `_mcp-server-panel-header_1hilk_288`,
    "mcp-server-panel-header-icon": `_mcp-server-panel-header-icon_1hilk_293`,
    "mcp-server-panel-header-content": `_mcp-server-panel-header-content_1hilk_298`,
    "mcp-server-panel-header-title": `_mcp-server-panel-header-title_1hilk_302`,
    "mcp-server-panel-header-tag": `_mcp-server-panel-header-tag_1hilk_309`,
    "mcp-server-panel-header-info": `_mcp-server-panel-header-info_1hilk_320`,
    "mcp-server-panel-header-desc": `_mcp-server-panel-header-desc_1hilk_325`,
    "mcp-server-panel-header-desc-text": `_mcp-server-panel-header-desc-text_1hilk_328`,
    "mcp-tool-item": `_mcp-tool-item_1hilk_334`,
    "mcp-tool-name": `_mcp-tool-name_1hilk_348`,
    "mcp-tool-item-title": `_mcp-tool-item-title_1hilk_353`,
    "mcp-tool-item-desc": `_mcp-tool-item-desc_1hilk_361`,
    "mcp-tool-item-desc-text": `_mcp-tool-item-desc-text_1hilk_370`,
  };
s();
var V = ({ skill: e }) =>
    (0, R.jsxs)(`div`, {
      className: B[`vs-skill-row`],
      children: [
        (0, R.jsx)(`span`, { className: B[`skill-icon`], children: `</>` }),
        (0, R.jsxs)(`div`, {
          className: B[`skill-row-info`],
          children: [
            (0, R.jsx)(a.Text, { strong: !0, children: e.skillName }),
            (0, R.jsx)(a.Text, {
              type: `secondary`,
              className: B[`skill-desc`],
              children: e.skillDescription,
            }),
          ],
        }),
      ],
    }),
  { Panel: H } = d,
  U = ({ mcp: e }) =>
    (0, R.jsx)(d, {
      ghost: !0,
      className: B[`mcp-server-panel`],
      expandIconPosition: `end`,
      expandIcon: ({ isActive: e }) =>
        (0, R.jsx)(`img`, { src: e ? O : k, width: 18, alt: `展开/收起` }),
      children: (0, R.jsx)(
        H,
        {
          header: (0, R.jsxs)(`div`, {
            className: B[`mcp-server-panel-header`],
            children: [
              (0, R.jsx)(`img`, {
                alt: `mcp服务图标`,
                src: e.iconUrl,
                onError: (e) => {
                  e.currentTarget.src = C;
                },
                className: B[`mcp-server-panel-header-icon`],
              }),
              (0, R.jsxs)(`div`, {
                className: B[`mcp-server-panel-header-content`],
                children: [
                  (0, R.jsxs)(`div`, {
                    className: B[`mcp-server-panel-header-title`],
                    children: [
                      (0, R.jsx)(a.Text, { children: e.mcpServerName }),
                      (0, R.jsx)(p, {
                        className: B[`mcp-server-panel-header-tag`],
                        bordered: !1,
                        children: `MCP`,
                      }),
                    ],
                  }),
                  !!e.desc &&
                    (0, R.jsx)(`div`, {
                      className: B[`mcp-server-panel-header-desc`],
                      children: (0, R.jsx)(a.Text, {
                        className: B[`mcp-server-panel-header-desc-text`],
                        ellipsis: {
                          tooltip: { title: e.desc, placement: `topLeft` },
                        },
                        children: e.desc,
                      }),
                    }),
                  (0, R.jsxs)(`div`, {
                    className: B[`mcp-server-panel-header-info`],
                    children: [
                      (0, R.jsxs)(`span`, {
                        children: [`已添加`, e.toolCount ?? 0, `个工具`],
                      }),
                      (0, R.jsx)(c, { type: `vertical` }),
                      (0, R.jsx)(u, {
                        type: `link`,
                        onClick: (t) => {
                          (t.preventDefault(),
                            v(
                              `${T.SSO}?targetPath=${T.AGENT_PLUGIN_MCP_DETAILS}&state=${JSON.stringify({ id: e.id })}`,
                            ));
                        },
                        children: `详情`,
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          children: e.tools?.map((e, t) =>
            (0, R.jsxs)(
              `div`,
              {
                className: B[`mcp-tool-item`],
                children: [
                  (0, R.jsx)(`div`, {
                    className: B[`mcp-tool-item-title`],
                    children: (0, R.jsx)(a.Text, {
                      className: B[`mcp-tool-name`],
                      children: e.toolName,
                    }),
                  }),
                  !!e.toolDesc &&
                    (0, R.jsx)(`div`, {
                      className: B[`mcp-tool-item-desc`],
                      children: (0, R.jsx)(a.Text, {
                        className: B[`mcp-tool-item-desc-text`],
                        children: e.toolDesc,
                      }),
                    }),
                ],
              },
              t,
            ),
          ),
        },
        e.id,
      ),
    }),
  W = ({ record: e, disabled: t, onToggle: n, onEdit: r }) => {
    let [i, s] = (0, I.useState)(!1),
      c = t || e.inEffect === 1,
      u = async (t) => {
        if (!e.pluginVersionId) {
          m.error(`未获取到版本ID`);
          return;
        }
        try {
          if (
            (s(!0),
            (
              await x({
                pluginVersionId: e.pluginVersionId
                  ? String(e.pluginVersionId)
                  : ``,
                activePlugin: +!!t,
              })
            )?.errCode === 0)
          ) {
            (m.success(t ? `启用成功` : `停用成功`), n(e.version, t));
            return;
          }
        } catch (e) {
          (e?.data && m.error(e?.data),
            console.error(t ? `启用版本失败` : `停用版本失败`, e));
        } finally {
          s(!1);
        }
      };
    return (0, R.jsxs)(`div`, {
      className: B[`version-card`],
      children: [
        (0, R.jsxs)(`div`, {
          className: B[`version-card-header`],
          children: [
            (0, R.jsxs)(o, {
              size: 8,
              align: `center`,
              children: [
                (0, R.jsx)(a.Text, {
                  strong: !0,
                  className: B[`version-no`],
                  children: e.version,
                }),
                e.inEffect === 1 &&
                  (0, R.jsx)(`span`, {
                    className: B[`version-current-tag`],
                    children: `当前生效`,
                  }),
              ],
            }),
            (0, R.jsxs)(`div`, {
              className: B[`version-card-meta`],
              children: [
                (0, R.jsxs)(a.Text, {
                  type: `secondary`,
                  children: [`发布时间：`, e.publishTime ?? `-`],
                }),
                (0, R.jsxs)(a.Text, {
                  type: `secondary`,
                  children: [`最后更新人：`, e.updatePerson ?? `-`],
                }),
              ],
            }),
            (0, R.jsxs)(`div`, {
              className: B[`version-card-actions`],
              children: [
                (0, R.jsx)(g, {
                  size: `small`,
                  checked: e.inEffect === 1,
                  loading: i,
                  onChange: (e) => u(e),
                  disabled: t,
                }),
                (0, R.jsx)(a.Text, {
                  type: `secondary`,
                  className: B[`version-status-text`],
                  children: e.inEffect === 1 ? `已启用` : `已停用`,
                }),
                (0, R.jsx)(l, {
                  className: `${B[`version-edit-icon`]}${c ? ` ${B[`version-edit-icon-disabled`]}` : ``}`,
                  onClick: () => {
                    c || r(e);
                  },
                }),
              ],
            }),
          ],
        }),
        (0, R.jsx)(a.Text, {
          type: `secondary`,
          className: B[`version-changelog`],
          children: e.description,
        }),
        (e.skills?.length ?? 0) > 0 &&
          (0, R.jsxs)(`div`, {
            className: B[`version-skills`],
            children: [
              (0, R.jsxs)(a.Text, {
                type: `secondary`,
                className: B[`version-skills-label`],
                children: [`包含的原子技能 (`, e.skills.length, `)`],
              }),
              (0, R.jsx)(`div`, {
                className: B[`version-skills-list`],
                children: e.skills.map((e) =>
                  (0, R.jsx)(V, { skill: e }, e.skillId),
                ),
              }),
            ],
          }),
        (0, R.jsxs)(`div`, {
          className: B[`version-skills`],
          children: [
            (0, R.jsxs)(a.Text, {
              type: `secondary`,
              className: B[`version-skills-label`],
              children: [`关联的 MCP (`, e.mcps?.length ?? 0, `)`],
            }),
            (0, R.jsx)(`div`, {
              className: B[`version-skills-list`],
              children: (e.mcps ?? []).map((e) =>
                (0, R.jsx)(U, { mcp: e }, e.id),
              ),
            }),
          ],
        }),
      ],
    });
  };
s();
var G = () => {
  let { state: e } = w(),
    t = E(),
    [n, r] = (0, I.useState)([]),
    [i, s] = (0, I.useState)(),
    [c, l] = (0, I.useState)(!1),
    [d, p] = (0, I.useState)(!1),
    [m, h] = (0, I.useState)(``),
    g = (0, I.useCallback)(async () => {
      try {
        let t = e?.pluginIdStr;
        if (!t) return;
        l(!0);
        let n = await b({ id: t });
        n?.errCode === 0 &&
          (s(n?.data),
          r(
            (n?.data?.pluginVersionDetails ?? []).map((e) => ({
              ...e,
              mcps: (e.mcps || []).map((e) => ({
                id: e.mcpServiceId,
                mcpServerName: e.mcpServerName,
                desc: e.mcpServerDesc,
                iconUrl:
                  e.iconUrl ||
                  `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                toolCount: e.tools?.length || 0,
                tools: (e.tools || []).map((e) => ({
                  toolName: e.toolName,
                  toolDesc: e.toolDesc,
                })),
              })),
            })),
          ));
      } catch (e) {
        (console.error(`获取插件详情失败`, e), s(null));
      } finally {
        l(!1);
      }
    }, [e?.pluginIdStr]);
  (0, I.useEffect)(() => {
    g();
  }, [g]);
  let _ = (e, t) => {
      (r((n) => n.map((n) => (n.version === e ? { ...n, enabled: t } : n))),
        g());
    },
    v = n.find((e) => e.inEffect === 1);
  return (0, R.jsxs)(D, {
    title: i?.pluginNameCn ?? ``,
    showBack: !0,
    onBack: () => t(T.AGENT_ROLE_AGENT),
    showFooter: !1,
    children: [
      (0, R.jsx)(f, {
        spinning: c,
        children: (0, R.jsxs)(`div`, {
          className: B[`detail-page`],
          children: [
            (0, R.jsx)(`section`, {
              className: B.section,
              children: (0, R.jsxs)(`div`, {
                className: B[`header-area`],
                children: [
                  (0, R.jsx)(`img`, {
                    src:
                      i?.iconUrl ||
                      `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                    className: B[`plugin-icon`],
                    alt: i?.name ?? ``,
                  }),
                  (0, R.jsxs)(`div`, {
                    className: B[`header-info`],
                    children: [
                      (0, R.jsxs)(`div`, {
                        className: B[`header-info-title`],
                        children: [
                          (0, R.jsxs)(o, {
                            size: 8,
                            children: [
                              (0, R.jsx)(a.Title, {
                                level: 4,
                                className: B[`plugin-name`],
                                children: i?.pluginNameCn ?? ``,
                              }),
                              (0, R.jsxs)(a.Text, {
                                type: `secondary`,
                                children: [`ID：`, i?.name ?? ``],
                              }),
                            ],
                          }),
                          (0, R.jsx)(A, {
                            tags: i?.tags || [],
                            tooltipTitle: (i?.tags || []).join(`、`),
                          }),
                        ],
                      }),
                      (0, R.jsxs)(a.Text, {
                        type: `secondary`,
                        children: [`当前版本：`, v?.version ?? `-`],
                      }),
                    ],
                  }),
                ],
              }),
            }),
            (0, R.jsxs)(`section`, {
              className: B.section,
              children: [
                (0, R.jsx)(a.Title, {
                  level: 5,
                  className: B[`section-title`],
                  children: `基础信息`,
                }),
                (0, R.jsx)(`div`, {
                  className: B.description,
                  children: i?.pluginDescription ?? `-`,
                }),
              ],
            }),
            (0, R.jsxs)(`section`, {
              className: B.section,
              children: [
                (0, R.jsxs)(`div`, {
                  className: B[`section-header`],
                  children: [
                    (0, R.jsx)(a.Title, {
                      level: 5,
                      className: B[`section-title`],
                      children: `版本管理`,
                    }),
                    (0, R.jsx)(u, {
                      type: `default`,
                      onClick: () => {
                        (h(``), p(!0));
                      },
                      children: `+ 添加版本`,
                    }),
                  ],
                }),
                (0, R.jsx)(`div`, {
                  className: B[`version-list`],
                  children: n.map((e) =>
                    (0, R.jsx)(
                      W,
                      {
                        record: e,
                        onToggle: _,
                        onEdit: (e) => {
                          (h(
                            e?.pluginVersionId
                              ? String(e?.pluginVersionId)
                              : ``,
                          ),
                            p(!0));
                        },
                        disabled: !1,
                      },
                      e.version,
                    ),
                  ),
                }),
              ],
            }),
          ],
        }),
      }),
      (0, R.jsx)(z, {
        open: d,
        pluginId: e?.pluginIdStr,
        editingVersionId: m,
        addWay: String(i?.addWay ?? ``),
        onCancel: () => {
          (p(!1), h(``));
        },
        onOk: () => {
          (p(!1), h(``), g());
        },
      }),
    ],
  });
};
export { G as default };
