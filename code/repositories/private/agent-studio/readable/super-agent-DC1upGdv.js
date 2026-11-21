const __vite__mapDeps = (
  i,
  m = __vite__mapDeps,
  d = m.f ||
    (m.f = [
      "assets/js/vendor-antd.QfSgOu5e.js",
      "assets/js/rolldown-runtime-CMxvf4Kt.js",
      "assets/js/vendor-react.CV1S_bb1.js",
    ]),
) => i.map((i) => d[i]);
import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  $ as r,
  Br as i,
  C as a,
  Ii as o,
  Kt as s,
  Pi as c,
  Vt as l,
  Yi as u,
  _r as d,
  an as f,
  dr as p,
  f as m,
  ni as h,
  nn as g,
  or as _,
  po as v,
  rr as y,
  wr as b,
  yr as x,
} from "./vendor-antd.QfSgOu5e.js";
import { p as S } from "./client-BfElcTb7.js";
import { t as C } from "./debounce-DLVkj6TJ.js";
import { t as w } from "./Icon-BCAHkjHa.js";
import { g as T, u as E } from "./src-_hjT3BN9.js";
import { n as D } from "./industry-dict-C4tk0Vz4.js";
import { n as O } from "./agent-C0JAlTor.js";
import { i as k } from "./status-dict-D3T8Xf4E.js";
import { x as A } from "./singleton-rEY9lZZ3-YXHRT4AG.js";
import { i as j, n as M, r as N, t as P } from "./app-super-agent-DMsaDZI3.js";
import { u as F } from "./plugin-manage-C7jNL1TC.js";
import { t as I } from "./react-D9MLkLvv.js";
import "./Workflow-publish-a42ZnFqp.js";
import "./app-Dnx7bwXT.js";
import { J as L, Tt as R, Y as ee, k as te } from "./index.B_LPe2F7.js";
var ne = Object.fromEntries(k.map(({ value: e, label: t }) => [e, t])),
  re = {
    [O.RELEASED]: { backgroundColor: `#E6FFFB`, color: `#08979C` },
    [O.UNDER_REVIEW]: { backgroundColor: `#FFF7E6`, color: `#D46B08` },
    [O.REJECTED]: { backgroundColor: `#FFF1F0`, color: `#D32029` },
    [O.NOT_RELEASED]: { backgroundColor: `#E9EBF2`, color: `#9296A6` },
  },
  ie = { backgroundColor: `#E6F4FF`, color: `#0958D9` },
  z = I((e) => ({
    microAppInfo: {},
    setMicroAppInfo: (t) => e({ microAppInfo: t }),
    appInfo: null,
    setAppInfo: (t) => e({ appInfo: t }),
    detailConfig: null,
    setDetailConfig: (t) => e({ detailConfig: t }),
    lastSaveTime: null,
    setLastSaveTime: (t) => e({ lastSaveTime: t }),
    modelList: [],
    setModelList: (t) => e({ modelList: t }),
  })),
  B = e(t()),
  ae = (e) => {
    let { isReadOnly: t, saveData: n, validateConfig: r } = e,
      i = (0, B.useCallback)(async () => {
        await r?.();
      }, [r]);
    return {
      handleBeforeStartDebug: (0, B.useCallback)(async () => {
        t || (await n(!1));
      }, [t, n]),
      validateBeforeDebug: i,
    };
  },
  oe = () => {
    let { microAppInfo: e } = z(),
      t = e?.status;
    return {
      isReadOnly: (0, B.useMemo)(
        () => t === O.RELEASED || t === O.UNDER_REVIEW,
        [t],
      ),
    };
  },
  se = e(v(), 1);
l();
var V = {
    "search-input": `_search-input_9sbmm_1`,
    "search-icon": `_search-icon_9sbmm_5`,
    "skill-list": `_skill-list_9sbmm_8`,
    "skill-item": `_skill-item_9sbmm_14`,
    "skill-info": `_skill-info_9sbmm_27`,
    "skill-name": `_skill-name_9sbmm_31`,
    "skill-icon": `_skill-icon_9sbmm_40`,
    "skill-desc": `_skill-desc_9sbmm_44`,
    "skill-empty": `_skill-empty_9sbmm_49`,
  },
  H = n(),
  ce = ({ open: e, defaultPlugins: t, onCancel: n, title: r, onOk: a }) => {
    let [l, d] = (0, B.useState)(``),
      [f, g] = (0, B.useState)(``),
      [_, v] = (0, B.useState)(t ?? []),
      [b, x] = (0, B.useState)([]),
      [S, w] = (0, B.useState)([]),
      [T, E] = (0, B.useState)(!1),
      [O] = (0, B.useState)(20),
      k = (0, B.useRef)(null),
      A = (0, B.useCallback)(
        async (e, t) => {
          try {
            E(!0);
            let n = await F({
              tagName: t ?? f,
              searchKey: e || ``,
              pageNum: `1`,
              pageSize: `99999`,
            });
            if (n?.errCode === 0) {
              let e = (n?.data?.records || []).filter((e) => e.status !== 0);
              (x(e), w(e.slice(0, O)));
            } else (x([]), w([]));
          } catch (e) {
            (console.error(`获取插件列表失败`, e), x([]), w([]));
          } finally {
            E(!1);
          }
        },
        [f, O],
      ),
      j = (0, B.useMemo)(
        () =>
          C((e) => {
            A(e);
          }, 300),
        [A],
      );
    ((0, B.useEffect)(() => {
      e && (v(t ?? []), d(``), x([]), w([]), A(``), g(``));
    }, [e, t]),
      (0, B.useEffect)(
        () => () => {
          j.cancel();
        },
        [j],
      ),
      (0, B.useEffect)(() => {
        let e = () => {
            if (!k.current) return;
            let { scrollTop: e, scrollHeight: t, clientHeight: n } = k.current;
            if (e + n >= t - 100 && S.length < b.length) {
              let e = Math.min(S.length + O, b.length);
              w(b.slice(0, e));
            }
          },
          t = k.current;
        return (
          t && t.addEventListener(`scroll`, e),
          () => {
            t && t.removeEventListener(`scroll`, e);
          }
        );
      }, [b.length, S.length, O]));
    let M = (e, t) => {
        v((n) =>
          t
            ? n.some(
                (t) =>
                  t.pluginIdStr === e.pluginIdStr ||
                  t.pluginId === e.pluginIdStr ||
                  t.pluginIdStr === e.pluginId ||
                  t.pluginId === e.pluginId,
              )
              ? n
              : [...n, e]
            : n.filter(
                (t) =>
                  !(
                    t.pluginIdStr === e.pluginIdStr ||
                    t.pluginId === e.pluginIdStr ||
                    t.pluginIdStr === e.pluginId ||
                    t.pluginId === e.pluginId
                  ),
              ),
        );
      },
      N = () => {
        (a(_), g(``), v([]), d(``));
      },
      P = () => {
        (v([]), g(``), d(``), x([]), w([]), n());
      };
    return (0, H.jsxs)(y, {
      title: r || `从智能专家市场选择`,
      open: e,
      onCancel: P,
      onOk: N,
      okText: `确认添加`,
      cancelText: `取消`,
      destroyOnClose: !0,
      confirmLoading: T,
      footer: [
        (0, H.jsxs)(
          `div`,
          {
            style: {
              width: `100%`,
              display: `flex`,
              alignItems: `center`,
              justifyContent: `space-between`,
            },
            children: [
              (0, H.jsxs)(`div`, {
                style: {
                  display: `flex`,
                  alignItems: `center`,
                  minWidth: 0,
                  maxWidth: `calc(100% - 300px)`,
                },
                children: [
                  (0, H.jsxs)(`span`, {
                    style: {
                      fontSize: `12px`,
                      padding: `2px 8px`,
                      backgroundColor: `#eee9fe`,
                      color: `#8888f4`,
                      borderRadius: `10px`,
                      marginRight: `8px`,
                      flexShrink: 0,
                      fontWeight: `bold`,
                    },
                    children: [`已选 `, _.length, ` 个`],
                  }),
                  _.length > 0 &&
                    (0, H.jsx)(c, {
                      title: _.map((e) => e.pluginNameCn).join(`, `),
                      children: (0, H.jsxs)(`span`, {
                        style: {
                          fontSize: `12px`,
                          color: `#666`,
                          cursor: `pointer`,
                          overflow: `hidden`,
                          textOverflow: `ellipsis`,
                          whiteSpace: `nowrap`,
                          flex: 1,
                        },
                        children: [
                          _.slice(0, 1)
                            .map((e) => e.pluginNameCn)
                            .join(`、`),
                          _.length > 1 && `... 等 ${_.length} 个`,
                        ],
                      }),
                    }),
                ],
              }),
              (0, H.jsxs)(`div`, {
                style: { display: `flex`, alignItems: `center`, gap: `8px` },
                children: [
                  (0, H.jsx)(u, {
                    onClick: () => v([]),
                    disabled: _.length === 0,
                    children: `清空已选`,
                  }),
                  (0, H.jsx)(u, { onClick: P, children: `取消` }),
                  (0, H.jsx)(u, {
                    type: `primary`,
                    onClick: N,
                    loading: T,
                    children: `确认添加`,
                  }),
                ],
              }),
            ],
          },
          `footer-content`,
        ),
      ],
      bodyStyle: { height: `100%`, overflow: `hidden` },
      children: [
        (0, H.jsxs)(`div`, {
          style: { display: `flex`, alignItems: `center`, marginBottom: 16 },
          children: [
            (0, H.jsx)(i, {
              prefix: (0, H.jsx)(m, { className: V[`search-icon`] }),
              placeholder: `搜索智能专家名称`,
              value: l,
              onChange: (e) => {
                let t = e.target.value;
                (d(t), j(t));
              },
              className: V[`search-input`],
              allowClear: !0,
              style: { flex: 1, height: 32, marginBottom: 0 },
            }),
            (0, H.jsx)(o, {
              style: {
                marginLeft: 12,
                width: 160,
                height: 32,
                marginBottom: 0,
              },
              placeholder: `请选择行业`,
              value: f,
              onChange: (e) => {
                (g(e), A(l, e));
              },
              options: [
                { value: ``, label: `全部` },
                ...D.map((e) => ({ value: e.label, label: e.label })),
              ],
            }),
          ],
        }),
        (0, H.jsx)(p, {
          spinning: T,
          children: (0, H.jsxs)(`div`, {
            ref: k,
            className: V[`skill-list`],
            style: { border: `none`, marginTop: 16, overflowY: `auto` },
            children: [
              S.map((e) => {
                let t = _.some(
                  (t) =>
                    t.pluginIdStr === e.pluginIdStr ||
                    t.pluginId === e.pluginIdStr ||
                    t.pluginIdStr === e.pluginId ||
                    t.pluginId === e.pluginId,
                );
                return (0, H.jsxs)(
                  `div`,
                  {
                    className: V[`skill-item`],
                    title: e.description,
                    style: {
                      display: `flex`,
                      alignItems: `flex-start`,
                      padding: `16px`,
                      border: t ? `1px solid #6466f1` : `1px solid #e8e8e8`,
                      borderRadius: `8px`,
                      marginBottom: `12px`,
                      backgroundColor: `#fff`,
                    },
                    onClick: () => M(e, !t),
                    children: [
                      (0, H.jsx)(`img`, {
                        src:
                          e.iconUrl ||
                          `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/app-HyR_3gKT.png`,
                        style: {
                          width: `48px`,
                          height: `48px`,
                          borderRadius: `8px`,
                          marginRight: `16px`,
                          flexShrink: 0,
                        },
                        alt: e.pluginNameCn,
                      }),
                      (0, H.jsxs)(`div`, {
                        style: {
                          flex: 1,
                          display: `flex`,
                          flexDirection: `column`,
                        },
                        children: [
                          (0, H.jsxs)(`div`, {
                            style: {
                              display: `flex`,
                              alignItems: `center`,
                              marginBottom: `8px`,
                              flexWrap: `wrap`,
                            },
                            children: [
                              (0, H.jsx)(c, {
                                title: e.pluginNameCn,
                                children: (0, H.jsx)(s.Text, {
                                  style: {
                                    fontWeight: `500`,
                                    fontSize: `14px`,
                                    marginRight: `8px`,
                                    maxWidth: `150px`,
                                    overflow: `hidden`,
                                    textOverflow: `ellipsis`,
                                    whiteSpace: `nowrap`,
                                    cursor: `pointer`,
                                  },
                                  children: e.pluginNameCn,
                                }),
                              }),
                              Array.isArray(e.tags) &&
                                e.tags.map((e) => {
                                  let t = `#f0f0f0`;
                                  switch (e) {
                                    case `康养`:
                                      t = `#1074ff`;
                                      break;
                                    case `教育`:
                                      t = `#7c3aed`;
                                      break;
                                    case `美业`:
                                      t = `#ff9500`;
                                      break;
                                    case `农业`:
                                      t = `#10b981`;
                                      break;
                                    case `运动健康`:
                                      t = `#1074ff`;
                                      break;
                                    case `其他(通用)`:
                                      t = `#5761f5`;
                                      break;
                                    default:
                                      t = `#f0f0f0`;
                                  }
                                  return (0, H.jsx)(
                                    `span`,
                                    {
                                      style: {
                                        fontSize: `11px`,
                                        padding: `2px 6px`,
                                        backgroundColor: t,
                                        color: `#fff`,
                                        borderRadius: `10px`,
                                        marginRight: `6px`,
                                        marginBottom: `4px`,
                                      },
                                      children: e,
                                    },
                                    e,
                                  );
                                }),
                              e.status === 1 &&
                                (0, H.jsxs)(`span`, {
                                  style: {
                                    display: `flex`,
                                    alignItems: `center`,
                                    color: `#52c41a`,
                                    fontSize: `12px`,
                                    marginLeft: `8px`,
                                  },
                                  children: [
                                    (0, H.jsx)(`span`, {
                                      style: {
                                        width: `6px`,
                                        height: `6px`,
                                        borderRadius: `50%`,
                                        backgroundColor: `#52c41a`,
                                        marginRight: `4px`,
                                      },
                                    }),
                                    `已上架`,
                                  ],
                                }),
                              e.status === 0 &&
                                (0, H.jsxs)(`span`, {
                                  style: {
                                    display: `flex`,
                                    alignItems: `center`,
                                    color: `#8c8c8c`,
                                    fontSize: `12px`,
                                    marginLeft: `8px`,
                                  },
                                  children: [
                                    (0, H.jsx)(`span`, {
                                      style: {
                                        width: `6px`,
                                        height: `6px`,
                                        borderRadius: `50%`,
                                        backgroundColor: `#8c8c8c`,
                                        marginRight: `4px`,
                                      },
                                    }),
                                    `未上架`,
                                  ],
                                }),
                            ],
                          }),
                          (0, H.jsx)(c, {
                            title: e.description,
                            children: (0, H.jsx)(s.Text, {
                              style: {
                                fontWeight: `400`,
                                fontSize: `12px`,
                                color: `#666`,
                                marginRight: `8px`,
                                maxWidth: `300px`,
                                overflow: `hidden`,
                                textOverflow: `ellipsis`,
                                whiteSpace: `nowrap`,
                                cursor: `pointer`,
                              },
                              children: e.description,
                            }),
                          }),
                          (0, H.jsxs)(`div`, {
                            style: {
                              display: `flex`,
                              alignItems: `center`,
                              fontSize: `12px`,
                              color: `#999`,
                              marginBottom: `4px`,
                            },
                            children: [
                              e.bindSkillCount != null &&
                                e.bindSkillCount > 0 &&
                                (0, H.jsxs)(`span`, {
                                  style: {
                                    marginRight: `16px`,
                                    display: `flex`,
                                    alignItems: `center`,
                                  },
                                  children: [
                                    (0, H.jsx)(`span`, {
                                      style: { marginRight: `4px` },
                                      children: `⚙️`,
                                    }),
                                    e.bindSkillCount,
                                    `个技能`,
                                  ],
                                }),
                              e.bindMcpCount != null &&
                                e.bindMcpCount > 0 &&
                                (0, H.jsxs)(`span`, {
                                  style: {
                                    marginRight: `16px`,
                                    display: `flex`,
                                    alignItems: `center`,
                                  },
                                  children: [
                                    (0, H.jsx)(`span`, {
                                      style: { marginRight: `4px` },
                                      children: `🔧`,
                                    }),
                                    e.bindMcpCount,
                                    `个 MCP 工具`,
                                  ],
                                }),
                            ],
                          }),
                          (0, H.jsx)(`div`, {
                            style: {
                              display: `flex`,
                              alignItems: `center`,
                              fontSize: `12px`,
                              color: `#999`,
                              marginBottom: `8px`,
                            },
                            children: (0, H.jsxs)(`span`, {
                              style: { display: `flex`, alignItems: `center` },
                              children: [
                                (0, H.jsx)(`span`, {
                                  style: { marginRight: `4px` },
                                  children: `👤`,
                                }),
                                e.updatedBy ?? `-`,
                              ],
                            }),
                          }),
                          (0, H.jsxs)(`div`, {
                            style: {
                              display: `flex`,
                              justifyContent: `space-between`,
                              alignItems: `center`,
                              fontSize: `12px`,
                            },
                            children: [
                              (0, H.jsx)(`span`, {
                                style: { color: `#696bf1`, fontWeight: `bold` },
                                children: e.version ?? `-`,
                              }),
                              (0, H.jsxs)(`span`, {
                                style: { color: `#999` },
                                children: [`更新于 `, e.updatedTime ?? `-`],
                              }),
                            ],
                          }),
                        ],
                      }),
                      (0, H.jsx)(h, {
                        checked: t,
                        onClick: (e) => {
                          e.stopPropagation();
                        },
                        onChange: (t) => {
                          (t.stopPropagation(), M(e, t.target.checked));
                        },
                        style: { marginLeft: `16px`, flexShrink: 0 },
                      }),
                    ],
                  },
                  e.pluginIdStr,
                );
              }),
              !T &&
                b.length === 0 &&
                (0, H.jsx)(`div`, {
                  className: V[`skill-empty`],
                  children: `暂无匹配的智能专家`,
                }),
              !T &&
                S.length < b.length &&
                (0, H.jsx)(`div`, {
                  style: {
                    textAlign: `center`,
                    padding: `16px`,
                    color: `#999`,
                  },
                  children: `加载中...`,
                }),
              !T &&
                b.length > 0 &&
                (0, H.jsxs)(`div`, {
                  style: {
                    textAlign: `center`,
                    padding: `16px`,
                    color: `#999`,
                  },
                  children: [b.length, `条数据已加载完成`],
                }),
            ],
          }),
        }),
      ],
    });
  },
  U = {
    "ant-modal-wrap": `_ant-modal-wrap_83pdu_34`,
    "ant-modal": `_ant-modal_83pdu_34`,
    "ant-modal-content": `_ant-modal-content_83pdu_44`,
    "ant-modal-footer": `_ant-modal-footer_83pdu_47`,
    "ant-modal-header": `_ant-modal-header_83pdu_47`,
    "ant-modal-body": `_ant-modal-body_83pdu_53`,
    "ant-table-body": `_ant-table-body_83pdu_67`,
    "ant-table-content": `_ant-table-content_83pdu_68`,
    "ant-table-container": `_ant-table-container_83pdu_69`,
    "ant-table-thead": `_ant-table-thead_83pdu_97`,
    "ant-input": `_ant-input_83pdu_101`,
    "ant-pagination": `_ant-pagination_83pdu_104`,
    "ant-pagination-options": `_ant-pagination-options_83pdu_104`,
    "ant-select": `_ant-select_83pdu_107`,
    "ant-pagination-options-quick-jumper": `_ant-pagination-options-quick-jumper_83pdu_110`,
    "app-super-agent-section": `_app-super-agent-section_83pdu_119`,
    "lead-agent-section": `_lead-agent-section_83pdu_124`,
    "module-header": `_module-header_83pdu_138`,
    "module-title": `_module-title_83pdu_145`,
    "module-content": `_module-content_83pdu_151`,
    "collapsible-header": `_collapsible-header_83pdu_155`,
    "header-left": `_header-left_83pdu_160`,
    "collapsible-content": `_collapsible-content_83pdu_165`,
    collapsed: `_collapsed_83pdu_171`,
    "content-wrapper": `_content-wrapper_83pdu_175`,
    "prompt-section": `_prompt-section_83pdu_179`,
    "agent-team-table-title-section": `_agent-team-table-title-section_83pdu_185`,
    "content-header": `_content-header_83pdu_190`,
  };
l();
var le = 1e4,
  ue = [
    {
      validator: async (e, t) => {
        if (!(typeof t == `string` && t.trim()))
          throw Error(`请先填写 Lead Agent 的系统提示词`);
      },
    },
  ],
  W = ({ config: e, onChange: t, disabled: n = !1 }) => {
    let [o, c] = (0, B.useState)(!1),
      l = (0, B.useCallback)(() => {
        n || c(!0);
      }, [n]),
      d = (0, B.useCallback)(() => {
        c(!1);
      }, []),
      p = (0, B.useCallback)(
        (e) => {
          (t({ plugins: e }), c(!1));
        },
        [t],
      );
    return (0, H.jsxs)(`div`, {
      className: U[`app-super-agent-section`],
      children: [
        (0, H.jsxs)(`div`, {
          className: U[`lead-agent-section`],
          children: [
            (0, H.jsx)(`div`, {
              className: U[`module-header`],
              children: (0, H.jsxs)(`div`, {
                className: U[`header-left`],
                children: [
                  (0, H.jsx)(s.Title, {
                    className: U[`module-title`],
                    children: `🐱‍🚀 System Prompt（系统提示词）`,
                  }),
                  (0, H.jsx)(s.Text, {
                    type: `secondary`,
                    style: { fontSize: 12 },
                    children: `定义智能体的角色、性格、行为准则和业务边界。`,
                  }),
                ],
              }),
            }),
            (0, H.jsx)(`div`, {
              className: U[`module-content`],
              children: (0, H.jsx)(x.Item, {
                name: `prompt`,
                label: ``,
                className: U[`prompt-section`],
                rules: ue,
                validateTrigger: [`onChange`, `onBlur`],
                children: (0, H.jsx)(i.TextArea, {
                  disabled: n,
                  autoSize: { minRows: 4, maxRows: 50 },
                  maxLength: le,
                  showCount: !0,
                  placeholder: `定义主智能体的角色、语气、和行为准则...`,
                }),
              }),
            }),
          ],
        }),
        (0, H.jsxs)(`div`, {
          className: U[`lead-agent-section`],
          children: [
            (0, H.jsx)(`div`, {
              className: U[`module-header`],
              children: (0, H.jsxs)(`div`, {
                className: U[`content-header`],
                children: [
                  (0, H.jsxs)(`div`, {
                    children: [
                      (0, H.jsx)(s.Title, {
                        className: U[`module-title`],
                        children: `🔧 智能专家`,
                      }),
                      (0, H.jsx)(s.Text, {
                        type: `secondary`,
                        style: { fontSize: 12 },
                        children: `为 Lead Agent 管理由多个智能专家 组成的业务团队（插件），实现复杂业务流程的协同处理。`,
                      }),
                    ],
                  }),
                  (0, H.jsx)(`div`, {
                    children: (0, H.jsx)(u, {
                      onClick: l,
                      icon: (0, H.jsx)(a, {}),
                      disabled: n,
                      children: `从智能专家市场选择`,
                    }),
                  }),
                ],
              }),
            }),
            (0, H.jsx)(`div`, {
              className: U[`content-wrapper`],
              children: (0, H.jsx)(x.Item, {
                label: ``,
                className: U[`prompt-section`],
                children: (0, H.jsx)(b, {
                  vertical: !0,
                  gap: `middle`,
                  children: (0, H.jsx)(f, {
                    columns: [
                      {
                        title: `智能专家名称`,
                        dataIndex: `pluginNameCn`,
                        key: `pluginNameCn`,
                        render: (e) => e || `-`,
                      },
                      {
                        title: `描述`,
                        dataIndex: `description`,
                        key: `description`,
                        render: (e) => e || `-`,
                      },
                      {
                        title: `所属行业`,
                        dataIndex: `tags`,
                        key: `tags`,
                        render: (e) => e?.join(`, `) || `-`,
                      },
                      {
                        title: `版本号`,
                        dataIndex: `version`,
                        key: `version`,
                        render: (e) => e || `-`,
                      },
                      {
                        title: `创建人`,
                        dataIndex: `createdBy`,
                        key: `createdBy`,
                        render: (e) => e || `-`,
                      },
                      {
                        title: `操作`,
                        key: `action`,
                        render: (i, a) =>
                          (0, H.jsx)(u, {
                            type: `link`,
                            danger: !0,
                            disabled: n,
                            style: { padding: 0 },
                            onClick: () => {
                              n ||
                                t({
                                  plugins: (e.plugins || []).filter(
                                    (e, t) =>
                                      (e.pluginId || String(t + 1)) !==
                                        a.pluginId || ``,
                                  ),
                                });
                            },
                            children: (0, H.jsx)(r, {}),
                          }),
                      },
                    ],
                    dataSource: e.plugins || [],
                    pagination: !1,
                    bordered: !0,
                    size: `small`,
                    rowKey: `pluginId`,
                  }),
                }),
              }),
            }),
            (0, H.jsx)(ce, {
              open: o,
              defaultPlugins: e.plugins || [],
              onCancel: d,
              title: `从智能专家市场选择`,
              onOk: p,
            }),
          ],
        }),
      ],
    });
  };
W.displayName = `LeadAgentSection`;
var de = (0, B.memo)(W),
  fe = {
    "ant-modal-wrap": `_ant-modal-wrap_5dii8_34`,
    "ant-modal": `_ant-modal_5dii8_34`,
    "ant-modal-content": `_ant-modal-content_5dii8_44`,
    "ant-modal-footer": `_ant-modal-footer_5dii8_47`,
    "ant-modal-header": `_ant-modal-header_5dii8_47`,
    "ant-modal-body": `_ant-modal-body_5dii8_53`,
    "ant-table-body": `_ant-table-body_5dii8_67`,
    "ant-table-content": `_ant-table-content_5dii8_68`,
    "ant-table-container": `_ant-table-container_5dii8_69`,
    "ant-table-thead": `_ant-table-thead_5dii8_97`,
    "ant-input": `_ant-input_5dii8_101`,
    "ant-pagination": `_ant-pagination_5dii8_104`,
    "ant-pagination-options": `_ant-pagination-options_5dii8_104`,
    "ant-select": `_ant-select_5dii8_107`,
    "ant-pagination-options-quick-jumper": `_ant-pagination-options-quick-jumper_5dii8_110`,
    "agent-configuration": `_agent-configuration_5dii8_119`,
    "module-section": `_module-section_5dii8_122`,
    "module-header": `_module-header_5dii8_132`,
    "module-icon": `_module-icon_5dii8_136`,
    "module-title": `_module-title_5dii8_140`,
    "collapsible-header": `_collapsible-header_5dii8_146`,
    "header-left": `_header-left_5dii8_155`,
    "collapse-icon": `_collapse-icon_5dii8_160`,
    "collapsible-content": `_collapsible-content_5dii8_165`,
    collapsed: `_collapsed_5dii8_171`,
    "content-wrapper": `_content-wrapper_5dii8_175`,
    "form-item": `_form-item_5dii8_180`,
    label: `_label_5dii8_186`,
    tooltip: `_tooltip_5dii8_193`,
    "character-counter": `_character-counter_5dii8_197`,
    error: `_error_5dii8_203`,
    "add-button": `_add-button_5dii8_206`,
    "list-item": `_list-item_5dii8_209`,
    "item-content": `_item-content_5dii8_221`,
    "item-name": `_item-name_5dii8_224`,
    "item-description": `_item-description_5dii8_229`,
    "item-actions": `_item-actions_5dii8_233`,
    "strategy-selector": `_strategy-selector_5dii8_237`,
    "switch-row": `_switch-row_5dii8_241`,
    "slider-row": `_slider-row_5dii8_247`,
    "slider-container": `_slider-container_5dii8_247`,
    slider: `_slider_5dii8_247`,
    "slider-value": `_slider-value_5dii8_255`,
    "conditional-section": `_conditional-section_5dii8_259`,
  };
l();
var G = B.forwardRef(
  (
    { initialConfig: e, onChange: t, disabled: n = !1, className: r, style: i },
    a,
  ) => {
    let o = (0, B.useRef)(e),
      s = (0, B.useRef)(!1),
      [c] = x.useForm();
    (0, B.useEffect)(() => {
      ((o.current = e),
        c.getFieldValue(`prompt`) !== e.prompt &&
          ((s.current = !0),
          c.setFieldsValue({ prompt: e.prompt }),
          queueMicrotask(() => {
            s.current = !1;
          })));
    }, [c, e]);
    let l = (0, B.useCallback)(
      (e) => {
        n || t({ ...o.current, ...e });
      },
      [t, n],
    );
    return (
      (0, B.useImperativeHandle)(
        a,
        () => ({
          validate: async () => {
            let e = await c.validateFields();
            return { ...o.current, ...e };
          },
        }),
        [c],
      ),
      (0, H.jsx)(x, {
        form: c,
        layout: `vertical`,
        initialValues: e,
        onValuesChange: (e) => {
          s.current || l(e);
        },
        children: (0, H.jsx)(`div`, {
          className: (0, se.default)(fe[`agent-configuration`], r),
          style: i,
          children: (0, H.jsx)(de, { config: e, onChange: l, disabled: n }),
        }),
      })
    );
  },
);
G.displayName = `AgentConfigurationComponent`;
var K = {
  header: `_header_1jyqk_4`,
  "header-inner": `_header-inner_1jyqk_10`,
  "header-left": `_header-left_1jyqk_17`,
  "header-center": `_header-center_1jyqk_21`,
  "header-right": `_header-right_1jyqk_27`,
  "app-name-box": `_app-name-box_1jyqk_31`,
  "app-name": `_app-name_1jyqk_31`,
  "app-icon": `_app-icon_1jyqk_46`,
  "app-status-tag": `_app-status-tag_1jyqk_49`,
  "save-time": `_save-time_1jyqk_52`,
  "debug-chat-play-btn": `_debug-chat-play-btn_1jyqk_57`,
};
l();
var q = `${S()}/agent/console/workspace/debug/chats/new`,
  pe = ({
    microAppId: e,
    microAppVersionId: t,
    onPublish: n,
    onUnpublish: r,
    publishLoading: i = !1,
    onAppInfoUpdate: a,
    isReadOnly: o,
    onBeforeStartDebug: l,
    onValidateBeforeDebug: f,
  }) => {
    let p = ee(),
      { microAppInfo: m, lastSaveTime: h } = z(),
      {
        flowName: v,
        status: y,
        microAppName: x,
        picUrl: S,
        runMode: C,
        updateDate: T,
      } = m || {},
      D = (0, B.useMemo)(() => ne[y] ?? `-`, [y]),
      k = (0, B.useMemo)(() => re[y] || ie, [y]),
      A = (0, B.useMemo)(() => {
        let n = new URLSearchParams();
        (e && n.set(`agent_id`, e), t && n.set(`agent_version_id`, t));
        let r = n.toString();
        return r ? `${q}?${r}` : q;
      }, [e, t]);
    (0, B.useCallback)(async () => {
      let e = window.open(A, `_blank`);
      if (!e) {
        _.error(`调试页面被浏览器拦截，请允许当前站点打开新窗口`);
        return;
      }
      try {
        (await f?.(), await l?.());
      } catch (t) {
        e.close();
        let n = t?.errorFields?.[0]?.errors?.[0];
        _.error(n || t?.message || `自动保存失败，无法开始调试`);
      }
    }, [A, l, f]);
    let j = (0, B.useCallback)(() => {
        window.history.length > 1 ? p(-1) : p(R.AGENT_APP_MANAGE);
      }, [p]),
      M = (0, B.useCallback)(() => {
        p(R.AGENT_APP_VERSION, {
          state: { microAppId: e, microAppVersionId: t, runMode: C },
        });
      }, [e, t, C, p]),
      N = (0, B.useMemo)(() => y === O.RELEASED, [y]),
      P = (0, B.useMemo)(() => y === O.NOT_RELEASED || y === O.REJECTED, [y]),
      F = (0, B.useMemo)(() => y === O.RELEASED, [y]),
      I = (0, B.useMemo)(() => (N ? !F : !P), [N, P, F]),
      L = (0, B.useCallback)(() => {
        I || (N ? r && r() : n && n());
      }, [I, N, n, r]);
    return (0, H.jsx)(`header`, {
      className: K.header,
      children: (0, H.jsxs)(`div`, {
        className: K[`header-inner`],
        children: [
          (0, H.jsxs)(b, {
            align: `center`,
            gap: 7,
            className: K[`header-left`],
            children: [
              (0, H.jsx)(te, { onClick: j }),
              (0, H.jsx)(E, {
                type: `Edit`,
                record: m,
                disabled: !!o,
                callback: () => {
                  a && a();
                },
                children: (0, H.jsxs)(b, {
                  align: `center`,
                  gap: 8,
                  className: K[`app-name-box`],
                  children: [
                    S &&
                      (0, H.jsx)(d, {
                        preview: !1,
                        src: S,
                        width: 32,
                        height: 32,
                        className: K[`app-icon`],
                      }),
                    (0, H.jsx)(s.Text, {
                      className: K[`app-name`],
                      children: v || x,
                    }),
                  ],
                }),
              }),
              `🧨`,
              (0, H.jsx)(g, {
                style: {
                  backgroundColor: k.backgroundColor,
                  color: k.color,
                  borderColor: `transparent`,
                },
                className: K[`app-status-tag`],
                children: D,
              }),
              (0, H.jsx)(s.Text, {
                children:
                  T &&
                  (0, H.jsxs)(`span`, {
                    className: K[`save-time`],
                    children: [`保存于 `, T],
                  }),
              }),
            ],
          }),
          (0, H.jsxs)(`div`, {
            className: K[`header-right`],
            children: [
              (0, H.jsx)(
                c,
                {
                  title: `历史版本`,
                  placement: `bottom`,
                  children: (0, H.jsx)(u, { onClick: M, children: `版本管理` }),
                },
                `version`,
              ),
              (0, H.jsx)(u, {
                type: `primary`,
                onClick: L,
                loading: i,
                disabled: I,
                icon:
                  !N &&
                  (0, H.jsx)(w, {
                    src: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHIAAABsCAYAAAC2AeaWAAAKX0lEQVR4Aeyda8gtVRnH36OUUX2JKArKCLpYdtOjhhDVF/vS6dy8HSPPMftSSFERFRQdT0KC5YcIiopCu2mmaaURFJJ0IfR4jpUJUhaJmllBX1K72NvvN66V+93v7JlZM7P3u2fPkufns+6zZj3zP7P3XPZ7zFr+byVWIAdyJcK4tpYDmQO5IiuwIruRFZkDuSIrsCK7kRWZA7kiK7Aiu5EVOcxAbpp1DuSmJRlmQQ7kMOO2adY5kJuWZJgFOZALitv6+vrOwPV4+TFeduB3dJ1GDmTXFVyS/jmQPQcCdW0L7MLLEfwRNvOdwG68vAEv1+Gvo80LhXQry4FstWzL1ykHsmNMUFFU4G7SKu12hpQb8HISXnCl9mRK5dV4waVbDmT6mm1Bj/pN5kDWr9GGFqhuWoGe/+R6GorqE7JJ9ndaCy7dciDT12wpe+RA1oRlQoF7SO+h+dGA6pPXkBdcJ7uX3oJLtxzI9DVbyh45kFNhQXXxHLiX9F6qowK/TVr8ZClke7F1RpH78IJLtxzI9DVbyh6jDySqm1bgHURKiisupFWfkJyLPcioD27btu1fQrqVjT6QrVZtCTuNLpATCjyT9JnERPVJVOCrKBPcQsxPqvLExlqkRhfIFms0iC4rH0hUF8+BZ5E+i6j8MnAtXlSfkE2y39FacJ1MNUqnQVY+kJ1WZ0CdVy6QqG6WAr9FXOSVeMEl2fdpLR/Fy4vwgqu0x6gVXKmpRimtbFq4coFsuuOr1m7wgZxQ4NmkzyZAvwqoPlF9QnGSqT45jV5yMV5Uo5CtNPvKsbQSXKmpRimtbFo4+EA23dFVbze4QKK6eA48h/Q5BOjXgWvw8gq84JLsJlqL6juNqyxvFsr+FIjP3DyFvOBKLV6b/SS1gqu0P1IruPY2uEC239Xl7dnHzJY+kKjumMC0Ar/JAsiJeMEl2Y20llPxp6K+HYHb8LexzacKdVGJzyUtuFIrrplSszPwbLzgKs3zo1Q2qqtc+kDW7UCuf3wFli6QqCAq8FzS5zLNeA5UfaL6hKokU30SFfgWlCeH8YfjSGyzOAeT/0rgZLzgSu1RSmUXfhdj3Sekjw/gKk01SmWjusqlC2TdhHN9+QpseSBRQFTgPtL7mGZU4NWk5eV4wSXZ92gtp+BPQSWqTzYokLppu4QC8c6IkK20C6m9kPFvFdLR6hT5MA0fps/fhHQn2/JAdpp97vz/FVh4IFHdtALvZDZyFV5Un5BNsu/SWrbjt3OU7wzcjvfJb4pnG/N6q9DiIwFcpanaSxj7KilpWadIz4tS0jW9aOGBTJ9i7tFkBeYeSI7yqMDzSJ/HpFSfqD55GWWCSzLVJ1GBfmKUIyjEJ78bDcacXis0/lIAV2new5SDtBJcqc1SZGysGiXmO/m5B7LT7HLnxivQeyA5uqMC4znnN8xGvoEX1SdkkyxeYfE73cmoTvVJkgLjFpnn84W8b0yJ10+FolJT5XKA2gNsf11Iz7KsyFkrk8tnr0BnRXJUz1Lg19msnIAXXCPzqWtRJRIVuBsFyFG8dxgaDTbdiPk+TSj3/CrPIS24Uot3P4prqGzb735+Byxt7NhC5TMDuFLz/CillamFnQOZusHcfj4r0DqQHHXxU+hdTE1Un6g+obiRqT5RfRIVuIejXzopMM6A+cZrqF+jTHyDSsiW2iOUSryGej/zuZ+yOqs7N8b+3oOUmO/kWwey01Zz595XIDmQHNmXCjPxE6i8lLTgGpnqE98tlGkF3sGR75PfjQZLaPQJ2orv+QvZUnNucgG1FzCX4v4k6abWVJGeH6XpuJXtkgNZOVquLFmBxRQ1DiQqPFaY1rsDuEbm0S2+Wyi+X38SR/rewLwUWEyOOZ8vZD4cwFXaIWoPMbdrhHSqZUWmrlhu/8QKNFYkR+djQte/BnCNTDXKn2ktflITsvMzVHi6sIUvBnCV5hN48nFaCa6V1SnStRDfTpZWG5nu1DiQ0x1zfrlWoE0g38YuiL8JI2QrzW3Iu2gld+PvRi37hXSvxpjHC4P6nVSOIy24UvN5HYmfUuuuoZYOMlFYp8jiaTv+dev0hvLE9oqkC1wk8v+GvQLJgeRI+qmw2353lK+SFlwj81lPuZLWV6KeWwIn4ts8Hccwa2v0fbqQ8TkdcRtCUal5lUbilZtH2C+v5JQ2TiisU6TfHSVhyPqmyYGsHzK32IoVaB1Ijt6HAvvx+5n8GwNedxWyjez1tBLvaBxFVYcC8doo1bONtsXdF1p4nVd8+1goKjXvXEhU4gPM/4HSlm0K19ayItutW+7lCrRWpJ0n4ai+RSjzjoJ8iLT8Ay+4SnsStfIxvBSfIknX2aU0kOJ+IelZ5nc3iXf4Gz1dN2uw6XL+ZYj/gjyPOsGVmudHKa1sW9hbINtOIPfrZwV6DySq/HfgMvxlTNNnVMU7HUJRIyvuisxqiQIOCPUfDOAq7SC1B5nTtUK6b/NNLfHXkGXW+F7Vkln1rcp7D2SrWeROnVdg7oHk6L83UNztYMb+jQv5A2nBbTDPY+Lbw7Kxcn19O0r0WdYvUCG4SvPZWZ8G96lwnw6vbNyhsu7Tahza86PEfC9+7oHsZZZ5kNoVWHggUedNwsy8iiPvJS1fxkvx6ZM2PxDKpu19FIjnISFbardSKsXbUqTnbVmR817heY6/LGMvXJFxx1FbcW0T/+nAO/ByI943i2PTaf8sCgRXag9RKvHKzaOM5xvFFM/VsiLnurwjGXzLFDnH9b2Hse9Bhf4qsff+yC7E6hTp9V2fUu/lDeXpPVrFQE7v4yjyowkk3z2PC1yOl8N4+RxeTsCnPCE/fYDUKdLvjjLdr5f8aALZy2ot8SBjCmR8rvX9xEO8OiTvJC/eQ70LVd4QiE/hUd3IsiIbLVNuVLkCY1Kk6pNZC7KNCim+f5L+uaDOnwT8W8gS7ztSvcGyIjcsR860WoExKdI7KZK6UK+jg/hknviLJHei0uJ+KP4ZQpu6N5S9Byk07d/GFMj+V2+JRhxNILnS83lh7d8e8F6okE0yn3aQK+glv8ULrtL8DimVjdpWjiaQbRdoKP1GF0hUeYUQoBcH/DUuKZ6rpSzV6s6NcTzVKDHfqx9dIHtdvSUabLSBRJXF+574qwP+mpZP7r2J+MiP8ILrxVSj9DLY9CCjDeT0QpTnh1M6xED+h+UVXKlZJ6WVdYWo84eBM/Bn0N6rQeLvqYt/50qoamT/pZX4drKQ7d+GGMj+V2EFRhxiIItroBVr/zPqBNfdUGXx65P4fcKILwl8Fi++UylkS+1mSm+mb69vKDPmBhtiIDfsQM48vgJDDOSnmLpcjhd/Q1U+Q158mlzI9m8o6/eBi/AXsYUXBIrf5yH9i4DnUzmfvODmZ0MM5PxWY8AjDy6QqOCfgQ/gxb8oIO8hLz6p5hNrCwkL2/xL4GK8nI6X4pxKeiFP8w0ukAuJzgA3kgM5GbQBp3MgBxy8yannQE6uxoDTOZADDt7k1HMgJ1djwOkcyAEHb3LqOZCTqzHgdA7kgIM3OfUcyMnVGHB61IEccNw2Tf1/AAAA//+qkKvbAAAABklEQVQDAOShtwZ1IhccAAAAAElFTkSuQmCC`,
                    size: 18,
                  }),
                style: { marginLeft: 10 },
                children: N ? `取消发布` : `发布`,
              }),
            ],
          }),
        ],
      }),
    });
  },
  J = (e) => {
    let t = Number(e);
    return Number.isFinite(t) ? t : 0;
  },
  me = (e, t) => {
    let n =
      t.plugins.map(
        (e) => (
          typeof e.pluginId == `number` && (e.pluginId = e.pluginIdStr),
          e
        ),
      ) || [];
    return {
      microAppId: e.microAppId,
      microAppVersionId: e.microAppVersionId,
      leadAgentPrompt: t.prompt?.trim() || ``,
      plugins: n,
    };
  },
  he = (e) => (e || ``).trim().replace(/^v/i, ``),
  ge = (e, t) => {
    let n = J(e),
      r = J(t);
    return !n || !r ? null : { microAppId: n, microAppVersionId: r };
  };
l();
var Y = /^v?\d+\.\d+\.\d+$/i,
  _e = `1.0.0`,
  X = (e) => {
    let t = he(e);
    return !t || !Y.test(t) ? null : t.split(`.`).map(Number);
  },
  ve = (e, t) => {
    let n = X(e),
      r = X(t);
    if (!n || !r) return 0;
    for (let e = 0; e < 3; e += 1) {
      if (n[e] > r[e]) return 1;
      if (n[e] < r[e]) return -1;
    }
    return 0;
  },
  ye = (e) => {
    let t = X(e);
    if (!t) return _e;
    let [n, r] = t;
    return `${n}.${r + 1}.0`;
  },
  Z = (e) => e?.trim() ?? ``,
  Q = (e) => {
    if (!e || typeof e != `object`) return !1;
    let t = e;
    return (
      t.success === !0 || t.errCode === 0 || t.code === 0 || t.code === 200
    );
  },
  be = (e) => {
    let {
        microAppId: t,
        microAppVersionId: n,
        microAppName: r,
        microAppIcon: a,
        currentVersion: o,
        config: s,
        saveData: c,
        publishAPI: l,
        suggestVersionAPI: u,
        unpublishAPI: d,
        onPublishSuccess: f,
        onUnpublishSuccess: p,
      } = e,
      [m] = x.useForm(),
      [h, g] = (0, B.useState)(!1),
      [v, b] = (0, B.useState)(!1),
      S = (0, B.useMemo)(() => ye(o), [o]),
      C = (0, B.useCallback)(({ title: e, content: t, action: n }) => {
        y.confirm({
          title: e,
          content: t,
          okText: `确认`,
          cancelText: `取消`,
          centered: !0,
          onOk: async () => {
            g(!0);
            try {
              await n();
            } finally {
              g(!1);
            }
          },
        });
      }, []),
      w = (0, B.useCallback)(() => {
        let e = [
          { valid: !!Z(r), message: `请先填写应用名称后再发布` },
          { valid: !!Z(a), message: `请先上传应用图标后再发布` },
          {
            valid: !!Z(s.prompt),
            message: `请先填写 Lead Agent 的系统提示词后再发布`,
          },
          {
            valid: (s.plugins || []).length > 0,
            message: `请先绑定至少一个 Plugin 后再发布`,
          },
        ];
        for (let t of e) if (!t.valid) return (_.error(t.message), !1);
        return !0;
      }, [s.plugins, s.prompt, a, r]),
      T = (0, B.useCallback)(() => {
        (b(!1), m.resetFields());
      }, [m]),
      E = (0, B.useCallback)(async () => {
        if (!t || !n) {
          _.error(`应用信息不存在`);
          return;
        }
        if (!w()) return;
        let e = S;
        if (u)
          try {
            let r = await u({
              microAppId: Number(t),
              microAppVersionId: Number(n),
            });
            Q(r) &&
              Z(r.data?.suggestVersion) &&
              (e = r.data.suggestVersion.trim());
          } catch (e) {
            console.error(`获取推荐版本号失败:`, e);
          }
        (m.setFieldsValue({ version: e, versionDescription: `` }), b(!0));
      }, [S, m, t, n, u, w]),
      D = (0, B.useCallback)(async () => {
        if (!t || !n) {
          _.error(`应用信息不存在`);
          return;
        }
        let e;
        try {
          e = await m.validateFields();
        } catch {
          return;
        }
        g(!0);
        try {
          (await c(),
            Q(
              await l({
                microAppId: Number(t),
                microAppVersionId: Number(n),
                publishVersion: e.version.trim(),
                releaseNote: e.versionDescription.trim(),
              }),
            ) && (_.success(`发布成功`), T(), f?.()));
        } catch (e) {
          console.error(`发布失败:`, e);
        } finally {
          g(!1);
        }
      }, [T, m, t, n, f, l, c]),
      O = (0, B.useCallback)(() => {
        C({
          title: `取消发布`,
          content: `取消发布后，当前应用将不再对外提供最新发布版本，是否确认取消发布？`,
          action: async () => {
            if (!n) {
              _.error(`应用版本ID不存在`);
              return;
            }
            Q(await d({ id: n })) && (_.success(`取消发布成功！`), p?.());
          },
        });
      }, [n, p, C, d]);
    return {
      publishLoading: h,
      publishModal: (0, H.jsx)(y, {
        title: `发布`,
        open: v,
        centered: !0,
        onCancel: T,
        onOk: D,
        okText: `确认发布`,
        cancelText: `取消`,
        confirmLoading: h,
        children: (0, H.jsxs)(x, {
          form: m,
          layout: `vertical`,
          preserve: !1,
          children: [
            (0, H.jsx)(x.Item, {
              label: `版本号`,
              hidden: !0,
              name: `version`,
              rules: [
                { required: !0, message: `请输入版本号` },
                {
                  validator: async (e, t) => {
                    let n = Z(t);
                    if (!n) return;
                    if (!Y.test(n))
                      throw Error(
                        `请输入正确的语义化版本号，例如 1.1.0 或 v1.1.0`,
                      );
                    let r = o && Y.test(o) ? o : _e;
                    if (ve(n, r) <= 0)
                      throw Error(`版本号必须大于当前版本 ${he(r)}`);
                  },
                },
              ],
              children: (0, H.jsx)(i, {
                disabled: !0,
                placeholder: `请输入版本号，例如 1.1.0 或 v1.1.0`,
                maxLength: 32,
              }),
            }),
            (0, H.jsx)(x.Item, {
              label: `版本说明`,
              name: `versionDescription`,
              rules: [
                { required: !0, whitespace: !0, message: `请输入版本说明` },
                { max: 500, message: `版本说明不能超过 500 字` },
              ],
              children: (0, H.jsx)(i.TextArea, {
                placeholder: `请输入版本说明`,
                maxLength: 500,
                showCount: !0,
                autoSize: { minRows: 4, maxRows: 8 },
              }),
            }),
          ],
        }),
      }),
      handlePublish: E,
      handleUnpublish: O,
    };
  },
  xe = { AUTO_SAVE_DEBOUNCE: 500 },
  Se = (e) => {
    if (!e || typeof e != `object`) return !1;
    let t = e;
    return (
      t.success === !0 || t.errCode === 0 || t.code === 0 || t.code === 200
    );
  },
  Ce = (e) => {
    let { microAppVersionId: t, enabled: n = !0, saveAPI: r } = e,
      { setLastSaveTime: i } = z(),
      a = (0, B.useRef)(!1),
      o = (0, B.useRef)(null),
      s = (0, B.useRef)(t),
      c = (0, B.useRef)(n),
      l = (0, B.useRef)(r),
      u = (0, B.useRef)(i);
    (0, B.useEffect)(() => {
      ((s.current = t), (c.current = n), (l.current = r), (u.current = i));
    }, [t, n, r, i]);
    let d = (0, B.useCallback)(
        (e) =>
          `${String(e.getHours()).padStart(2, `0`)}:${String(e.getMinutes()).padStart(2, `0`)}:${String(e.getSeconds()).padStart(2, `0`)}`,
        [],
      ),
      f = (0, B.useCallback)(
        async (e = !1) => {
          if (!c.current) return Promise.resolve();
          if (!s.current)
            return (
              console.warn(`[自动保存] 保存跳过：microAppVersionId 未设置`),
              Promise.resolve()
            );
          if (a.current) return Promise.resolve();
          try {
            if (((a.current = !0), Se(await l.current()))) {
              let t = d(new Date());
              if ((u.current(t), e)) {
                let { message: e } = await A(
                  async () => {
                    let { message: e } = await import(
                      `./vendor-antd.QfSgOu5e.js`
                    ).then((e) => (e.Vt(), e.Bt));
                    return { message: e };
                  },
                  __vite__mapDeps([0, 1, 2]),
                );
                e.success(`保存成功！`);
              }
              return Promise.resolve();
            }
            return Promise.reject(Error(`保存失败`));
          } catch (e) {
            return (
              console.error(`[自动保存] 保存失败:`, e),
              Promise.reject(e)
            );
          } finally {
            a.current = !1;
          }
        },
        [d],
      ),
      p = (0, B.useCallback)(
        (e) => {
          (o.current && clearTimeout(o.current),
            c.current &&
              (o.current = setTimeout(() => {
                f(!1)
                  .then(() => {
                    e?.();
                  })
                  .catch((e) => {
                    console.error(`[自动保存] 防抖保存失败:`, e);
                  });
              }, xe.AUTO_SAVE_DEBOUNCE)));
        },
        [f],
      );
    return (
      (0, B.useEffect)(
        () => () => {
          o.current &&= (clearTimeout(o.current), null);
        },
        [],
      ),
      { saveData: f, triggerAutoSave: p }
    );
  },
  we = (e, t) => {
    let { setMicroAppInfo: n, setAppInfo: r, setDetailConfig: i } = z(),
      [a, o] = (0, B.useState)(!1),
      s = (0, B.useCallback)(async () => {
        if (!e || !t) {
          o(!1);
          return;
        }
        try {
          let { data: a } = await P({ microAppId: e, microAppVersionId: t }),
            o = a?.appInfo || null,
            s = a?.config || null;
          (r(o), i(s), o && n(o));
        } finally {
          o(!1);
        }
      }, [e, t, r, i, n]);
    return (
      (0, B.useEffect)(() => {
        (o(!0), s());
      }, [s]),
      (0, B.useEffect)(
        () => () => {
          (n({}), r(null), i(null));
        },
        [r, i, n],
      ),
      { fetchAppInfo: s, initialLoading: a }
    );
  },
  Te = (e) => {
    let { microAppId: t, microAppVersionId: n, config: r } = e;
    return {
      saveSuperAgentConfig: (0, B.useCallback)(async () => {
        let e = ge(t, n);
        if (!e) throw Error(`应用信息不存在`);
        return M(me(e, r));
      }, [r, t, n]),
    };
  },
  Ee = (e) => {
    let { microAppId: t, microAppVersionId: n } = e,
      { detailConfig: r, microAppInfo: i, setLastSaveTime: a } = z(),
      { isReadOnly: o } = oe(),
      [s, c] = (0, B.useState)({}),
      { fetchAppInfo: l, initialLoading: u } = we(t, n),
      { saveSuperAgentConfig: d } = Te({
        microAppId: t,
        microAppVersionId: n,
        config: s,
        plugins: r?.plugins,
      }),
      { saveData: f, triggerAutoSave: p } = Ce({
        microAppVersionId: n,
        enabled: !o,
        saveAPI: d,
      });
    return (
      (0, B.useEffect)(
        () => (
          a(null),
          (window.onbeforeunload = () => {
            o || f(!1);
          }),
          () => {
            window.onbeforeunload = null;
          }
        ),
        [o, f, a],
      ),
      (0, B.useEffect)(() => {
        (i || r) &&
          c({ prompt: r?.leadAgentPrompt || ``, plugins: r?.plugins || [] });
      }, [r, i]),
      {
        config: s,
        onConfigChange: (0, B.useCallback)(
          (e) => {
            o || (c((t) => ({ ...t, ...e })), p());
          },
          [o, p],
        ),
        saveData: f,
        initialLoading: u,
        isReadOnly: o,
        fetchAppInfo: l,
      }
    );
  },
  $ = {
    "page-wrap": `_page-wrap_1o85r_5`,
    "loading-overlay": `_loading-overlay_1o85r_16`,
    "page-body": `_page-body_1o85r_31`,
    "body-left": `_body-left_1o85r_41`,
    "body-resizer": `_body-resizer_1o85r_50`,
    "body-right": `_body-right_1o85r_78`,
    "form-panel": `_form-panel_1o85r_86`,
    "chat-panel": `_chat-panel_1o85r_94`,
  };
l();
var De = () => {
  let { state: e } = L(),
    { microAppInfo: t } = z(),
    n = (0, B.useRef)(null),
    { microAppId: r, microAppVersionId: i } = e || {},
    {
      isReadOnly: a,
      config: o,
      onConfigChange: s,
      saveData: c,
      fetchAppInfo: l,
      initialLoading: u,
    } = Ee({ microAppId: r, microAppVersionId: i }),
    {
      publishLoading: d,
      publishModal: f,
      handlePublish: m,
      handleUnpublish: h,
    } = be({
      microAppId: r,
      microAppVersionId: i,
      microAppName: t?.microAppName,
      microAppIcon: t?.picUrl,
      currentVersion: t?.currentVersion || t?.latestVersion,
      config: o,
      saveData: () => c(!1),
      publishAPI: N,
      suggestVersionAPI: j,
      unpublishAPI: T,
      onPublishSuccess: l,
      onUnpublishSuccess: l,
    }),
    { handleBeforeStartDebug: g, validateBeforeDebug: _ } = ae({
      isReadOnly: a,
      saveData: c,
      validateConfig: (0, B.useCallback)(async () => {
        await n.current?.validate();
      }, []),
    });
  return (0, H.jsxs)(`div`, {
    className: $[`page-wrap`],
    children: [
      u &&
        (0, H.jsx)(`div`, {
          className: $[`loading-overlay`],
          children: (0, H.jsx)(p, { size: `large`, tip: `加载中...` }),
        }),
      (0, H.jsx)(pe, {
        microAppId: r,
        microAppVersionId: i,
        onPublish: m,
        onUnpublish: h,
        publishLoading: d,
        onAppInfoUpdate: l,
        isReadOnly: a,
        onBeforeStartDebug: g,
        onValidateBeforeDebug: _,
      }),
      (0, H.jsx)(`div`, {
        className: $[`page-body`],
        children: (0, H.jsx)(`div`, {
          className: $[`body-left`],
          children: (0, H.jsx)(`div`, {
            className: $[`form-panel`],
            children: (0, H.jsx)(G, {
              ref: n,
              initialConfig: o,
              onChange: s,
              disabled: a,
            }),
          }),
        }),
      }),
      f,
    ],
  });
};
De.displayName = `AppAgent`;
export { De as default };
