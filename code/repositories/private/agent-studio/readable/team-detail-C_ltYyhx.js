import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Br as r,
  C as i,
  Kt as a,
  Or as o,
  Vt as s,
  Y as c,
  Yi as l,
  dr as u,
  or as d,
  rr as f,
  un as p,
  yr as m,
} from "./vendor-antd.QfSgOu5e.js";
import { a as h, i as g, n as _, o as v } from "./agent-team-Ucmswz9S.js";
import "./app-Dnx7bwXT.js";
import { J as y, Tt as b, Y as x } from "./index.B_LPe2F7.js";
import { t as S } from "./DetailLayout-139jNxZs.js";
import { t as C } from "./PluginCardIndustryTags-C8M2x0JY.js";
import { n as w, t as T } from "./Section-Db89Dz6a.js";
var E = e(t(), 1);
s();
var D = {
    "version-modal-form": `_version-modal-form_ptlyf_1`,
    "skills-form-item-label-container": `_skills-form-item-label-container_ptlyf_4`,
    "skills-form-item-label": `_skills-form-item-label_ptlyf_4`,
    "skills-form-item-required": `_skills-form-item-required_ptlyf_15`,
  },
  O = n(),
  k = ({ open: e, pluginId: t, editingVersionId: n, onCancel: a, onOk: o }) => {
    let [s] = m.useForm(),
      c = !!n,
      p = m.useWatch(`plugins`, s),
      [h, g] = (0, E.useState)(!1),
      [y, b] = (0, E.useState)({ default: [] }),
      [x, S] = (0, E.useState)(`default`),
      [C, k] = (0, E.useState)(!1),
      [A, j] = (0, E.useState)(!1);
    (0, E.useEffect)(() => {
      (async () => {
        if (!e) {
          (s.resetFields(), b({ default: [] }), S(`default`));
          return;
        }
        if (n)
          try {
            k(!0);
            let e = await v({ collectionVersionId: n ? String(n) : `` });
            if (e?.errCode === 0) {
              let t = [];
              try {
                t = e.data?.plugins ? e.data?.plugins : [];
              } catch (e) {
                console.error(`解析版本 kit 失败`, e);
              }
              s.setFieldsValue({
                version: e.data?.collectionVersionCode || ``,
                description:
                  e.data?.pluginDescription || e.data?.description || ``,
                pluginIdStr: e.data?.collectionId || ``,
                pluginId: e.data?.collectionId || ``,
                plugins: Array.isArray(e.data?.plugins) ? e.data?.plugins : [],
                kit: Array.isArray(t) ? t : [],
              });
              let n = e.data?.plugins?.map((e) => ({
                pluginId: e.pluginIdStr || e.pluginId || ``,
                pluginIdStr: e.pluginIdStr || e.pluginId || ``,
                pluginName: e.pluginName ?? ``,
                pluginNameCn: e.pluginNameCn ?? ``,
                industry: e.industry,
                description: e.description ?? ``,
              }));
              b({ default: n || [] });
            }
          } catch (e) {
            console.error(`获取插件版本详情失败`, e);
          } finally {
            k(!1);
          }
      })();
    }, [e, n, s]);
    let M = async () => {
        try {
          let e = await s.validateFields();
          if (!t) {
            d.error(`未获取到插件ID`);
            return;
          }
          let r = {
            description: e.description ?? ``,
            plugins: e.plugins ?? ``,
            collectionId: t ?? ``,
            collectionVersionId: n ?? ``,
          };
          if ((j(!0), (await _(r))?.errCode === 0)) {
            (d.success(n ? `编辑版本成功` : `新增版本成功`), o(), N());
            return;
          }
          d.error(n ? `编辑版本失败` : `新增版本失败`);
        } catch (e) {
          console.error(n ? `编辑版本失败` : `新增版本失败`, e);
        } finally {
          j(!1);
        }
      },
      N = () => {
        (s.resetFields(), b({ default: [] }), S(`default`), g(!1), a());
      };
    return (0, O.jsxs)(O.Fragment, {
      children: [
        (0, O.jsx)(f, {
          title: c ? `编辑版本` : `新增版本`,
          open: e,
          onCancel: N,
          onOk: M,
          okText: `确认`,
          cancelText: `取消`,
          confirmLoading: A,
          destroyOnClose: !0,
          children: (0, O.jsxs)(m, {
            form: s,
            layout: `vertical`,
            className: D[`version-modal-form`],
            children: [
              (0, O.jsx)(m.Item, {
                rules: [{ required: !0, message: `请输入版本介绍` }],
                label: `版本介绍`,
                name: `description`,
                children: (0, O.jsx)(r.TextArea, {
                  rows: 3,
                  placeholder: `初始版本发布`,
                  maxLength: 500,
                  showCount: !0,
                }),
              }),
              (0, O.jsx)(m.Item, {
                name: `kit`,
                hidden: !0,
                children: (0, O.jsx)(r, {}),
              }),
              (0, O.jsx)(u, {
                spinning: C,
                children: (0, O.jsxs)(m.Item, {
                  name: `plugins`,
                  rules: [{ required: !0, message: `请至少关联一个智能专家` }],
                  className: D[`skills-form-item`],
                  children: [
                    (0, O.jsxs)(`div`, {
                      className: D[`skills-form-item-label-container`],
                      children: [
                        (0, O.jsxs)(`span`, {
                          className: D[`skills-form-item-label`],
                          children: [
                            (0, O.jsx)(`span`, {
                              className: D[`skills-form-item-required`],
                              children: `*`,
                            }),
                            `关联智能专家`,
                          ],
                        }),
                        (0, O.jsx)(l, {
                          type: `primary`,
                          icon: (0, O.jsx)(i, {}),
                          onClick: () => {
                            (S(`default`), g(!0));
                          },
                          children: `从智能专家市场选择`,
                        }),
                      ],
                    }),
                    (0, O.jsx)(T, {
                      value: p ?? [],
                      onRemove: (e) => {
                        let t = p?.filter((t) => t.pluginId !== e);
                        (s.setFieldValue(`plugins`, t),
                          b({
                            default:
                              t?.map((e) => ({
                                pluginId: e.pluginId ?? ``,
                                pluginIdStr: e.pluginIdStr ?? ``,
                                pluginName: e.pluginName,
                                pluginNameCn: e.pluginNameCn ?? ``,
                                description: ``,
                                iconUrl: ``,
                                status: 1,
                                bindSkillCount: 0,
                                bindMcpCount: 0,
                                updatedBy: ``,
                                version: ``,
                                updatedTime: ``,
                                tags: [],
                              })) || [],
                          }));
                      },
                    }),
                  ],
                }),
              }),
            ],
          }),
        }),
        (0, O.jsx)(w, {
          open: h,
          defaultCheckedIds: y[x] ?? [],
          onCancel: () => {
            (g(!1), S(``));
          },
          onOk: (e) => {
            let t = e.map((e) => ({
              pluginId: e.pluginId || e.pluginIdStr || ``,
              pluginIdStr: e.pluginId || e.pluginIdStr || ``,
              pluginNameCn: e.pluginNameCn || e.pluginName || ``,
              pluginName: e.pluginNameCn || e.pluginName || ``,
              industry: e.industry,
            }));
            (b((t) => ({ ...t, [x]: e })),
              s.setFieldValue(`plugins`, t),
              s.validateFields([`plugins`]),
              g(!1),
              S(``));
          },
        }),
      ],
    });
  },
  A = {
    "detail-page": `_detail-page_1cvfd_1`,
    section: `_section_1cvfd_7`,
    "section-title": `_section-title_1cvfd_13`,
    "section-subtitle": `_section-subtitle_1cvfd_18`,
    "section-header": `_section-header_1cvfd_23`,
    "header-area": `_header-area_1cvfd_32`,
    "plugin-icon": `_plugin-icon_1cvfd_37`,
    "plugin-name": `_plugin-name_1cvfd_43`,
    "header-info": `_header-info_1cvfd_47`,
    "header-info-title": `_header-info-title_1cvfd_52`,
    description: `_description_1cvfd_57`,
    "resource-sub-section": `_resource-sub-section_1cvfd_64`,
    "sub-section-title": `_sub-section-title_1cvfd_70`,
    "sub-section-hint": `_sub-section-hint_1cvfd_74`,
    "skill-row": `_skill-row_1cvfd_79`,
    "skill-row-main": `_skill-row-main_1cvfd_88`,
    "skill-icon": `_skill-icon_1cvfd_94`,
    "skill-row-info": `_skill-row-info_1cvfd_107`,
    "skill-desc": `_skill-desc_1cvfd_114`,
    "skill-sub": `_skill-sub_1cvfd_117`,
    "skill-sub-group": `_skill-sub-group_1cvfd_125`,
    "sub-label": `_sub-label_1cvfd_130`,
    "tenant-list": `_tenant-list_1cvfd_135`,
    "tenant-card": `_tenant-card_1cvfd_140`,
    "tenant-icon": `_tenant-icon_1cvfd_149`,
    "tenant-info": `_tenant-info_1cvfd_160`,
    "tenant-meta": `_tenant-meta_1cvfd_166`,
    "tenant-revoke": `_tenant-revoke_1cvfd_169`,
    "version-list": `_version-list_1cvfd_173`,
    "version-card": `_version-card_1cvfd_178`,
    "version-card-header": `_version-card-header_1cvfd_184`,
    "version-no": `_version-no_1cvfd_190`,
    "version-current-tag": `_version-current-tag_1cvfd_195`,
    "version-card-meta": `_version-card-meta_1cvfd_209`,
    "version-card-actions": `_version-card-actions_1cvfd_215`,
    "version-status-text": `_version-status-text_1cvfd_221`,
    "version-ref-link": `_version-ref-link_1cvfd_225`,
    "version-edit-icon": `_version-edit-icon_1cvfd_228`,
    "version-edit-icon-disabled": `_version-edit-icon-disabled_1cvfd_236`,
    "version-changelog": `_version-changelog_1cvfd_244`,
    "version-skills": `_version-skills_1cvfd_249`,
    "version-skills-label": `_version-skills-label_1cvfd_252`,
    "version-skills-list": `_version-skills-list_1cvfd_257`,
    "vs-skill-row": `_vs-skill-row_1cvfd_262`,
  };
s();
var j = ({ skill: e }) =>
    (0, O.jsxs)(`div`, {
      className: A[`vs-skill-row`],
      children: [
        (0, O.jsx)(`span`, { className: A[`skill-icon`], children: `</>` }),
        (0, O.jsxs)(`div`, {
          className: A[`skill-row-info`],
          children: [
            (0, O.jsx)(a.Text, { strong: !0, children: e.pluginNameCn }),
            e.description
              ? (0, O.jsx)(a.Text, {
                  type: `secondary`,
                  className: A[`skill-desc`],
                  children: e.description,
                })
              : null,
          ],
        }),
      ],
    }),
  M = ({ record: e, pluginDetail: t, onToggle: n, onEdit: r }) => {
    let [i, s] = (0, E.useState)(!1),
      l = async (t) => {
        if (!e.collectionVersionId) {
          d.error(`未获取到版本ID`);
          return;
        }
        try {
          if (
            (s(!0),
            (
              await g({
                collectionVersionId: e.collectionVersionId
                  ? String(e.collectionVersionId)
                  : ``,
                activeCollection: +!!t,
              })
            )?.errCode === 0)
          ) {
            (d.success(t ? `启用成功` : `停用成功`), n(e.version, t));
            return;
          }
        } catch (e) {
          (e?.data && d.error(e?.data),
            console.error(t ? `启用版本失败` : `停用版本失败`, e));
        } finally {
          s(!1);
        }
      };
    return (0, O.jsxs)(`div`, {
      className: A[`version-card`],
      children: [
        (0, O.jsxs)(`div`, {
          className: A[`version-card-header`],
          children: [
            (0, O.jsxs)(o, {
              size: 8,
              align: `center`,
              children: [
                (0, O.jsx)(a.Text, {
                  strong: !0,
                  className: A[`version-no`],
                  children: e.version,
                }),
                e.inEffect === 1 &&
                  (0, O.jsx)(`span`, {
                    className: A[`version-current-tag`],
                    children: `当前生效`,
                  }),
              ],
            }),
            (0, O.jsxs)(`div`, {
              className: A[`version-card-meta`],
              children: [
                (0, O.jsxs)(a.Text, {
                  type: `secondary`,
                  children: [`发布时间：`, e.publishTime ?? `-`],
                }),
                (0, O.jsxs)(a.Text, {
                  type: `secondary`,
                  children: [`最后更新人：`, e.updatePerson ?? `-`],
                }),
              ],
            }),
            (0, O.jsxs)(`div`, {
              className: A[`version-card-actions`],
              children: [
                (0, O.jsx)(p, {
                  size: `small`,
                  checked: e.inEffect === 1,
                  disabled: t.readonly === 2,
                  loading: i,
                  onChange: (e) => l(e),
                }),
                (0, O.jsx)(a.Text, {
                  type: `secondary`,
                  className: A[`version-status-text`],
                  children: e.inEffect === 1 ? `已启用` : `已停用`,
                }),
                (0, O.jsx)(c, {
                  className: `${A[`version-edit-icon`]}${e.inEffect === 1 || t.readonly === 2 ? ` ${A[`version-edit-icon-disabled`]}` : ``}`,
                  onClick: () => {
                    e.inEffect === 1 || t.readonly === 2 || r(e);
                  },
                }),
              ],
            }),
          ],
        }),
        (0, O.jsx)(a.Text, {
          type: `secondary`,
          className: A[`version-changelog`],
          children: e.description,
        }),
        (e.plugins?.length ?? 0) > 0 &&
          (0, O.jsxs)(`div`, {
            className: A[`version-skills`],
            children: [
              (0, O.jsxs)(a.Text, {
                type: `secondary`,
                className: A[`version-skills-label`],
                children: [`包含的智能专家 (`, e.plugins.length, `)`],
              }),
              (0, O.jsx)(`div`, {
                className: A[`version-skills-list`],
                children: e.plugins.map((e) =>
                  (0, O.jsx)(j, { skill: e }, e.pluginId),
                ),
              }),
            ],
          }),
      ],
    });
  };
s();
var N = () => {
  let { state: e } = y(),
    t = x(),
    [n, r] = (0, E.useState)([]),
    [i, o] = (0, E.useState)(),
    [s, c] = (0, E.useState)(!1),
    [d, f] = (0, E.useState)(!1),
    [p, m] = (0, E.useState)(``),
    g = (0, E.useCallback)(async () => {
      try {
        if (!e?.collectionId) return;
        c(!0);
        let t = await h({ collectionId: e?.collectionId ?? `` });
        t?.errCode === 0 &&
          (o(t?.data), r(t?.data?.collectionVersionDetails ?? []));
      } catch (e) {
        (console.error(`获取插件详情失败`, e), o({}));
      } finally {
        c(!1);
      }
    }, [e?.collectionId]);
  (0, E.useEffect)(() => {
    g();
  }, [e?.collectionId]);
  let _ = (e, t) => {
      (r((n) => n.map((n) => (n.version === e ? { ...n, enabled: t } : n))),
        g());
    },
    v = n.find((e) => e.inEffect === 1);
  return (0, O.jsxs)(S, {
    title: i?.collectionName ?? ``,
    showBack: !0,
    onBack: () => t(b.AGENT_AGENT_TEAM),
    showFooter: !1,
    children: [
      (0, O.jsx)(u, {
        spinning: s,
        children: (0, O.jsxs)(`div`, {
          className: A[`detail-page`],
          children: [
            (0, O.jsx)(`section`, {
              className: A.section,
              children: (0, O.jsxs)(`div`, {
                className: A[`header-area`],
                children: [
                  (0, O.jsx)(`img`, {
                    src:
                      i?.iconUrl ||
                      `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                    className: A[`plugin-icon`],
                    alt: i?.collectionName ?? ``,
                  }),
                  (0, O.jsxs)(`div`, {
                    className: A[`header-info`],
                    children: [
                      (0, O.jsxs)(`div`, {
                        className: A[`header-info-title`],
                        children: [
                          (0, O.jsx)(a.Title, {
                            level: 4,
                            className: A[`plugin-name`],
                            children: i?.collectionName ?? ``,
                          }),
                          (0, O.jsx)(C, {
                            tags: i?.tags || [],
                            tooltipTitle: (i?.tags || []).join(`、`),
                          }),
                        ],
                      }),
                      (0, O.jsxs)(a.Text, {
                        type: `secondary`,
                        children: [`当前版本：`, v?.version ?? `-`],
                      }),
                    ],
                  }),
                ],
              }),
            }),
            (0, O.jsxs)(`section`, {
              className: A.section,
              children: [
                (0, O.jsx)(a.Title, {
                  level: 5,
                  className: A[`section-title`],
                  children: `基础信息`,
                }),
                (0, O.jsx)(`div`, {
                  className: A.description,
                  children: i?.collectionDescription ?? `-`,
                }),
              ],
            }),
            (0, O.jsxs)(`section`, {
              className: A.section,
              children: [
                (0, O.jsxs)(`div`, {
                  className: A[`section-header`],
                  children: [
                    (0, O.jsx)(a.Title, {
                      level: 5,
                      className: A[`section-title`],
                      children: `版本管理`,
                    }),
                    (0, O.jsx)(l, {
                      type: `default`,
                      disabled: i?.readonly === 2,
                      onClick: () => {
                        (m(``), f(!0));
                      },
                      children: `+ 添加版本`,
                    }),
                  ],
                }),
                (0, O.jsx)(`div`, {
                  className: A[`version-list`],
                  children: n.map((e) =>
                    (0, O.jsx)(
                      M,
                      {
                        record: e,
                        pluginDetail: i ?? {},
                        onToggle: _,
                        onEdit: (e) => {
                          (m(
                            e?.collectionVersionId
                              ? String(e?.collectionVersionId)
                              : ``,
                          ),
                            f(!0));
                        },
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
      (0, O.jsx)(k, {
        open: d,
        pluginId: e?.pluginId || e?.pluginIdStr || e?.collectionId,
        editingVersionId: p,
        onCancel: () => {
          (f(!1), m(``));
        },
        onOk: () => {
          (f(!1), m(``), g());
        },
      }),
    ],
  });
};
export { N as default };
