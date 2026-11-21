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
  Vt as d,
  Xr as f,
  Yi as p,
  oi as m,
  or as h,
  rr as g,
  yr as _,
} from "./vendor-antd.QfSgOu5e.js";
import { t as v } from "./Icon-BCAHkjHa.js";
import { n as y } from "./src-_hjT3BN9.js";
import { n as b } from "./industry-dict-C4tk0Vz4.js";
import {
  c as x,
  l as S,
  r as C,
  s as w,
  t as T,
} from "./agent-team-Ucmswz9S.js";
import { t as E } from "./TooltipEllipsis-4_dXZz0S.js";
import { t as D } from "./CardList-_VjNd1BT.js";
import "./app-Dnx7bwXT.js";
import { t as O } from "./drop-CiF4TSIV.js";
import { D as k, Tt as A, Y as j, ft as M } from "./index.B_LPe2F7.js";
import { t as ee } from "./ListLayout-B8lj_6O3.js";
import { n as te, t as ne } from "./version-icon-CKJPyHEt.js";
import { n as N, t as P } from "./Section-Db89Dz6a.js";
var F = e(t(), 1);
d();
var re = `data:image/svg+xml,%3csvg%20width='12'%20height='12'%20viewBox='0%200%209%2012'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3ccircle%20cx='4.5'%20cy='3.5'%20r='3'%20stroke='%23616078'%20/%3e%3cpath%20d='M4.5%208C6.53975%208%208.22165%209.52692%208.46777%2011.5H0.532227C0.778345%209.52692%202.46025%208%204.5%208Z'%20stroke='%23616078'%20/%3e%3c/svg%3e`,
  I = {
    "plugin-upload-hint": `_plugin-upload-hint_qknh5_1`,
    "plugin-industry-select": `_plugin-industry-select_qknh5_6`,
    "avatar-divider": `_avatar-divider_qknh5_9`,
    "skill-icon-upload": `_skill-icon-upload_qknh5_14`,
    "avatar-uploader-text": `_avatar-uploader-text_qknh5_17`,
    "avatar-gallery-item": `_avatar-gallery-item_qknh5_22`,
    "avatar-gallery-mask": `_avatar-gallery-mask_qknh5_31`,
    "avatar-image": `_avatar-image_qknh5_34`,
    "action-icon": `_action-icon_qknh5_74`,
    "action-select-circle": `_action-select-circle_qknh5_82`,
    "avatar-selected-badge": `_avatar-selected-badge_qknh5_95`,
    "skills-form-item": `_skills-form-item_qknh5_110`,
    "skills-form-item-label-container": `_skills-form-item-label-container_qknh5_113`,
    "skills-form-item-label": `_skills-form-item-label_qknh5_113`,
    "skills-form-item-required": `_skills-form-item-required_qknh5_124`,
  },
  L = n(),
  ie = ({ open: e, onCancel: t, isEdit: n = !1, record: a, onOk: o }) => {
    let [l] = _.useForm(),
      d = _.useWatch(`plugins`, l),
      [f, m] = (0, F.useState)(!1),
      [v, S] = (0, F.useState)({}),
      [C, w] = (0, F.useState)(``),
      [E, D] = (0, F.useState)(!1),
      [O, k] = (0, F.useState)([]),
      A = _.useWatch(`avatar`, l),
      j = (0, F.useMemo)(
        () =>
          new Map(
            b.filter((e) => e.value).map((e) => [Number(e.value), e.label]),
          ),
        [],
      );
    (0, F.useEffect)(() => {
      if (e)
        if (n && a) {
          let e = a.tags
            ?.map((e) => {
              let t = b.find((t) => t.label === e);
              return t?.value ? Number(t.value) : null;
            })
            .filter((e) => e !== null);
          l.setFieldsValue({
            collectionName: a.collectionName,
            collectionDescription: a.collectionDescription,
            tags: e,
            avatar: a.iconUrl,
            collectionCode: a.version,
            versionDescription: a.collectionDescription,
            plugins:
              a.plugins?.map((e) => ({
                pluginName: e.pluginName,
                pluginNameCn: e.pluginNameCn,
                pluginId: e.pluginId || e.pluginIdStr || ``,
                pluginIdStr: e.pluginId || e.pluginIdStr || ``,
              })) || [],
          });
        } else (l.resetFields(), S({}));
    }, [e, n, a, l]);
    let M = () => {
      (l.resetFields(),
        S({}),
        w(``),
        m(!1),
        l.setFieldValue(`avatar`, ``),
        k([]),
        t());
    };
    return (0, L.jsxs)(g, {
      title: n ? `编辑专家团队` : `新建专家团队`,
      open: e,
      onCancel: () => {
        M();
      },
      onOk: async () => {
        try {
          let e = await l.validateFields(),
            t = [];
          if (e.tags)
            if (typeof e.tags == `number` || typeof e.tags == `string`) {
              let n = Number(e.tags);
              t = [{ tagId: n, tagName: j.get(n) ?? String(n) }];
            } else
              Array.isArray(e.tags) &&
                (t = e.tags
                  .map((e) => Number(e))
                  .filter(Boolean)
                  .map((e) => ({ tagId: e, tagName: j.get(e) ?? String(e) })));
          if (!t[0]) {
            h.error(`请选择所属行业`);
            return;
          }
          if ((D(!0), n)) {
            if (
              (
                await x({
                  collectionId: String(
                    a?.collectionIdStr || a?.collectionId || ``,
                  ),
                  collectionName: e.collectionName,
                  collectionDescription: e.collectionDescription,
                  iconUrl: e.avatar,
                  collectionCode: e.versionDescription || ``,
                  versionDescription: e.versionDescription || ``,
                  tags: t,
                })
              )?.errCode === 0
            ) {
              (h.success(`编辑专家团队成功`), o?.(), M());
              return;
            }
            h.error(`编辑专家团队失败`);
          } else {
            let n = await T({
              collectionName: e.collectionName,
              collectionDescription: e.collectionDescription,
              iconUrl: e.avatar,
              versionDescription: e.versionDescription || ``,
              plugins: e.plugins.map((e) => ({
                pluginName: e.pluginNameCn || e.pluginName || ``,
                pluginNameCn: e.pluginNameCn || e.pluginName || ``,
                pluginId: e.pluginId || e.pluginIdStr || ``,
                pluginIdStr: e.pluginId || e.pluginIdStr || ``,
              })),
              tags: t,
              kit: JSON.stringify(e.kit ?? {}),
              sortValue: e.sortValue,
            });
            if (n?.errCode === 0) {
              (h.success(n?.data?.message || `新增成功`), o?.(), M());
              return;
            }
            h.error(n?.data?.message || `新增失败`);
          }
        } catch (e) {
          console.error(`提交失败`, e);
        } finally {
          D(!1);
        }
      },
      confirmLoading: E,
      children: [
        (0, L.jsxs)(_, {
          layout: `vertical`,
          form: l,
          children: [
            (0, L.jsx)(u, {
              align: `start`,
              children: (0, L.jsx)(_.Item, {
                label: `团队名称`,
                name: `collectionName`,
                rules: [
                  { required: !0, message: `请输入团队名称` },
                  {
                    validator: (e, t) =>
                      t && /[<>/\\"']/.test(t)
                        ? Promise.reject(
                            Error(`团队名称不允许包含特殊字符 < > / \\ " '`),
                          )
                        : Promise.resolve(),
                  },
                ],
                children: (0, L.jsx)(r, {
                  placeholder: `请输入团队名称`,
                  maxLength: 50,
                  showCount: !0,
                }),
              }),
            }),
            (0, L.jsx)(_.Item, {
              label: `职责描述`,
              name: `collectionDescription`,
              rules: [{ required: !0, message: `请输入职责描述` }],
              children: (0, L.jsx)(r.TextArea, {
                placeholder: `请输入职责描述`,
                maxLength: 200,
                rows: 4,
                showCount: !0,
              }),
            }),
            (0, L.jsx)(_.Item, {
              label: `所属行业`,
              name: `tags`,
              rules: [{ required: !0, message: `请选择所属行业` }],
              className: I[`plugin-industry-select`],
              children: (0, L.jsx)(s, {
                options: b.filter((e) => e.value),
                placeholder: `请选择所属行业`,
                showSearch: !0,
                filterOption: (e, t) =>
                  (t?.label ?? ``).toLowerCase().includes(e.toLowerCase()),
              }),
            }),
            (0, L.jsx)(y, {
              form: l,
              fieldName: `avatar`,
              value: A,
              onChange: (e) => l.setFieldValue(`avatar`, e ?? ``),
              onRemove: () => l.setFieldValue(`avatar`, ``),
              iconList: O,
              onDelete: (e) => {
                k(O.filter((t) => t.uid !== e));
              },
              label: `上传照片`,
              generateNameFieldName: `collectionName`,
              generateDescriptionFieldName: `collectionDescription`,
              generateHint: `输入团队名称和职责描述后，点击自动生成图标`,
              className: I[`skill-icon-upload`],
            }),
            !n &&
              (0, L.jsx)(_.Item, {
                label: `版本介绍`,
                name: `versionDescription`,
                rules: [{ required: !0, message: `请输入版本介绍` }],
                children: (0, L.jsx)(r.TextArea, {
                  placeholder: `初始版本发布`,
                  maxLength: 200,
                  rows: 4,
                  showCount: !0,
                }),
              }),
            !n &&
              (0, L.jsx)(_.Item, {
                label: `排序值`,
                name: `sortValue`,
                children: (0, L.jsx)(c, {
                  placeholder: `请输入排序值，数字整型`,
                  min: 0,
                  max: 9999,
                  precision: 0,
                }),
              }),
            !n &&
              (0, L.jsxs)(_.Item, {
                name: `plugins`,
                rules: [{ required: !0, message: `请至少关联一个智能专家` }],
                className: I[`skills-form-item`],
                children: [
                  (0, L.jsxs)(`div`, {
                    className: I[`skills-form-item-label-container`],
                    children: [
                      (0, L.jsxs)(`span`, {
                        className: I[`skills-form-item-label`],
                        children: [
                          (0, L.jsx)(`span`, {
                            className: I[`skills-form-item-required`],
                            children: `*`,
                          }),
                          `关联智能专家`,
                        ],
                      }),
                      (0, L.jsx)(p, {
                        type: `primary`,
                        icon: (0, L.jsx)(i, {}),
                        onClick: () => m(!0),
                        children: `从智能专家市场选择`,
                      }),
                    ],
                  }),
                  (0, L.jsx)(P, {
                    value: d ?? [],
                    onRemove: (e) => {
                      let t = d?.filter(
                        (t) => t.pluginId !== e && t.pluginIdStr !== e,
                      );
                      l.setFieldValue(`plugins`, t);
                      let n = C;
                      S((t) => {
                        let r = (t[n] || []).filter(
                          (t) => t.pluginIdStr !== e && t.pluginId !== e,
                        );
                        return { ...t, [n]: r };
                      });
                    },
                  }),
                ],
              }),
          ],
        }),
        (0, L.jsx)(N, {
          open: f,
          defaultCheckedIds: v[C] ?? [],
          onCancel: () => {
            (m(!1), w(``));
          },
          onOk: (e) => {
            let t = e.map((e) => ({
              pluginId: e.pluginId || e.pluginIdStr || ``,
              pluginIdStr: e.pluginId || e.pluginIdStr || ``,
              pluginNameCn: e.pluginNameCn || e.pluginName || ``,
              pluginName: e.pluginNameCn || e.pluginName || ``,
              industry: e.industry,
            }));
            (S((t) => ({ ...t, [C]: e })),
              l.setFieldValue(`plugins`, t),
              l.validateFields([`plugins`]),
              m(!1),
              w(``));
          },
        }),
      ],
    });
  },
  R = {
    "plugin-card": `_plugin-card_19yg4_1`,
    "plugin-card-dropdown": `_plugin-card-dropdown_19yg4_17`,
    "plugin-header": `_plugin-header_19yg4_31`,
    "plugin-card-header": `_plugin-card-header_19yg4_34`,
    "plugin-card-header-info": `_plugin-card-header-info_19yg4_40`,
    "plugin-card-icon": `_plugin-card-icon_19yg4_47`,
    "plugin-card-title": `_plugin-card-title_19yg4_55`,
    "plugin-card-meta": `_plugin-card-meta_19yg4_65`,
    "plugin-card-meta-icon": `_plugin-card-meta-icon_19yg4_71`,
    "plugin-card-subtext": `_plugin-card-subtext_19yg4_75`,
    "plugin-card-status": `_plugin-card-status_19yg4_82`,
    "plugin-card-description": `_plugin-card-description_19yg4_92`,
    "plugin-card-footer": `_plugin-card-footer_19yg4_107`,
    "plugin-card-footer-left": `_plugin-card-footer-left_19yg4_115`,
    "created-by": `_created-by_19yg4_123`,
    "created-by-icon": `_created-by-icon_19yg4_131`,
    "plugin-card-footer-version-icon": `_plugin-card-footer-version-icon_19yg4_132`,
    "created-by-text": `_created-by-text_19yg4_136`,
    "plugin-card-footer-version": `_plugin-card-footer-version_19yg4_132`,
    "plugin-card-footer-divider": `_plugin-card-footer-divider_19yg4_153`,
    "plugin-card-footer-tag": `_plugin-card-footer-tag_19yg4_161`,
    "plugin-card-dropdown-trigger": `_plugin-card-dropdown-trigger_19yg4_184`,
    "ant-dropdown-open": `_ant-dropdown-open_19yg4_189`,
    "plugin-card-dropdown-menu": `_plugin-card-dropdown-menu_19yg4_193`,
  };
d();
var z = () => {
  let e = j(),
    [t, n] = (0, F.useState)(``),
    [r, i] = (0, F.useState)(),
    [c, d] = (0, F.useState)(``),
    [_, y] = (0, F.useState)([]),
    [x, T] = (0, F.useState)(!1),
    [N, P] = (0, F.useState)(null),
    [I, z] = (0, F.useState)(1),
    [B, V] = (0, F.useState)(36),
    [H, U] = (0, F.useState)(0),
    [W, G] = (0, F.useState)(`idle`),
    ae = M(k.INDUSTRY_PLUGIN_MANAGE_DETAIL),
    K = M(k.INDUSTRY_PLUGIN_MANAGE_DETAIL),
    q = M(k.INDUSTRY_PLUGIN_MANAGE_DETAIL),
    J = M(k.INDUSTRY_PLUGIN_MANAGE_DETAIL),
    Y = M(k.INDUSTRY_PLUGIN_MANAGE_DETAIL),
    X = (0, F.useCallback)(
      async (e) => {
        let t = e?.pageNum ?? I,
          n = e?.collectionName === void 0 ? c : e.collectionName,
          i = b.find((t) => t.value === (e?.filterIndustry ?? r))?.label;
        e?.collectionName !== void 0 && d(e.collectionName);
        let a = t === 1 ? `initial` : `more`;
        (t === 1 && y([]), G(a));
        let o = {
          pageNum: t,
          pageSize: B,
          tagName: i,
          collectionName: n || ``,
        };
        try {
          let { data: e, errCode: t } = await w(o);
          if (t === 0 && e) {
            let { records: t, total: n, size: r, current: i } = e;
            (z(i),
              V(r),
              U(n),
              y((e) => (i === 1 ? t || [] : [...e, ...(t || [])])));
          } else (z(1), V(10), U(0), y([]));
        } catch (e) {
          (console.error(`获取列表失败:`, e), z(1), V(10), U(0), y([]));
        } finally {
          G(`idle`);
        }
      },
      [I, B, c, r],
    );
  (0, F.useEffect)(() => {
    X({ pageNum: 1 });
  }, []);
  let oe = (e) => {
      n(e);
    },
    se = (0, F.useCallback)(
      (e) => {
        (d(e), X({ pageNum: 1, collectionName: e }));
      },
      [X],
    ),
    ce = (0, F.useCallback)(
      (e) => {
        (i(e), X({ pageNum: 1, filterIndustry: e }));
      },
      [X],
    ),
    le = (0, F.useCallback)(async () => {
      I * B < H && (await X({ pageNum: I + 1 }));
    }, [I, B, H, X]),
    Z = (0, F.useCallback)(
      (e) =>
        e.state === 1
          ? [
              Y && e.readonly !== 2
                ? { label: `下架`, key: `Unpublish` }
                : null,
            ].filter(Boolean)
          : [
              K && e.readonly !== 2 ? { label: `编辑`, key: `Edit` } : null,
              J && e.readonly !== 2 ? { label: `上架`, key: `Publish` } : null,
              q && e.readonly === 0 ? { label: `删除`, key: `Delete` } : null,
            ].filter(Boolean),
      [ae, K, q, J, Y],
    ),
    ue = {
      Detail: (t) => {
        e(A.AGENT_AGENT_TEAM_DETAIL, { state: t });
      },
      Edit: (e) => {
        (P(e), T(!0));
      },
      Delete: (e) => {
        g.confirm({
          title: `确认删除？`,
          onOk: async () => {
            let t = await C({ collectionId: e.collectionId ?? `` });
            t.errCode === 0
              ? (h.success(t.data?.message || `删除成功`), X({ pageNum: 1 }))
              : h.error(t.data?.message || `删除失败`);
          },
        });
      },
      Publish: async (e) => {
        let t = await S({ collectionId: e.collectionId ?? ``, state: 1 });
        t.errCode === 0
          ? (h.success(t.data?.message || `上架成功`), X({ pageNum: 1 }))
          : h.error(t.data?.message || `上架失败`);
      },
      Unpublish: async (e) => {
        g.confirm({
          title: `下架`,
          content: `专家团队下架后，在用户端不能被引用使用；`,
          onOk: async () => {
            let t = await S({ collectionId: e.collectionId ?? ``, state: 2 });
            t.errCode === 0
              ? (h.success(t.data?.message || `下架成功`), X({ pageNum: 1 }))
              : g.error({
                  title: `下架失败`,
                  content: t.data?.message || `下架失败`,
                  okText: `确定`,
                });
          },
          cancelText: `取消`,
          okText: `确认`,
        });
      },
    },
    Q = () => {
      (T(!1), P(null));
    },
    de = W === `initial`,
    fe = W === `more`,
    pe = _.length < H,
    $ = {
      1: { text: `已上架`, status: `success` },
      0: { text: `未上架`, status: `default` },
    };
  return (0, L.jsxs)(ee, {
    mode: `card`,
    title: `专家团队`,
    tip: {
      content: `管理由多个智能专家组成的业务团队，实现复杂业务流程的协同处理。`,
      type: `info`,
    },
    activeKey: t,
    onChange: oe,
    search: { value: c, onChange: se, placeholder: `搜索专家团队`, width: 200 },
    extra: (0, L.jsxs)(
      u,
      {
        size: 8,
        children: [
          (0, L.jsx)(s, {
            placeholder: `请选择行业`,
            style: { width: 160 },
            value: r,
            onChange: ce,
            options: [{ value: ``, label: `全部` }, ...b],
          }),
          (0, L.jsx)(p, {
            type: `primary`,
            onClick: () => {
              (P(null), T(!0));
            },
            children: `新建专家团队`,
          }),
        ],
      },
      `solution-plugin-manage-extra`,
    ),
    headerClassName: R[`plugin-header`],
    children: [
      (0, L.jsx)(D, {
        skeleton: { loading: de, count: 8 },
        scrollLoad: {
          enabled: !0,
          hasMore: pe,
          onLoadMore: le,
          loadingMore: fe,
        },
        children: (_ || []).map((t) => {
          let n = (t?.tags || [])[0],
            r = !!t.createdBy,
            i = !!t.version,
            s = !!n;
          return (0, L.jsxs)(
            m,
            {
              hoverable: !0,
              className: R[`plugin-card`],
              onClick: () => {
                e(A.AGENT_AGENT_TEAM_DETAIL, { state: t });
              },
              children: [
                (0, L.jsxs)(`div`, {
                  className: R[`plugin-card-header`],
                  children: [
                    (0, L.jsx)(`img`, {
                      src:
                        t.iconUrl ||
                        `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                      className: R[`plugin-card-icon`],
                      alt: t.collectionName,
                    }),
                    (0, L.jsxs)(`div`, {
                      className: R[`plugin-card-header-info`],
                      children: [
                        (0, L.jsx)(l.Text, {
                          className: R[`plugin-card-title`],
                          children: t.collectionName,
                        }),
                        t.pluginCount == null
                          ? null
                          : (0, L.jsxs)(`div`, {
                              className: R[`plugin-card-meta`],
                              children: [
                                (0, L.jsx)(v, {
                                  src: re,
                                  size: 12,
                                  className: R[`plugin-card-meta-icon`],
                                }),
                                (0, L.jsxs)(l.Text, {
                                  className: R[`plugin-card-subtext`],
                                  children: [t.pluginCount, `个智能专家`],
                                }),
                              ],
                            }),
                      ],
                    }),
                    (0, L.jsx)(a, {
                      status: $[t.state ?? 0]?.status,
                      text: $[t.state ?? 0]?.text,
                      className: R[`plugin-card-status`],
                    }),
                  ],
                }),
                (0, L.jsx)(E, {
                  maxLines: 2,
                  className: R[`plugin-card-description`],
                  children: t.collectionDescription || `-`,
                }),
                (0, L.jsxs)(`div`, {
                  className: R[`plugin-card-footer`],
                  children: [
                    (0, L.jsxs)(`div`, {
                      className: R[`plugin-card-footer-left`],
                      children: [
                        r
                          ? (0, L.jsxs)(`div`, {
                              className: R[`created-by`],
                              children: [
                                (0, L.jsx)(v, {
                                  src: te,
                                  size: 12,
                                  className: R[`created-by-icon`],
                                }),
                                (0, L.jsx)(l.Text, {
                                  className: R[`created-by-text`],
                                  children: t.createdBy,
                                }),
                              ],
                            })
                          : null,
                        r && (i || s)
                          ? (0, L.jsx)(f, {
                              type: `vertical`,
                              className: R[`plugin-card-footer-divider`],
                            })
                          : null,
                        i
                          ? (0, L.jsxs)(`div`, {
                              className: R[`plugin-card-footer-version`],
                              children: [
                                (0, L.jsx)(v, {
                                  src: ne,
                                  size: 12,
                                  className:
                                    R[`plugin-card-footer-version-icon`],
                                }),
                                (0, L.jsx)(`span`, { children: t.version }),
                              ],
                            })
                          : null,
                        i && s
                          ? (0, L.jsx)(f, {
                              type: `vertical`,
                              className: R[`plugin-card-footer-divider`],
                            })
                          : null,
                        s
                          ? (0, L.jsx)(`span`, {
                              className: R[`plugin-card-footer-tag`],
                              children: n,
                            })
                          : null,
                      ],
                    }),
                    (0, L.jsx)(o, {
                      className: R[`plugin-card-dropdown`],
                      overlayClassName: R[`plugin-card-dropdown-menu`],
                      trigger: [`hover`],
                      menu: {
                        items: Z(t),
                        onClick: (e) => {
                          (e.domEvent?.stopPropagation(), ue[e.key]?.(t));
                        },
                      },
                      children: (0, L.jsx)(`span`, {
                        className: R[`plugin-card-dropdown-trigger`],
                        onClick: (e) => e.stopPropagation(),
                        children: (0, L.jsx)(v, { src: O, size: 28 }),
                      }),
                    }),
                  ],
                }),
              ],
            },
            t.collectionId,
          );
        }),
      }),
      (0, L.jsx)(ie, {
        open: x,
        onCancel: Q,
        record: N ?? void 0,
        isEdit: !!N,
        onOk: () => {
          (X({ pageNum: 1 }), Q());
        },
      }),
    ],
  });
};
export { z as default };
