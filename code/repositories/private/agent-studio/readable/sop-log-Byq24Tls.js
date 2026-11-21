import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Ai as r,
  Pr as i,
  Vt as a,
  a as o,
  dr as s,
  rr as c,
  x as l,
} from "./vendor-antd.QfSgOu5e.js";
import { n as u, t as d } from "./moment-ROF23LCm.js";
import { J as f, Y as p } from "./index.B_LPe2F7.js";
import { J as m, Y as h } from "./intelligentEngine-BhRFRjx8.js";
import { t as g } from "./ListPage-Dda3HptU.js";
import "./radar-Cqm7UC7U.js";
(a(), u());
var _ = e(t(), 1),
  v = n(),
  { RangePicker: y } = i,
  b = () => {
    let [e, t] = (0, _.useState)(!1),
      [n, i] = (0, _.useState)(!1),
      [a, u] = (0, _.useState)([]),
      [b, x] = (0, _.useState)(null),
      { state: S } = f(),
      C = p(),
      w = (0, _.useRef)(),
      T = (0, _.useRef)(),
      E = (0, _.useRef)(),
      D = (0, _.useRef)(),
      O = [
        { title: `sessionid`, dataIndex: `sessionId` },
        { title: `会话时长`, dataIndex: `sessionTimeLong`, hideInSearch: !0 },
        {
          title: `开始时间`,
          dataIndex: `sessionStartTime`,
          renderFormItem: () => (0, v.jsx)(y, {}),
        },
        { title: `结束时间`, dataIndex: `sessionEndTime`, hideInSearch: !0 },
        { title: `创建时间`, dataIndex: `createDate`, hideInSearch: !0 },
        {
          title: `操作`,
          dataIndex: `option`,
          valueType: `option`,
          render: (e, t) => [
            (0, v.jsx)(
              `a`,
              {
                type: `link`,
                onClick: () => {
                  (i(!0), k(t));
                },
                children: `详情`,
              },
              `edit`,
            ),
          ],
        },
      ],
      k = (e) => {
        let { sessionId: n, saasAppId: r, sopId: a } = e;
        m({ sessionId: n, saasAppId: r, sopId: a }).then((e) => {
          (i(!1), e.success && (t(!0), u(e.data)));
        });
      },
      A = () => {
        t(!1);
      };
    (0, _.useEffect)(() => {
      a &&
        E.current &&
        ((E.current.scrollTop = E.current.scrollHeight + E.current.scrollTop),
        (D.current.scrollTop = D.current.scrollHeight + D.current.scrollTop));
    }, [a]);
    let j = (e) => {
      (x(e),
        document
          .querySelector(`#anchor${e}`)
          .scrollIntoView({ bahavior: `smooth`, block: `start` }));
    };
    return (0, v.jsxs)(v.Fragment, {
      children: [
        (0, v.jsx)(g, {
          title: `${S.flowName}日志`,
          showBack: !0,
          onBack: () => C(-1),
          rowKey: `ssrId`,
          actionRef: T,
          formRef: w,
          columns: O,
          pagination: { defaultPageSize: 10 },
          tableProps: {
            className: `layout-content-scroll`,
            request: async (e) => {
              let { sessionId: t, sessionStartTime: n } =
                  w.current.getFieldsValue(),
                { current: r, pageSize: i } = e,
                a,
                o;
              n &&
                n.length &&
                ((a = d(new Date(n[0]))
                  .startOf(`day`)
                  .format(`yyyy-MM-DD HH:mm:ss`)),
                (o = d(new Date(n[1]))
                  .endOf(`day`)
                  .format(`YYYY-MM-DD HH:mm:ss`)));
              try {
                let { success: e, data: n } =
                  (await h({
                    sopId: S.id,
                    sessionId: t,
                    startTime: a,
                    pageNum: r,
                    microAppId: S.microAppId,
                    microAppVersionId: S.microAppVersionId,
                    pageSize: i,
                    endTime: o,
                  })) || {};
                if (e) {
                  let { records: e = [], total: t } = n || {};
                  return { data: e, success: !0, total: t };
                }
              } catch (e) {
                console.log(e);
              }
            },
          },
        }),
        (0, v.jsx)(c, {
          open: e,
          title: `调试详情`,
          width: 1e3,
          onCancel: A,
          keyboard: !1,
          cancelText: `关闭`,
          footer: (e) => e.props.children[0],
          children: (0, v.jsxs)(`div`, {
            className: `debug-all-box`,
            children: [
              (0, v.jsxs)(`div`, {
                style: { margin: `0 16px` },
                children: [
                  (0, v.jsx)(`div`, {
                    className: `debugBox-title`,
                    children: (0, v.jsx)(`span`, {
                      children: `大模型问答记录：`,
                    }),
                  }),
                  (0, v.jsx)(`div`, {
                    className: `debugBox`,
                    children: (0, v.jsxs)(`div`, {
                      className: `debugBox-list`,
                      ref: E,
                      children: [
                        a.map((e, t) =>
                          (0, v.jsxs)(
                            `div`,
                            {
                              className: `chat-text-base ${e.chatUser === 1 ? `chat-text-right` : ``}`,
                              children: [
                                (0, v.jsx)(r, {
                                  icon:
                                    e.type === 1
                                      ? (0, v.jsx)(o, {})
                                      : (0, v.jsx)(l, {}),
                                  onClick: () => {
                                    j(t);
                                  },
                                }),
                                (0, v.jsxs)(`div`, {
                                  className: `chat-text-content`,
                                  children: [
                                    (0, v.jsx)(`span`, {
                                      style: { wordBreak: `break-all` },
                                      children: e.response,
                                    }),
                                    t === 0 &&
                                      S.sopName === `绘画教学目标` &&
                                      (0, v.jsx)(`img`, {
                                        src: `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/radar-wbVBqfxs.jpg`,
                                      }),
                                    (0, v.jsx)(`div`, {
                                      children: (e.imageList || []).map(
                                        (e, t) =>
                                          (0, v.jsx)(
                                            `div`,
                                            {
                                              children: (0, v.jsx)(
                                                `img`,
                                                {
                                                  style: {
                                                    maxWidth: 220,
                                                    height: `auto`,
                                                  },
                                                  src: e,
                                                },
                                                t,
                                              ),
                                            },
                                            t,
                                          ),
                                      ),
                                    }),
                                  ],
                                }),
                              ],
                            },
                            t,
                          ),
                        ),
                        (0, v.jsx)(s, {
                          spinning: n,
                          style: { background: `#f1f1f1` },
                          children: n
                            ? (0, v.jsx)(`div`, { style: { height: 40 } })
                            : null,
                        }),
                      ],
                    }),
                  }),
                ],
              }),
              (0, v.jsxs)(`div`, {
                children: [
                  (0, v.jsx)(`div`, {
                    className: `debugBox-title`,
                    children: (0, v.jsx)(`span`, {
                      children: `大模型调用日志：`,
                    }),
                  }),
                  (0, v.jsx)(`div`, {
                    className: `right-box`,
                    ref: D,
                    children: a.map((e, t) =>
                      (0, v.jsxs)(
                        `div`,
                        {
                          className: `right-box-item`,
                          id: `anchor${t}`,
                          style: { background: b === t ? `#ffcece` : `` },
                          children: [
                            (0, v.jsxs)(`span`, {
                              children: [
                                e.chatUser === 1 ? `用户` : `机器人`,
                                `：`,
                              ],
                            }),
                            e.chatUser === 1 &&
                              (0, v.jsx)(`div`, {
                                className: `right-box-item-obj`,
                                children: (0, v.jsxs)(`div`, {
                                  children: [
                                    (0, v.jsx)(`label`, {
                                      children: `用户问题：`,
                                    }),
                                    (0, v.jsxs)(`span`, {
                                      children: [
                                        e.response,
                                        e.inParam
                                          ? (0, v.jsxs)(v.Fragment, {
                                              children: [
                                                (0, v.jsx)(`br`, {}),
                                                `用户参数：`,
                                                e.inParam,
                                              ],
                                            })
                                          : null,
                                        (e?.imageList || []).map((e, t) =>
                                          (0, v.jsx)(
                                            `div`,
                                            {
                                              style: { wordWrap: `break-word` },
                                              children: `图片地址：${e}`,
                                            },
                                            t,
                                          ),
                                        ),
                                      ],
                                    }),
                                  ],
                                }),
                              }),
                            e.chatUser !== 1 &&
                              (0, v.jsxs)(`div`, {
                                className: `right-box-item-list`,
                                children: [
                                  (0, v.jsxs)(`div`, {
                                    className: `right-box-item-list-title`,
                                    children: [
                                      (0, v.jsxs)(`div`, {
                                        children: [
                                          (0, v.jsx)(`label`, {
                                            children: `会话ID：`,
                                          }),
                                          (0, v.jsx)(`span`, {
                                            children: e.sessionId,
                                          }),
                                        ],
                                      }),
                                      (0, v.jsxs)(`div`, {
                                        children: [
                                          (0, v.jsx)(`label`, {
                                            children: `会话次数：`,
                                          }),
                                          (0, v.jsx)(`span`, {
                                            children: e.sessionNum,
                                          }),
                                        ],
                                      }),
                                      (0, v.jsxs)(`div`, {
                                        children: [
                                          (0, v.jsx)(`label`, {
                                            children: `本次会话时长：`,
                                          }),
                                          (0, v.jsx)(`span`, {
                                            children: e.timeLong,
                                          }),
                                        ],
                                      }),
                                      (0, v.jsxs)(`div`, {
                                        children: [
                                          (0, v.jsx)(`label`, {
                                            children: `返回结果：`,
                                          }),
                                          (0, v.jsx)(`span`, {
                                            children: e.agentResponse,
                                          }),
                                        ],
                                      }),
                                    ],
                                  }),
                                  (e.infoList || []).map((e, t) =>
                                    (0, v.jsxs)(
                                      `div`,
                                      {
                                        className: `right-box-item-list-box`,
                                        children: [
                                          (0, v.jsxs)(`div`, {
                                            className: `right-box-item-list-box-title`,
                                            children: [
                                              (0, v.jsxs)(`label`, {
                                                children: [`序号：`, t + 1],
                                              }),
                                              (0, v.jsxs)(`label`, {
                                                children: [
                                                  `类型：`,
                                                  e.callType,
                                                ],
                                              }),
                                              (0, v.jsxs)(`label`, {
                                                children: [
                                                  `调用对象：`,
                                                  e.callName,
                                                ],
                                              }),
                                              (0, v.jsxs)(`label`, {
                                                children: [
                                                  `调用时长：`,
                                                  e.timeLong,
                                                ],
                                              }),
                                            ],
                                          }),
                                          (0, v.jsxs)(`div`, {
                                            className: `right-box-item-list-box-row`,
                                            children: [
                                              (0, v.jsxs)(`div`, {
                                                children: [
                                                  (0, v.jsx)(`label`, {
                                                    children: `系统提示词：`,
                                                  }),
                                                  (0, v.jsx)(`span`, {
                                                    children: e.systemPrompt,
                                                  }),
                                                ],
                                              }),
                                              (0, v.jsxs)(`div`, {
                                                children: [
                                                  (0, v.jsx)(`label`, {
                                                    children: `用户提示词：`,
                                                  }),
                                                  (0, v.jsx)(`span`, {
                                                    children: e.userPrompt,
                                                  }),
                                                ],
                                              }),
                                              (0, v.jsxs)(`div`, {
                                                children: [
                                                  (0, v.jsx)(`label`, {
                                                    children: `大模型响应：`,
                                                  }),
                                                  (0, v.jsxs)(`span`, {
                                                    children: [
                                                      e.response,
                                                      (e?.imageList || []).map(
                                                        (e, t) =>
                                                          (0, v.jsx)(
                                                            `div`,
                                                            {
                                                              style: {
                                                                wordWrap: `break-word`,
                                                              },
                                                              children: `图片地址：${e}`,
                                                            },
                                                            t,
                                                          ),
                                                      ),
                                                    ],
                                                  }),
                                                ],
                                              }),
                                            ],
                                          }),
                                        ],
                                      },
                                      t,
                                    ),
                                  ),
                                  !e.infoList?.length &&
                                    (0, v.jsx)(`div`, {
                                      children: `暂无调用数据`,
                                    }),
                                ],
                              }),
                          ],
                        },
                        t,
                      ),
                    ),
                  }),
                ],
              }),
            ],
          }),
        }),
      ],
    });
  };
export { b as default };
