import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, t as n } from "./vendor-react.CV1S_bb1.js";
import {
  Ar as r,
  Br as i,
  C as a,
  Gt as o,
  Or as s,
  Pi as c,
  S as l,
  Vt as u,
  Wt as d,
  X as f,
  Yi as p,
  dr as m,
  fn as h,
  or as g,
  ot as _,
  rr as v,
  w as y,
  yr as b,
} from "./vendor-antd.QfSgOu5e.js";
import { t as x } from "./Icon-BCAHkjHa.js";
import { n as S } from "./fileUtils-BjWnOXhL.js";
import { F as C, J as w, Tt as T, Y as E, j as D } from "./index.B_LPe2F7.js";
import { t as O } from "./withCommonModal-DtIjzNPg.js";
import { t as k } from "./ListPage-Dda3HptU.js";
var ee = `data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20xmlns:xlink='http://www.w3.org/1999/xlink'%20viewBox='0%200%2060%2060'%20class='design-iconfont'%3e%3cdefs%3e%3cpath%20id='dut0n1z62__jqe4cjyvda'%20d='M0%200H60V60H0z'/%3e%3c/defs%3e%3cg%20fill='none'%20fill-rule='evenodd'%3e%3cmask%20id='dut0n1z62__3rbwlvlknb'%20fill='%23fff'%3e%3cuse%20xlink:href='%23dut0n1z62__jqe4cjyvda'/%3e%3c/mask%3e%3cuse%20fill-opacity='0'%20fill='%23D8D8D8'%20xlink:href='%23dut0n1z62__jqe4cjyvda'/%3e%3cg%20mask='url(%23dut0n1z62__3rbwlvlknb)'%3e%3cpath%20fill='%23716AE5'%20opacity='.70084635'%20d='M30%2017A17%2017%200%201%200%2030%2051A17%2017%200%201%200%2030%2017Z'%20transform='translate(7%205)'/%3e%3cg%20transform='translate(7%205)'%3e%3crect%20stroke='%23211E2F'%20fill='%23FFF'%20stroke-linejoin='round'%20width='36'%20height='42'%20rx='8'/%3e%3crect%20fill='%235E7DFF'%20x='9'%20y='8'%20width='18'%20height='2'%20rx='1'/%3e%3crect%20fill='%23F7B500'%20x='9'%20y='15'%20width='18'%20height='2'%20rx='1'/%3e%3cpath%20d='M36,26%20L36,34%20C36,38.418278%2032.418278,42%2028,42%20L8,42%20C3.581722,42%205.41083001e-16,38.418278%200,34%20L0,26%20L11.29008,26.0006762%20C12.1508455,28.8918177%2014.8292266,31%2018,31%20C21.1707734,31%2023.8491545,28.8918177%2024.70992,26.0006762%20L36,26%20Z'%20stroke='%23211E2F'%20fill='%23313648'%20stroke-linejoin='round'/%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/svg%3e`,
  A = e(t(), 1);
u();
var j = (e) => C(`post`, `/agent-kg/qa/list`, e),
  M = (e = {}) => C(`post`, `/agent-kg/qa/add`, e),
  N = (e = {}) => C(`post`, `/agent-kg/qa/modify`, e),
  P = (e = {}) => C(`post`, `/agent-kg/qa/del`, e),
  F = (e = {}) => C(`post`, `/agent-kg/qa/get`, e),
  I = (e = {}) =>
    C(`post`, `/agent-microapp/microAppVersion/aiAutoGenProblem`, e),
  te = (e) =>
    C(
      `post`,
      `/agent-kg/qa/uploadQAExcel?baseId=${e.baseId}&tenantCode=${e.tenantCode}`,
      e.file,
      { headers: { "Content-Type": `multipart/form-data` } },
    ),
  L = `下载模板`,
  R = 1024 * 1024 * 5,
  z = [
    {
      type: `.xlsx`,
      MIME: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
    },
  ],
  B = `https://ai-copilot.cos.clife.cn/web-agent-paas/static/files/knowledge-quiz-template.xlsx`,
  V = `知识问答模板.xlsx`,
  H = n(),
  U = ({ isDownloading: e, downloadPercent: t, onDownload: n }) =>
    (0, H.jsxs)(s, {
      style: { width: `100%`, justifyContent: `space-between` },
      children: [
        (0, H.jsx)(`div`, { children: L }),
        (0, H.jsx)(p, {
          icon: !e && (0, H.jsx)(f, {}),
          loading: e,
          onClick: n,
          children: e ? `下载中 ${t}%` : L,
        }),
      ],
    });
o();
var W = {
  container: `_container_19tid_1`,
  steps: `_steps_19tid_1`,
  "dragger-container": `_dragger-container_19tid_7`,
  space: `_space_19tid_14`,
  "text-center": `_text-center_19tid_17`,
  "text-footer": `_text-footer_19tid_22`,
  "button-container": `_button-container_19tid_27`,
};
u();
var G = ({ fileList: e, onRemove: t, customRequest: n, beforeUpload: r }) =>
    (0, H.jsx)(d, {
      maxCount: 1,
      listType: `picture`,
      fileList: e,
      onRemove: t,
      customRequest: n,
      beforeUpload: r,
      accept: z?.map((e) => e?.type)?.join(`,`),
      className: W[`dragger-container`],
      children: (0, H.jsxs)(s, {
        direction: `vertical`,
        className: W.space,
        children: [
          (0, H.jsx)(x, { src: ee, size: 60 }),
          (0, H.jsx)(`p`, {
            className: W[`text-center`],
            children: `点击或拖拽上传文件`,
          }),
          (0, H.jsxs)(`p`, {
            className: W[`text-footer`],
            children: [
              `文档支持`,
              z?.map((e) => e?.type)?.join(`、`),
              `，`,
              (0, H.jsxs)(`span`, { children: [`单个文件不超过≤`, 5, `MB`] }),
            ],
          }),
        ],
      }),
    }),
  K = (function (e) {
    return (
      (e[(e.Init = 0)] = `Init`),
      (e[(e.Uploading = 1)] = `Uploading`),
      (e[(e.Success = 2)] = `Success`),
      (e[(e.Error = 3)] = `Error`),
      e
    );
  })({});
u();
var { confirm: q } = v,
  J = O({
    renderComp: ({ open: e, params: t, onClose: n, onSuccess: r }) => {
      let { userInfo: i } = D(),
        [a, o] = (0, A.useState)(!1),
        [s, c] = (0, A.useState)(0),
        [l, u] = (0, A.useState)(K.Init),
        [d, f] = (0, A.useState)([]),
        [p, _] = (0, A.useState)(0),
        [y, b] = (0, A.useState)(!1),
        x = async (e) => {
          let { file: t } = e;
          f([
            {
              uid: `-1`,
              name: t?.name,
              status: `done`,
              url: ``,
              thumbUrl: ``,
              originFileObj: t,
            },
          ]);
        },
        C = () => {
          (f([]), u(K.Init));
        },
        w = (e) => {
          let t = e.size <= R,
            n = (z?.map((e) => e.MIME)).includes(e.type);
          return (
            n || g.error(`只能上传${z?.map((e) => e.type).join(`、`)}文件!`),
            t || g.info(`文件大小不能超过5MB!`),
            t && n
          );
        },
        T = async () => {
          let { originFileObj: e } = d[0] || {};
          if (!e) return g.error(`请先上传文件`);
          (o(!0), u(K.Uploading));
          try {
            let n = new FormData();
            n.append(`file`, e);
            let r = await te({
              file: n,
              baseId: t?.baseId || ``,
              userId: null,
              tenantCode: i?.tenant?.tenantCode,
            });
            (u(r?.code === 0 ? K.Success : K.Error),
              r?.code === 0 && g.success(`导入成功`));
          } catch (e) {
            (u(K.Error), console.error(`Import failed:`, e));
          } finally {
            o(!1);
          }
        },
        E = () => {
          if (l === K.Success) return k();
          if (l !== K.Uploading) return O();
          q({ title: `导入中，不可关闭弹窗，可能导致导入失败`, onOk: O });
        },
        O = () => {
          n?.();
        },
        k = () => {
          (O(), r?.());
        };
      return (0, H.jsx)(v, {
        open: e,
        title: `批量导入问答`,
        onCancel: E,
        className: W.container,
        okText: [K.Init, K.Error].includes(l)
          ? l === K.Init
            ? `导入文档`
            : `导入失败`
          : l === K.Uploading
            ? `导入中`
            : l === K.Success
              ? `导入成功`
              : `导入文档`,
        onOk: l === K.Success ? k : T,
        okButtonProps: { disabled: l === K.Uploading },
        children: (0, H.jsxs)(m, {
          spinning: a,
          children: [
            (0, H.jsx)(h, {
              direction: `vertical`,
              current: s,
              className: W.steps,
              items: [
                {
                  title: (0, H.jsx)(U, {
                    isDownloading: y,
                    downloadPercent: p,
                    onDownload: () => {
                      b(!0);
                      let e = new XMLHttpRequest();
                      (e.open(`GET`, B, !0),
                        (e.responseType = `blob`),
                        (e.onprogress = (e) => {
                          e.lengthComputable &&
                            _(Math.floor((e.loaded / e.total) * 100));
                        }),
                        (e.onload = () => {
                          if (e.status === 200) {
                            let t = window.URL.createObjectURL(e.response);
                            (S(t, V),
                              window.URL.revokeObjectURL(t),
                              c(1),
                              g.success(`下载成功`));
                          } else g.error(`下载失败`);
                          (b(!1), _(0));
                        }),
                        (e.onerror = () => {
                          (g.error(`下载出错`), b(!1), _(0));
                        }),
                        e.send());
                    },
                  }),
                },
                { title: `上传文件` },
              ],
            }),
            (0, H.jsx)(G, {
              fileList: d,
              onRemove: C,
              customRequest: x,
              beforeUpload: w,
            }),
          ],
        }),
      });
    },
  }),
  Y = (0, A.memo)(J),
  X = {
    "form-container": `_form-container_16iq8_1`,
    "label-container": `_label-container_16iq8_4`,
    label: `_label_16iq8_4`,
    "label-text": `_label-text_16iq8_15`,
  },
  Z = {
    label: `_label_1rfwz_1`,
    "form-list": `_form-list_1rfwz_9`,
    inp: `_inp_1rfwz_13`,
    space: `_space_1rfwz_16`,
    icon: `_icon_1rfwz_19`,
  },
  ne = (e) => {
    let t = 0;
    for (let n = e.length - 1; n >= 0 && !e[n]?.length; n--) t++;
    return t;
  };
u();
var re = O({
    renderComp: ({ open: e, params: t, onClose: n, onSuccess: a }) => {
      let [o] = b.useForm(),
        u = b.useWatch(`similarQuestion`, o),
        [d, f] = (0, A.useState)(!1),
        [h, v] = (0, A.useState)(!1),
        x = async () => {
          try {
            (await o.validateFields(), o.submit());
          } catch (e) {
            console.log(e);
          }
        },
        S = async () => {
          f(!0);
          try {
            let e = await I({
              count: 5,
              problem: t?.problem || ``,
              relProblem: u
                ?.filter((e) => e?.similarQuestion?.length)
                ?.map((e) => e?.similarQuestion),
            });
            if (e?.errCode !== 0) return g.error(e?.msg);
            let n = [...u],
              r = n?.map((e) => e?.similarQuestion),
              i = r.lastIndexOf(``),
              a = n?.length;
            i !== -1 &&
              (i = r.slice(i, r?.length).some((e) => e?.length) ? -1 : i);
            let s = ne(r),
              c = s - (s - e?.data?.length || 0);
            ((a = s === 1 ? i : i - (s - 1)),
              n.splice(
                i === -1 ? n?.length : a,
                c,
                ...(e?.data || []).map((e) => ({ similarQuestion: e })),
              ),
              o.setFieldsValue({ similarQuestion: n }));
          } catch (e) {
            console.error(`Error generating similar questions:`, e);
          } finally {
            f(!1);
          }
        },
        C = async (e) => {
          try {
            (a?.(e.similarQuestion), n());
          } catch (e) {
            console.error(`Error generating similar questions:`, e);
          }
        },
        w = () => {
          setTimeout(() => {
            o.setFieldsValue({
              similarQuestion: t?.similarQuestion || [{ similarQuestion: `` }],
            });
          });
        },
        T = (e, t) => {
          let n = t?.similarQuestion?.filter((e) => e?.similarQuestion?.length);
          v(new Set(n.map((e) => e?.similarQuestion))?.size !== n?.length);
        },
        E = (e, t) => {
          if (!t?.length) return Promise.resolve();
          let n = [...u],
            r = u?.findIndex((e) => e.similarQuestion?.trim() === t?.trim());
          return (
            n?.splice(r, 1),
            n.some((e) => e.similarQuestion?.trim() === t?.trim())
              ? Promise.reject(Error(`问题不可相同，请修改`))
              : Promise.resolve()
          );
        };
      return (
        (0, A.useEffect)(() => {
          e && w();
        }, [t, e]),
        (0, H.jsx)(r, {
          open: e,
          width: `35vw`,
          title: `相似问`,
          onClose: n,
          extra: (0, H.jsxs)(s, {
            children: [
              (0, H.jsx)(p, {
                loading: d,
                disabled: h,
                type: `primary`,
                onClick: x,
                children: `完成`,
              }),
              (0, H.jsx)(p, { onClick: n, children: `取消` }),
            ],
          }),
          children: (0, H.jsxs)(m, {
            spinning: d,
            children: [
              (0, H.jsx)(b, {
                form: o,
                layout: `horizontal`,
                wrapperCol: { span: 24 },
                onFinish: C,
                onValuesChange: T,
                children: (0, H.jsx)(b.List, {
                  name: `similarQuestion`,
                  children: (e, { add: t, remove: n }) =>
                    (0, H.jsx)(`div`, {
                      className: Z[`form-list`],
                      children: e.map((r) =>
                        (0, H.jsxs)(
                          b.Item,
                          {
                            colon: !1,
                            required: !1,
                            label: (0, H.jsx)(`div`, {
                              className: Z.label,
                              children: r.name + 1,
                            }),
                            children: [
                              (0, H.jsx)(b.Item, {
                                ...r,
                                noStyle: !0,
                                name: [r.name, `similarQuestion`],
                                validateTrigger: [`onChange`, `onBlur`],
                                rules: [
                                  { required: !0, message: `请输入相似问题` },
                                  { validator: E },
                                ],
                                children: (0, H.jsx)(i, {
                                  placeholder: `请输入相似问题`,
                                  className: Z.inp,
                                }),
                              }),
                              (0, H.jsxs)(s, {
                                className: Z.space,
                                children: [
                                  (0, H.jsx)(y, {
                                    className: Z.icon,
                                    onClick: () => t({ similarQuestion: `` }),
                                  }),
                                  e?.length > 1 &&
                                    (0, H.jsx)(_, {
                                      className: Z.icon,
                                      onClick: () => n(r.name),
                                    }),
                                ],
                              }),
                            ],
                          },
                          r.key,
                        ),
                      ),
                    }),
                }),
              }),
              (0, H.jsxs)(p, {
                block: !0,
                type: `primary`,
                onClick: S,
                children: [
                  `一键生成相似问`,
                  (0, H.jsx)(c, {
                    title: `根据当前已录入的问题（如已录入答案也将作为参考）使用模型消耗token生成。`,
                    children: (0, H.jsx)(l, {}),
                  }),
                ],
              }),
            ],
          }),
        })
      );
    },
  }),
  ie = (0, A.memo)(re);
u();
var { TextArea: Q } = i,
  ae = O({
    renderComp: ({ open: e, params: t, onClose: n, onSuccess: r }) => {
      let [i] = b.useForm(),
        { userInfo: a } = D(),
        o = b.useWatch(`questionContent`, i),
        s = b.useWatch(`similarQuestion`, i),
        c = (0, A.useRef)(null),
        [l, u] = (0, A.useState)(!1),
        d = (0, A.useMemo)(() => t?.qaId === void 0, [t?.qaId]),
        f = async () => {
          try {
            (await i.validateFields(), i.submit());
          } catch (e) {
            console.log(e);
          }
        },
        p = async (e) => {
          let i = {
              ...e,
              baseId: t?.baseId,
              userId: null,
              tenantCode: a?.tenant?.tenantCode,
            },
            o = { 0: () => N({ ...i, qaId: t?.qaId || `` }), 1: () => M(i) };
          try {
            u(!0);
            let e = await o[Number(d)]();
            if (e?.code !== 0) return g.error(e?.msg);
            (g.success(`成功`), n(), r?.());
          } catch (e) {
            console.log(e);
          } finally {
            u(!1);
          }
        },
        h = async () => {
          if (!t?.qaId) return;
          u(!0);
          let e = await F({ qaId: t?.qaId }),
            n =
              e?.data?.similarQuestion?.map((e) => ({
                similarQuestion: e?.similarQuestion,
              })) || null;
          (i.setFieldsValue({ ...e?.data, similarQuestion: n }), u(!1));
        };
      return (
        (0, A.useEffect)(() => {
          e && !d && h();
        }, [t?.qaId, e]),
        (0, H.jsxs)(H.Fragment, {
          children: [
            (0, H.jsx)(v, {
              open: e,
              width: `35vw`,
              onOk: f,
              onCancel: n,
              okButtonProps: { loading: l },
              title: `${d ? `新增` : `编辑`}问答`,
              children: (0, H.jsx)(m, {
                spinning: l,
                children: (0, H.jsxs)(b, {
                  form: i,
                  layout: `vertical`,
                  wrapperCol: { span: 24 },
                  onFinish: p,
                  className: X[`form-container`],
                  children: [
                    (0, H.jsx)(b.Item, {
                      name: `questionContent`,
                      rootClassName: X[`label-container`],
                      rules: [
                        { required: !0, message: `请输入问题!` },
                        { max: 100, message: `问题不能超过10个字符!` },
                      ],
                      label: (0, H.jsxs)(`div`, {
                        className: X.label,
                        children: [
                          (0, H.jsx)(`span`, { children: `问题` }),
                          (0, H.jsxs)(`span`, {
                            className: X[`label-text`],
                            onClick: () => {
                              if (!o?.length) return g.info(`请输入问题`);
                              c?.current?.open({
                                problem: o,
                                similarQuestion: s,
                              });
                            },
                            children: [`相似问(`, s?.length || 0, `)`],
                          }),
                        ],
                      }),
                      children: (0, H.jsx)(Q, {
                        placeholder: `请输入问题`,
                        maxLength: 100,
                      }),
                    }),
                    (0, H.jsx)(b.Item, {
                      label: `答案`,
                      name: `answerContent`,
                      rules: [{ required: !0, message: `请输入答案!` }],
                      children: (0, H.jsx)(Q, {
                        rows: 4,
                        placeholder: `请输入答案`,
                        maxLength: 1e3,
                      }),
                    }),
                    (0, H.jsx)(b.Item, {
                      name: `similarQuestion`,
                      rules: [{ required: !0, message: `请输入相似问!` }],
                    }),
                  ],
                }),
              }),
            }),
            (0, H.jsx)(ie, {
              ref: c,
              onSuccess: (e) => {
                i.setFieldsValue({ similarQuestion: e });
              },
            }),
          ],
        })
      );
    },
  }),
  oe = (0, A.memo)(ae),
  $ = { 0: `向量化处理中...`, 1: `向量化处理中...`, 2: `已生效` },
  se = (e, t) => [
    { title: `问题`, dataIndex: `questionContent`, hideInTable: !0 },
    { title: `答案`, dataIndex: `answerContent`, hideInTable: !0 },
    {
      title: `问题`,
      ellipsis: !0,
      dataIndex: `questionContent`,
      hideInSearch: !0,
    },
    {
      title: `答案`,
      ellipsis: !0,
      dataIndex: `answerContent`,
      hideInSearch: !0,
    },
    { title: `状态`, dataIndex: `qaStatus`, hideInSearch: !0, valueEnum: $ },
    {
      title: `操作`,
      dataIndex: `action`,
      valueType: `option`,
      hideInSearch: !0,
      actionButtons: (n) => [
        { key: `edit`, label: `查看/修改`, onClick: () => e?.(n) },
        { key: `delete`, label: `删除`, onClick: () => t?.(n) },
      ],
    },
  ],
  ce = (e, t, n, r) => ({ ...e, ...t, ...n, baseId: r }),
  le = (e) => {
    let t = e?.data || [];
    return { data: t || [], success: e?.code === 0, total: t?.length || 0 };
  };
u();
var ue = () => {
  let e = w(),
    t = E(),
    { baseId: n = ``, baseName: r = ``, checkTabs: i = `` } = e.state || {},
    o = (0, A.useRef)(null),
    s = (0, A.useRef)(null),
    c = (0, A.useRef)(null),
    l = (0, A.useCallback)(() => {
      o.current?.reload();
    }, []),
    u = (0, A.useCallback)(
      (e) => {
        s.current?.open?.({ baseId: n, qaId: e?.qaId });
      },
      [n],
    ),
    d = (0, A.useCallback)(
      (e) => {
        v.confirm({
          title: `确认删除`,
          content: `确定要删除该问答吗？删除后不可恢复。`,
          okText: `确认`,
          cancelText: `取消`,
          onOk: async () => {
            let t = await P({ baseId: n, qaId: e?.qaId });
            if (t?.code !== 0) {
              g.error(t?.msg);
              return;
            }
            (g.success(`删除成功`), l());
          },
        });
      },
      [n, l],
    ),
    f = (0, A.useCallback)(() => {
      s.current?.open?.({ baseId: n });
    }, [n]),
    m = (0, A.useCallback)(() => {
      c.current?.open?.({ baseId: n });
    }, [n]),
    h = (0, A.useCallback)(
      async (e, t, r) =>
        n
          ? le(await j({ ...ce(e, t, r, n), baseId: n }))
          : { data: [], success: !1, total: 0 },
      [n],
    ),
    _ = (0, A.useMemo)(() => se(u, d), [u, d]);
  return (0, H.jsxs)(H.Fragment, {
    children: [
      (0, H.jsx)(k, {
        title: r,
        showBack: !0,
        onBack: () => t(T.AGENT_KNOWLEDGE, { state: { checkTabs: i } }),
        extra: (0, A.useMemo)(
          () => [
            (0, H.jsx)(
              p,
              {
                type: `primary`,
                icon: (0, H.jsx)(a, {}),
                onClick: f,
                children: `新增`,
              },
              `add`,
            ),
            (0, H.jsx)(
              p,
              {
                type: `primary`,
                icon: (0, H.jsx)(a, {}),
                onClick: m,
                children: `批量导入`,
              },
              `import`,
            ),
          ],
          [f, m],
        ),
        rowKey: `qaId`,
        actionRef: o,
        columns: _,
        tableProps: { request: h },
      }),
      (0, H.jsx)(oe, { ref: s, onSuccess: l }),
      (0, H.jsx)(Y, { ref: c, onSuccess: l }),
    ],
  });
};
export { ue as default };
