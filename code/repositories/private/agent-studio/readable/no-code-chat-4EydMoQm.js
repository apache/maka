import {
  o as __toESM,
  t as __commonJSMin,
} from "./rolldown-runtime-CMxvf4Kt.js";
import {
  i as require_react,
  t as require_jsx_runtime,
} from "./vendor-react.CV1S_bb1.js";
import {
  Br as Input,
  Fi as init_tooltip,
  Ht as Upload,
  N as RefIcon$8,
  Or as Space,
  Pi as Tooltip,
  Ut as init_upload,
  Vr as init_input,
  Vt as init_es,
  X as RefIcon$1,
  Xi as init_button,
  Xt as Tour,
  Yi as button_default,
  Zt as init_tour,
  _ as RefIcon$3,
  _r as Image$1,
  ar as init_message,
  b as RefIcon$7,
  br as init_form,
  g as RefIcon$4,
  i as RefIcon$6,
  ir as init_modal,
  kr as init_space,
  l as RefIcon$2,
  or as staticMethods,
  r as RefIcon$5,
  rr as Modal,
  vr as init_image,
  w as RefIcon,
  yr as Form,
} from "./vendor-antd.QfSgOu5e.js";
import { n as init_moment, t as hooks } from "./moment-ROF23LCm.js";
import { u as CreateAgent } from "./src-_hjT3BN9.js";
import { o as homingRequestHeaders } from "./request-Cb6e7tFu.js";
import { a as ProFormList, t as ProForm } from "./ProForm-DbXaWFwb.js";
import { t as WrappedProFormSelect } from "./Select-BVLhUCvL.js";
import { t as ProFormSlider } from "./Slider-3xwDuWkl.js";
import { t as TextArea_default } from "./TextArea-BMhByJVA.js";
import { t as require_prop_types } from "./prop-types-CZe_Cxea.js";
import {
  A as appStore,
  I as chatStreaming,
  J as useLocation,
  R as getUUId,
  Tt as ERoutes,
  V as getHeaderSign,
  Y as useNavigate,
} from "./index.B_LPe2F7.js";
import {
  C as findIsFistQuy,
  M as getDictList,
  W as getMicroAppVersionDetail,
  b as enableMicroAppVersion,
  et as getUserDataBase,
  j as getDefaultcompList,
  mt as updataMicroAppVersion,
  ot as interruptSOP,
  s as aiAutoGenConfig,
  ut as startDebugSOP,
  x as endDebugSOP,
} from "./intelligentEngine-BhRFRjx8.js";
import { t as OptimizePrompt } from "./OptimizePrompt-BBfC54FK.js";
import { t as OnLineButton } from "./onLineButton-Cl6BEDHI.js";
var import_react = __toESM(require_react(), 1);
(init_es(), init_moment());
var plugin_check_default = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAAXNSR0IArs4c6QAABSBJREFUWEfVmX9M1HUYx9/P9477wXE/QGT8kKUVC5CiZmU2LCK1LJP8RVZSRqsVbA2wVm25sdnWrCSWQ51/pOUPnC43mwqG5WYMWzg1RdeiTTeFIyDgOA6P4+77aZ8vHRxwx/e+HJzd8+/3+Tyf1+f5Pp/n8zyfDyEIqahg6t4Oa5rAhDRG4nKBKFuEmAbACAZtECZGVQiDAOwChBaRsd+JCbUiiS2WhKSWigpyy9kiOYXSUutcwSWWAOxZBpoHwCA3RuF3B4FdB6hO1AjVVVVJNyYbHxC4vLw1FU5hI4P44QxABmJyEISt0Il7KytTbvpT8gv8QXFHohvufSD2BBg0Cj0WmjrBBUZn1VAXfrEjoX28sQnAm0palzKGrxmQHtrMoY0m4A8ivLetOqXe19IYYO5ZD4bO3GlYLyCHViHqKV9PjwDzmGVO+gZgS0LzzXSPptOkY0XemB4FLrZuZiR+EvaYlVsfwUVM+LRyR9IWrioB89RFLrE5jNlADnP8dwfTCFk85RE/FPo62j5jwPtKrYRTn4AvTQnJH1NpcVuGAPEwA2WFE8B3LkOMgNw8A0QRqD1u94tBYM0ihAIqf7d9JSPPwTsVDskpaixbbkRWth62Xg+2bP478KHCVK9QWXHbToC9E27vGgwCHlygxwsvmqDREnq63fj+sA3XrvBSI5DQLtpUYm0UmbgonMB6PaHgVQsyMnUSrNvNsH9PD65eccLjCUwikHCOykpaO8EQHy7g+zK0WJFvQkpqlDRln82DY0f7cPH8bXkEQhcHdiouEeVNT9AgAjLm67DmJTNi41TSd8aAQ/t7cPG8U/KyrBAGqay4NQhNWVOTKmi1hGeeN+LxxQZoNMNn1cCAiJM/9KHxlwFFxmccWKcjPL0sBrlLYqBSjZYuP9f348daO1yDyvw1o8A8v6572YL7s3XgIcGF59przU7s2d0thYRSmTFgo0nAcytNePSx6BFYDnfr5hAOftuDdqtsN+T/AJGLYUEA5t6twdr1Zly+5MSZ+n4MyvxGS6wKrxXFSuN8xd4nYuf2LrS3TQ2W25L1cOZ8LfLXmjE7QS3t5MYGB07X9aPfLvr1gMksIH+NGQ8t0I/5PugUceJYHxrOKttk4yeRBS7/KB5zUsd6yto2hJp9vWi7NSTFpFeiowVseMOC9EzdhMX8dMqOupN2eKbuXMmmLHB6pharC8yIn60eA9FuHULdcbsUJlx4NuCp68m8mAmw/Nj96vOugH9FycaTBebGkueoUfT2LMTNGk74XuG7/NQJOy5duI28pTF4eGE0eMz7iqNfxKEDvbh6eXhhoUpQwHySrAd0WLVu9JTyTjzkYujsdCMxMQrC2PVIKucaHNLRqzTfBlpY0MDcwF1zo/D6W3GwWPyQ+Zmho8ONqq2dcDqnkHADECsC5jZ4SZi/2gSzDDTPCkeP2ND0axBFjYI4mVLxc8+9GhS+GQuTKbCnLzQN4EiNTTZnK2DlHejglMvLRxbqsWKVGUbjuF32XxW2fVsXblx3KeKRVeblZSgFPK9tN2yMBa8ZRlMH0PTbAGq+65WdX6nCcAEfYou0KCdaqhl4y8PFZvPgwN4e/PXnNHtXsk67pqUJ5SlvfaEF/KTjZSOvc31PQKWeDKDvIN6ETlebn5NrQM5iA3ZX/4Pu7kkasynSj7T5EXeRwhccUVdV3j9UHkmXgRw64q5bOXREXWh7QyOingy80BH1KDOyCSPp2cs3t0fMw6Iv9P/p6fZfkQlYycIjSCYAAAAASUVORK5CYII=`,
  plugin_logo_default = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/plugin-logo-zkC3hlTt.png`,
  plugin_logo2_default = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/plugin-logo2-CbId6gow.png`,
  plugin_uncheck_default = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAAXNSR0IArs4c6QAAA2pJREFUWEftWVtLVFEU/tYe596MORqJkZoiea3sQhRUnjKolx57CILoKQh6CiKop4IIegqiniIIeugPFDR6ZgqMyEulljJophSFOuVMZ67O3rEnxsZuM+Po4IHZTwfOunz7O+usvfZahCyWqqol88zZYAA1CPCjQtBWCDQAcAAwZ2EiXSQKIAiCj0i8JrBHCQhfCQ/4FEWZz2SLMgmo6kAtZ/wsOI4IYBMAeyadHN9rBLwHw2PG2S1FaZ/4n/4/AXu9gxsTInqKC7ogQZrNRtisFrhcDjgddlgtJphMRhgMLCd8iQRHLBZHOBJDIKjB7w8iFI4gGo1LOxojcd1A5nsHDrRN/c3wXwGr6nBlgiL3AexnRKZyVylqNq6HzWaG0ViSE8BMwvH4PEKhKD5MfcGsfw5ciBiApwZhOakoLZ9/1/8DsNvz8jCB3QSocY3disbN1XA6bJn8Lsv7QDCEkdFJfNfCAMSIAD/X2bHrSbrxRYAls5wiqhBorCgvRX1dFSToQi4Jdmz8E2Zm50CEESYsSjrTC4BlzMZF7C6BOstdTmxprQNRxn9yRfYihMCboXHM+gMQEG4jmU6nYnoBUben9zIHXXLYbabmppqCM/v7ziXTb999QFALxRjE1YMdO69ImSRgmboS4EOMkX1H++aCxWymzyNjum9gFJwLzQDWKlMeyUOBM+c1wXF+XcXaZCispiVDY3rmG4jhBuOBi/TE29fEOB6azMbWtuY6lJYu97mQ3/bn5jQMvh1HLBof4gzHqdvbf4xz8aBsrcPe1rJp2fNsfnABmacHh9/j67egxhidoC5v723B6Ux93QbUVq/P1/6K6E9MfsHY+EcQE3fI7enrgcCe9q0NcJXJWmb1Lf/XIAZe+2SKeE5utW8aQMXe3S2wWnMtvAqzuXA4ip4Xw9LZjAQckSVix75tORcyhYELyILJ8+yVdBeVgIV8OtSxvVD+l+Sny9Of1CsCXhJ9WSgVGc6CpLxEigznRV8WykWGsyApL5Eiw3nRl4WyrhnWXfGjs/JSbwX8rytSFWqrK7MI/8KLTEx+TnaDklck3V1CdXfN110jRUakrlpVqV9IV81ACVp37dafoaGjhnYqNHQ1MkiB1tVQJgX632MvZ7LhvTxjrxD8/kD+Y6/0w1c3g8XFoFfP6PYHLvN3AfF0xUIAAAAASUVORK5CYII=`,
  import_jsx_runtime = require_jsx_runtime(),
  AiPlugin = ({
    plugins: e,
    setPluginCheck: t,
    pluginCheck: n,
    updateTest: r,
    disabled: i,
  }) =>
    (0, import_jsx_runtime.jsx)(`div`, {
      className: `agent-config-plugin`,
      children: e.map((e, a) => {
        let { paramName: o, paramCode: s, paramDesc: c } = e,
          l = typeof n == `object` ? n.indexOf(s) : -1;
        return (0, import_jsx_runtime.jsxs)(
          `div`,
          {
            className: `config-plugin-box`,
            style: {
              cursor: i ? `not-allowed` : `pointer`,
              background: i
                ? `rgba(0, 0, 0, 0.04)`
                : a % 2 == 0
                  ? `linear-gradient(-90deg, #E0F0FF 0%, #d4f4ff8c 100%)`
                  : `linear-gradient(270deg, #FFF5DD 0%, #FFEAEA 98%)`,
            },
            children: [
              (0, import_jsx_runtime.jsx)(`img`, {
                src: a ? plugin_logo2_default : plugin_logo_default,
                className: `config-plugin-logo`,
              }),
              (0, import_jsx_runtime.jsxs)(`div`, {
                className: `config-plugin-content`,
                children: [
                  (0, import_jsx_runtime.jsx)(`div`, {
                    className: `config-plugin-name`,
                    children: o,
                  }),
                  (0, import_jsx_runtime.jsx)(`div`, {
                    className: `config-plugin-desc`,
                    children: c || `--`,
                  }),
                ],
              }),
              (0, import_jsx_runtime.jsx)(`img`, {
                src: l > -1 ? plugin_check_default : plugin_uncheck_default,
                className: `config-plugin-check ${i ? `config-plugin-check-disabled` : ``}`,
                onClick: () => {
                  i ||
                    (l > -1
                      ? (n.splice(l, 1), t([...(n || [])]))
                      : t([...(n || []), s]),
                    r());
                },
              }),
            ],
          },
          s,
        );
      }),
    }),
  createConfig_default = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/createConfig-BoW4U_4s.png`,
  ApiBase = (0, import_react.forwardRef)(
    ({ initData: e, updateTest: t, status: n }, r) => {
      let [i, a] = (0, import_react.useState)(1),
        [o, s] = (0, import_react.useState)([]),
        [c, l] = (0, import_react.useState)(!1),
        [u, d] = (0, import_react.useState)(!1),
        [f, p] = (0, import_react.useState)(``),
        [m, g] = (0, import_react.useState)([]),
        [_, y] = (0, import_react.useState)([]),
        [b, x] = (0, import_react.useState)([]),
        [S, C] = (0, import_react.useState)([]),
        [T, E] = (0, import_react.useState)([]),
        D = (0, import_react.useRef)();
      ((0, import_react.useEffect)(() => {
        j();
      }, []),
        (0, import_react.useEffect)(() => {
          r?.current?.setFieldValue(`plugs`, _);
        }, [_]),
        (0, import_react.useEffect)(() => {
          e && O(e);
        }, [e]));
      let O = async (e) => {
          if (e.data) {
            let t = await M(),
              n = [];
            t.forEach((e) => {
              e.children && n.push(...e.children);
            });
            let i = n
                .filter(
                  (e, t, n) => t === n.findIndex((t) => t.baseId === e.baseId),
                )
                ?.filter((e) => e.baseType !== 2)
                ?.filter((e) => e.platformType !== 1 && e.platformType !== 2),
              o = JSON.parse(e.data),
              s = o.defaultAnswerList,
              c = i.find((e) => JSON.stringify(e) === o.knowledgeBase)
                ? o.knowledgeBase
                : null;
            (r?.current?.setFieldsValue({ ...o, knowledgeBase: c }),
              x(i),
              y(o.plugs),
              a(s?.length || 1));
          }
          N();
        },
        k = (e) => {
          if (r.current.getFieldValue(`defaultAnswerList`).length < 2) {
            staticMethods.warning(`引导示例最少要有一条!`);
            return;
          }
          (a(i - 1), D.current?.remove(e), t());
        },
        A = () => {
          i === 6 || n === 1 || n === 2 || (a(i + 1), D.current?.add(), t());
        },
        j = async () => {
          let { errCode: e, data: t } = await getDictList({
            type: `zeroCodePlugin`,
          });
          e === 0 && t && s(t);
        },
        M = async () => {
          let { code: e, data: t } = await getUserDataBase();
          return e === 0 && t ? t : [];
        },
        N = async () => {
          let { errCode: e, data: n } = await getDefaultcompList({
            type: `default_bigModel`,
          });
          e === 0 &&
            n &&
            n.length &&
            (E(n),
            r?.current?.getFieldValue(`compSysCode`)
              ? t({ time: 0, removeSaveFlag: !0 })
              : (r?.current?.setFieldValue(`compSysCode`, n[0].compCode),
                t({ time: 0 })));
        },
        P = () => {
          (l(!0),
            aiAutoGenConfig({ description: f }).then((e) => {
              if ((l(!1), e.errCode === 0 && e.data)) {
                let { defaultAnswerList: t } = e.data;
                (t &&
                  (e.data.defaultAnswerList = t.map((e) => ({
                    defaultAnswer: e,
                  }))),
                  (e.data.des = f),
                  g([...m, e.data]),
                  r.current?.setFieldsValue(e.data),
                  d(!1));
              } else staticMethods.warning(`生成失败，请输入正确的语术!`);
            }));
        };
      return (0, import_jsx_runtime.jsxs)(`div`, {
        className: `create-agent-config`,
        children: [
          (0, import_jsx_runtime.jsxs)(`div`, {
            className: `create-agent--config-content`,
            children: [
              (0, import_jsx_runtime.jsxs)(`div`, {
                className: `create-agent--config-title`,
                children: [
                  (0, import_jsx_runtime.jsx)(`label`, { children: `配置` }),
                  (0, import_jsx_runtime.jsx)(Tooltip, {
                    title: `AI自动生成配置最多只能3次`,
                    children: (0, import_jsx_runtime.jsx)(`img`, {
                      onClick: () => {
                        if (m.length > 2) {
                          let e = r.current?.getFieldsValue(),
                            t = m.findIndex((t) => t.prologue === e.prologue);
                          (console.log(t),
                            (t = t + 1 > 2 ? 0 : t + 1),
                            console.log(t),
                            r.current?.setFieldsValue(m[t]));
                        } else d(!0);
                      },
                      src: createConfig_default,
                    }),
                  }),
                ],
              }),
              (0, import_jsx_runtime.jsxs)(ProForm, {
                formRef: r,
                submitter: !1,
                disabled: n === 1 || n === 2,
                className: `status-form-container`,
                initialValues: { questionType: 1 },
                children: [
                  (0, import_jsx_runtime.jsx)(
                    TextArea_default,
                    {
                      name: `prologue`,
                      label: `开场白`,
                      placeholder: `请填写开场白`,
                      fieldProps: {
                        showCount: !0,
                        autoSize: { minRows: 3, maxRows: 3 },
                        maxLength: 200,
                        resize: `none`,
                      },
                      onChange: t,
                    },
                    `prologue`,
                  ),
                  (0, import_jsx_runtime.jsx)(`div`, {
                    style: {
                      right: `0`,
                      textAlign: `right`,
                      zIndex: 10,
                      position: `relative`,
                      bottom: `-28px`,
                      pointerEvents: `none`,
                    },
                    children: (0, import_jsx_runtime.jsx)(OptimizePrompt, {
                      parentForm: r,
                      promptName: `prompt`,
                      aiPromptList: S,
                      setAiPromptList: C,
                      noSource: !0,
                      setPromptValue: (e) => {
                        r.current?.setFieldValue(`prompt`, e);
                      },
                      maxLength: 1e3,
                    }),
                  }),
                  (0, import_jsx_runtime.jsx)(
                    TextArea_default,
                    {
                      name: `prompt`,
                      label: `指令`,
                      tooltip: `指令（prompt）直接决定你所创造的AI智能体的效果，最简单的公式是：你想让AI智能体扮演的角色+希望ta生成什么样的结果+对智能体所生成的内容的详细要求`,
                      placeholder: `作为一名幼儿园的分析助理，你具备丰富的想象力，能够依据学生的作品生成一段幽默风趣的故事；要求：想象力丰富，限制在1000字内；`,
                      fieldProps: {
                        showCount: !0,
                        rows: 7,
                        maxLength: 1e3,
                        className: `dom-guidance-instruct`,
                      },
                      onChange: () => {
                        t({ time: 0 });
                      },
                    },
                    `prompt`,
                  ),
                  (0, import_jsx_runtime.jsx)(ProFormList, {
                    label: `引导示例`,
                    name: `defaultAnswerList`,
                    className: `form-list-bottom-answer`,
                    initialValue: [{}],
                    creatorButtonProps: !1,
                    copyIconProps: !1,
                    deleteIconProps: !1,
                    creatorRecord: { useMode: `none` },
                    actionRef: D,
                    children: (e, n) =>
                      (0, import_jsx_runtime.jsxs)(`div`, {
                        className: `form-text-box`,
                        children: [
                          (0, import_jsx_runtime.jsx)(
                            TextArea_default,
                            {
                              name: `defaultAnswer`,
                              label: ``,
                              placeholder: `请填写引导示例`,
                              fieldProps: {
                                showCount: !0,
                                autoSize: { minRows: 3, maxRows: 3 },
                                maxLength: 64,
                                resize: `none`,
                              },
                              onChange: t,
                            },
                            `defaultAnswer`,
                          ),
                          (0, import_jsx_runtime.jsx)(`svg`, {
                            className: `icon svg-icon form-text-icon`,
                            style: { display: i === 1 ? `none` : `` },
                            "aria-hidden": `true`,
                            onClick: () => {
                              k(n);
                            },
                            children: (0, import_jsx_runtime.jsx)(`use`, {
                              xlinkHref: `#icon-remove-copy`,
                            }),
                          }),
                        ],
                      }),
                  }),
                  (0, import_jsx_runtime.jsxs)(`div`, {
                    className: `intention-keyword-btn ${i === 6 || n === 1 || n === 2 ? `intention-keyword-btn-disabled` : ``}`,
                    onClick: () => {
                      A();
                    },
                    children: [
                      (0, import_jsx_runtime.jsx)(RefIcon, {}),
                      (0, import_jsx_runtime.jsx)(`span`, {
                        className: `intention-keyword-btn-title`,
                        children: `添加示例`,
                      }),
                    ],
                  }),
                  (0, import_jsx_runtime.jsx)(WrappedProFormSelect, {
                    name: `compSysCode`,
                    label: `大模型`,
                    params: T,
                    request: async () =>
                      T.map((e) => ({ label: e.compName, value: e.compCode })),
                    fieldProps: { allowClear: !1 },
                    rules: [{ required: !0, message: `请选择大模型` }],
                    placeholder: `请选择大模型`,
                    onChange: t,
                  }),
                  (0, import_jsx_runtime.jsx)(WrappedProFormSelect, {
                    name: `knowledgeBase`,
                    label: `知识库`,
                    options: b.map((e) => ({
                      label: e.baseName,
                      value: JSON.stringify(e),
                    })),
                    fieldProps: { allowClear: !0 },
                    placeholder: `请选择知识库`,
                    onChange: t,
                  }),
                  (0, import_jsx_runtime.jsx)(WrappedProFormSelect, {
                    label: `追问`,
                    name: `questionType`,
                    options: [
                      { label: `默认`, value: 1 },
                      { label: `自定义`, value: 2 },
                      { label: `关闭`, value: 3 },
                    ],
                    tooltip: `大模型根据对话内容自动生成的追加问题`,
                    allowClear: !1,
                  }),
                  (0, import_jsx_runtime.jsx)(ProForm.Item, {
                    noStyle: !0,
                    shouldUpdate: !0,
                    children: ({ getFieldValue: e }) =>
                      e(`questionType`) === 2
                        ? (0, import_jsx_runtime.jsxs)(
                            import_jsx_runtime.Fragment,
                            {
                              children: [
                                (0, import_jsx_runtime.jsx)(ProFormSlider, {
                                  label: `参考对话轮数`,
                                  name: `round`,
                                  max: 5,
                                  tooltip: `大模型在追问生成过程中可参考1、3、5轮的对话轮数`,
                                }),
                                (0, import_jsx_runtime.jsx)(TextArea_default, {
                                  label: `追问prompt`,
                                  tooltip: `追问prompt可以控制追问的数量、字数、风格和内容范围`,
                                  help: `追问prompt可以控制追问的数量、字数、风格和内容范围`,
                                  name: `problemPrompt`,
                                  placeholder: `1.每次生成3个20字以内的问题
2.生成问题的对话风格，与用户对话历史要一致，贴合用户对话场景
3.不要生成相同或过于相似的问题。`,
                                  fieldProps: { rows: 5 },
                                }),
                              ],
                            },
                          )
                        : null,
                  }),
                  (0, import_jsx_runtime.jsx)(Form.Item, {
                    name: `plugs`,
                    label: `插件`,
                    children: (0, import_jsx_runtime.jsx)(AiPlugin, {
                      plugins: o,
                      setPluginCheck: y,
                      pluginCheck: _,
                      updateTest: t,
                      disabled: n === 1 || n === 2,
                    }),
                  }),
                ],
              }),
            ],
          }),
          (0, import_jsx_runtime.jsx)(Modal, {
            open: u,
            title: `AI自动生成配置`,
            okText: `使用`,
            width: 770,
            confirmLoading: c,
            onCancel: () => d(!1),
            okButtonProps: { disabled: m?.length && f === m[m.length - 1].des },
            onOk: () => {
              if (!f) {
                staticMethods.warning(`请输入话术描述`);
                return;
              }
              P();
            },
            children: (0, import_jsx_runtime.jsx)(`div`, {
              className: `ai-create-agent--config-des`,
              children: (0, import_jsx_runtime.jsx)(Input.TextArea, {
                style: { maxWidth: `100%` },
                rows: 15,
                showCount: !0,
                maxLength: 500,
                onChange: (e) => p(e.target?.value || ``),
                placeholder: `请用简短的话术描述您想生成的智能体`,
              }),
            }),
          }),
        ],
      });
    },
  ),
  logo_default = `data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20width='26px'%20height='29px'%20viewBox='0%200%2026%2029'%20version='1.1'%20xmlns='http://www.w3.org/2000/svg'%20xmlns:xlink='http://www.w3.org/1999/xlink'%3e%3ctitle%3e编组%3c/title%3e%3cg%20id='1.3'%20stroke='none'%20stroke-width='1'%20fill='none'%20fill-rule='evenodd'%3e%3cg%20id='文档中心'%20transform='translate(-26,%20-15)'%20fill='%23716AE5'%3e%3cg%20id='编组'%20transform='translate(26,%2015)'%3e%3cpath%20d='M25.400553,21.2985264%20C24.7108777,20.7420083%2023.7037125,20.8536181%2023.1507559,21.5478458%20C21.0100697,24.2360653%2017.8220069,25.7777778%2014.404079,25.7777778%20C11.4115916,25.7777778%208.59823488,24.6046875%206.48223566,22.4745972%20C4.36623645,20.3445069%203.20090644,17.5124153%203.20090644,14.5%20C3.20090644,11.4875847%204.36623645,8.65549306%206.48223566,6.52540278%20C8.59827489,4.3953125%2011.4115916,3.22222222%2014.404079,3.22222222%20C15.8576106,3.22222222%2017.2710109,3.49784306%2018.6049486,4.04139167%20C18.8017243,4.121625%2019.0049419,4.15956667%2019.2049185,4.15956667%20C19.8376577,4.15948611%2020.4369874,3.77926389%2020.6889788,3.15254167%20C21.0206327,2.32777361%2020.6253208,1.38849583%2019.8060087,1.05463333%20C18.0886824,0.354847222%2016.2712077,0%2014.404079,0%20C12.4602485,0%2010.5737143,0.383605556%208.79685113,1.14014306%20C7.08144535,1.87054028%205.54116917,2.91582917%204.21883471,4.24692917%20C2.89654025,5.57810972%201.85812619,7.12860278%201.13260073,8.85547222%20C0.381027901,10.6441278%200,12.543225%200,14.5%20C0,16.456775%200.381027901,18.3558722%201.13260073,20.1445681%20C1.85812619,21.8713972%202.89654025,23.4219306%204.21883471,24.7530708%20C5.54116917,26.0841708%207.08144535,27.1295%208.79685113,27.8598569%20C10.5737143,28.6164347%2012.4602485,29%2014.404079,29%20C18.7984434,29%2022.896804,27.0184139%2025.6482232,23.5633056%20C26.2010997,22.8690375%2026.0901883,21.8550847%2025.400553,21.2985264'%20id='Fill-1'%3e%3c/path%3e%3cpath%20d='M10.1628179,11.2777778%20C9.41148518,11.2777778%208.80243271,11.8908861%208.80243271,12.6472222%20L8.80243271,14.7416667%20C8.80243271,15.4980028%209.41148518,16.1111111%2010.1628179,16.1111111%20L10.3228633,16.1111111%20C11.074196,16.1111111%2011.6832485,15.4980028%2011.6832485,14.7416667%20L11.6832485,12.6472222%20C11.6832485,11.8908861%2011.074196,11.2777778%2010.3228633,11.2777778%20L10.1628179,11.2777778%20Z'%20id='Fill-3'%3e%3c/path%3e%3cpath%20d='M16.5646308,11.2777778%20C15.8132981,11.2777778%2015.2042456,11.8908861%2015.2042456,12.6472222%20L15.2042456,14.7416667%20C15.2042456,15.4980028%2015.8132981,16.1111111%2016.5646308,16.1111111%20L16.7246762,16.1111111%20C17.4760089,16.1111111%2018.0850614,15.4980028%2018.0850614,14.7416667%20L18.0850614,12.6472222%20C18.0850614,11.8908861%2017.4760089,11.2777778%2016.7246762,11.2777778%20L16.5646308,11.2777778%20Z'%20id='Fill-5'%3e%3c/path%3e%3cpath%20d='M23.4608837,6.99397833%20C24.3448141,6.99397833%2025.061337,6.27264361%2025.061337,5.38286722%20C25.061337,4.49309083%2024.3448141,3.77175611%2023.4608837,3.77175611%20C22.5769934,3.77175611%2021.8604305,4.49309083%2021.8604305,5.38286722%20C21.8604305,6.27264361%2022.5769934,6.99397833%2023.4608837,6.99397833'%20id='Fill-7'%3e%3c/path%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/svg%3e`,
  require__global = __commonJSMin((e, t) => {
    var n = (t.exports =
      typeof window < `u` && window.Math == Math
        ? window
        : typeof self < `u` && self.Math == Math
          ? self
          : Function(`return this`)());
    typeof __g == `number` && (__g = n);
  }),
  require__core = __commonJSMin((e, t) => {
    var n = (t.exports = { version: `2.6.12` });
    typeof __e == `number` && (__e = n);
  }),
  require__a_function = __commonJSMin((e, t) => {
    t.exports = function (e) {
      if (typeof e != `function`) throw TypeError(e + ` is not a function!`);
      return e;
    };
  }),
  require__ctx = __commonJSMin((e, t) => {
    var n = require__a_function();
    t.exports = function (e, t, r) {
      if ((n(e), t === void 0)) return e;
      switch (r) {
        case 1:
          return function (n) {
            return e.call(t, n);
          };
        case 2:
          return function (n, r) {
            return e.call(t, n, r);
          };
        case 3:
          return function (n, r, i) {
            return e.call(t, n, r, i);
          };
      }
      return function () {
        return e.apply(t, arguments);
      };
    };
  }),
  require__is_object = __commonJSMin((e, t) => {
    t.exports = function (e) {
      return typeof e == `object` ? e !== null : typeof e == `function`;
    };
  }),
  require__an_object = __commonJSMin((e, t) => {
    var n = require__is_object();
    t.exports = function (e) {
      if (!n(e)) throw TypeError(e + ` is not an object!`);
      return e;
    };
  }),
  require__fails = __commonJSMin((e, t) => {
    t.exports = function (e) {
      try {
        return !!e();
      } catch {
        return !0;
      }
    };
  }),
  require__descriptors = __commonJSMin((e, t) => {
    t.exports = !require__fails()(function () {
      return (
        Object.defineProperty({}, "a", {
          get: function () {
            return 7;
          },
        }).a != 7
      );
    });
  }),
  require__dom_create = __commonJSMin((e, t) => {
    var n = require__is_object(),
      r = require__global().document,
      i = n(r) && n(r.createElement);
    t.exports = function (e) {
      return i ? r.createElement(e) : {};
    };
  }),
  require__ie8_dom_define = __commonJSMin((e, t) => {
    t.exports =
      !require__descriptors() &&
      !require__fails()(function () {
        return (
          Object.defineProperty(require__dom_create()(`div`), "a", {
            get: function () {
              return 7;
            },
          }).a != 7
        );
      });
  }),
  require__to_primitive = __commonJSMin((e, t) => {
    var n = require__is_object();
    t.exports = function (e, t) {
      if (!n(e)) return e;
      var r, i;
      if (
        (t && typeof (r = e.toString) == `function` && !n((i = r.call(e)))) ||
        (typeof (r = e.valueOf) == `function` && !n((i = r.call(e)))) ||
        (!t && typeof (r = e.toString) == `function` && !n((i = r.call(e))))
      )
        return i;
      throw TypeError(`Can't convert object to primitive value`);
    };
  }),
  require__object_dp = __commonJSMin((e) => {
    var t = require__an_object(),
      n = require__ie8_dom_define(),
      r = require__to_primitive(),
      i = Object.defineProperty;
    e.f = require__descriptors()
      ? Object.defineProperty
      : function (e, a, o) {
          if ((t(e), (a = r(a, !0)), t(o), n))
            try {
              return i(e, a, o);
            } catch {}
          if (`get` in o || `set` in o)
            throw TypeError(`Accessors not supported!`);
          return (`value` in o && (e[a] = o.value), e);
        };
  }),
  require__property_desc = __commonJSMin((e, t) => {
    t.exports = function (e, t) {
      return {
        enumerable: !(e & 1),
        configurable: !(e & 2),
        writable: !(e & 4),
        value: t,
      };
    };
  }),
  require__hide = __commonJSMin((e, t) => {
    var n = require__object_dp(),
      r = require__property_desc();
    t.exports = require__descriptors()
      ? function (e, t, i) {
          return n.f(e, t, r(1, i));
        }
      : function (e, t, n) {
          return ((e[t] = n), e);
        };
  }),
  require__has = __commonJSMin((e, t) => {
    var n = {}.hasOwnProperty;
    t.exports = function (e, t) {
      return n.call(e, t);
    };
  }),
  require__export = __commonJSMin((e, t) => {
    var n = require__global(),
      r = require__core(),
      i = require__ctx(),
      a = require__hide(),
      o = require__has(),
      s = `prototype`,
      c = function (e, t, l) {
        var u = e & c.F,
          d = e & c.G,
          f = e & c.S,
          p = e & c.P,
          m = e & c.B,
          g = e & c.W,
          _ = d ? r : r[t] || (r[t] = {}),
          y = _[s],
          b = d ? n : f ? n[t] : (n[t] || {})[s],
          x,
          S,
          C;
        for (x in (d && (l = t), l))
          ((S = !u && b && b[x] !== void 0),
            !(S && o(_, x)) &&
              ((C = S ? b[x] : l[x]),
              (_[x] =
                d && typeof b[x] != `function`
                  ? l[x]
                  : m && S
                    ? i(C, n)
                    : g && b[x] == C
                      ? (function (e) {
                          var t = function (t, n, r) {
                            if (this instanceof e) {
                              switch (arguments.length) {
                                case 0:
                                  return new e();
                                case 1:
                                  return new e(t);
                                case 2:
                                  return new e(t, n);
                              }
                              return new e(t, n, r);
                            }
                            return e.apply(this, arguments);
                          };
                          return ((t[s] = e[s]), t);
                        })(C)
                      : p && typeof C == `function`
                        ? i(Function.call, C)
                        : C),
              p &&
                (((_.virtual ||= {})[x] = C),
                e & c.R && y && !y[x] && a(y, x, C))));
      };
    ((c.F = 1),
      (c.G = 2),
      (c.S = 4),
      (c.P = 8),
      (c.B = 16),
      (c.W = 32),
      (c.U = 64),
      (c.R = 128),
      (t.exports = c));
  }),
  require__cof = __commonJSMin((e, t) => {
    var n = {}.toString;
    t.exports = function (e) {
      return n.call(e).slice(8, -1);
    };
  }),
  require__iobject = __commonJSMin((e, t) => {
    var n = require__cof();
    t.exports = Object(`z`).propertyIsEnumerable(0)
      ? Object
      : function (e) {
          return n(e) == `String` ? e.split(``) : Object(e);
        };
  }),
  require__defined = __commonJSMin((e, t) => {
    t.exports = function (e) {
      if (e == null) throw TypeError(`Can't call method on  ` + e);
      return e;
    };
  }),
  require__to_iobject = __commonJSMin((e, t) => {
    var n = require__iobject(),
      r = require__defined();
    t.exports = function (e) {
      return n(r(e));
    };
  }),
  require__to_integer = __commonJSMin((e, t) => {
    var n = Math.ceil,
      r = Math.floor;
    t.exports = function (e) {
      return isNaN((e = +e)) ? 0 : (e > 0 ? r : n)(e);
    };
  }),
  require__to_length = __commonJSMin((e, t) => {
    var n = require__to_integer(),
      r = Math.min;
    t.exports = function (e) {
      return e > 0 ? r(n(e), 9007199254740991) : 0;
    };
  }),
  require__to_absolute_index = __commonJSMin((e, t) => {
    var n = require__to_integer(),
      r = Math.max,
      i = Math.min;
    t.exports = function (e, t) {
      return ((e = n(e)), e < 0 ? r(e + t, 0) : i(e, t));
    };
  }),
  require__array_includes = __commonJSMin((e, t) => {
    var n = require__to_iobject(),
      r = require__to_length(),
      i = require__to_absolute_index();
    t.exports = function (e) {
      return function (t, a, o) {
        var s = n(t),
          c = r(s.length),
          l = i(o, c),
          u;
        if (e && a != a) {
          for (; c > l;) if (((u = s[l++]), u != u)) return !0;
        } else
          for (; c > l; l++)
            if ((e || l in s) && s[l] === a) return e || l || 0;
        return !e && -1;
      };
    };
  }),
  require__library = __commonJSMin((e, t) => {
    t.exports = !0;
  }),
  require__shared = __commonJSMin((e, t) => {
    var n = require__core(),
      r = require__global(),
      i = `__core-js_shared__`,
      a = r[i] || (r[i] = {});
    (t.exports = function (e, t) {
      return a[e] || (a[e] = t === void 0 ? {} : t);
    })(`versions`, []).push({
      version: n.version,
      mode: require__library() ? `pure` : `global`,
      copyright: `© 2020 Denis Pushkarev (zloirock.ru)`,
    });
  }),
  require__uid = __commonJSMin((e, t) => {
    var n = 0,
      r = Math.random();
    t.exports = function (e) {
      return `Symbol(${e === void 0 ? `` : e})_${(++n + r).toString(36)}`;
    };
  }),
  require__shared_key = __commonJSMin((e, t) => {
    var n = require__shared()(`keys`),
      r = require__uid();
    t.exports = function (e) {
      return n[e] || (n[e] = r(e));
    };
  }),
  require__object_keys_internal = __commonJSMin((e, t) => {
    var n = require__has(),
      r = require__to_iobject(),
      i = require__array_includes()(!1),
      a = require__shared_key()(`IE_PROTO`);
    t.exports = function (e, t) {
      var o = r(e),
        s = 0,
        c = [],
        l;
      for (l in o) l != a && n(o, l) && c.push(l);
      for (; t.length > s;) n(o, (l = t[s++])) && (~i(c, l) || c.push(l));
      return c;
    };
  }),
  require__enum_bug_keys = __commonJSMin((e, t) => {
    t.exports =
      `constructor,hasOwnProperty,isPrototypeOf,propertyIsEnumerable,toLocaleString,toString,valueOf`.split(
        `,`,
      );
  }),
  require__object_keys = __commonJSMin((e, t) => {
    var n = require__object_keys_internal(),
      r = require__enum_bug_keys();
    t.exports =
      Object.keys ||
      function (e) {
        return n(e, r);
      };
  }),
  require__object_gops = __commonJSMin((e) => {
    e.f = Object.getOwnPropertySymbols;
  }),
  require__object_pie = __commonJSMin((e) => {
    e.f = {}.propertyIsEnumerable;
  }),
  require__to_object = __commonJSMin((e, t) => {
    var n = require__defined();
    t.exports = function (e) {
      return Object(n(e));
    };
  }),
  require__object_assign = __commonJSMin((e, t) => {
    var n = require__descriptors(),
      r = require__object_keys(),
      i = require__object_gops(),
      a = require__object_pie(),
      o = require__to_object(),
      s = require__iobject(),
      c = Object.assign;
    t.exports =
      !c ||
      require__fails()(function () {
        var e = {},
          t = {},
          n = Symbol(),
          r = `abcdefghijklmnopqrst`;
        return (
          (e[n] = 7),
          r.split(``).forEach(function (e) {
            t[e] = e;
          }),
          c({}, e)[n] != 7 || Object.keys(c({}, t)).join(``) != r
        );
      })
        ? function (e, t) {
            for (
              var c = o(e), l = arguments.length, u = 1, d = i.f, f = a.f;
              l > u;
            )
              for (
                var p = s(arguments[u++]),
                  m = d ? r(p).concat(d(p)) : r(p),
                  g = m.length,
                  _ = 0,
                  y;
                g > _;
              )
                ((y = m[_++]), (!n || f.call(p, y)) && (c[y] = p[y]));
            return c;
          }
        : c;
  }),
  require_es6_object_assign = __commonJSMin(() => {
    var e = require__export();
    e(e.S + e.F, `Object`, { assign: require__object_assign() });
  }),
  require_assign$1 = __commonJSMin((e, t) => {
    (require_es6_object_assign(), (t.exports = require__core().Object.assign));
  }),
  require_assign = __commonJSMin((e, t) => {
    t.exports = { default: require_assign$1(), __esModule: !0 };
  }),
  require_extends = __commonJSMin((e) => {
    e.__esModule = !0;
    var t = n(require_assign());
    function n(e) {
      return e && e.__esModule ? e : { default: e };
    }
    e.default =
      t.default ||
      function (e) {
        for (var t = 1; t < arguments.length; t++) {
          var n = arguments[t];
          for (var r in n)
            Object.prototype.hasOwnProperty.call(n, r) && (e[r] = n[r]);
        }
        return e;
      };
  }),
  require__object_gpo = __commonJSMin((e, t) => {
    var n = require__has(),
      r = require__to_object(),
      i = require__shared_key()(`IE_PROTO`),
      a = Object.prototype;
    t.exports =
      Object.getPrototypeOf ||
      function (e) {
        return (
          (e = r(e)),
          n(e, i)
            ? e[i]
            : typeof e.constructor == `function` && e instanceof e.constructor
              ? e.constructor.prototype
              : e instanceof Object
                ? a
                : null
        );
      };
  }),
  require__object_sap = __commonJSMin((e, t) => {
    var n = require__export(),
      r = require__core(),
      i = require__fails();
    t.exports = function (e, t) {
      var a = (r.Object || {})[e] || Object[e],
        o = {};
      ((o[e] = t(a)),
        n(
          n.S +
            n.F *
              i(function () {
                a(1);
              }),
          `Object`,
          o,
        ));
    };
  }),
  require_es6_object_get_prototype_of = __commonJSMin(() => {
    var e = require__to_object(),
      t = require__object_gpo();
    require__object_sap()(`getPrototypeOf`, function () {
      return function (n) {
        return t(e(n));
      };
    });
  }),
  require_get_prototype_of$1 = __commonJSMin((e, t) => {
    (require_es6_object_get_prototype_of(),
      (t.exports = require__core().Object.getPrototypeOf));
  }),
  require_get_prototype_of = __commonJSMin((e, t) => {
    t.exports = { default: require_get_prototype_of$1(), __esModule: !0 };
  }),
  require_classCallCheck = __commonJSMin((e) => {
    ((e.__esModule = !0),
      (e.default = function (e, t) {
        if (!(e instanceof t))
          throw TypeError(`Cannot call a class as a function`);
      }));
  }),
  require_es6_object_define_property = __commonJSMin(() => {
    var e = require__export();
    e(e.S + e.F * !require__descriptors(), `Object`, {
      defineProperty: require__object_dp().f,
    });
  }),
  require_define_property$1 = __commonJSMin((e, t) => {
    require_es6_object_define_property();
    var n = require__core().Object;
    t.exports = function (e, t, r) {
      return n.defineProperty(e, t, r);
    };
  }),
  require_define_property = __commonJSMin((e, t) => {
    t.exports = { default: require_define_property$1(), __esModule: !0 };
  }),
  require_createClass = __commonJSMin((e) => {
    e.__esModule = !0;
    var t = n(require_define_property());
    function n(e) {
      return e && e.__esModule ? e : { default: e };
    }
    e.default = (function () {
      function e(e, n) {
        for (var r = 0; r < n.length; r++) {
          var i = n[r];
          ((i.enumerable = i.enumerable || !1),
            (i.configurable = !0),
            `value` in i && (i.writable = !0),
            (0, t.default)(e, i.key, i));
        }
      }
      return function (t, n, r) {
        return (n && e(t.prototype, n), r && e(t, r), t);
      };
    })();
  }),
  require__string_at = __commonJSMin((e, t) => {
    var n = require__to_integer(),
      r = require__defined();
    t.exports = function (e) {
      return function (t, i) {
        var a = String(r(t)),
          o = n(i),
          s = a.length,
          c,
          l;
        return o < 0 || o >= s
          ? e
            ? ``
            : void 0
          : ((c = a.charCodeAt(o)),
            c < 55296 ||
            c > 56319 ||
            o + 1 === s ||
            (l = a.charCodeAt(o + 1)) < 56320 ||
            l > 57343
              ? e
                ? a.charAt(o)
                : c
              : e
                ? a.slice(o, o + 2)
                : ((c - 55296) << 10) + (l - 56320) + 65536);
      };
    };
  }),
  require__redefine = __commonJSMin((e, t) => {
    t.exports = require__hide();
  }),
  require__iterators = __commonJSMin((e, t) => {
    t.exports = {};
  }),
  require__object_dps = __commonJSMin((e, t) => {
    var n = require__object_dp(),
      r = require__an_object(),
      i = require__object_keys();
    t.exports = require__descriptors()
      ? Object.defineProperties
      : function (e, t) {
          r(e);
          for (var a = i(t), o = a.length, s = 0, c; o > s;)
            n.f(e, (c = a[s++]), t[c]);
          return e;
        };
  }),
  require__html = __commonJSMin((e, t) => {
    var n = require__global().document;
    t.exports = n && n.documentElement;
  }),
  require__object_create = __commonJSMin((e, t) => {
    var n = require__an_object(),
      r = require__object_dps(),
      i = require__enum_bug_keys(),
      a = require__shared_key()(`IE_PROTO`),
      o = function () {},
      s = `prototype`,
      c = function () {
        var e = require__dom_create()(`iframe`),
          t = i.length,
          n = `<`,
          r = `>`,
          a;
        for (
          e.style.display = `none`,
            require__html().appendChild(e),
            e.src = `javascript:`,
            a = e.contentWindow.document,
            a.open(),
            a.write(n + `script` + r + `document.F=Object` + n + `/script` + r),
            a.close(),
            c = a.F;
          t--;
        )
          delete c[s][i[t]];
        return c();
      };
    t.exports =
      Object.create ||
      function (e, t) {
        var i;
        return (
          e === null
            ? (i = c())
            : ((o[s] = n(e)), (i = new o()), (o[s] = null), (i[a] = e)),
          t === void 0 ? i : r(i, t)
        );
      };
  }),
  require__wks = __commonJSMin((e, t) => {
    var n = require__shared()(`wks`),
      r = require__uid(),
      i = require__global().Symbol,
      a = typeof i == `function`,
      o = (t.exports = function (e) {
        return n[e] || (n[e] = (a && i[e]) || (a ? i : r)(`Symbol.` + e));
      });
    o.store = n;
  }),
  require__set_to_string_tag = __commonJSMin((e, t) => {
    var n = require__object_dp().f,
      r = require__has(),
      i = require__wks()(`toStringTag`);
    t.exports = function (e, t, a) {
      e &&
        !r((e = a ? e : e.prototype), i) &&
        n(e, i, { configurable: !0, value: t });
    };
  }),
  require__iter_create = __commonJSMin((e, t) => {
    var n = require__object_create(),
      r = require__property_desc(),
      i = require__set_to_string_tag(),
      a = {};
    (require__hide()(a, require__wks()(`iterator`), function () {
      return this;
    }),
      (t.exports = function (e, t, o) {
        ((e.prototype = n(a, { next: r(1, o) })), i(e, t + ` Iterator`));
      }));
  }),
  require__iter_define = __commonJSMin((e, t) => {
    var n = require__library(),
      r = require__export(),
      i = require__redefine(),
      a = require__hide(),
      o = require__iterators(),
      s = require__iter_create(),
      c = require__set_to_string_tag(),
      l = require__object_gpo(),
      u = require__wks()(`iterator`),
      d = !([].keys && `next` in [].keys()),
      f = `@@iterator`,
      p = `keys`,
      m = `values`,
      g = function () {
        return this;
      };
    t.exports = function (e, t, _, y, b, x, S) {
      s(_, t, y);
      var C = function (e) {
          if (!d && e in O) return O[e];
          switch (e) {
            case p:
              return function () {
                return new _(this, e);
              };
            case m:
              return function () {
                return new _(this, e);
              };
          }
          return function () {
            return new _(this, e);
          };
        },
        T = t + ` Iterator`,
        E = b == m,
        D = !1,
        O = e.prototype,
        k = O[u] || O[f] || (b && O[b]),
        A = k || C(b),
        j = b ? (E ? C(`entries`) : A) : void 0,
        M = (t == `Array` && O.entries) || k,
        N,
        P,
        F;
      if (
        (M &&
          ((F = l(M.call(new e()))),
          F !== Object.prototype &&
            F.next &&
            (c(F, T, !0), !n && typeof F[u] != `function` && a(F, u, g))),
        E &&
          k &&
          k.name !== m &&
          ((D = !0),
          (A = function () {
            return k.call(this);
          })),
        (!n || S) && (d || D || !O[u]) && a(O, u, A),
        (o[t] = A),
        (o[T] = g),
        b)
      )
        if (((N = { values: E ? A : C(m), keys: x ? A : C(p), entries: j }), S))
          for (P in N) P in O || i(O, P, N[P]);
        else r(r.P + r.F * (d || D), t, N);
      return N;
    };
  }),
  require_es6_string_iterator = __commonJSMin(() => {
    var e = require__string_at()(!0);
    require__iter_define()(
      String,
      `String`,
      function (e) {
        ((this._t = String(e)), (this._i = 0));
      },
      function () {
        var t = this._t,
          n = this._i,
          r;
        return n >= t.length
          ? { value: void 0, done: !0 }
          : ((r = e(t, n)), (this._i += r.length), { value: r, done: !1 });
      },
    );
  }),
  require__add_to_unscopables = __commonJSMin((e, t) => {
    t.exports = function () {};
  }),
  require__iter_step = __commonJSMin((e, t) => {
    t.exports = function (e, t) {
      return { value: t, done: !!e };
    };
  }),
  require_es6_array_iterator = __commonJSMin((e, t) => {
    var n = require__add_to_unscopables(),
      r = require__iter_step(),
      i = require__iterators(),
      a = require__to_iobject();
    ((t.exports = require__iter_define()(
      Array,
      `Array`,
      function (e, t) {
        ((this._t = a(e)), (this._i = 0), (this._k = t));
      },
      function () {
        var e = this._t,
          t = this._k,
          n = this._i++;
        return !e || n >= e.length
          ? ((this._t = void 0), r(1))
          : t == `keys`
            ? r(0, n)
            : t == `values`
              ? r(0, e[n])
              : r(0, [n, e[n]]);
      },
      `values`,
    )),
      (i.Arguments = i.Array),
      n(`keys`),
      n(`values`),
      n(`entries`));
  }),
  require_web_dom_iterable = __commonJSMin(() => {
    require_es6_array_iterator();
    for (
      var e = require__global(),
        t = require__hide(),
        n = require__iterators(),
        r = require__wks()(`toStringTag`),
        i =
          `CSSRuleList,CSSStyleDeclaration,CSSValueList,ClientRectList,DOMRectList,DOMStringList,DOMTokenList,DataTransferItemList,FileList,HTMLAllCollection,HTMLCollection,HTMLFormElement,HTMLSelectElement,MediaList,MimeTypeArray,NamedNodeMap,NodeList,PaintRequestList,Plugin,PluginArray,SVGLengthList,SVGNumberList,SVGPathSegList,SVGPointList,SVGStringList,SVGTransformList,SourceBufferList,StyleSheetList,TextTrackCueList,TextTrackList,TouchList`.split(
            `,`,
          ),
        a = 0;
      a < i.length;
      a++
    ) {
      var o = i[a],
        s = e[o],
        c = s && s.prototype;
      (c && !c[r] && t(c, r, o), (n[o] = n.Array));
    }
  }),
  require__wks_ext = __commonJSMin((e) => {
    e.f = require__wks();
  }),
  require_iterator$1 = __commonJSMin((e, t) => {
    (require_es6_string_iterator(),
      require_web_dom_iterable(),
      (t.exports = require__wks_ext().f(`iterator`)));
  }),
  require_iterator = __commonJSMin((e, t) => {
    t.exports = { default: require_iterator$1(), __esModule: !0 };
  }),
  require__meta = __commonJSMin((e, t) => {
    var n = require__uid()(`meta`),
      r = require__is_object(),
      i = require__has(),
      a = require__object_dp().f,
      o = 0,
      s =
        Object.isExtensible ||
        function () {
          return !0;
        },
      c = !require__fails()(function () {
        return s(Object.preventExtensions({}));
      }),
      l = function (e) {
        a(e, n, { value: { i: `O` + ++o, w: {} } });
      },
      u = (t.exports = {
        KEY: n,
        NEED: !1,
        fastKey: function (e, t) {
          if (!r(e))
            return typeof e == `symbol`
              ? e
              : (typeof e == `string` ? `S` : `P`) + e;
          if (!i(e, n)) {
            if (!s(e)) return `F`;
            if (!t) return `E`;
            l(e);
          }
          return e[n].i;
        },
        getWeak: function (e, t) {
          if (!i(e, n)) {
            if (!s(e)) return !0;
            if (!t) return !1;
            l(e);
          }
          return e[n].w;
        },
        onFreeze: function (e) {
          return (c && u.NEED && s(e) && !i(e, n) && l(e), e);
        },
      });
  }),
  require__wks_define = __commonJSMin((e, t) => {
    var n = require__global(),
      r = require__core(),
      i = require__library(),
      a = require__wks_ext(),
      o = require__object_dp().f;
    t.exports = function (e) {
      var t = (r.Symbol ||= i ? {} : n.Symbol || {});
      e.charAt(0) != `_` && !(e in t) && o(t, e, { value: a.f(e) });
    };
  }),
  require__enum_keys = __commonJSMin((e, t) => {
    var n = require__object_keys(),
      r = require__object_gops(),
      i = require__object_pie();
    t.exports = function (e) {
      var t = n(e),
        a = r.f;
      if (a)
        for (var o = a(e), s = i.f, c = 0, l; o.length > c;)
          s.call(e, (l = o[c++])) && t.push(l);
      return t;
    };
  }),
  require__is_array = __commonJSMin((e, t) => {
    var n = require__cof();
    t.exports =
      Array.isArray ||
      function (e) {
        return n(e) == `Array`;
      };
  }),
  require__object_gopn = __commonJSMin((e) => {
    var t = require__object_keys_internal(),
      n = require__enum_bug_keys().concat(`length`, `prototype`);
    e.f =
      Object.getOwnPropertyNames ||
      function (e) {
        return t(e, n);
      };
  }),
  require__object_gopn_ext = __commonJSMin((e, t) => {
    var n = require__to_iobject(),
      r = require__object_gopn().f,
      i = {}.toString,
      a =
        typeof window == `object` && window && Object.getOwnPropertyNames
          ? Object.getOwnPropertyNames(window)
          : [],
      o = function (e) {
        try {
          return r(e);
        } catch {
          return a.slice();
        }
      };
    t.exports.f = function (e) {
      return a && i.call(e) == `[object Window]` ? o(e) : r(n(e));
    };
  }),
  require__object_gopd = __commonJSMin((e) => {
    var t = require__object_pie(),
      n = require__property_desc(),
      r = require__to_iobject(),
      i = require__to_primitive(),
      a = require__has(),
      o = require__ie8_dom_define(),
      s = Object.getOwnPropertyDescriptor;
    e.f = require__descriptors()
      ? s
      : function (e, c) {
          if (((e = r(e)), (c = i(c, !0)), o))
            try {
              return s(e, c);
            } catch {}
          if (a(e, c)) return n(!t.f.call(e, c), e[c]);
        };
  }),
  require_es6_symbol = __commonJSMin(() => {
    var e = require__global(),
      t = require__has(),
      n = require__descriptors(),
      r = require__export(),
      i = require__redefine(),
      a = require__meta().KEY,
      o = require__fails(),
      s = require__shared(),
      c = require__set_to_string_tag(),
      l = require__uid(),
      u = require__wks(),
      d = require__wks_ext(),
      f = require__wks_define(),
      p = require__enum_keys(),
      m = require__is_array(),
      g = require__an_object(),
      _ = require__is_object(),
      y = require__to_object(),
      b = require__to_iobject(),
      x = require__to_primitive(),
      S = require__property_desc(),
      C = require__object_create(),
      T = require__object_gopn_ext(),
      E = require__object_gopd(),
      D = require__object_gops(),
      O = require__object_dp(),
      k = require__object_keys(),
      A = E.f,
      j = O.f,
      M = T.f,
      N = e.Symbol,
      P = e.JSON,
      F = P && P.stringify,
      I = `prototype`,
      L = u(`_hidden`),
      R = u(`toPrimitive`),
      z = {}.propertyIsEnumerable,
      B = s(`symbol-registry`),
      V = s(`symbols`),
      H = s(`op-symbols`),
      U = Object[I],
      W = typeof N == `function` && !!D.f,
      ee = e.QObject,
      te = !ee || !ee[I] || !ee[I].findChild,
      ne =
        n &&
        o(function () {
          return (
            C(
              j({}, `a`, {
                get: function () {
                  return j(this, `a`, { value: 7 }).a;
                },
              }),
            ).a != 7
          );
        })
          ? function (e, t, n) {
              var r = A(U, t);
              (r && delete U[t], j(e, t, n), r && e !== U && j(U, t, r));
            }
          : j,
      re = function (e) {
        var t = (V[e] = C(N[I]));
        return ((t._k = e), t);
      },
      G =
        W && typeof N.iterator == `symbol`
          ? function (e) {
              return typeof e == `symbol`;
            }
          : function (e) {
              return e instanceof N;
            },
      K = function (e, n, r) {
        return (
          e === U && K(H, n, r),
          g(e),
          (n = x(n, !0)),
          g(r),
          t(V, n)
            ? (r.enumerable
                ? (t(e, L) && e[L][n] && (e[L][n] = !1),
                  (r = C(r, { enumerable: S(0, !1) })))
                : (t(e, L) || j(e, L, S(1, {})), (e[L][n] = !0)),
              ne(e, n, r))
            : j(e, n, r)
        );
      },
      q = function (e, t) {
        g(e);
        for (var n = p((t = b(t))), r = 0, i = n.length, a; i > r;)
          K(e, (a = n[r++]), t[a]);
        return e;
      },
      J = function (e, t) {
        return t === void 0 ? C(e) : q(C(e), t);
      },
      Y = function (e) {
        var n = z.call(this, (e = x(e, !0)));
        return this === U && t(V, e) && !t(H, e)
          ? !1
          : n || !t(this, e) || !t(V, e) || (t(this, L) && this[L][e])
            ? n
            : !0;
      },
      X = function (e, n) {
        if (((e = b(e)), (n = x(n, !0)), !(e === U && t(V, n) && !t(H, n)))) {
          var r = A(e, n);
          return (
            r && t(V, n) && !(t(e, L) && e[L][n]) && (r.enumerable = !0),
            r
          );
        }
      },
      ie = function (e) {
        for (var n = M(b(e)), r = [], i = 0, o; n.length > i;)
          !t(V, (o = n[i++])) && o != L && o != a && r.push(o);
        return r;
      },
      Z = function (e) {
        for (
          var n = e === U, r = M(n ? H : b(e)), i = [], a = 0, o;
          r.length > a;
        )
          t(V, (o = r[a++])) && (!n || t(U, o)) && i.push(V[o]);
        return i;
      };
    (W ||
      ((N = function () {
        if (this instanceof N) throw TypeError(`Symbol is not a constructor!`);
        var e = l(arguments.length > 0 ? arguments[0] : void 0),
          r = function (n) {
            (this === U && r.call(H, n),
              t(this, L) && t(this[L], e) && (this[L][e] = !1),
              ne(this, e, S(1, n)));
          };
        return (n && te && ne(U, e, { configurable: !0, set: r }), re(e));
      }),
      i(N[I], `toString`, function () {
        return this._k;
      }),
      (E.f = X),
      (O.f = K),
      (require__object_gopn().f = T.f = ie),
      (require__object_pie().f = Y),
      (D.f = Z),
      n && !require__library() && i(U, `propertyIsEnumerable`, Y, !0),
      (d.f = function (e) {
        return re(u(e));
      })),
      r(r.G + r.W + r.F * !W, { Symbol: N }));
    for (
      var Q =
          `hasInstance,isConcatSpreadable,iterator,match,replace,search,species,split,toPrimitive,toStringTag,unscopables`.split(
            `,`,
          ),
        ae = 0;
      Q.length > ae;
    )
      u(Q[ae++]);
    for (var oe = k(u.store), $ = 0; oe.length > $;) f(oe[$++]);
    (r(r.S + r.F * !W, `Symbol`, {
      for: function (e) {
        return t(B, (e += ``)) ? B[e] : (B[e] = N(e));
      },
      keyFor: function (e) {
        if (!G(e)) throw TypeError(e + ` is not a symbol!`);
        for (var t in B) if (B[t] === e) return t;
      },
      useSetter: function () {
        te = !0;
      },
      useSimple: function () {
        te = !1;
      },
    }),
      r(r.S + r.F * !W, `Object`, {
        create: J,
        defineProperty: K,
        defineProperties: q,
        getOwnPropertyDescriptor: X,
        getOwnPropertyNames: ie,
        getOwnPropertySymbols: Z,
      }));
    var se = o(function () {
      D.f(1);
    });
    (r(r.S + r.F * se, `Object`, {
      getOwnPropertySymbols: function (e) {
        return D.f(y(e));
      },
    }),
      P &&
        r(
          r.S +
            r.F *
              (!W ||
                o(function () {
                  var e = N();
                  return (
                    F([e]) != `[null]` ||
                    F({ a: e }) != `{}` ||
                    F(Object(e)) != `{}`
                  );
                })),
          `JSON`,
          {
            stringify: function (e) {
              for (var t = [e], n = 1, r, i; arguments.length > n;)
                t.push(arguments[n++]);
              if (((i = r = t[1]), !((!_(r) && e === void 0) || G(e))))
                return (
                  m(r) ||
                    (r = function (e, t) {
                      if (
                        (typeof i == `function` && (t = i.call(this, e, t)),
                        !G(t))
                      )
                        return t;
                    }),
                  (t[1] = r),
                  F.apply(P, t)
                );
            },
          },
        ),
      N[I][R] || require__hide()(N[I], R, N[I].valueOf),
      c(N, `Symbol`),
      c(Math, `Math`, !0),
      c(e.JSON, `JSON`, !0));
  }),
  require_es6_object_to_string = __commonJSMin(() => {}),
  require_es7_symbol_async_iterator = __commonJSMin(() => {
    require__wks_define()(`asyncIterator`);
  }),
  require_es7_symbol_observable = __commonJSMin(() => {
    require__wks_define()(`observable`);
  }),
  require_symbol$1 = __commonJSMin((e, t) => {
    (require_es6_symbol(),
      require_es6_object_to_string(),
      require_es7_symbol_async_iterator(),
      require_es7_symbol_observable(),
      (t.exports = require__core().Symbol));
  }),
  require_symbol = __commonJSMin((e, t) => {
    t.exports = { default: require_symbol$1(), __esModule: !0 };
  }),
  require_typeof = __commonJSMin((e) => {
    e.__esModule = !0;
    var t = i(require_iterator()),
      n = i(require_symbol()),
      r =
        typeof n.default == `function` && typeof t.default == `symbol`
          ? function (e) {
              return typeof e;
            }
          : function (e) {
              return e &&
                typeof n.default == `function` &&
                e.constructor === n.default &&
                e !== n.default.prototype
                ? `symbol`
                : typeof e;
            };
    function i(e) {
      return e && e.__esModule ? e : { default: e };
    }
    e.default =
      typeof n.default == `function` && r(t.default) === `symbol`
        ? function (e) {
            return e === void 0 ? `undefined` : r(e);
          }
        : function (e) {
            return e &&
              typeof n.default == `function` &&
              e.constructor === n.default &&
              e !== n.default.prototype
              ? `symbol`
              : e === void 0
                ? `undefined`
                : r(e);
          };
  }),
  require_possibleConstructorReturn = __commonJSMin((e) => {
    e.__esModule = !0;
    var t = n(require_typeof());
    function n(e) {
      return e && e.__esModule ? e : { default: e };
    }
    e.default = function (e, n) {
      if (!e)
        throw ReferenceError(
          `this hasn't been initialised - super() hasn't been called`,
        );
      return n &&
        ((n === void 0 ? `undefined` : (0, t.default)(n)) === `object` ||
          typeof n == `function`)
        ? n
        : e;
    };
  }),
  require__set_proto = __commonJSMin((e, t) => {
    var n = require__is_object(),
      r = require__an_object(),
      i = function (e, t) {
        if ((r(e), !n(t) && t !== null))
          throw TypeError(t + `: can't set as prototype!`);
      };
    t.exports = {
      set:
        Object.setPrototypeOf ||
        (`__proto__` in {}
          ? (function (e, t, n) {
              try {
                ((n = require__ctx()(
                  Function.call,
                  require__object_gopd().f(Object.prototype, `__proto__`).set,
                  2,
                )),
                  n(e, []),
                  (t = !(e instanceof Array)));
              } catch {
                t = !0;
              }
              return function (e, r) {
                return (i(e, r), t ? (e.__proto__ = r) : n(e, r), e);
              };
            })({}, !1)
          : void 0),
      check: i,
    };
  }),
  require_es6_object_set_prototype_of = __commonJSMin(() => {
    var e = require__export();
    e(e.S, `Object`, { setPrototypeOf: require__set_proto().set });
  }),
  require_set_prototype_of$1 = __commonJSMin((e, t) => {
    (require_es6_object_set_prototype_of(),
      (t.exports = require__core().Object.setPrototypeOf));
  }),
  require_set_prototype_of = __commonJSMin((e, t) => {
    t.exports = { default: require_set_prototype_of$1(), __esModule: !0 };
  }),
  require_es6_object_create = __commonJSMin(() => {
    var e = require__export();
    e(e.S, `Object`, { create: require__object_create() });
  }),
  require_create$1 = __commonJSMin((e, t) => {
    require_es6_object_create();
    var n = require__core().Object;
    t.exports = function (e, t) {
      return n.create(e, t);
    };
  }),
  require_create = __commonJSMin((e, t) => {
    t.exports = { default: require_create$1(), __esModule: !0 };
  }),
  require_inherits = __commonJSMin((e) => {
    e.__esModule = !0;
    var t = i(require_set_prototype_of()),
      n = i(require_create()),
      r = i(require_typeof());
    function i(e) {
      return e && e.__esModule ? e : { default: e };
    }
    e.default = function (e, i) {
      if (typeof i != `function` && i !== null)
        throw TypeError(
          `Super expression must either be null or a function, not ` +
            (i === void 0 ? `undefined` : (0, r.default)(i)),
        );
      ((e.prototype = (0, n.default)(i && i.prototype, {
        constructor: {
          value: e,
          enumerable: !1,
          writable: !0,
          configurable: !0,
        },
      })),
        i && (t.default ? (0, t.default)(e, i) : (e.__proto__ = i)));
    };
  }),
  require_lottie = __commonJSMin((exports, module) => {
    typeof document < `u` &&
      typeof navigator < `u` &&
      (function (e, t) {
        typeof exports == `object` && module !== void 0
          ? (module.exports = t())
          : typeof define == `function` && define.amd
            ? define(t)
            : ((e = typeof globalThis < `u` ? globalThis : e || self),
              (e.lottie = t()));
      })(exports, function () {
        var svgNS = `http://www.w3.org/2000/svg`,
          locationHref = ``,
          _useWebWorker = !1,
          initialDefaultFrame = -999999,
          setWebWorker = function (e) {
            _useWebWorker = !!e;
          },
          getWebWorker = function () {
            return _useWebWorker;
          },
          setLocationHref = function (e) {
            locationHref = e;
          },
          getLocationHref = function () {
            return locationHref;
          };
        function createTag(e) {
          return document.createElement(e);
        }
        function extendPrototype(e, t) {
          var n,
            r = e.length,
            i;
          for (n = 0; n < r; n += 1)
            for (var a in ((i = e[n].prototype), i))
              Object.prototype.hasOwnProperty.call(i, a) &&
                (t.prototype[a] = i[a]);
        }
        function getDescriptor(e, t) {
          return Object.getOwnPropertyDescriptor(e, t);
        }
        function createProxyFunction(e) {
          function t() {}
          return ((t.prototype = e), t);
        }
        var audioControllerFactory = (function () {
            function e(e) {
              ((this.audios = []),
                (this.audioFactory = e),
                (this._volume = 1),
                (this._isMuted = !1));
            }
            return (
              (e.prototype = {
                addAudio: function (e) {
                  this.audios.push(e);
                },
                pause: function () {
                  var e,
                    t = this.audios.length;
                  for (e = 0; e < t; e += 1) this.audios[e].pause();
                },
                resume: function () {
                  var e,
                    t = this.audios.length;
                  for (e = 0; e < t; e += 1) this.audios[e].resume();
                },
                setRate: function (e) {
                  var t,
                    n = this.audios.length;
                  for (t = 0; t < n; t += 1) this.audios[t].setRate(e);
                },
                createAudio: function (e) {
                  return this.audioFactory
                    ? this.audioFactory(e)
                    : window.Howl
                      ? new window.Howl({ src: [e] })
                      : {
                          isPlaying: !1,
                          play: function () {
                            this.isPlaying = !0;
                          },
                          seek: function () {
                            this.isPlaying = !1;
                          },
                          playing: function () {},
                          rate: function () {},
                          setVolume: function () {},
                        };
                },
                setAudioFactory: function (e) {
                  this.audioFactory = e;
                },
                setVolume: function (e) {
                  ((this._volume = e), this._updateVolume());
                },
                mute: function () {
                  ((this._isMuted = !0), this._updateVolume());
                },
                unmute: function () {
                  ((this._isMuted = !1), this._updateVolume());
                },
                getVolume: function () {
                  return this._volume;
                },
                _updateVolume: function () {
                  var e,
                    t = this.audios.length;
                  for (e = 0; e < t; e += 1)
                    this.audios[e].volume(this._volume * +!this._isMuted);
                },
              }),
              function () {
                return new e();
              }
            );
          })(),
          createTypedArray = (function () {
            function e(e, t) {
              var n = 0,
                r = [],
                i;
              switch (e) {
                case `int16`:
                case `uint8c`:
                  i = 1;
                  break;
                default:
                  i = 1.1;
                  break;
              }
              for (n = 0; n < t; n += 1) r.push(i);
              return r;
            }
            function t(t, n) {
              return t === `float32`
                ? new Float32Array(n)
                : t === `int16`
                  ? new Int16Array(n)
                  : t === `uint8c`
                    ? new Uint8ClampedArray(n)
                    : e(t, n);
            }
            return typeof Uint8ClampedArray == `function` &&
              typeof Float32Array == `function`
              ? t
              : e;
          })();
        function createSizedArray(e) {
          return Array.apply(null, { length: e });
        }
        function _typeof$6(e) {
          "@babel/helpers - typeof";
          return (
            (_typeof$6 =
              typeof Symbol == `function` && typeof Symbol.iterator == `symbol`
                ? function (e) {
                    return typeof e;
                  }
                : function (e) {
                    return e &&
                      typeof Symbol == `function` &&
                      e.constructor === Symbol &&
                      e !== Symbol.prototype
                      ? `symbol`
                      : typeof e;
                  }),
            _typeof$6(e)
          );
        }
        var subframeEnabled = !0,
          expressionsPlugin = null,
          expressionsInterfaces = null,
          idPrefix$1 = ``,
          isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
          _shouldRoundValues = !1,
          bmPow = Math.pow,
          bmSqrt = Math.sqrt,
          bmFloor = Math.floor,
          bmMax = Math.max,
          bmMin = Math.min,
          BMMath = {};
        (function () {
          var e =
              `abs.acos.acosh.asin.asinh.atan.atanh.atan2.ceil.cbrt.expm1.clz32.cos.cosh.exp.floor.fround.hypot.imul.log.log1p.log2.log10.max.min.pow.random.round.sign.sin.sinh.sqrt.tan.tanh.trunc.E.LN10.LN2.LOG10E.LOG2E.PI.SQRT1_2.SQRT2`.split(
                `.`,
              ),
            t,
            n = e.length;
          for (t = 0; t < n; t += 1) BMMath[e[t]] = Math[e[t]];
        })();
        function ProjectInterface$1() {
          return {};
        }
        ((BMMath.random = Math.random),
          (BMMath.abs = function (e) {
            if (_typeof$6(e) === `object` && e.length) {
              var t = createSizedArray(e.length),
                n,
                r = e.length;
              for (n = 0; n < r; n += 1) t[n] = Math.abs(e[n]);
              return t;
            }
            return Math.abs(e);
          }));
        var defaultCurveSegments = 150,
          degToRads = Math.PI / 180,
          roundCorner = 0.5519;
        function roundValues(e) {
          _shouldRoundValues = !!e;
        }
        function bmRnd(e) {
          return _shouldRoundValues ? Math.round(e) : e;
        }
        function styleDiv(e) {
          ((e.style.position = `absolute`),
            (e.style.top = 0),
            (e.style.left = 0),
            (e.style.display = `block`),
            (e.style.transformOrigin = `0 0`),
            (e.style.webkitTransformOrigin = `0 0`),
            (e.style.backfaceVisibility = `visible`),
            (e.style.webkitBackfaceVisibility = `visible`),
            (e.style.transformStyle = `preserve-3d`),
            (e.style.webkitTransformStyle = `preserve-3d`),
            (e.style.mozTransformStyle = `preserve-3d`));
        }
        function BMEnterFrameEvent(e, t, n, r) {
          ((this.type = e),
            (this.currentTime = t),
            (this.totalTime = n),
            (this.direction = r < 0 ? -1 : 1));
        }
        function BMCompleteEvent(e, t) {
          ((this.type = e), (this.direction = t < 0 ? -1 : 1));
        }
        function BMCompleteLoopEvent(e, t, n, r) {
          ((this.type = e),
            (this.currentLoop = n),
            (this.totalLoops = t),
            (this.direction = r < 0 ? -1 : 1));
        }
        function BMSegmentStartEvent(e, t, n) {
          ((this.type = e), (this.firstFrame = t), (this.totalFrames = n));
        }
        function BMDestroyEvent(e, t) {
          ((this.type = e), (this.target = t));
        }
        function BMRenderFrameErrorEvent(e, t) {
          ((this.type = `renderFrameError`),
            (this.nativeError = e),
            (this.currentTime = t));
        }
        function BMConfigErrorEvent(e) {
          ((this.type = `configError`), (this.nativeError = e));
        }
        function BMAnimationConfigErrorEvent(e, t) {
          ((this.type = e), (this.nativeError = t));
        }
        var createElementID = (function () {
          var e = 0;
          return function () {
            return ((e += 1), idPrefix$1 + `__lottie_element_` + e);
          };
        })();
        function HSVtoRGB(e, t, n) {
          var r,
            i,
            a,
            o = Math.floor(e * 6),
            s = e * 6 - o,
            c = n * (1 - t),
            l = n * (1 - s * t),
            u = n * (1 - (1 - s) * t);
          switch (o % 6) {
            case 0:
              ((r = n), (i = u), (a = c));
              break;
            case 1:
              ((r = l), (i = n), (a = c));
              break;
            case 2:
              ((r = c), (i = n), (a = u));
              break;
            case 3:
              ((r = c), (i = l), (a = n));
              break;
            case 4:
              ((r = u), (i = c), (a = n));
              break;
            case 5:
              ((r = n), (i = c), (a = l));
              break;
            default:
              break;
          }
          return [r, i, a];
        }
        function RGBtoHSV(e, t, n) {
          var r = Math.max(e, t, n),
            i = Math.min(e, t, n),
            a = r - i,
            o,
            s = r === 0 ? 0 : a / r,
            c = r / 255;
          switch (r) {
            case i:
              o = 0;
              break;
            case e:
              ((o = t - n + a * (t < n ? 6 : 0)), (o /= 6 * a));
              break;
            case t:
              ((o = n - e + a * 2), (o /= 6 * a));
              break;
            case n:
              ((o = e - t + a * 4), (o /= 6 * a));
              break;
            default:
              break;
          }
          return [o, s, c];
        }
        function addSaturationToRGB(e, t) {
          var n = RGBtoHSV(e[0] * 255, e[1] * 255, e[2] * 255);
          return (
            (n[1] += t),
            n[1] > 1 ? (n[1] = 1) : n[1] <= 0 && (n[1] = 0),
            HSVtoRGB(n[0], n[1], n[2])
          );
        }
        function addBrightnessToRGB(e, t) {
          var n = RGBtoHSV(e[0] * 255, e[1] * 255, e[2] * 255);
          return (
            (n[2] += t),
            n[2] > 1 ? (n[2] = 1) : n[2] < 0 && (n[2] = 0),
            HSVtoRGB(n[0], n[1], n[2])
          );
        }
        function addHueToRGB(e, t) {
          var n = RGBtoHSV(e[0] * 255, e[1] * 255, e[2] * 255);
          return (
            (n[0] += t / 360),
            n[0] > 1 ? --n[0] : n[0] < 0 && (n[0] += 1),
            HSVtoRGB(n[0], n[1], n[2])
          );
        }
        var rgbToHex = (function () {
            var e = [],
              t,
              n;
            for (t = 0; t < 256; t += 1)
              ((n = t.toString(16)), (e[t] = n.length === 1 ? `0` + n : n));
            return function (t, n, r) {
              return (
                t < 0 && (t = 0),
                n < 0 && (n = 0),
                r < 0 && (r = 0),
                `#` + e[t] + e[n] + e[r]
              );
            };
          })(),
          setSubframeEnabled = function (e) {
            subframeEnabled = !!e;
          },
          getSubframeEnabled = function () {
            return subframeEnabled;
          },
          setExpressionsPlugin = function (e) {
            expressionsPlugin = e;
          },
          getExpressionsPlugin = function () {
            return expressionsPlugin;
          },
          setExpressionInterfaces = function (e) {
            expressionsInterfaces = e;
          },
          getExpressionInterfaces = function () {
            return expressionsInterfaces;
          },
          setDefaultCurveSegments = function (e) {
            defaultCurveSegments = e;
          },
          getDefaultCurveSegments = function () {
            return defaultCurveSegments;
          },
          setIdPrefix = function (e) {
            idPrefix$1 = e;
          },
          getIdPrefix = function () {
            return idPrefix$1;
          };
        function createNS(e) {
          return document.createElementNS(svgNS, e);
        }
        function _typeof$5(e) {
          "@babel/helpers - typeof";
          return (
            (_typeof$5 =
              typeof Symbol == `function` && typeof Symbol.iterator == `symbol`
                ? function (e) {
                    return typeof e;
                  }
                : function (e) {
                    return e &&
                      typeof Symbol == `function` &&
                      e.constructor === Symbol &&
                      e !== Symbol.prototype
                      ? `symbol`
                      : typeof e;
                  }),
            _typeof$5(e)
          );
        }
        var dataManager = (function () {
            var e = 1,
              t = [],
              n,
              r,
              i = {
                onmessage: function () {},
                postMessage: function (e) {
                  n({ data: e });
                },
              },
              a = {
                postMessage: function (e) {
                  i.onmessage({ data: e });
                },
              };
            function o(e) {
              if (window.Worker && window.Blob && getWebWorker()) {
                var t = new Blob(
                    [`var _workerSelf = self; self.onmessage = `, e.toString()],
                    { type: `text/javascript` },
                  ),
                  r = URL.createObjectURL(t);
                return new Worker(r);
              }
              return ((n = e), i);
            }
            function s() {
              r ||
                ((r = o(function (e) {
                  function t() {
                    function e(t, n) {
                      var o,
                        s,
                        c = t.length,
                        l,
                        u,
                        d,
                        f;
                      for (s = 0; s < c; s += 1)
                        if (((o = t[s]), `ks` in o && !o.completed)) {
                          if (((o.completed = !0), o.hasMask)) {
                            var m = o.masksProperties;
                            for (u = m.length, l = 0; l < u; l += 1)
                              if (m[l].pt.k.i) a(m[l].pt.k);
                              else
                                for (f = m[l].pt.k.length, d = 0; d < f; d += 1)
                                  (m[l].pt.k[d].s && a(m[l].pt.k[d].s[0]),
                                    m[l].pt.k[d].e && a(m[l].pt.k[d].e[0]));
                          }
                          o.ty === 0
                            ? ((o.layers = r(o.refId, n)), e(o.layers, n))
                            : o.ty === 4
                              ? i(o.shapes)
                              : o.ty === 5 && p(o);
                        }
                    }
                    function t(t, n) {
                      if (t) {
                        var i = 0,
                          a = t.length;
                        for (i = 0; i < a; i += 1)
                          t[i].t === 1 &&
                            ((t[i].data.layers = r(t[i].data.refId, n)),
                            e(t[i].data.layers, n));
                      }
                    }
                    function n(e, t) {
                      for (var n = 0, r = t.length; n < r;) {
                        if (t[n].id === e) return t[n];
                        n += 1;
                      }
                      return null;
                    }
                    function r(e, t) {
                      var r = n(e, t);
                      return r
                        ? r.layers.__used
                          ? JSON.parse(JSON.stringify(r.layers))
                          : ((r.layers.__used = !0), r.layers)
                        : null;
                    }
                    function i(e) {
                      var t,
                        n = e.length,
                        r,
                        o;
                      for (t = n - 1; t >= 0; --t)
                        if (e[t].ty === `sh`)
                          if (e[t].ks.k.i) a(e[t].ks.k);
                          else
                            for (o = e[t].ks.k.length, r = 0; r < o; r += 1)
                              (e[t].ks.k[r].s && a(e[t].ks.k[r].s[0]),
                                e[t].ks.k[r].e && a(e[t].ks.k[r].e[0]));
                        else e[t].ty === `gr` && i(e[t].it);
                    }
                    function a(e) {
                      var t,
                        n = e.i.length;
                      for (t = 0; t < n; t += 1)
                        ((e.i[t][0] += e.v[t][0]),
                          (e.i[t][1] += e.v[t][1]),
                          (e.o[t][0] += e.v[t][0]),
                          (e.o[t][1] += e.v[t][1]));
                    }
                    function o(e, t) {
                      var n = t ? t.split(`.`) : [100, 100, 100];
                      return e[0] > n[0]
                        ? !0
                        : n[0] > e[0]
                          ? !1
                          : e[1] > n[1]
                            ? !0
                            : n[1] > e[1]
                              ? !1
                              : e[2] > n[2]
                                ? !0
                                : n[2] > e[2]
                                  ? !1
                                  : null;
                    }
                    var s = (function () {
                        var e = [4, 4, 14];
                        function t(e) {
                          var t = e.t.d;
                          e.t.d = { k: [{ s: t, t: 0 }] };
                        }
                        function n(e) {
                          var n,
                            r = e.length;
                          for (n = 0; n < r; n += 1) e[n].ty === 5 && t(e[n]);
                        }
                        return function (t) {
                          if (o(e, t.v) && (n(t.layers), t.assets)) {
                            var r,
                              i = t.assets.length;
                            for (r = 0; r < i; r += 1)
                              t.assets[r].layers && n(t.assets[r].layers);
                          }
                        };
                      })(),
                      c = (function () {
                        var e = [4, 7, 99];
                        return function (t) {
                          if (t.chars && !o(e, t.v)) {
                            var n,
                              r = t.chars.length;
                            for (n = 0; n < r; n += 1) {
                              var a = t.chars[n];
                              a.data &&
                                a.data.shapes &&
                                (i(a.data.shapes),
                                (a.data.ip = 0),
                                (a.data.op = 99999),
                                (a.data.st = 0),
                                (a.data.sr = 1),
                                (a.data.ks = {
                                  p: { k: [0, 0], a: 0 },
                                  s: { k: [100, 100], a: 0 },
                                  a: { k: [0, 0], a: 0 },
                                  r: { k: 0, a: 0 },
                                  o: { k: 100, a: 0 },
                                }),
                                t.chars[n].t ||
                                  (a.data.shapes.push({ ty: `no` }),
                                  a.data.shapes[0].it.push({
                                    p: { k: [0, 0], a: 0 },
                                    s: { k: [100, 100], a: 0 },
                                    a: { k: [0, 0], a: 0 },
                                    r: { k: 0, a: 0 },
                                    o: { k: 100, a: 0 },
                                    sk: { k: 0, a: 0 },
                                    sa: { k: 0, a: 0 },
                                    ty: `tr`,
                                  })));
                            }
                          }
                        };
                      })(),
                      l = (function () {
                        var e = [5, 7, 15];
                        function t(e) {
                          var t = e.t.p;
                          (typeof t.a == `number` && (t.a = { a: 0, k: t.a }),
                            typeof t.p == `number` && (t.p = { a: 0, k: t.p }),
                            typeof t.r == `number` && (t.r = { a: 0, k: t.r }));
                        }
                        function n(e) {
                          var n,
                            r = e.length;
                          for (n = 0; n < r; n += 1) e[n].ty === 5 && t(e[n]);
                        }
                        return function (t) {
                          if (o(e, t.v) && (n(t.layers), t.assets)) {
                            var r,
                              i = t.assets.length;
                            for (r = 0; r < i; r += 1)
                              t.assets[r].layers && n(t.assets[r].layers);
                          }
                        };
                      })(),
                      u = (function () {
                        var e = [4, 1, 9];
                        function t(e) {
                          var n,
                            r = e.length,
                            i,
                            a;
                          for (n = 0; n < r; n += 1)
                            if (e[n].ty === `gr`) t(e[n].it);
                            else if (e[n].ty === `fl` || e[n].ty === `st`)
                              if (e[n].c.k && e[n].c.k[0].i)
                                for (a = e[n].c.k.length, i = 0; i < a; i += 1)
                                  (e[n].c.k[i].s &&
                                    ((e[n].c.k[i].s[0] /= 255),
                                    (e[n].c.k[i].s[1] /= 255),
                                    (e[n].c.k[i].s[2] /= 255),
                                    (e[n].c.k[i].s[3] /= 255)),
                                    e[n].c.k[i].e &&
                                      ((e[n].c.k[i].e[0] /= 255),
                                      (e[n].c.k[i].e[1] /= 255),
                                      (e[n].c.k[i].e[2] /= 255),
                                      (e[n].c.k[i].e[3] /= 255)));
                              else
                                ((e[n].c.k[0] /= 255),
                                  (e[n].c.k[1] /= 255),
                                  (e[n].c.k[2] /= 255),
                                  (e[n].c.k[3] /= 255));
                        }
                        function n(e) {
                          var n,
                            r = e.length;
                          for (n = 0; n < r; n += 1)
                            e[n].ty === 4 && t(e[n].shapes);
                        }
                        return function (t) {
                          if (o(e, t.v) && (n(t.layers), t.assets)) {
                            var r,
                              i = t.assets.length;
                            for (r = 0; r < i; r += 1)
                              t.assets[r].layers && n(t.assets[r].layers);
                          }
                        };
                      })(),
                      d = (function () {
                        var e = [4, 4, 18];
                        function t(e) {
                          var n,
                            r = e.length,
                            i,
                            a;
                          for (n = r - 1; n >= 0; --n)
                            if (e[n].ty === `sh`)
                              if (e[n].ks.k.i) e[n].ks.k.c = e[n].closed;
                              else
                                for (a = e[n].ks.k.length, i = 0; i < a; i += 1)
                                  (e[n].ks.k[i].s &&
                                    (e[n].ks.k[i].s[0].c = e[n].closed),
                                    e[n].ks.k[i].e &&
                                      (e[n].ks.k[i].e[0].c = e[n].closed));
                            else e[n].ty === `gr` && t(e[n].it);
                        }
                        function n(e) {
                          var n,
                            r,
                            i = e.length,
                            a,
                            o,
                            s,
                            c;
                          for (r = 0; r < i; r += 1) {
                            if (((n = e[r]), n.hasMask)) {
                              var l = n.masksProperties;
                              for (o = l.length, a = 0; a < o; a += 1)
                                if (l[a].pt.k.i) l[a].pt.k.c = l[a].cl;
                                else
                                  for (
                                    c = l[a].pt.k.length, s = 0;
                                    s < c;
                                    s += 1
                                  )
                                    (l[a].pt.k[s].s &&
                                      (l[a].pt.k[s].s[0].c = l[a].cl),
                                      l[a].pt.k[s].e &&
                                        (l[a].pt.k[s].e[0].c = l[a].cl));
                            }
                            n.ty === 4 && t(n.shapes);
                          }
                        }
                        return function (t) {
                          if (o(e, t.v) && (n(t.layers), t.assets)) {
                            var r,
                              i = t.assets.length;
                            for (r = 0; r < i; r += 1)
                              t.assets[r].layers && n(t.assets[r].layers);
                          }
                        };
                      })();
                    function f(n) {
                      n.__complete ||=
                        (u(n),
                        s(n),
                        c(n),
                        l(n),
                        d(n),
                        e(n.layers, n.assets),
                        t(n.chars, n.assets),
                        !0);
                    }
                    function p(e) {
                      e.t.a.length === 0 && `m` in e.t.p;
                    }
                    var m = {};
                    return (
                      (m.completeData = f),
                      (m.checkColors = u),
                      (m.checkChars = c),
                      (m.checkPathProperties = l),
                      (m.checkShapes = d),
                      (m.completeLayers = e),
                      m
                    );
                  }
                  if (
                    ((a.dataManager ||= t()),
                    (a.assetLoader ||= (function () {
                      function e(e) {
                        var t = e.getResponseHeader(`content-type`);
                        return (t &&
                          e.responseType === `json` &&
                          t.indexOf(`json`) !== -1) ||
                          (e.response && _typeof$5(e.response) === `object`)
                          ? e.response
                          : e.response && typeof e.response == `string`
                            ? JSON.parse(e.response)
                            : e.responseText
                              ? JSON.parse(e.responseText)
                              : null;
                      }
                      function t(t, n, r, i) {
                        var a,
                          o = new XMLHttpRequest();
                        try {
                          o.responseType = `json`;
                        } catch {}
                        o.onreadystatechange = function () {
                          if (o.readyState === 4)
                            if (o.status === 200) ((a = e(o)), r(a));
                            else
                              try {
                                ((a = e(o)), r(a));
                              } catch (e) {
                                i && i(e);
                              }
                        };
                        try {
                          o.open([`G`, `E`, `T`].join(``), t, !0);
                        } catch {
                          o.open([`G`, `E`, `T`].join(``), n + `/` + t, !0);
                        }
                        o.send();
                      }
                      return { load: t };
                    })()),
                    e.data.type === `loadAnimation`)
                  )
                    a.assetLoader.load(
                      e.data.path,
                      e.data.fullPath,
                      function (t) {
                        (a.dataManager.completeData(t),
                          a.postMessage({
                            id: e.data.id,
                            payload: t,
                            status: `success`,
                          }));
                      },
                      function () {
                        a.postMessage({ id: e.data.id, status: `error` });
                      },
                    );
                  else if (e.data.type === `complete`) {
                    var n = e.data.animation;
                    (a.dataManager.completeData(n),
                      a.postMessage({
                        id: e.data.id,
                        payload: n,
                        status: `success`,
                      }));
                  } else
                    e.data.type === `loadData` &&
                      a.assetLoader.load(
                        e.data.path,
                        e.data.fullPath,
                        function (t) {
                          a.postMessage({
                            id: e.data.id,
                            payload: t,
                            status: `success`,
                          });
                        },
                        function () {
                          a.postMessage({ id: e.data.id, status: `error` });
                        },
                      );
                })),
                (r.onmessage = function (e) {
                  var n = e.data,
                    r = n.id,
                    i = t[r];
                  ((t[r] = null),
                    n.status === `success`
                      ? i.onComplete(n.payload)
                      : i.onError && i.onError());
                }));
            }
            function c(n, r) {
              e += 1;
              var i = `processId_` + e;
              return ((t[i] = { onComplete: n, onError: r }), i);
            }
            function l(e, t, n) {
              s();
              var i = c(t, n);
              r.postMessage({
                type: `loadAnimation`,
                path: e,
                fullPath: window.location.origin + window.location.pathname,
                id: i,
              });
            }
            function u(e, t, n) {
              s();
              var i = c(t, n);
              r.postMessage({
                type: `loadData`,
                path: e,
                fullPath: window.location.origin + window.location.pathname,
                id: i,
              });
            }
            function d(e, t, n) {
              s();
              var i = c(t, n);
              r.postMessage({ type: `complete`, animation: e, id: i });
            }
            return { loadAnimation: l, loadData: u, completeAnimation: d };
          })(),
          ImagePreloader = (function () {
            var e = (function () {
              var e = createTag(`canvas`);
              ((e.width = 1), (e.height = 1));
              var t = e.getContext(`2d`);
              return (
                (t.fillStyle = `rgba(0,0,0,0)`),
                t.fillRect(0, 0, 1, 1),
                e
              );
            })();
            function t() {
              ((this.loadedAssets += 1),
                this.loadedAssets === this.totalImages &&
                  this.loadedFootagesCount === this.totalFootages &&
                  this.imagesLoadedCb &&
                  this.imagesLoadedCb(null));
            }
            function n() {
              ((this.loadedFootagesCount += 1),
                this.loadedAssets === this.totalImages &&
                  this.loadedFootagesCount === this.totalFootages &&
                  this.imagesLoadedCb &&
                  this.imagesLoadedCb(null));
            }
            function r(e, t, n) {
              var r = ``;
              if (e.e) r = e.p;
              else if (t) {
                var i = e.p;
                (i.indexOf(`images/`) !== -1 && (i = i.split(`/`)[1]),
                  (r = t + i));
              } else ((r = n), (r += e.u ? e.u : ``), (r += e.p));
              return r;
            }
            function i(e) {
              var t = 0,
                n = setInterval(
                  function () {
                    ((e.getBBox().width || t > 500) &&
                      (this._imageLoaded(), clearInterval(n)),
                      (t += 1));
                  }.bind(this),
                  50,
                );
            }
            function a(t) {
              var n = r(t, this.assetsPath, this.path),
                i = createNS(`image`);
              (isSafari
                ? this.testImageLoaded(i)
                : i.addEventListener(`load`, this._imageLoaded, !1),
                i.addEventListener(
                  `error`,
                  function () {
                    ((a.img = e), this._imageLoaded());
                  }.bind(this),
                  !1,
                ),
                i.setAttributeNS(`http://www.w3.org/1999/xlink`, `href`, n),
                this._elementHelper.append
                  ? this._elementHelper.append(i)
                  : this._elementHelper.appendChild(i));
              var a = { img: i, assetData: t };
              return a;
            }
            function o(t) {
              var n = r(t, this.assetsPath, this.path),
                i = createTag(`img`);
              ((i.crossOrigin = `anonymous`),
                i.addEventListener(`load`, this._imageLoaded, !1),
                i.addEventListener(
                  `error`,
                  function () {
                    ((a.img = e), this._imageLoaded());
                  }.bind(this),
                  !1,
                ),
                (i.src = n));
              var a = { img: i, assetData: t };
              return a;
            }
            function s(e) {
              var t = { assetData: e },
                n = r(e, this.assetsPath, this.path);
              return (
                dataManager.loadData(
                  n,
                  function (e) {
                    ((t.img = e), this._footageLoaded());
                  }.bind(this),
                  function () {
                    ((t.img = {}), this._footageLoaded());
                  }.bind(this),
                ),
                t
              );
            }
            function c(e, t) {
              this.imagesLoadedCb = t;
              var n,
                r = e.length;
              for (n = 0; n < r; n += 1)
                e[n].layers ||
                  (!e[n].t || e[n].t === `seq`
                    ? ((this.totalImages += 1),
                      this.images.push(this._createImageData(e[n])))
                    : e[n].t === 3 &&
                      ((this.totalFootages += 1),
                      this.images.push(this.createFootageData(e[n]))));
            }
            function l(e) {
              this.path = e || ``;
            }
            function u(e) {
              this.assetsPath = e || ``;
            }
            function d(e) {
              for (var t = 0, n = this.images.length; t < n;) {
                if (this.images[t].assetData === e) return this.images[t].img;
                t += 1;
              }
              return null;
            }
            function f() {
              ((this.imagesLoadedCb = null), (this.images.length = 0));
            }
            function p() {
              return this.totalImages === this.loadedAssets;
            }
            function m() {
              return this.totalFootages === this.loadedFootagesCount;
            }
            function g(e, t) {
              e === `svg`
                ? ((this._elementHelper = t),
                  (this._createImageData = this.createImageData.bind(this)))
                : (this._createImageData = this.createImgData.bind(this));
            }
            function _() {
              ((this._imageLoaded = t.bind(this)),
                (this._footageLoaded = n.bind(this)),
                (this.testImageLoaded = i.bind(this)),
                (this.createFootageData = s.bind(this)),
                (this.assetsPath = ``),
                (this.path = ``),
                (this.totalImages = 0),
                (this.totalFootages = 0),
                (this.loadedAssets = 0),
                (this.loadedFootagesCount = 0),
                (this.imagesLoadedCb = null),
                (this.images = []));
            }
            return (
              (_.prototype = {
                loadAssets: c,
                setAssetsPath: u,
                setPath: l,
                loadedImages: p,
                loadedFootages: m,
                destroy: f,
                getAsset: d,
                createImgData: o,
                createImageData: a,
                imageLoaded: t,
                footageLoaded: n,
                setCacheType: g,
              }),
              _
            );
          })();
        function BaseEvent() {}
        BaseEvent.prototype = {
          triggerEvent: function (e, t) {
            if (this._cbs[e])
              for (var n = this._cbs[e], r = 0; r < n.length; r += 1) n[r](t);
          },
          addEventListener: function (e, t) {
            return (
              this._cbs[e] || (this._cbs[e] = []),
              this._cbs[e].push(t),
              function () {
                this.removeEventListener(e, t);
              }.bind(this)
            );
          },
          removeEventListener: function (e, t) {
            if (!t) this._cbs[e] = null;
            else if (this._cbs[e]) {
              for (var n = 0, r = this._cbs[e].length; n < r;)
                (this._cbs[e][n] === t && (this._cbs[e].splice(n, 1), --n, --r),
                  (n += 1));
              this._cbs[e].length || (this._cbs[e] = null);
            }
          },
        };
        var markerParser = (function () {
            function e(e) {
              for (
                var t = e.split(`\r
`),
                  n = {},
                  r,
                  i = 0,
                  a = 0;
                a < t.length;
                a += 1
              )
                ((r = t[a].split(`:`)),
                  r.length === 2 && ((n[r[0]] = r[1].trim()), (i += 1)));
              if (i === 0) throw Error();
              return n;
            }
            return function (t) {
              for (var n = [], r = 0; r < t.length; r += 1) {
                var i = t[r],
                  a = { time: i.tm, duration: i.dr };
                try {
                  a.payload = JSON.parse(t[r].cm);
                } catch {
                  try {
                    a.payload = e(t[r].cm);
                  } catch {
                    a.payload = { name: t[r].cm };
                  }
                }
                n.push(a);
              }
              return n;
            };
          })(),
          ProjectInterface = (function () {
            function e(e) {
              this.compositions.push(e);
            }
            return function () {
              function t(e) {
                for (var t = 0, n = this.compositions.length; t < n;) {
                  if (
                    this.compositions[t].data &&
                    this.compositions[t].data.nm === e
                  )
                    return (
                      this.compositions[t].prepareFrame &&
                        this.compositions[t].data.xt &&
                        this.compositions[t].prepareFrame(this.currentFrame),
                      this.compositions[t].compInterface
                    );
                  t += 1;
                }
                return null;
              }
              return (
                (t.compositions = []),
                (t.currentFrame = 0),
                (t.registerComposition = e),
                t
              );
            };
          })(),
          renderers = {},
          registerRenderer = function (e, t) {
            renderers[e] = t;
          };
        function getRenderer(e) {
          return renderers[e];
        }
        function getRegisteredRenderer() {
          if (renderers.canvas) return `canvas`;
          for (var e in renderers) if (renderers[e]) return e;
          return ``;
        }
        function _typeof$4(e) {
          "@babel/helpers - typeof";
          return (
            (_typeof$4 =
              typeof Symbol == `function` && typeof Symbol.iterator == `symbol`
                ? function (e) {
                    return typeof e;
                  }
                : function (e) {
                    return e &&
                      typeof Symbol == `function` &&
                      e.constructor === Symbol &&
                      e !== Symbol.prototype
                      ? `symbol`
                      : typeof e;
                  }),
            _typeof$4(e)
          );
        }
        var AnimationItem = function () {
          ((this._cbs = []),
            (this.name = ``),
            (this.path = ``),
            (this.isLoaded = !1),
            (this.currentFrame = 0),
            (this.currentRawFrame = 0),
            (this.firstFrame = 0),
            (this.totalFrames = 0),
            (this.frameRate = 0),
            (this.frameMult = 0),
            (this.playSpeed = 1),
            (this.playDirection = 1),
            (this.playCount = 0),
            (this.animationData = {}),
            (this.assets = []),
            (this.isPaused = !0),
            (this.autoplay = !1),
            (this.loop = !0),
            (this.renderer = null),
            (this.animationID = createElementID()),
            (this.assetsPath = ``),
            (this.timeCompleted = 0),
            (this.segmentPos = 0),
            (this.isSubframeEnabled = getSubframeEnabled()),
            (this.segments = []),
            (this._idle = !0),
            (this._completedLoop = !1),
            (this.projectInterface = ProjectInterface()),
            (this.imagePreloader = new ImagePreloader()),
            (this.audioController = audioControllerFactory()),
            (this.markers = []),
            (this.configAnimation = this.configAnimation.bind(this)),
            (this.onSetupError = this.onSetupError.bind(this)),
            (this.onSegmentComplete = this.onSegmentComplete.bind(this)),
            (this.drawnFrameEvent = new BMEnterFrameEvent(
              `drawnFrame`,
              0,
              0,
              0,
            )),
            (this.expressionsPlugin = getExpressionsPlugin()));
        };
        (extendPrototype([BaseEvent], AnimationItem),
          (AnimationItem.prototype.setParams = function (e) {
            (e.wrapper || e.container) &&
              (this.wrapper = e.wrapper || e.container);
            var t = `svg`;
            e.animType ? (t = e.animType) : e.renderer && (t = e.renderer);
            var n = getRenderer(t);
            ((this.renderer = new n(this, e.rendererSettings)),
              this.imagePreloader.setCacheType(
                t,
                this.renderer.globalData.defs,
              ),
              this.renderer.setProjectInterface(this.projectInterface),
              (this.animType = t),
              e.loop === `` ||
              e.loop === null ||
              e.loop === void 0 ||
              e.loop === !0
                ? (this.loop = !0)
                : e.loop === !1
                  ? (this.loop = !1)
                  : (this.loop = parseInt(e.loop, 10)),
              (this.autoplay = `autoplay` in e ? e.autoplay : !0),
              (this.name = e.name ? e.name : ``),
              (this.autoloadSegments = Object.prototype.hasOwnProperty.call(
                e,
                `autoloadSegments`,
              )
                ? e.autoloadSegments
                : !0),
              (this.assetsPath = e.assetsPath),
              (this.initialSegment = e.initialSegment),
              e.audioFactory &&
                this.audioController.setAudioFactory(e.audioFactory),
              e.animationData
                ? this.setupAnimation(e.animationData)
                : e.path &&
                  (e.path.lastIndexOf(`\\`) === -1
                    ? (this.path = e.path.substr(
                        0,
                        e.path.lastIndexOf(`/`) + 1,
                      ))
                    : (this.path = e.path.substr(
                        0,
                        e.path.lastIndexOf(`\\`) + 1,
                      )),
                  (this.fileName = e.path.substr(e.path.lastIndexOf(`/`) + 1)),
                  (this.fileName = this.fileName.substr(
                    0,
                    this.fileName.lastIndexOf(`.json`),
                  )),
                  dataManager.loadAnimation(
                    e.path,
                    this.configAnimation,
                    this.onSetupError,
                  )));
          }),
          (AnimationItem.prototype.onSetupError = function () {
            this.trigger(`data_failed`);
          }),
          (AnimationItem.prototype.setupAnimation = function (e) {
            dataManager.completeAnimation(e, this.configAnimation);
          }),
          (AnimationItem.prototype.setData = function (e, t) {
            t && _typeof$4(t) !== `object` && (t = JSON.parse(t));
            var n = { wrapper: e, animationData: t },
              r = e.attributes;
            ((n.path = r.getNamedItem(`data-animation-path`)
              ? r.getNamedItem(`data-animation-path`).value
              : r.getNamedItem(`data-bm-path`)
                ? r.getNamedItem(`data-bm-path`).value
                : r.getNamedItem(`bm-path`)
                  ? r.getNamedItem(`bm-path`).value
                  : ``),
              (n.animType = r.getNamedItem(`data-anim-type`)
                ? r.getNamedItem(`data-anim-type`).value
                : r.getNamedItem(`data-bm-type`)
                  ? r.getNamedItem(`data-bm-type`).value
                  : r.getNamedItem(`bm-type`)
                    ? r.getNamedItem(`bm-type`).value
                    : r.getNamedItem(`data-bm-renderer`)
                      ? r.getNamedItem(`data-bm-renderer`).value
                      : r.getNamedItem(`bm-renderer`)
                        ? r.getNamedItem(`bm-renderer`).value
                        : getRegisteredRenderer() || `canvas`));
            var i = r.getNamedItem(`data-anim-loop`)
              ? r.getNamedItem(`data-anim-loop`).value
              : r.getNamedItem(`data-bm-loop`)
                ? r.getNamedItem(`data-bm-loop`).value
                : r.getNamedItem(`bm-loop`)
                  ? r.getNamedItem(`bm-loop`).value
                  : ``;
            (i === `false`
              ? (n.loop = !1)
              : i === `true`
                ? (n.loop = !0)
                : i !== `` && (n.loop = parseInt(i, 10)),
              (n.autoplay =
                (r.getNamedItem(`data-anim-autoplay`)
                  ? r.getNamedItem(`data-anim-autoplay`).value
                  : r.getNamedItem(`data-bm-autoplay`)
                    ? r.getNamedItem(`data-bm-autoplay`).value
                    : r.getNamedItem(`bm-autoplay`)
                      ? r.getNamedItem(`bm-autoplay`).value
                      : !0) !== `false`),
              (n.name = r.getNamedItem(`data-name`)
                ? r.getNamedItem(`data-name`).value
                : r.getNamedItem(`data-bm-name`)
                  ? r.getNamedItem(`data-bm-name`).value
                  : r.getNamedItem(`bm-name`)
                    ? r.getNamedItem(`bm-name`).value
                    : ``),
              (r.getNamedItem(`data-anim-prerender`)
                ? r.getNamedItem(`data-anim-prerender`).value
                : r.getNamedItem(`data-bm-prerender`)
                  ? r.getNamedItem(`data-bm-prerender`).value
                  : r.getNamedItem(`bm-prerender`)
                    ? r.getNamedItem(`bm-prerender`).value
                    : ``) === `false` && (n.prerender = !1),
              n.path ? this.setParams(n) : this.trigger(`destroy`));
          }),
          (AnimationItem.prototype.includeLayers = function (e) {
            e.op > this.animationData.op &&
              ((this.animationData.op = e.op),
              (this.totalFrames = Math.floor(e.op - this.animationData.ip)));
            var t = this.animationData.layers,
              n,
              r = t.length,
              i = e.layers,
              a,
              o = i.length;
            for (a = 0; a < o; a += 1)
              for (n = 0; n < r;) {
                if (t[n].id === i[a].id) {
                  t[n] = i[a];
                  break;
                }
                n += 1;
              }
            if (
              ((e.chars || e.fonts) &&
                (this.renderer.globalData.fontManager.addChars(e.chars),
                this.renderer.globalData.fontManager.addFonts(
                  e.fonts,
                  this.renderer.globalData.defs,
                )),
              e.assets)
            )
              for (r = e.assets.length, n = 0; n < r; n += 1)
                this.animationData.assets.push(e.assets[n]);
            ((this.animationData.__complete = !1),
              dataManager.completeAnimation(
                this.animationData,
                this.onSegmentComplete,
              ));
          }),
          (AnimationItem.prototype.onSegmentComplete = function (e) {
            this.animationData = e;
            var t = getExpressionsPlugin();
            (t && t.initExpressions(this), this.loadNextSegment());
          }),
          (AnimationItem.prototype.loadNextSegment = function () {
            var e = this.animationData.segments;
            if (!e || e.length === 0 || !this.autoloadSegments) {
              (this.trigger(`data_ready`),
                (this.timeCompleted = this.totalFrames));
              return;
            }
            var t = e.shift();
            this.timeCompleted = t.time * this.frameRate;
            var n = this.path + this.fileName + `_` + this.segmentPos + `.json`;
            ((this.segmentPos += 1),
              dataManager.loadData(
                n,
                this.includeLayers.bind(this),
                function () {
                  this.trigger(`data_failed`);
                }.bind(this),
              ));
          }),
          (AnimationItem.prototype.loadSegments = function () {
            (this.animationData.segments ||
              (this.timeCompleted = this.totalFrames),
              this.loadNextSegment());
          }),
          (AnimationItem.prototype.imagesLoaded = function () {
            (this.trigger(`loaded_images`), this.checkLoaded());
          }),
          (AnimationItem.prototype.preloadImages = function () {
            (this.imagePreloader.setAssetsPath(this.assetsPath),
              this.imagePreloader.setPath(this.path),
              this.imagePreloader.loadAssets(
                this.animationData.assets,
                this.imagesLoaded.bind(this),
              ));
          }),
          (AnimationItem.prototype.configAnimation = function (e) {
            if (this.renderer)
              try {
                ((this.animationData = e),
                  this.initialSegment
                    ? ((this.totalFrames = Math.floor(
                        this.initialSegment[1] - this.initialSegment[0],
                      )),
                      (this.firstFrame = Math.round(this.initialSegment[0])))
                    : ((this.totalFrames = Math.floor(
                        this.animationData.op - this.animationData.ip,
                      )),
                      (this.firstFrame = Math.round(this.animationData.ip))),
                  this.renderer.configAnimation(e),
                  (e.assets ||= []),
                  (this.assets = this.animationData.assets),
                  (this.frameRate = this.animationData.fr),
                  (this.frameMult = this.animationData.fr / 1e3),
                  this.renderer.searchExtraCompositions(e.assets),
                  (this.markers = markerParser(e.markers || [])),
                  this.trigger(`config_ready`),
                  this.preloadImages(),
                  this.loadSegments(),
                  this.updaFrameModifier(),
                  this.waitForFontsLoaded(),
                  this.isPaused && this.audioController.pause());
              } catch (e) {
                this.triggerConfigError(e);
              }
          }),
          (AnimationItem.prototype.waitForFontsLoaded = function () {
            this.renderer &&
              (this.renderer.globalData.fontManager.isLoaded
                ? this.checkLoaded()
                : setTimeout(this.waitForFontsLoaded.bind(this), 20));
          }),
          (AnimationItem.prototype.checkLoaded = function () {
            if (
              !this.isLoaded &&
              this.renderer.globalData.fontManager.isLoaded &&
              (this.imagePreloader.loadedImages() ||
                this.renderer.rendererType !== `canvas`) &&
              this.imagePreloader.loadedFootages()
            ) {
              this.isLoaded = !0;
              var e = getExpressionsPlugin();
              (e && e.initExpressions(this),
                this.renderer.initItems(),
                setTimeout(
                  function () {
                    this.trigger(`DOMLoaded`);
                  }.bind(this),
                  0,
                ),
                this.gotoFrame(),
                this.autoplay && this.play());
            }
          }),
          (AnimationItem.prototype.resize = function (e, t) {
            var n = typeof e == `number` ? e : void 0,
              r = typeof t == `number` ? t : void 0;
            this.renderer.updateContainerSize(n, r);
          }),
          (AnimationItem.prototype.setSubframe = function (e) {
            this.isSubframeEnabled = !!e;
          }),
          (AnimationItem.prototype.gotoFrame = function () {
            ((this.currentFrame = this.isSubframeEnabled
              ? this.currentRawFrame
              : ~~this.currentRawFrame),
              this.timeCompleted !== this.totalFrames &&
                this.currentFrame > this.timeCompleted &&
                (this.currentFrame = this.timeCompleted),
              this.trigger(`enterFrame`),
              this.renderFrame(),
              this.trigger(`drawnFrame`));
          }),
          (AnimationItem.prototype.renderFrame = function () {
            if (!(this.isLoaded === !1 || !this.renderer))
              try {
                (this.expressionsPlugin && this.expressionsPlugin.resetFrame(),
                  this.renderer.renderFrame(
                    this.currentFrame + this.firstFrame,
                  ));
              } catch (e) {
                this.triggerRenderFrameError(e);
              }
          }),
          (AnimationItem.prototype.play = function (e) {
            (e && this.name !== e) ||
              (this.isPaused === !0 &&
                ((this.isPaused = !1),
                this.trigger(`_play`),
                this.audioController.resume(),
                this._idle && ((this._idle = !1), this.trigger(`_active`))));
          }),
          (AnimationItem.prototype.pause = function (e) {
            (e && this.name !== e) ||
              (this.isPaused === !1 &&
                ((this.isPaused = !0),
                this.trigger(`_pause`),
                (this._idle = !0),
                this.trigger(`_idle`),
                this.audioController.pause()));
          }),
          (AnimationItem.prototype.togglePause = function (e) {
            (e && this.name !== e) ||
              (this.isPaused === !0 ? this.play() : this.pause());
          }),
          (AnimationItem.prototype.stop = function (e) {
            (e && this.name !== e) ||
              (this.pause(),
              (this.playCount = 0),
              (this._completedLoop = !1),
              this.setCurrentRawFrameValue(0));
          }),
          (AnimationItem.prototype.getMarkerData = function (e) {
            for (var t, n = 0; n < this.markers.length; n += 1)
              if (((t = this.markers[n]), t.payload && t.payload.name === e))
                return t;
            return null;
          }),
          (AnimationItem.prototype.goToAndStop = function (e, t, n) {
            if (!(n && this.name !== n)) {
              var r = Number(e);
              if (isNaN(r)) {
                var i = this.getMarkerData(e);
                i && this.goToAndStop(i.time, !0);
              } else
                t
                  ? this.setCurrentRawFrameValue(e)
                  : this.setCurrentRawFrameValue(e * this.frameModifier);
              this.pause();
            }
          }),
          (AnimationItem.prototype.goToAndPlay = function (e, t, n) {
            if (!(n && this.name !== n)) {
              var r = Number(e);
              if (isNaN(r)) {
                var i = this.getMarkerData(e);
                i &&
                  (i.duration
                    ? this.playSegments([i.time, i.time + i.duration], !0)
                    : this.goToAndStop(i.time, !0));
              } else this.goToAndStop(r, t, n);
              this.play();
            }
          }),
          (AnimationItem.prototype.advanceTime = function (e) {
            if (!(this.isPaused === !0 || this.isLoaded === !1)) {
              var t = this.currentRawFrame + e * this.frameModifier,
                n = !1;
              (t >= this.totalFrames - 1 && this.frameModifier > 0
                ? !this.loop || this.playCount === this.loop
                  ? this.checkSegments(
                      t > this.totalFrames ? t % this.totalFrames : 0,
                    ) || ((n = !0), (t = this.totalFrames - 1))
                  : t >= this.totalFrames
                    ? ((this.playCount += 1),
                      this.checkSegments(t % this.totalFrames) ||
                        (this.setCurrentRawFrameValue(t % this.totalFrames),
                        (this._completedLoop = !0),
                        this.trigger(`loopComplete`)))
                    : this.setCurrentRawFrameValue(t)
                : t < 0
                  ? this.checkSegments(t % this.totalFrames) ||
                    (this.loop && !(this.playCount-- <= 0 && this.loop !== !0)
                      ? (this.setCurrentRawFrameValue(
                          this.totalFrames + (t % this.totalFrames),
                        ),
                        this._completedLoop
                          ? this.trigger(`loopComplete`)
                          : (this._completedLoop = !0))
                      : ((n = !0), (t = 0)))
                  : this.setCurrentRawFrameValue(t),
                n &&
                  (this.setCurrentRawFrameValue(t),
                  this.pause(),
                  this.trigger(`complete`)));
            }
          }),
          (AnimationItem.prototype.adjustSegment = function (e, t) {
            ((this.playCount = 0),
              e[1] < e[0]
                ? (this.frameModifier > 0 &&
                    (this.playSpeed < 0
                      ? this.setSpeed(-this.playSpeed)
                      : this.setDirection(-1)),
                  (this.totalFrames = e[0] - e[1]),
                  (this.timeCompleted = this.totalFrames),
                  (this.firstFrame = e[1]),
                  this.setCurrentRawFrameValue(this.totalFrames - 0.001 - t))
                : e[1] > e[0] &&
                  (this.frameModifier < 0 &&
                    (this.playSpeed < 0
                      ? this.setSpeed(-this.playSpeed)
                      : this.setDirection(1)),
                  (this.totalFrames = e[1] - e[0]),
                  (this.timeCompleted = this.totalFrames),
                  (this.firstFrame = e[0]),
                  this.setCurrentRawFrameValue(0.001 + t)),
              this.trigger(`segmentStart`));
          }),
          (AnimationItem.prototype.setSegment = function (e, t) {
            var n = -1;
            (this.isPaused &&
              (this.currentRawFrame + this.firstFrame < e
                ? (n = e)
                : this.currentRawFrame + this.firstFrame > t && (n = t - e)),
              (this.firstFrame = e),
              (this.totalFrames = t - e),
              (this.timeCompleted = this.totalFrames),
              n !== -1 && this.goToAndStop(n, !0));
          }),
          (AnimationItem.prototype.playSegments = function (e, t) {
            if (
              (t && (this.segments.length = 0), _typeof$4(e[0]) === `object`)
            ) {
              var n,
                r = e.length;
              for (n = 0; n < r; n += 1) this.segments.push(e[n]);
            } else this.segments.push(e);
            (this.segments.length &&
              t &&
              this.adjustSegment(this.segments.shift(), 0),
              this.isPaused && this.play());
          }),
          (AnimationItem.prototype.resetSegments = function (e) {
            ((this.segments.length = 0),
              this.segments.push([
                this.animationData.ip,
                this.animationData.op,
              ]),
              e && this.checkSegments(0));
          }),
          (AnimationItem.prototype.checkSegments = function (e) {
            return this.segments.length
              ? (this.adjustSegment(this.segments.shift(), e), !0)
              : !1;
          }),
          (AnimationItem.prototype.destroy = function (e) {
            (e && this.name !== e) ||
              !this.renderer ||
              (this.renderer.destroy(),
              this.imagePreloader.destroy(),
              this.trigger(`destroy`),
              (this._cbs = null),
              (this.onEnterFrame = null),
              (this.onLoopComplete = null),
              (this.onComplete = null),
              (this.onSegmentStart = null),
              (this.onDestroy = null),
              (this.renderer = null),
              (this.expressionsPlugin = null),
              (this.imagePreloader = null),
              (this.projectInterface = null));
          }),
          (AnimationItem.prototype.setCurrentRawFrameValue = function (e) {
            ((this.currentRawFrame = e), this.gotoFrame());
          }),
          (AnimationItem.prototype.setSpeed = function (e) {
            ((this.playSpeed = e), this.updaFrameModifier());
          }),
          (AnimationItem.prototype.setDirection = function (e) {
            ((this.playDirection = e < 0 ? -1 : 1), this.updaFrameModifier());
          }),
          (AnimationItem.prototype.setLoop = function (e) {
            this.loop = e;
          }),
          (AnimationItem.prototype.setVolume = function (e, t) {
            (t && this.name !== t) || this.audioController.setVolume(e);
          }),
          (AnimationItem.prototype.getVolume = function () {
            return this.audioController.getVolume();
          }),
          (AnimationItem.prototype.mute = function (e) {
            (e && this.name !== e) || this.audioController.mute();
          }),
          (AnimationItem.prototype.unmute = function (e) {
            (e && this.name !== e) || this.audioController.unmute();
          }),
          (AnimationItem.prototype.updaFrameModifier = function () {
            ((this.frameModifier =
              this.frameMult * this.playSpeed * this.playDirection),
              this.audioController.setRate(
                this.playSpeed * this.playDirection,
              ));
          }),
          (AnimationItem.prototype.getPath = function () {
            return this.path;
          }),
          (AnimationItem.prototype.getAssetsPath = function (e) {
            var t = ``;
            if (e.e) t = e.p;
            else if (this.assetsPath) {
              var n = e.p;
              (n.indexOf(`images/`) !== -1 && (n = n.split(`/`)[1]),
                (t = this.assetsPath + n));
            } else ((t = this.path), (t += e.u ? e.u : ``), (t += e.p));
            return t;
          }),
          (AnimationItem.prototype.getAssetData = function (e) {
            for (var t = 0, n = this.assets.length; t < n;) {
              if (e === this.assets[t].id) return this.assets[t];
              t += 1;
            }
            return null;
          }),
          (AnimationItem.prototype.hide = function () {
            this.renderer.hide();
          }),
          (AnimationItem.prototype.show = function () {
            this.renderer.show();
          }),
          (AnimationItem.prototype.getDuration = function (e) {
            return e ? this.totalFrames : this.totalFrames / this.frameRate;
          }),
          (AnimationItem.prototype.updateDocumentData = function (e, t, n) {
            try {
              this.renderer.getElementByPath(e).updateDocumentData(t, n);
            } catch {}
          }),
          (AnimationItem.prototype.trigger = function (e) {
            if (this._cbs && this._cbs[e])
              switch (e) {
                case `enterFrame`:
                  this.triggerEvent(
                    e,
                    new BMEnterFrameEvent(
                      e,
                      this.currentFrame,
                      this.totalFrames,
                      this.frameModifier,
                    ),
                  );
                  break;
                case `drawnFrame`:
                  ((this.drawnFrameEvent.currentTime = this.currentFrame),
                    (this.drawnFrameEvent.totalTime = this.totalFrames),
                    (this.drawnFrameEvent.direction = this.frameModifier),
                    this.triggerEvent(e, this.drawnFrameEvent));
                  break;
                case `loopComplete`:
                  this.triggerEvent(
                    e,
                    new BMCompleteLoopEvent(
                      e,
                      this.loop,
                      this.playCount,
                      this.frameMult,
                    ),
                  );
                  break;
                case `complete`:
                  this.triggerEvent(e, new BMCompleteEvent(e, this.frameMult));
                  break;
                case `segmentStart`:
                  this.triggerEvent(
                    e,
                    new BMSegmentStartEvent(
                      e,
                      this.firstFrame,
                      this.totalFrames,
                    ),
                  );
                  break;
                case `destroy`:
                  this.triggerEvent(e, new BMDestroyEvent(e, this));
                  break;
                default:
                  this.triggerEvent(e);
              }
            (e === `enterFrame` &&
              this.onEnterFrame &&
              this.onEnterFrame.call(
                this,
                new BMEnterFrameEvent(
                  e,
                  this.currentFrame,
                  this.totalFrames,
                  this.frameMult,
                ),
              ),
              e === `loopComplete` &&
                this.onLoopComplete &&
                this.onLoopComplete.call(
                  this,
                  new BMCompleteLoopEvent(
                    e,
                    this.loop,
                    this.playCount,
                    this.frameMult,
                  ),
                ),
              e === `complete` &&
                this.onComplete &&
                this.onComplete.call(
                  this,
                  new BMCompleteEvent(e, this.frameMult),
                ),
              e === `segmentStart` &&
                this.onSegmentStart &&
                this.onSegmentStart.call(
                  this,
                  new BMSegmentStartEvent(e, this.firstFrame, this.totalFrames),
                ),
              e === `destroy` &&
                this.onDestroy &&
                this.onDestroy.call(this, new BMDestroyEvent(e, this)));
          }),
          (AnimationItem.prototype.triggerRenderFrameError = function (e) {
            var t = new BMRenderFrameErrorEvent(e, this.currentFrame);
            (this.triggerEvent(`error`, t),
              this.onError && this.onError.call(this, t));
          }),
          (AnimationItem.prototype.triggerConfigError = function (e) {
            var t = new BMConfigErrorEvent(e, this.currentFrame);
            (this.triggerEvent(`error`, t),
              this.onError && this.onError.call(this, t));
          }));
        var animationManager = (function () {
            var e = {},
              t = [],
              n = 0,
              r = 0,
              i = 0,
              a = !0,
              o = !1;
            function s(e) {
              for (var n = 0, i = e.target; n < r;)
                (t[n].animation === i &&
                  (t.splice(n, 1), --n, --r, i.isPaused || d()),
                  (n += 1));
            }
            function c(e, n) {
              if (!e) return null;
              for (var i = 0; i < r;) {
                if (t[i].elem === e && t[i].elem !== null)
                  return t[i].animation;
                i += 1;
              }
              var a = new AnimationItem();
              return (f(a, e), a.setData(e, n), a);
            }
            function l() {
              var e,
                n = t.length,
                r = [];
              for (e = 0; e < n; e += 1) r.push(t[e].animation);
              return r;
            }
            function u() {
              ((i += 1), k());
            }
            function d() {
              --i;
            }
            function f(e, n) {
              (e.addEventListener(`destroy`, s),
                e.addEventListener(`_active`, u),
                e.addEventListener(`_idle`, d),
                t.push({ elem: n, animation: e }),
                (r += 1));
            }
            function p(e) {
              var t = new AnimationItem();
              return (f(t, null), t.setParams(e), t);
            }
            function m(e, n) {
              var i;
              for (i = 0; i < r; i += 1) t[i].animation.setSpeed(e, n);
            }
            function g(e, n) {
              var i;
              for (i = 0; i < r; i += 1) t[i].animation.setDirection(e, n);
            }
            function _(e) {
              var n;
              for (n = 0; n < r; n += 1) t[n].animation.play(e);
            }
            function y(e) {
              var s = e - n,
                c;
              for (c = 0; c < r; c += 1) t[c].animation.advanceTime(s);
              ((n = e), i && !o ? window.requestAnimationFrame(y) : (a = !0));
            }
            function b(e) {
              ((n = e), window.requestAnimationFrame(y));
            }
            function x(e) {
              var n;
              for (n = 0; n < r; n += 1) t[n].animation.pause(e);
            }
            function S(e, n, i) {
              var a;
              for (a = 0; a < r; a += 1) t[a].animation.goToAndStop(e, n, i);
            }
            function C(e) {
              var n;
              for (n = 0; n < r; n += 1) t[n].animation.stop(e);
            }
            function T(e) {
              var n;
              for (n = 0; n < r; n += 1) t[n].animation.togglePause(e);
            }
            function E(e) {
              var n;
              for (n = r - 1; n >= 0; --n) t[n].animation.destroy(e);
            }
            function D(e, t, n) {
              var r = [].concat(
                  [].slice.call(document.getElementsByClassName(`lottie`)),
                  [].slice.call(document.getElementsByClassName(`bodymovin`)),
                ),
                i,
                a = r.length;
              for (i = 0; i < a; i += 1)
                (n && r[i].setAttribute(`data-bm-type`, n), c(r[i], e));
              if (t && a === 0) {
                n ||= `svg`;
                var o = document.getElementsByTagName(`body`)[0];
                o.innerText = ``;
                var s = createTag(`div`);
                ((s.style.width = `100%`),
                  (s.style.height = `100%`),
                  s.setAttribute(`data-bm-type`, n),
                  o.appendChild(s),
                  c(s, e));
              }
            }
            function O() {
              var e;
              for (e = 0; e < r; e += 1) t[e].animation.resize();
            }
            function k() {
              !o && i && (a &&= (window.requestAnimationFrame(b), !1));
            }
            function A() {
              o = !0;
            }
            function j() {
              ((o = !1), k());
            }
            function M(e, n) {
              var i;
              for (i = 0; i < r; i += 1) t[i].animation.setVolume(e, n);
            }
            function N(e) {
              var n;
              for (n = 0; n < r; n += 1) t[n].animation.mute(e);
            }
            function P(e) {
              var n;
              for (n = 0; n < r; n += 1) t[n].animation.unmute(e);
            }
            return (
              (e.registerAnimation = c),
              (e.loadAnimation = p),
              (e.setSpeed = m),
              (e.setDirection = g),
              (e.play = _),
              (e.pause = x),
              (e.stop = C),
              (e.togglePause = T),
              (e.searchAnimations = D),
              (e.resize = O),
              (e.goToAndStop = S),
              (e.destroy = E),
              (e.freeze = A),
              (e.unfreeze = j),
              (e.setVolume = M),
              (e.mute = N),
              (e.unmute = P),
              (e.getRegisteredAnimations = l),
              e
            );
          })(),
          BezierFactory = (function () {
            var e = {};
            e.getBezierEasing = n;
            var t = {};
            function n(e, n, r, i, a) {
              var o =
                a ||
                (`bez_` + e + `_` + n + `_` + r + `_` + i).replace(/\./g, `p`);
              if (t[o]) return t[o];
              var s = new y([e, n, r, i]);
              return ((t[o] = s), s);
            }
            var r = 4,
              i = 0.001,
              a = 1e-7,
              o = 10,
              s = 11,
              c = 1 / (s - 1),
              l = typeof Float32Array == `function`;
            function u(e, t) {
              return 1 - 3 * t + 3 * e;
            }
            function d(e, t) {
              return 3 * t - 6 * e;
            }
            function f(e) {
              return 3 * e;
            }
            function p(e, t, n) {
              return ((u(t, n) * e + d(t, n)) * e + f(t)) * e;
            }
            function m(e, t, n) {
              return 3 * u(t, n) * e * e + 2 * d(t, n) * e + f(t);
            }
            function g(e, t, n, r, i) {
              var s,
                c,
                l = 0;
              do
                ((c = t + (n - t) / 2),
                  (s = p(c, r, i) - e),
                  s > 0 ? (n = c) : (t = c));
              while (Math.abs(s) > a && ++l < o);
              return c;
            }
            function _(e, t, n, i) {
              for (var a = 0; a < r; ++a) {
                var o = m(t, n, i);
                if (o === 0) return t;
                var s = p(t, n, i) - e;
                t -= s / o;
              }
              return t;
            }
            function y(e) {
              ((this._p = e),
                (this._mSampleValues = l ? new Float32Array(s) : Array(s)),
                (this._precomputed = !1),
                (this.get = this.get.bind(this)));
            }
            return (
              (y.prototype = {
                get: function (e) {
                  var t = this._p[0],
                    n = this._p[1],
                    r = this._p[2],
                    i = this._p[3];
                  return (
                    this._precomputed || this._precompute(),
                    t === n && r === i
                      ? e
                      : e === 0
                        ? 0
                        : e === 1
                          ? 1
                          : p(this._getTForX(e), n, i)
                  );
                },
                _precompute: function () {
                  var e = this._p[0],
                    t = this._p[1],
                    n = this._p[2],
                    r = this._p[3];
                  ((this._precomputed = !0),
                    (e !== t || n !== r) && this._calcSampleValues());
                },
                _calcSampleValues: function () {
                  for (var e = this._p[0], t = this._p[2], n = 0; n < s; ++n)
                    this._mSampleValues[n] = p(n * c, e, t);
                },
                _getTForX: function (e) {
                  for (
                    var t = this._p[0],
                      n = this._p[2],
                      r = this._mSampleValues,
                      a = 0,
                      o = 1,
                      l = s - 1;
                    o !== l && r[o] <= e;
                    ++o
                  )
                    a += c;
                  --o;
                  var u = (e - r[o]) / (r[o + 1] - r[o]),
                    d = a + u * c,
                    f = m(d, t, n);
                  return f >= i
                    ? _(e, d, t, n)
                    : f === 0
                      ? d
                      : g(e, a, a + c, t, n);
                },
              }),
              e
            );
          })(),
          pooling = (function () {
            function e(e) {
              return e.concat(createSizedArray(e.length));
            }
            return { double: e };
          })(),
          poolFactory = (function () {
            return function (e, t, n) {
              var r = 0,
                i = e,
                a = createSizedArray(i),
                o = { newElement: s, release: c };
              function s() {
                var e;
                return (r ? (--r, (e = a[r])) : (e = t()), e);
              }
              function c(e) {
                (r === i && ((a = pooling.double(a)), (i *= 2)),
                  n && n(e),
                  (a[r] = e),
                  (r += 1));
              }
              return o;
            };
          })(),
          bezierLengthPool = (function () {
            function e() {
              return {
                addedLength: 0,
                percents: createTypedArray(
                  `float32`,
                  getDefaultCurveSegments(),
                ),
                lengths: createTypedArray(`float32`, getDefaultCurveSegments()),
              };
            }
            return poolFactory(8, e);
          })(),
          segmentsLengthPool = (function () {
            function e() {
              return { lengths: [], totalLength: 0 };
            }
            function t(e) {
              var t,
                n = e.lengths.length;
              for (t = 0; t < n; t += 1) bezierLengthPool.release(e.lengths[t]);
              e.lengths.length = 0;
            }
            return poolFactory(8, e, t);
          })();
        function bezFunction() {
          var e = Math;
          function t(e, t, n, r, i, a) {
            var o = e * r + t * i + n * a - i * r - a * e - n * t;
            return o > -0.001 && o < 0.001;
          }
          function n(n, r, i, a, o, s, c, l, u) {
            if (i === 0 && s === 0 && u === 0) return t(n, r, a, o, c, l);
            var d = e.sqrt(e.pow(a - n, 2) + e.pow(o - r, 2) + e.pow(s - i, 2)),
              f = e.sqrt(e.pow(c - n, 2) + e.pow(l - r, 2) + e.pow(u - i, 2)),
              p = e.sqrt(e.pow(c - a, 2) + e.pow(l - o, 2) + e.pow(u - s, 2)),
              m =
                d > f
                  ? d > p
                    ? d - f - p
                    : p - f - d
                  : p > f
                    ? p - f - d
                    : f - d - p;
            return m > -1e-4 && m < 1e-4;
          }
          var r = (function () {
            return function (e, t, n, r) {
              var i = getDefaultCurveSegments(),
                a,
                o,
                s,
                c,
                l,
                u = 0,
                d,
                f = [],
                p = [],
                m = bezierLengthPool.newElement();
              for (s = n.length, a = 0; a < i; a += 1) {
                for (l = a / (i - 1), d = 0, o = 0; o < s; o += 1)
                  ((c =
                    bmPow(1 - l, 3) * e[o] +
                    3 * bmPow(1 - l, 2) * l * n[o] +
                    3 * (1 - l) * bmPow(l, 2) * r[o] +
                    bmPow(l, 3) * t[o]),
                    (f[o] = c),
                    p[o] !== null && (d += bmPow(f[o] - p[o], 2)),
                    (p[o] = f[o]));
                (d && ((d = bmSqrt(d)), (u += d)),
                  (m.percents[a] = l),
                  (m.lengths[a] = u));
              }
              return ((m.addedLength = u), m);
            };
          })();
          function i(e) {
            var t = segmentsLengthPool.newElement(),
              n = e.c,
              i = e.v,
              a = e.o,
              o = e.i,
              s,
              c = e._length,
              l = t.lengths,
              u = 0;
            for (s = 0; s < c - 1; s += 1)
              ((l[s] = r(i[s], i[s + 1], a[s], o[s + 1])),
                (u += l[s].addedLength));
            return (
              n &&
                c &&
                ((l[s] = r(i[s], i[0], a[s], o[0])), (u += l[s].addedLength)),
              (t.totalLength = u),
              t
            );
          }
          function a(e) {
            ((this.segmentLength = 0), (this.points = Array(e)));
          }
          function o(e, t) {
            ((this.partialLength = e), (this.point = t));
          }
          var s = (function () {
            var e = {};
            return function (n, r, i, s) {
              var c = (
                n[0] +
                `_` +
                n[1] +
                `_` +
                r[0] +
                `_` +
                r[1] +
                `_` +
                i[0] +
                `_` +
                i[1] +
                `_` +
                s[0] +
                `_` +
                s[1]
              ).replace(/\./g, `p`);
              if (!e[c]) {
                var l = getDefaultCurveSegments(),
                  u,
                  d,
                  f,
                  p,
                  m,
                  g = 0,
                  _,
                  y,
                  b = null;
                n.length === 2 &&
                  (n[0] !== r[0] || n[1] !== r[1]) &&
                  t(n[0], n[1], r[0], r[1], n[0] + i[0], n[1] + i[1]) &&
                  t(n[0], n[1], r[0], r[1], r[0] + s[0], r[1] + s[1]) &&
                  (l = 2);
                var x = new a(l);
                for (f = i.length, u = 0; u < l; u += 1) {
                  for (
                    y = createSizedArray(f), m = u / (l - 1), _ = 0, d = 0;
                    d < f;
                    d += 1
                  )
                    ((p =
                      bmPow(1 - m, 3) * n[d] +
                      3 * bmPow(1 - m, 2) * m * (n[d] + i[d]) +
                      3 * (1 - m) * bmPow(m, 2) * (r[d] + s[d]) +
                      bmPow(m, 3) * r[d]),
                      (y[d] = p),
                      b !== null && (_ += bmPow(y[d] - b[d], 2)));
                  ((_ = bmSqrt(_)),
                    (g += _),
                    (x.points[u] = new o(_, y)),
                    (b = y));
                }
                ((x.segmentLength = g), (e[c] = x));
              }
              return e[c];
            };
          })();
          function c(e, t) {
            var n = t.percents,
              r = t.lengths,
              i = n.length,
              a = bmFloor((i - 1) * e),
              o = e * t.addedLength,
              s = 0;
            if (a === i - 1 || a === 0 || o === r[a]) return n[a];
            for (var c = r[a] > o ? -1 : 1, l = !0; l;)
              if (
                (r[a] <= o && r[a + 1] > o
                  ? ((s = (o - r[a]) / (r[a + 1] - r[a])), (l = !1))
                  : (a += c),
                a < 0 || a >= i - 1)
              ) {
                if (a === i - 1) return n[a];
                l = !1;
              }
            return n[a] + (n[a + 1] - n[a]) * s;
          }
          function l(t, n, r, i, a, o) {
            var s = c(a, o),
              l = 1 - s;
            return [
              e.round(
                (l * l * l * t[0] +
                  (s * l * l + l * s * l + l * l * s) * r[0] +
                  (s * s * l + l * s * s + s * l * s) * i[0] +
                  s * s * s * n[0]) *
                  1e3,
              ) / 1e3,
              e.round(
                (l * l * l * t[1] +
                  (s * l * l + l * s * l + l * l * s) * r[1] +
                  (s * s * l + l * s * s + s * l * s) * i[1] +
                  s * s * s * n[1]) *
                  1e3,
              ) / 1e3,
            ];
          }
          var u = createTypedArray(`float32`, 8);
          function d(t, n, r, i, a, o, s) {
            a < 0 ? (a = 0) : a > 1 && (a = 1);
            var l = c(a, s);
            o = o > 1 ? 1 : o;
            var d = c(o, s),
              f,
              p = t.length,
              m = 1 - l,
              g = 1 - d,
              _ = m * m * m,
              y = l * m * m * 3,
              b = l * l * m * 3,
              x = l * l * l,
              S = m * m * g,
              C = l * m * g + m * l * g + m * m * d,
              T = l * l * g + m * l * d + l * m * d,
              E = l * l * d,
              D = m * g * g,
              O = l * g * g + m * d * g + m * g * d,
              k = l * d * g + m * d * d + l * g * d,
              A = l * d * d,
              j = g * g * g,
              M = d * g * g + g * d * g + g * g * d,
              N = d * d * g + g * d * d + d * g * d,
              P = d * d * d;
            for (f = 0; f < p; f += 1)
              ((u[f * 4] =
                e.round((_ * t[f] + y * r[f] + b * i[f] + x * n[f]) * 1e3) /
                1e3),
                (u[f * 4 + 1] =
                  e.round((S * t[f] + C * r[f] + T * i[f] + E * n[f]) * 1e3) /
                  1e3),
                (u[f * 4 + 2] =
                  e.round((D * t[f] + O * r[f] + k * i[f] + A * n[f]) * 1e3) /
                  1e3),
                (u[f * 4 + 3] =
                  e.round((j * t[f] + M * r[f] + N * i[f] + P * n[f]) * 1e3) /
                  1e3));
            return u;
          }
          return {
            getSegmentsLength: i,
            getNewSegment: d,
            getPointInSegment: l,
            buildBezierData: s,
            pointOnLine2D: t,
            pointOnLine3D: n,
          };
        }
        var bez = bezFunction(),
          initFrame = initialDefaultFrame,
          mathAbs = Math.abs;
        function interpolateValue(e, t) {
          var n = this.offsetTime,
            r;
          this.propType === `multidimensional` &&
            (r = createTypedArray(`float32`, this.pv.length));
          for (
            var i = t.lastIndex,
              a = i,
              o = this.keyframes.length - 1,
              s = !0,
              c,
              l,
              u;
            s;
          ) {
            if (
              ((c = this.keyframes[a]),
              (l = this.keyframes[a + 1]),
              a === o - 1 && e >= l.t - n)
            ) {
              (c.h && (c = l), (i = 0));
              break;
            }
            if (l.t - n > e) {
              i = a;
              break;
            }
            a < o - 1 ? (a += 1) : ((i = 0), (s = !1));
          }
          u = this.keyframesMetadata[a] || {};
          var d,
            f,
            p,
            m,
            g,
            _,
            y = l.t - n,
            b = c.t - n,
            x;
          if (c.to) {
            u.bezierData ||= bez.buildBezierData(c.s, l.s || c.e, c.to, c.ti);
            var S = u.bezierData;
            if (e >= y || e < b) {
              var C = e >= y ? S.points.length - 1 : 0;
              for (f = S.points[C].point.length, d = 0; d < f; d += 1)
                r[d] = S.points[C].point[d];
            } else {
              (u.__fnct
                ? (_ = u.__fnct)
                : ((_ = BezierFactory.getBezierEasing(
                    c.o.x,
                    c.o.y,
                    c.i.x,
                    c.i.y,
                    c.n,
                  ).get),
                  (u.__fnct = _)),
                (p = _((e - b) / (y - b))));
              var T = S.segmentLength * p,
                E,
                D =
                  t.lastFrame < e && t._lastKeyframeIndex === a
                    ? t._lastAddedLength
                    : 0;
              for (
                g =
                  t.lastFrame < e && t._lastKeyframeIndex === a
                    ? t._lastPoint
                    : 0,
                  s = !0,
                  m = S.points.length;
                s;
              ) {
                if (
                  ((D += S.points[g].partialLength),
                  T === 0 || p === 0 || g === S.points.length - 1)
                ) {
                  for (f = S.points[g].point.length, d = 0; d < f; d += 1)
                    r[d] = S.points[g].point[d];
                  break;
                } else if (T >= D && T < D + S.points[g + 1].partialLength) {
                  for (
                    E = (T - D) / S.points[g + 1].partialLength,
                      f = S.points[g].point.length,
                      d = 0;
                    d < f;
                    d += 1
                  )
                    r[d] =
                      S.points[g].point[d] +
                      (S.points[g + 1].point[d] - S.points[g].point[d]) * E;
                  break;
                }
                g < m - 1 ? (g += 1) : (s = !1);
              }
              ((t._lastPoint = g),
                (t._lastAddedLength = D - S.points[g].partialLength),
                (t._lastKeyframeIndex = a));
            }
          } else {
            var O, k, A, j, M;
            if (((o = c.s.length), (x = l.s || c.e), this.sh && c.h !== 1))
              if (e >= y) ((r[0] = x[0]), (r[1] = x[1]), (r[2] = x[2]));
              else if (e <= b)
                ((r[0] = c.s[0]), (r[1] = c.s[1]), (r[2] = c.s[2]));
              else {
                var N = createQuaternion(c.s),
                  P = createQuaternion(x),
                  F = (e - b) / (y - b);
                quaternionToEuler(r, slerp(N, P, F));
              }
            else
              for (a = 0; a < o; a += 1)
                (c.h !== 1 &&
                  (e >= y
                    ? (p = 1)
                    : e < b
                      ? (p = 0)
                      : (c.o.x.constructor === Array
                          ? ((u.__fnct ||= []),
                            u.__fnct[a]
                              ? (_ = u.__fnct[a])
                              : ((O =
                                  c.o.x[a] === void 0 ? c.o.x[0] : c.o.x[a]),
                                (k = c.o.y[a] === void 0 ? c.o.y[0] : c.o.y[a]),
                                (A = c.i.x[a] === void 0 ? c.i.x[0] : c.i.x[a]),
                                (j = c.i.y[a] === void 0 ? c.i.y[0] : c.i.y[a]),
                                (_ = BezierFactory.getBezierEasing(
                                  O,
                                  k,
                                  A,
                                  j,
                                ).get),
                                (u.__fnct[a] = _)))
                          : u.__fnct
                            ? (_ = u.__fnct)
                            : ((O = c.o.x),
                              (k = c.o.y),
                              (A = c.i.x),
                              (j = c.i.y),
                              (_ = BezierFactory.getBezierEasing(
                                O,
                                k,
                                A,
                                j,
                              ).get),
                              (c.keyframeMetadata = _)),
                        (p = _((e - b) / (y - b))))),
                  (x = l.s || c.e),
                  (M = c.h === 1 ? c.s[a] : c.s[a] + (x[a] - c.s[a]) * p),
                  this.propType === `multidimensional` ? (r[a] = M) : (r = M));
          }
          return ((t.lastIndex = i), r);
        }
        function slerp(e, t, n) {
          var r = [],
            i = e[0],
            a = e[1],
            o = e[2],
            s = e[3],
            c = t[0],
            l = t[1],
            u = t[2],
            d = t[3],
            f,
            p = i * c + a * l + o * u + s * d,
            m,
            g,
            _;
          return (
            p < 0 && ((p = -p), (c = -c), (l = -l), (u = -u), (d = -d)),
            1 - p > 1e-6
              ? ((f = Math.acos(p)),
                (m = Math.sin(f)),
                (g = Math.sin((1 - n) * f) / m),
                (_ = Math.sin(n * f) / m))
              : ((g = 1 - n), (_ = n)),
            (r[0] = g * i + _ * c),
            (r[1] = g * a + _ * l),
            (r[2] = g * o + _ * u),
            (r[3] = g * s + _ * d),
            r
          );
        }
        function quaternionToEuler(e, t) {
          var n = t[0],
            r = t[1],
            i = t[2],
            a = t[3],
            o = Math.atan2(2 * r * a - 2 * n * i, 1 - 2 * r * r - 2 * i * i),
            s = Math.asin(2 * n * r + 2 * i * a),
            c = Math.atan2(2 * n * a - 2 * r * i, 1 - 2 * n * n - 2 * i * i);
          ((e[0] = o / degToRads),
            (e[1] = s / degToRads),
            (e[2] = c / degToRads));
        }
        function createQuaternion(e) {
          var t = e[0] * degToRads,
            n = e[1] * degToRads,
            r = e[2] * degToRads,
            i = Math.cos(t / 2),
            a = Math.cos(n / 2),
            o = Math.cos(r / 2),
            s = Math.sin(t / 2),
            c = Math.sin(n / 2),
            l = Math.sin(r / 2),
            u = i * a * o - s * c * l;
          return [
            s * c * o + i * a * l,
            s * a * o + i * c * l,
            i * c * o - s * a * l,
            u,
          ];
        }
        function getValueAtCurrentTime() {
          var e = this.comp.renderedFrame - this.offsetTime,
            t = this.keyframes[0].t - this.offsetTime,
            n = this.keyframes[this.keyframes.length - 1].t - this.offsetTime;
          if (!(
            e === this._caching.lastFrame ||
            (this._caching.lastFrame !== initFrame &&
              ((this._caching.lastFrame >= n && e >= n) ||
                (this._caching.lastFrame < t && e < t)))
          )) {
            this._caching.lastFrame >= e &&
              ((this._caching._lastKeyframeIndex = -1),
              (this._caching.lastIndex = 0));
            var r = this.interpolateValue(e, this._caching);
            this.pv = r;
          }
          return ((this._caching.lastFrame = e), this.pv);
        }
        function setVValue(e) {
          var t;
          if (this.propType === `unidimensional`)
            ((t = e * this.mult),
              mathAbs(this.v - t) > 1e-5 && ((this.v = t), (this._mdf = !0)));
          else
            for (var n = 0, r = this.v.length; n < r;)
              ((t = e[n] * this.mult),
                mathAbs(this.v[n] - t) > 1e-5 &&
                  ((this.v[n] = t), (this._mdf = !0)),
                (n += 1));
        }
        function processEffectsSequence() {
          if (!(
            this.elem.globalData.frameId === this.frameId ||
            !this.effectsSequence.length
          )) {
            if (this.lock) {
              this.setVValue(this.pv);
              return;
            }
            ((this.lock = !0), (this._mdf = this._isFirstFrame));
            var e,
              t = this.effectsSequence.length,
              n = this.kf ? this.pv : this.data.k;
            for (e = 0; e < t; e += 1) n = this.effectsSequence[e](n);
            (this.setVValue(n),
              (this._isFirstFrame = !1),
              (this.lock = !1),
              (this.frameId = this.elem.globalData.frameId));
          }
        }
        function addEffect(e) {
          (this.effectsSequence.push(e),
            this.container.addDynamicProperty(this));
        }
        function ValueProperty(e, t, n, r) {
          ((this.propType = `unidimensional`),
            (this.mult = n || 1),
            (this.data = t),
            (this.v = n ? t.k * n : t.k),
            (this.pv = t.k),
            (this._mdf = !1),
            (this.elem = e),
            (this.container = r),
            (this.comp = e.comp),
            (this.k = !1),
            (this.kf = !1),
            (this.vel = 0),
            (this.effectsSequence = []),
            (this._isFirstFrame = !0),
            (this.getValue = processEffectsSequence),
            (this.setVValue = setVValue),
            (this.addEffect = addEffect));
        }
        function MultiDimensionalProperty(e, t, n, r) {
          ((this.propType = `multidimensional`),
            (this.mult = n || 1),
            (this.data = t),
            (this._mdf = !1),
            (this.elem = e),
            (this.container = r),
            (this.comp = e.comp),
            (this.k = !1),
            (this.kf = !1),
            (this.frameId = -1));
          var i,
            a = t.k.length;
          for (
            this.v = createTypedArray(`float32`, a),
              this.pv = createTypedArray(`float32`, a),
              this.vel = createTypedArray(`float32`, a),
              i = 0;
            i < a;
            i += 1
          )
            ((this.v[i] = t.k[i] * this.mult), (this.pv[i] = t.k[i]));
          ((this._isFirstFrame = !0),
            (this.effectsSequence = []),
            (this.getValue = processEffectsSequence),
            (this.setVValue = setVValue),
            (this.addEffect = addEffect));
        }
        function KeyframedValueProperty(e, t, n, r) {
          ((this.propType = `unidimensional`),
            (this.keyframes = t.k),
            (this.keyframesMetadata = []),
            (this.offsetTime = e.data.st),
            (this.frameId = -1),
            (this._caching = {
              lastFrame: initFrame,
              lastIndex: 0,
              value: 0,
              _lastKeyframeIndex: -1,
            }),
            (this.k = !0),
            (this.kf = !0),
            (this.data = t),
            (this.mult = n || 1),
            (this.elem = e),
            (this.container = r),
            (this.comp = e.comp),
            (this.v = initFrame),
            (this.pv = initFrame),
            (this._isFirstFrame = !0),
            (this.getValue = processEffectsSequence),
            (this.setVValue = setVValue),
            (this.interpolateValue = interpolateValue),
            (this.effectsSequence = [getValueAtCurrentTime.bind(this)]),
            (this.addEffect = addEffect));
        }
        function KeyframedMultidimensionalProperty(e, t, n, r) {
          this.propType = `multidimensional`;
          var i,
            a = t.k.length,
            o,
            s,
            c,
            l;
          for (i = 0; i < a - 1; i += 1)
            t.k[i].to &&
              t.k[i].s &&
              t.k[i + 1] &&
              t.k[i + 1].s &&
              ((o = t.k[i].s),
              (s = t.k[i + 1].s),
              (c = t.k[i].to),
              (l = t.k[i].ti),
              ((o.length === 2 &&
                !(o[0] === s[0] && o[1] === s[1]) &&
                bez.pointOnLine2D(
                  o[0],
                  o[1],
                  s[0],
                  s[1],
                  o[0] + c[0],
                  o[1] + c[1],
                ) &&
                bez.pointOnLine2D(
                  o[0],
                  o[1],
                  s[0],
                  s[1],
                  s[0] + l[0],
                  s[1] + l[1],
                )) ||
                (o.length === 3 &&
                  !(o[0] === s[0] && o[1] === s[1] && o[2] === s[2]) &&
                  bez.pointOnLine3D(
                    o[0],
                    o[1],
                    o[2],
                    s[0],
                    s[1],
                    s[2],
                    o[0] + c[0],
                    o[1] + c[1],
                    o[2] + c[2],
                  ) &&
                  bez.pointOnLine3D(
                    o[0],
                    o[1],
                    o[2],
                    s[0],
                    s[1],
                    s[2],
                    s[0] + l[0],
                    s[1] + l[1],
                    s[2] + l[2],
                  ))) &&
                ((t.k[i].to = null), (t.k[i].ti = null)),
              o[0] === s[0] &&
                o[1] === s[1] &&
                c[0] === 0 &&
                c[1] === 0 &&
                l[0] === 0 &&
                l[1] === 0 &&
                (o.length === 2 ||
                  (o[2] === s[2] && c[2] === 0 && l[2] === 0)) &&
                ((t.k[i].to = null), (t.k[i].ti = null)));
          ((this.effectsSequence = [getValueAtCurrentTime.bind(this)]),
            (this.data = t),
            (this.keyframes = t.k),
            (this.keyframesMetadata = []),
            (this.offsetTime = e.data.st),
            (this.k = !0),
            (this.kf = !0),
            (this._isFirstFrame = !0),
            (this.mult = n || 1),
            (this.elem = e),
            (this.container = r),
            (this.comp = e.comp),
            (this.getValue = processEffectsSequence),
            (this.setVValue = setVValue),
            (this.interpolateValue = interpolateValue),
            (this.frameId = -1));
          var u = t.k[0].s.length;
          for (
            this.v = createTypedArray(`float32`, u),
              this.pv = createTypedArray(`float32`, u),
              i = 0;
            i < u;
            i += 1
          )
            ((this.v[i] = initFrame), (this.pv[i] = initFrame));
          ((this._caching = {
            lastFrame: initFrame,
            lastIndex: 0,
            value: createTypedArray(`float32`, u),
          }),
            (this.addEffect = addEffect));
        }
        var PropertyFactory = (function () {
          function e(e, t, n, r, i) {
            t.sid && (t = e.globalData.slotManager.getProp(t));
            var a;
            if (!t.k.length) a = new ValueProperty(e, t, r, i);
            else if (typeof t.k[0] == `number`)
              a = new MultiDimensionalProperty(e, t, r, i);
            else
              switch (n) {
                case 0:
                  a = new KeyframedValueProperty(e, t, r, i);
                  break;
                case 1:
                  a = new KeyframedMultidimensionalProperty(e, t, r, i);
                  break;
                default:
                  break;
              }
            return (a.effectsSequence.length && i.addDynamicProperty(a), a);
          }
          return { getProp: e };
        })();
        function DynamicPropertyContainer() {}
        DynamicPropertyContainer.prototype = {
          addDynamicProperty: function (e) {
            this.dynamicProperties.indexOf(e) === -1 &&
              (this.dynamicProperties.push(e),
              this.container.addDynamicProperty(this),
              (this._isAnimated = !0));
          },
          iterateDynamicProperties: function () {
            this._mdf = !1;
            var e,
              t = this.dynamicProperties.length;
            for (e = 0; e < t; e += 1)
              (this.dynamicProperties[e].getValue(),
                this.dynamicProperties[e]._mdf && (this._mdf = !0));
          },
          initDynamicPropertyContainer: function (e) {
            ((this.container = e),
              (this.dynamicProperties = []),
              (this._mdf = !1),
              (this._isAnimated = !1));
          },
        };
        var pointPool = (function () {
          function e() {
            return createTypedArray(`float32`, 2);
          }
          return poolFactory(8, e);
        })();
        function ShapePath() {
          ((this.c = !1),
            (this._length = 0),
            (this._maxLength = 8),
            (this.v = createSizedArray(this._maxLength)),
            (this.o = createSizedArray(this._maxLength)),
            (this.i = createSizedArray(this._maxLength)));
        }
        ((ShapePath.prototype.setPathData = function (e, t) {
          ((this.c = e), this.setLength(t));
          for (var n = 0; n < t;)
            ((this.v[n] = pointPool.newElement()),
              (this.o[n] = pointPool.newElement()),
              (this.i[n] = pointPool.newElement()),
              (n += 1));
        }),
          (ShapePath.prototype.setLength = function (e) {
            for (; this._maxLength < e;) this.doubleArrayLength();
            this._length = e;
          }),
          (ShapePath.prototype.doubleArrayLength = function () {
            ((this.v = this.v.concat(createSizedArray(this._maxLength))),
              (this.i = this.i.concat(createSizedArray(this._maxLength))),
              (this.o = this.o.concat(createSizedArray(this._maxLength))),
              (this._maxLength *= 2));
          }),
          (ShapePath.prototype.setXYAt = function (e, t, n, r, i) {
            var a;
            switch (
              ((this._length = Math.max(this._length, r + 1)),
              this._length >= this._maxLength && this.doubleArrayLength(),
              n)
            ) {
              case `v`:
                a = this.v;
                break;
              case `i`:
                a = this.i;
                break;
              case `o`:
                a = this.o;
                break;
              default:
                a = [];
                break;
            }
            ((!a[r] || (a[r] && !i)) && (a[r] = pointPool.newElement()),
              (a[r][0] = e),
              (a[r][1] = t));
          }),
          (ShapePath.prototype.setTripleAt = function (e, t, n, r, i, a, o, s) {
            (this.setXYAt(e, t, `v`, o, s),
              this.setXYAt(n, r, `o`, o, s),
              this.setXYAt(i, a, `i`, o, s));
          }),
          (ShapePath.prototype.reverse = function () {
            var e = new ShapePath();
            e.setPathData(this.c, this._length);
            var t = this.v,
              n = this.o,
              r = this.i,
              i = 0;
            this.c &&
              (e.setTripleAt(
                t[0][0],
                t[0][1],
                r[0][0],
                r[0][1],
                n[0][0],
                n[0][1],
                0,
                !1,
              ),
              (i = 1));
            var a = this._length - 1,
              o = this._length,
              s;
            for (s = i; s < o; s += 1)
              (e.setTripleAt(
                t[a][0],
                t[a][1],
                r[a][0],
                r[a][1],
                n[a][0],
                n[a][1],
                s,
                !1,
              ),
                --a);
            return e;
          }),
          (ShapePath.prototype.length = function () {
            return this._length;
          }));
        var shapePool = (function () {
          function e() {
            return new ShapePath();
          }
          function t(e) {
            var t = e._length,
              n;
            for (n = 0; n < t; n += 1)
              (pointPool.release(e.v[n]),
                pointPool.release(e.i[n]),
                pointPool.release(e.o[n]),
                (e.v[n] = null),
                (e.i[n] = null),
                (e.o[n] = null));
            ((e._length = 0), (e.c = !1));
          }
          function n(e) {
            var t = r.newElement(),
              n,
              i = e._length === void 0 ? e.v.length : e._length;
            for (t.setLength(i), t.c = e.c, n = 0; n < i; n += 1)
              t.setTripleAt(
                e.v[n][0],
                e.v[n][1],
                e.o[n][0],
                e.o[n][1],
                e.i[n][0],
                e.i[n][1],
                n,
              );
            return t;
          }
          var r = poolFactory(4, e, t);
          return ((r.clone = n), r);
        })();
        function ShapeCollection() {
          ((this._length = 0),
            (this._maxLength = 4),
            (this.shapes = createSizedArray(this._maxLength)));
        }
        ((ShapeCollection.prototype.addShape = function (e) {
          (this._length === this._maxLength &&
            ((this.shapes = this.shapes.concat(
              createSizedArray(this._maxLength),
            )),
            (this._maxLength *= 2)),
            (this.shapes[this._length] = e),
            (this._length += 1));
        }),
          (ShapeCollection.prototype.releaseShapes = function () {
            var e;
            for (e = 0; e < this._length; e += 1)
              shapePool.release(this.shapes[e]);
            this._length = 0;
          }));
        var shapeCollectionPool = (function () {
            var e = { newShapeCollection: i, release: a },
              t = 0,
              n = 4,
              r = createSizedArray(n);
            function i() {
              var e;
              return (t ? (--t, (e = r[t])) : (e = new ShapeCollection()), e);
            }
            function a(e) {
              var i,
                a = e._length;
              for (i = 0; i < a; i += 1) shapePool.release(e.shapes[i]);
              ((e._length = 0),
                t === n && ((r = pooling.double(r)), (n *= 2)),
                (r[t] = e),
                (t += 1));
            }
            return e;
          })(),
          ShapePropertyFactory = (function () {
            var e = -999999;
            function t(e, t, n) {
              var r = n.lastIndex,
                i,
                a,
                o,
                s,
                c,
                l,
                u,
                d,
                f,
                p = this.keyframes;
              if (e < p[0].t - this.offsetTime)
                ((i = p[0].s[0]), (o = !0), (r = 0));
              else if (e >= p[p.length - 1].t - this.offsetTime)
                ((i = p[p.length - 1].s
                  ? p[p.length - 1].s[0]
                  : p[p.length - 2].e[0]),
                  (o = !0));
              else {
                for (
                  var m = r, g = p.length - 1, _ = !0, y, b, x;
                  _ &&
                  ((y = p[m]), (b = p[m + 1]), !(b.t - this.offsetTime > e));
                )
                  m < g - 1 ? (m += 1) : (_ = !1);
                if (
                  ((x = this.keyframesMetadata[m] || {}),
                  (o = y.h === 1),
                  (r = m),
                  !o)
                ) {
                  if (e >= b.t - this.offsetTime) d = 1;
                  else if (e < y.t - this.offsetTime) d = 0;
                  else {
                    var S;
                    (x.__fnct
                      ? (S = x.__fnct)
                      : ((S = BezierFactory.getBezierEasing(
                          y.o.x,
                          y.o.y,
                          y.i.x,
                          y.i.y,
                        ).get),
                        (x.__fnct = S)),
                      (d = S(
                        (e - (y.t - this.offsetTime)) /
                          (b.t - this.offsetTime - (y.t - this.offsetTime)),
                      )));
                  }
                  a = b.s ? b.s[0] : y.e[0];
                }
                i = y.s[0];
              }
              for (
                l = t._length, u = i.i[0].length, n.lastIndex = r, s = 0;
                s < l;
                s += 1
              )
                for (c = 0; c < u; c += 1)
                  ((f = o
                    ? i.i[s][c]
                    : i.i[s][c] + (a.i[s][c] - i.i[s][c]) * d),
                    (t.i[s][c] = f),
                    (f = o
                      ? i.o[s][c]
                      : i.o[s][c] + (a.o[s][c] - i.o[s][c]) * d),
                    (t.o[s][c] = f),
                    (f = o
                      ? i.v[s][c]
                      : i.v[s][c] + (a.v[s][c] - i.v[s][c]) * d),
                    (t.v[s][c] = f));
            }
            function n() {
              var t = this.comp.renderedFrame - this.offsetTime,
                n = this.keyframes[0].t - this.offsetTime,
                r =
                  this.keyframes[this.keyframes.length - 1].t - this.offsetTime,
                i = this._caching.lastFrame;
              return (
                (i !== e && ((i < n && t < n) || (i > r && t > r))) ||
                  ((this._caching.lastIndex =
                    i < t ? this._caching.lastIndex : 0),
                  this.interpolateShape(t, this.pv, this._caching)),
                (this._caching.lastFrame = t),
                this.pv
              );
            }
            function r() {
              this.paths = this.localShapeCollection;
            }
            function i(e, t) {
              if (e._length !== t._length || e.c !== t.c) return !1;
              var n,
                r = e._length;
              for (n = 0; n < r; n += 1)
                if (
                  e.v[n][0] !== t.v[n][0] ||
                  e.v[n][1] !== t.v[n][1] ||
                  e.o[n][0] !== t.o[n][0] ||
                  e.o[n][1] !== t.o[n][1] ||
                  e.i[n][0] !== t.i[n][0] ||
                  e.i[n][1] !== t.i[n][1]
                )
                  return !1;
              return !0;
            }
            function a(e) {
              i(this.v, e) ||
                ((this.v = shapePool.clone(e)),
                this.localShapeCollection.releaseShapes(),
                this.localShapeCollection.addShape(this.v),
                (this._mdf = !0),
                (this.paths = this.localShapeCollection));
            }
            function o() {
              if (this.elem.globalData.frameId !== this.frameId) {
                if (!this.effectsSequence.length) {
                  this._mdf = !1;
                  return;
                }
                if (this.lock) {
                  this.setVValue(this.pv);
                  return;
                }
                ((this.lock = !0), (this._mdf = !1));
                var e = this.kf
                    ? this.pv
                    : this.data.ks
                      ? this.data.ks.k
                      : this.data.pt.k,
                  t,
                  n = this.effectsSequence.length;
                for (t = 0; t < n; t += 1) e = this.effectsSequence[t](e);
                (this.setVValue(e),
                  (this.lock = !1),
                  (this.frameId = this.elem.globalData.frameId));
              }
            }
            function s(e, t, n) {
              ((this.propType = `shape`),
                (this.comp = e.comp),
                (this.container = e),
                (this.elem = e),
                (this.data = t),
                (this.k = !1),
                (this.kf = !1),
                (this._mdf = !1));
              var i = n === 3 ? t.pt.k : t.ks.k;
              ((this.v = shapePool.clone(i)),
                (this.pv = shapePool.clone(this.v)),
                (this.localShapeCollection =
                  shapeCollectionPool.newShapeCollection()),
                (this.paths = this.localShapeCollection),
                this.paths.addShape(this.v),
                (this.reset = r),
                (this.effectsSequence = []));
            }
            function c(e) {
              (this.effectsSequence.push(e),
                this.container.addDynamicProperty(this));
            }
            ((s.prototype.interpolateShape = t),
              (s.prototype.getValue = o),
              (s.prototype.setVValue = a),
              (s.prototype.addEffect = c));
            function l(t, i, a) {
              ((this.propType = `shape`),
                (this.comp = t.comp),
                (this.elem = t),
                (this.container = t),
                (this.offsetTime = t.data.st),
                (this.keyframes = a === 3 ? i.pt.k : i.ks.k),
                (this.keyframesMetadata = []),
                (this.k = !0),
                (this.kf = !0));
              var o = this.keyframes[0].s[0].i.length;
              ((this.v = shapePool.newElement()),
                this.v.setPathData(this.keyframes[0].s[0].c, o),
                (this.pv = shapePool.clone(this.v)),
                (this.localShapeCollection =
                  shapeCollectionPool.newShapeCollection()),
                (this.paths = this.localShapeCollection),
                this.paths.addShape(this.v),
                (this.lastFrame = e),
                (this.reset = r),
                (this._caching = { lastFrame: e, lastIndex: 0 }),
                (this.effectsSequence = [n.bind(this)]));
            }
            ((l.prototype.getValue = o),
              (l.prototype.interpolateShape = t),
              (l.prototype.setVValue = a),
              (l.prototype.addEffect = c));
            var u = (function () {
                var e = roundCorner;
                function t(e, t) {
                  ((this.v = shapePool.newElement()),
                    this.v.setPathData(!0, 4),
                    (this.localShapeCollection =
                      shapeCollectionPool.newShapeCollection()),
                    (this.paths = this.localShapeCollection),
                    this.localShapeCollection.addShape(this.v),
                    (this.d = t.d),
                    (this.elem = e),
                    (this.comp = e.comp),
                    (this.frameId = -1),
                    this.initDynamicPropertyContainer(e),
                    (this.p = PropertyFactory.getProp(e, t.p, 1, 0, this)),
                    (this.s = PropertyFactory.getProp(e, t.s, 1, 0, this)),
                    this.dynamicProperties.length
                      ? (this.k = !0)
                      : ((this.k = !1), this.convertEllToPath()));
                }
                return (
                  (t.prototype = {
                    reset: r,
                    getValue: function () {
                      this.elem.globalData.frameId !== this.frameId &&
                        ((this.frameId = this.elem.globalData.frameId),
                        this.iterateDynamicProperties(),
                        this._mdf && this.convertEllToPath());
                    },
                    convertEllToPath: function () {
                      var t = this.p.v[0],
                        n = this.p.v[1],
                        r = this.s.v[0] / 2,
                        i = this.s.v[1] / 2,
                        a = this.d !== 3,
                        o = this.v;
                      ((o.v[0][0] = t),
                        (o.v[0][1] = n - i),
                        (o.v[1][0] = a ? t + r : t - r),
                        (o.v[1][1] = n),
                        (o.v[2][0] = t),
                        (o.v[2][1] = n + i),
                        (o.v[3][0] = a ? t - r : t + r),
                        (o.v[3][1] = n),
                        (o.i[0][0] = a ? t - r * e : t + r * e),
                        (o.i[0][1] = n - i),
                        (o.i[1][0] = a ? t + r : t - r),
                        (o.i[1][1] = n - i * e),
                        (o.i[2][0] = a ? t + r * e : t - r * e),
                        (o.i[2][1] = n + i),
                        (o.i[3][0] = a ? t - r : t + r),
                        (o.i[3][1] = n + i * e),
                        (o.o[0][0] = a ? t + r * e : t - r * e),
                        (o.o[0][1] = n - i),
                        (o.o[1][0] = a ? t + r : t - r),
                        (o.o[1][1] = n + i * e),
                        (o.o[2][0] = a ? t - r * e : t + r * e),
                        (o.o[2][1] = n + i),
                        (o.o[3][0] = a ? t - r : t + r),
                        (o.o[3][1] = n - i * e));
                    },
                  }),
                  extendPrototype([DynamicPropertyContainer], t),
                  t
                );
              })(),
              d = (function () {
                function e(e, t) {
                  ((this.v = shapePool.newElement()),
                    this.v.setPathData(!0, 0),
                    (this.elem = e),
                    (this.comp = e.comp),
                    (this.data = t),
                    (this.frameId = -1),
                    (this.d = t.d),
                    this.initDynamicPropertyContainer(e),
                    t.sy === 1
                      ? ((this.ir = PropertyFactory.getProp(
                          e,
                          t.ir,
                          0,
                          0,
                          this,
                        )),
                        (this.is = PropertyFactory.getProp(
                          e,
                          t.is,
                          0,
                          0.01,
                          this,
                        )),
                        (this.convertToPath = this.convertStarToPath))
                      : (this.convertToPath = this.convertPolygonToPath),
                    (this.pt = PropertyFactory.getProp(e, t.pt, 0, 0, this)),
                    (this.p = PropertyFactory.getProp(e, t.p, 1, 0, this)),
                    (this.r = PropertyFactory.getProp(
                      e,
                      t.r,
                      0,
                      degToRads,
                      this,
                    )),
                    (this.or = PropertyFactory.getProp(e, t.or, 0, 0, this)),
                    (this.os = PropertyFactory.getProp(e, t.os, 0, 0.01, this)),
                    (this.localShapeCollection =
                      shapeCollectionPool.newShapeCollection()),
                    this.localShapeCollection.addShape(this.v),
                    (this.paths = this.localShapeCollection),
                    this.dynamicProperties.length
                      ? (this.k = !0)
                      : ((this.k = !1), this.convertToPath()));
                }
                return (
                  (e.prototype = {
                    reset: r,
                    getValue: function () {
                      this.elem.globalData.frameId !== this.frameId &&
                        ((this.frameId = this.elem.globalData.frameId),
                        this.iterateDynamicProperties(),
                        this._mdf && this.convertToPath());
                    },
                    convertStarToPath: function () {
                      var e = Math.floor(this.pt.v) * 2,
                        t = (Math.PI * 2) / e,
                        n = !0,
                        r = this.or.v,
                        i = this.ir.v,
                        a = this.os.v,
                        o = this.is.v,
                        s = (2 * Math.PI * r) / (e * 2),
                        c = (2 * Math.PI * i) / (e * 2),
                        l,
                        u,
                        d,
                        f,
                        p = -Math.PI / 2;
                      p += this.r.v;
                      var m = this.data.d === 3 ? -1 : 1;
                      for (this.v._length = 0, l = 0; l < e; l += 1) {
                        ((u = n ? r : i), (d = n ? a : o), (f = n ? s : c));
                        var g = u * Math.cos(p),
                          _ = u * Math.sin(p),
                          y =
                            g === 0 && _ === 0
                              ? 0
                              : _ / Math.sqrt(g * g + _ * _),
                          b =
                            g === 0 && _ === 0
                              ? 0
                              : -g / Math.sqrt(g * g + _ * _);
                        ((g += +this.p.v[0]),
                          (_ += +this.p.v[1]),
                          this.v.setTripleAt(
                            g,
                            _,
                            g - y * f * d * m,
                            _ - b * f * d * m,
                            g + y * f * d * m,
                            _ + b * f * d * m,
                            l,
                            !0,
                          ),
                          (n = !n),
                          (p += t * m));
                      }
                    },
                    convertPolygonToPath: function () {
                      var e = Math.floor(this.pt.v),
                        t = (Math.PI * 2) / e,
                        n = this.or.v,
                        r = this.os.v,
                        i = (2 * Math.PI * n) / (e * 4),
                        a,
                        o = -Math.PI * 0.5,
                        s = this.data.d === 3 ? -1 : 1;
                      for (
                        o += this.r.v, this.v._length = 0, a = 0;
                        a < e;
                        a += 1
                      ) {
                        var c = n * Math.cos(o),
                          l = n * Math.sin(o),
                          u =
                            c === 0 && l === 0
                              ? 0
                              : l / Math.sqrt(c * c + l * l),
                          d =
                            c === 0 && l === 0
                              ? 0
                              : -c / Math.sqrt(c * c + l * l);
                        ((c += +this.p.v[0]),
                          (l += +this.p.v[1]),
                          this.v.setTripleAt(
                            c,
                            l,
                            c - u * i * r * s,
                            l - d * i * r * s,
                            c + u * i * r * s,
                            l + d * i * r * s,
                            a,
                            !0,
                          ),
                          (o += t * s));
                      }
                      ((this.paths.length = 0), (this.paths[0] = this.v));
                    },
                  }),
                  extendPrototype([DynamicPropertyContainer], e),
                  e
                );
              })(),
              f = (function () {
                function e(e, t) {
                  ((this.v = shapePool.newElement()),
                    (this.v.c = !0),
                    (this.localShapeCollection =
                      shapeCollectionPool.newShapeCollection()),
                    this.localShapeCollection.addShape(this.v),
                    (this.paths = this.localShapeCollection),
                    (this.elem = e),
                    (this.comp = e.comp),
                    (this.frameId = -1),
                    (this.d = t.d),
                    this.initDynamicPropertyContainer(e),
                    (this.p = PropertyFactory.getProp(e, t.p, 1, 0, this)),
                    (this.s = PropertyFactory.getProp(e, t.s, 1, 0, this)),
                    (this.r = PropertyFactory.getProp(e, t.r, 0, 0, this)),
                    this.dynamicProperties.length
                      ? (this.k = !0)
                      : ((this.k = !1), this.convertRectToPath()));
                }
                return (
                  (e.prototype = {
                    convertRectToPath: function () {
                      var e = this.p.v[0],
                        t = this.p.v[1],
                        n = this.s.v[0] / 2,
                        r = this.s.v[1] / 2,
                        i = bmMin(n, r, this.r.v),
                        a = i * (1 - roundCorner);
                      ((this.v._length = 0),
                        this.d === 2 || this.d === 1
                          ? (this.v.setTripleAt(
                              e + n,
                              t - r + i,
                              e + n,
                              t - r + i,
                              e + n,
                              t - r + a,
                              0,
                              !0,
                            ),
                            this.v.setTripleAt(
                              e + n,
                              t + r - i,
                              e + n,
                              t + r - a,
                              e + n,
                              t + r - i,
                              1,
                              !0,
                            ),
                            i === 0
                              ? (this.v.setTripleAt(
                                  e - n,
                                  t + r,
                                  e - n + a,
                                  t + r,
                                  e - n,
                                  t + r,
                                  2,
                                ),
                                this.v.setTripleAt(
                                  e - n,
                                  t - r,
                                  e - n,
                                  t - r + a,
                                  e - n,
                                  t - r,
                                  3,
                                ))
                              : (this.v.setTripleAt(
                                  e + n - i,
                                  t + r,
                                  e + n - i,
                                  t + r,
                                  e + n - a,
                                  t + r,
                                  2,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n + i,
                                  t + r,
                                  e - n + a,
                                  t + r,
                                  e - n + i,
                                  t + r,
                                  3,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n,
                                  t + r - i,
                                  e - n,
                                  t + r - i,
                                  e - n,
                                  t + r - a,
                                  4,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n,
                                  t - r + i,
                                  e - n,
                                  t - r + a,
                                  e - n,
                                  t - r + i,
                                  5,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n + i,
                                  t - r,
                                  e - n + i,
                                  t - r,
                                  e - n + a,
                                  t - r,
                                  6,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e + n - i,
                                  t - r,
                                  e + n - a,
                                  t - r,
                                  e + n - i,
                                  t - r,
                                  7,
                                  !0,
                                )))
                          : (this.v.setTripleAt(
                              e + n,
                              t - r + i,
                              e + n,
                              t - r + a,
                              e + n,
                              t - r + i,
                              0,
                              !0,
                            ),
                            i === 0
                              ? (this.v.setTripleAt(
                                  e - n,
                                  t - r,
                                  e - n + a,
                                  t - r,
                                  e - n,
                                  t - r,
                                  1,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n,
                                  t + r,
                                  e - n,
                                  t + r - a,
                                  e - n,
                                  t + r,
                                  2,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e + n,
                                  t + r,
                                  e + n - a,
                                  t + r,
                                  e + n,
                                  t + r,
                                  3,
                                  !0,
                                ))
                              : (this.v.setTripleAt(
                                  e + n - i,
                                  t - r,
                                  e + n - i,
                                  t - r,
                                  e + n - a,
                                  t - r,
                                  1,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n + i,
                                  t - r,
                                  e - n + a,
                                  t - r,
                                  e - n + i,
                                  t - r,
                                  2,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n,
                                  t - r + i,
                                  e - n,
                                  t - r + i,
                                  e - n,
                                  t - r + a,
                                  3,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n,
                                  t + r - i,
                                  e - n,
                                  t + r - a,
                                  e - n,
                                  t + r - i,
                                  4,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e - n + i,
                                  t + r,
                                  e - n + i,
                                  t + r,
                                  e - n + a,
                                  t + r,
                                  5,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e + n - i,
                                  t + r,
                                  e + n - a,
                                  t + r,
                                  e + n - i,
                                  t + r,
                                  6,
                                  !0,
                                ),
                                this.v.setTripleAt(
                                  e + n,
                                  t + r - i,
                                  e + n,
                                  t + r - i,
                                  e + n,
                                  t + r - a,
                                  7,
                                  !0,
                                ))));
                    },
                    getValue: function () {
                      this.elem.globalData.frameId !== this.frameId &&
                        ((this.frameId = this.elem.globalData.frameId),
                        this.iterateDynamicProperties(),
                        this._mdf && this.convertRectToPath());
                    },
                    reset: r,
                  }),
                  extendPrototype([DynamicPropertyContainer], e),
                  e
                );
              })();
            function p(e, t, n) {
              var r;
              return (
                n === 3 || n === 4
                  ? (r = (n === 3 ? t.pt : t.ks).k.length
                      ? new l(e, t, n)
                      : new s(e, t, n))
                  : n === 5
                    ? (r = new f(e, t))
                    : n === 6
                      ? (r = new u(e, t))
                      : n === 7 && (r = new d(e, t)),
                r.k && e.addDynamicProperty(r),
                r
              );
            }
            function m() {
              return s;
            }
            function g() {
              return l;
            }
            var _ = {};
            return (
              (_.getShapeProp = p),
              (_.getConstructorFunction = m),
              (_.getKeyframedConstructorFunction = g),
              _
            );
          })(),
          Matrix = (function () {
            var e = Math.cos,
              t = Math.sin,
              n = Math.tan,
              r = Math.round;
            function i() {
              return (
                (this.props[0] = 1),
                (this.props[1] = 0),
                (this.props[2] = 0),
                (this.props[3] = 0),
                (this.props[4] = 0),
                (this.props[5] = 1),
                (this.props[6] = 0),
                (this.props[7] = 0),
                (this.props[8] = 0),
                (this.props[9] = 0),
                (this.props[10] = 1),
                (this.props[11] = 0),
                (this.props[12] = 0),
                (this.props[13] = 0),
                (this.props[14] = 0),
                (this.props[15] = 1),
                this
              );
            }
            function a(n) {
              if (n === 0) return this;
              var r = e(n),
                i = t(n);
              return this._t(r, -i, 0, 0, i, r, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
            }
            function o(n) {
              if (n === 0) return this;
              var r = e(n),
                i = t(n);
              return this._t(1, 0, 0, 0, 0, r, -i, 0, 0, i, r, 0, 0, 0, 0, 1);
            }
            function s(n) {
              if (n === 0) return this;
              var r = e(n),
                i = t(n);
              return this._t(r, 0, i, 0, 0, 1, 0, 0, -i, 0, r, 0, 0, 0, 0, 1);
            }
            function c(n) {
              if (n === 0) return this;
              var r = e(n),
                i = t(n);
              return this._t(r, -i, 0, 0, i, r, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
            }
            function l(e, t) {
              return this._t(1, t, e, 1, 0, 0);
            }
            function u(e, t) {
              return this.shear(n(e), n(t));
            }
            function d(r, i) {
              var a = e(i),
                o = t(i);
              return this._t(a, o, 0, 0, -o, a, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
                ._t(1, 0, 0, 0, n(r), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
                ._t(a, -o, 0, 0, o, a, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
            }
            function f(e, t, n) {
              return (
                !n && n !== 0 && (n = 1),
                e === 1 && t === 1 && n === 1
                  ? this
                  : this._t(e, 0, 0, 0, 0, t, 0, 0, 0, 0, n, 0, 0, 0, 0, 1)
              );
            }
            function p(e, t, n, r, i, a, o, s, c, l, u, d, f, p, m, g) {
              return (
                (this.props[0] = e),
                (this.props[1] = t),
                (this.props[2] = n),
                (this.props[3] = r),
                (this.props[4] = i),
                (this.props[5] = a),
                (this.props[6] = o),
                (this.props[7] = s),
                (this.props[8] = c),
                (this.props[9] = l),
                (this.props[10] = u),
                (this.props[11] = d),
                (this.props[12] = f),
                (this.props[13] = p),
                (this.props[14] = m),
                (this.props[15] = g),
                this
              );
            }
            function m(e, t, n) {
              return (
                (n ||= 0),
                e !== 0 || t !== 0 || n !== 0
                  ? this._t(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, e, t, n, 1)
                  : this
              );
            }
            function g(e, t, n, r, i, a, o, s, c, l, u, d, f, p, m, g) {
              var _ = this.props;
              if (
                e === 1 &&
                t === 0 &&
                n === 0 &&
                r === 0 &&
                i === 0 &&
                a === 1 &&
                o === 0 &&
                s === 0 &&
                c === 0 &&
                l === 0 &&
                u === 1 &&
                d === 0
              )
                return (
                  (_[12] = _[12] * e + _[15] * f),
                  (_[13] = _[13] * a + _[15] * p),
                  (_[14] = _[14] * u + _[15] * m),
                  (_[15] *= g),
                  (this._identityCalculated = !1),
                  this
                );
              var y = _[0],
                b = _[1],
                x = _[2],
                S = _[3],
                C = _[4],
                T = _[5],
                E = _[6],
                D = _[7],
                O = _[8],
                k = _[9],
                A = _[10],
                j = _[11],
                M = _[12],
                N = _[13],
                P = _[14],
                F = _[15];
              return (
                (_[0] = y * e + b * i + x * c + S * f),
                (_[1] = y * t + b * a + x * l + S * p),
                (_[2] = y * n + b * o + x * u + S * m),
                (_[3] = y * r + b * s + x * d + S * g),
                (_[4] = C * e + T * i + E * c + D * f),
                (_[5] = C * t + T * a + E * l + D * p),
                (_[6] = C * n + T * o + E * u + D * m),
                (_[7] = C * r + T * s + E * d + D * g),
                (_[8] = O * e + k * i + A * c + j * f),
                (_[9] = O * t + k * a + A * l + j * p),
                (_[10] = O * n + k * o + A * u + j * m),
                (_[11] = O * r + k * s + A * d + j * g),
                (_[12] = M * e + N * i + P * c + F * f),
                (_[13] = M * t + N * a + P * l + F * p),
                (_[14] = M * n + N * o + P * u + F * m),
                (_[15] = M * r + N * s + P * d + F * g),
                (this._identityCalculated = !1),
                this
              );
            }
            function _(e) {
              var t = e.props;
              return this.transform(
                t[0],
                t[1],
                t[2],
                t[3],
                t[4],
                t[5],
                t[6],
                t[7],
                t[8],
                t[9],
                t[10],
                t[11],
                t[12],
                t[13],
                t[14],
                t[15],
              );
            }
            function y() {
              return (
                (this._identityCalculated ||=
                  ((this._identity = !(
                    this.props[0] !== 1 ||
                    this.props[1] !== 0 ||
                    this.props[2] !== 0 ||
                    this.props[3] !== 0 ||
                    this.props[4] !== 0 ||
                    this.props[5] !== 1 ||
                    this.props[6] !== 0 ||
                    this.props[7] !== 0 ||
                    this.props[8] !== 0 ||
                    this.props[9] !== 0 ||
                    this.props[10] !== 1 ||
                    this.props[11] !== 0 ||
                    this.props[12] !== 0 ||
                    this.props[13] !== 0 ||
                    this.props[14] !== 0 ||
                    this.props[15] !== 1
                  )),
                  !0)),
                this._identity
              );
            }
            function b(e) {
              for (var t = 0; t < 16;) {
                if (e.props[t] !== this.props[t]) return !1;
                t += 1;
              }
              return !0;
            }
            function x(e) {
              var t;
              for (t = 0; t < 16; t += 1) e.props[t] = this.props[t];
              return e;
            }
            function S(e) {
              var t;
              for (t = 0; t < 16; t += 1) this.props[t] = e[t];
            }
            function C(e, t, n) {
              return {
                x:
                  e * this.props[0] +
                  t * this.props[4] +
                  n * this.props[8] +
                  this.props[12],
                y:
                  e * this.props[1] +
                  t * this.props[5] +
                  n * this.props[9] +
                  this.props[13],
                z:
                  e * this.props[2] +
                  t * this.props[6] +
                  n * this.props[10] +
                  this.props[14],
              };
            }
            function T(e, t, n) {
              return (
                e * this.props[0] +
                t * this.props[4] +
                n * this.props[8] +
                this.props[12]
              );
            }
            function E(e, t, n) {
              return (
                e * this.props[1] +
                t * this.props[5] +
                n * this.props[9] +
                this.props[13]
              );
            }
            function D(e, t, n) {
              return (
                e * this.props[2] +
                t * this.props[6] +
                n * this.props[10] +
                this.props[14]
              );
            }
            function O() {
              var e =
                  this.props[0] * this.props[5] - this.props[1] * this.props[4],
                t = this.props[5] / e,
                n = -this.props[1] / e,
                r = -this.props[4] / e,
                i = this.props[0] / e,
                a =
                  (this.props[4] * this.props[13] -
                    this.props[5] * this.props[12]) /
                  e,
                o =
                  -(
                    this.props[0] * this.props[13] -
                    this.props[1] * this.props[12]
                  ) / e,
                s = new Matrix();
              return (
                (s.props[0] = t),
                (s.props[1] = n),
                (s.props[4] = r),
                (s.props[5] = i),
                (s.props[12] = a),
                (s.props[13] = o),
                s
              );
            }
            function k(e) {
              return this.getInverseMatrix().applyToPointArray(
                e[0],
                e[1],
                e[2] || 0,
              );
            }
            function A(e) {
              var t,
                n = e.length,
                r = [];
              for (t = 0; t < n; t += 1) r[t] = k(e[t]);
              return r;
            }
            function j(e, t, n) {
              var r = createTypedArray(`float32`, 6);
              if (this.isIdentity())
                ((r[0] = e[0]),
                  (r[1] = e[1]),
                  (r[2] = t[0]),
                  (r[3] = t[1]),
                  (r[4] = n[0]),
                  (r[5] = n[1]));
              else {
                var i = this.props[0],
                  a = this.props[1],
                  o = this.props[4],
                  s = this.props[5],
                  c = this.props[12],
                  l = this.props[13];
                ((r[0] = e[0] * i + e[1] * o + c),
                  (r[1] = e[0] * a + e[1] * s + l),
                  (r[2] = t[0] * i + t[1] * o + c),
                  (r[3] = t[0] * a + t[1] * s + l),
                  (r[4] = n[0] * i + n[1] * o + c),
                  (r[5] = n[0] * a + n[1] * s + l));
              }
              return r;
            }
            function M(e, t, n) {
              return this.isIdentity()
                ? [e, t, n]
                : [
                    e * this.props[0] +
                      t * this.props[4] +
                      n * this.props[8] +
                      this.props[12],
                    e * this.props[1] +
                      t * this.props[5] +
                      n * this.props[9] +
                      this.props[13],
                    e * this.props[2] +
                      t * this.props[6] +
                      n * this.props[10] +
                      this.props[14],
                  ];
            }
            function N(e, t) {
              if (this.isIdentity()) return e + `,` + t;
              var n = this.props;
              return (
                Math.round((e * n[0] + t * n[4] + n[12]) * 100) / 100 +
                `,` +
                Math.round((e * n[1] + t * n[5] + n[13]) * 100) / 100
              );
            }
            function P() {
              for (var e = 0, t = this.props, n = `matrix3d(`, i = 1e4; e < 16;)
                ((n += r(t[e] * i) / i), (n += e === 15 ? `)` : `,`), (e += 1));
              return n;
            }
            function F(e) {
              var t = 1e4;
              return (e < 1e-6 && e > 0) || (e > -1e-6 && e < 0)
                ? r(e * t) / t
                : e;
            }
            function I() {
              var e = this.props,
                t = F(e[0]),
                n = F(e[1]),
                r = F(e[4]),
                i = F(e[5]),
                a = F(e[12]),
                o = F(e[13]);
              return (
                `matrix(` +
                t +
                `,` +
                n +
                `,` +
                r +
                `,` +
                i +
                `,` +
                a +
                `,` +
                o +
                `)`
              );
            }
            return function () {
              ((this.reset = i),
                (this.rotate = a),
                (this.rotateX = o),
                (this.rotateY = s),
                (this.rotateZ = c),
                (this.skew = u),
                (this.skewFromAxis = d),
                (this.shear = l),
                (this.scale = f),
                (this.setTransform = p),
                (this.translate = m),
                (this.transform = g),
                (this.multiply = _),
                (this.applyToPoint = C),
                (this.applyToX = T),
                (this.applyToY = E),
                (this.applyToZ = D),
                (this.applyToPointArray = M),
                (this.applyToTriplePoints = j),
                (this.applyToPointStringified = N),
                (this.toCSS = P),
                (this.to2dCSS = I),
                (this.clone = x),
                (this.cloneFromProps = S),
                (this.equals = b),
                (this.inversePoints = A),
                (this.inversePoint = k),
                (this.getInverseMatrix = O),
                (this._t = this.transform),
                (this.isIdentity = y),
                (this._identity = !0),
                (this._identityCalculated = !1),
                (this.props = createTypedArray(`float32`, 16)),
                this.reset());
            };
          })();
        function _typeof$3(e) {
          "@babel/helpers - typeof";
          return (
            (_typeof$3 =
              typeof Symbol == `function` && typeof Symbol.iterator == `symbol`
                ? function (e) {
                    return typeof e;
                  }
                : function (e) {
                    return e &&
                      typeof Symbol == `function` &&
                      e.constructor === Symbol &&
                      e !== Symbol.prototype
                      ? `symbol`
                      : typeof e;
                  }),
            _typeof$3(e)
          );
        }
        var lottie = {},
          standalone = `__[STANDALONE]__`,
          animationData = `__[ANIMATIONDATA]__`,
          renderer = ``;
        function setLocation(e) {
          setLocationHref(e);
        }
        function searchAnimations() {
          standalone === !0
            ? animationManager.searchAnimations(
                animationData,
                standalone,
                renderer,
              )
            : animationManager.searchAnimations();
        }
        function setSubframeRendering(e) {
          setSubframeEnabled(e);
        }
        function setPrefix(e) {
          setIdPrefix(e);
        }
        function loadAnimation(e) {
          return (
            standalone === !0 && (e.animationData = JSON.parse(animationData)),
            animationManager.loadAnimation(e)
          );
        }
        function setQuality(e) {
          if (typeof e == `string`)
            switch (e) {
              case `high`:
                setDefaultCurveSegments(200);
                break;
              default:
              case `medium`:
                setDefaultCurveSegments(50);
                break;
              case `low`:
                setDefaultCurveSegments(10);
                break;
            }
          else !isNaN(e) && e > 1 && setDefaultCurveSegments(e);
          getDefaultCurveSegments() >= 50 ? roundValues(!1) : roundValues(!0);
        }
        function inBrowser() {
          return typeof navigator < `u`;
        }
        function installPlugin(e, t) {
          e === `expressions` && setExpressionsPlugin(t);
        }
        function getFactory(e) {
          switch (e) {
            case `propertyFactory`:
              return PropertyFactory;
            case `shapePropertyFactory`:
              return ShapePropertyFactory;
            case `matrix`:
              return Matrix;
            default:
              return null;
          }
        }
        ((lottie.play = animationManager.play),
          (lottie.pause = animationManager.pause),
          (lottie.setLocationHref = setLocation),
          (lottie.togglePause = animationManager.togglePause),
          (lottie.setSpeed = animationManager.setSpeed),
          (lottie.setDirection = animationManager.setDirection),
          (lottie.stop = animationManager.stop),
          (lottie.searchAnimations = searchAnimations),
          (lottie.registerAnimation = animationManager.registerAnimation),
          (lottie.loadAnimation = loadAnimation),
          (lottie.setSubframeRendering = setSubframeRendering),
          (lottie.resize = animationManager.resize),
          (lottie.goToAndStop = animationManager.goToAndStop),
          (lottie.destroy = animationManager.destroy),
          (lottie.setQuality = setQuality),
          (lottie.inBrowser = inBrowser),
          (lottie.installPlugin = installPlugin),
          (lottie.freeze = animationManager.freeze),
          (lottie.unfreeze = animationManager.unfreeze),
          (lottie.setVolume = animationManager.setVolume),
          (lottie.mute = animationManager.mute),
          (lottie.unmute = animationManager.unmute),
          (lottie.getRegisteredAnimations =
            animationManager.getRegisteredAnimations),
          (lottie.useWebWorker = setWebWorker),
          (lottie.setIDPrefix = setPrefix),
          (lottie.__getFactory = getFactory),
          (lottie.version = `5.13.0`));
        function checkReady() {
          document.readyState === `complete` &&
            (clearInterval(readyStateCheckInterval), searchAnimations());
        }
        function getQueryVariable(e) {
          for (var t = queryString.split(`&`), n = 0; n < t.length; n += 1) {
            var r = t[n].split(`=`);
            if (decodeURIComponent(r[0]) == e) return decodeURIComponent(r[1]);
          }
          return null;
        }
        var queryString = ``;
        if (standalone) {
          var scripts = document.getElementsByTagName(`script`),
            myScript = scripts[scripts.length - 1] || { src: `` };
          ((queryString = myScript.src
            ? myScript.src.replace(/^[^\?]+\??/, ``)
            : ``),
            (renderer = getQueryVariable(`renderer`)));
        }
        var readyStateCheckInterval = setInterval(checkReady, 100);
        try {
          !(
            (exports === void 0 ? `undefined` : _typeof$3(exports)) ===
              `object` && module !== void 0
          ) &&
            !(typeof define == `function` && define.amd) &&
            (window.bodymovin = lottie);
        } catch {}
        var ShapeModifiers = (function () {
          var e = {},
            t = {};
          ((e.registerModifier = n), (e.getModifier = r));
          function n(e, n) {
            t[e] || (t[e] = n);
          }
          function r(e, n, r) {
            return new t[e](n, r);
          }
          return e;
        })();
        function ShapeModifier() {}
        ((ShapeModifier.prototype.initModifierProperties = function () {}),
          (ShapeModifier.prototype.addShapeToModifier = function () {}),
          (ShapeModifier.prototype.addShape = function (e) {
            if (!this.closed) {
              e.sh.container.addDynamicProperty(e.sh);
              var t = {
                shape: e.sh,
                data: e,
                localShapeCollection: shapeCollectionPool.newShapeCollection(),
              };
              (this.shapes.push(t),
                this.addShapeToModifier(t),
                this._isAnimated && e.setAsAnimated());
            }
          }),
          (ShapeModifier.prototype.init = function (e, t) {
            ((this.shapes = []),
              (this.elem = e),
              this.initDynamicPropertyContainer(e),
              this.initModifierProperties(e, t),
              (this.frameId = initialDefaultFrame),
              (this.closed = !1),
              (this.k = !1),
              this.dynamicProperties.length
                ? (this.k = !0)
                : this.getValue(!0));
          }),
          (ShapeModifier.prototype.processKeys = function () {
            this.elem.globalData.frameId !== this.frameId &&
              ((this.frameId = this.elem.globalData.frameId),
              this.iterateDynamicProperties());
          }),
          extendPrototype([DynamicPropertyContainer], ShapeModifier));
        function TrimModifier() {}
        (extendPrototype([ShapeModifier], TrimModifier),
          (TrimModifier.prototype.initModifierProperties = function (e, t) {
            ((this.s = PropertyFactory.getProp(e, t.s, 0, 0.01, this)),
              (this.e = PropertyFactory.getProp(e, t.e, 0, 0.01, this)),
              (this.o = PropertyFactory.getProp(e, t.o, 0, 0, this)),
              (this.sValue = 0),
              (this.eValue = 0),
              (this.getValue = this.processKeys),
              (this.m = t.m),
              (this._isAnimated =
                !!this.s.effectsSequence.length ||
                !!this.e.effectsSequence.length ||
                !!this.o.effectsSequence.length));
          }),
          (TrimModifier.prototype.addShapeToModifier = function (e) {
            e.pathsData = [];
          }),
          (TrimModifier.prototype.calculateShapeEdges = function (
            e,
            t,
            n,
            r,
            i,
          ) {
            var a = [];
            t <= 1
              ? a.push({ s: e, e: t })
              : e >= 1
                ? a.push({ s: e - 1, e: t - 1 })
                : (a.push({ s: e, e: 1 }), a.push({ s: 0, e: t - 1 }));
            var o = [],
              s,
              c = a.length,
              l;
            for (s = 0; s < c; s += 1)
              if (((l = a[s]), !(l.e * i < r || l.s * i > r + n))) {
                var u = l.s * i <= r ? 0 : (l.s * i - r) / n,
                  d = l.e * i >= r + n ? 1 : (l.e * i - r) / n;
                o.push([u, d]);
              }
            return (o.length || o.push([0, 0]), o);
          }),
          (TrimModifier.prototype.releasePathsData = function (e) {
            var t,
              n = e.length;
            for (t = 0; t < n; t += 1) segmentsLengthPool.release(e[t]);
            return ((e.length = 0), e);
          }),
          (TrimModifier.prototype.processShapes = function (e) {
            var t, n;
            if (this._mdf || e) {
              var r = (this.o.v % 360) / 360;
              if (
                (r < 0 && (r += 1),
                (t =
                  this.s.v > 1 ? 1 + r : this.s.v < 0 ? 0 + r : this.s.v + r),
                (n =
                  this.e.v > 1 ? 1 + r : this.e.v < 0 ? 0 + r : this.e.v + r),
                t > n)
              ) {
                var i = t;
                ((t = n), (n = i));
              }
              ((t = Math.round(t * 1e4) * 1e-4),
                (n = Math.round(n * 1e4) * 1e-4),
                (this.sValue = t),
                (this.eValue = n));
            } else ((t = this.sValue), (n = this.eValue));
            var a,
              o,
              s = this.shapes.length,
              c,
              l,
              u,
              d,
              f,
              p = 0;
            if (n === t)
              for (o = 0; o < s; o += 1)
                (this.shapes[o].localShapeCollection.releaseShapes(),
                  (this.shapes[o].shape._mdf = !0),
                  (this.shapes[o].shape.paths =
                    this.shapes[o].localShapeCollection),
                  this._mdf && (this.shapes[o].pathsData.length = 0));
            else if (!((n === 1 && t === 0) || (n === 0 && t === 1))) {
              var m = [],
                g,
                _;
              for (o = 0; o < s; o += 1)
                if (
                  ((g = this.shapes[o]),
                  !g.shape._mdf && !this._mdf && !e && this.m !== 2)
                )
                  g.shape.paths = g.localShapeCollection;
                else {
                  if (
                    ((a = g.shape.paths),
                    (l = a._length),
                    (f = 0),
                    !g.shape._mdf && g.pathsData.length)
                  )
                    f = g.totalShapeLength;
                  else {
                    for (
                      u = this.releasePathsData(g.pathsData), c = 0;
                      c < l;
                      c += 1
                    )
                      ((d = bez.getSegmentsLength(a.shapes[c])),
                        u.push(d),
                        (f += d.totalLength));
                    ((g.totalShapeLength = f), (g.pathsData = u));
                  }
                  ((p += f), (g.shape._mdf = !0));
                }
              var y = t,
                b = n,
                x = 0,
                S;
              for (o = s - 1; o >= 0; --o)
                if (((g = this.shapes[o]), g.shape._mdf)) {
                  for (
                    _ = g.localShapeCollection,
                      _.releaseShapes(),
                      this.m === 2 && s > 1
                        ? ((S = this.calculateShapeEdges(
                            t,
                            n,
                            g.totalShapeLength,
                            x,
                            p,
                          )),
                          (x += g.totalShapeLength))
                        : (S = [[y, b]]),
                      l = S.length,
                      c = 0;
                    c < l;
                    c += 1
                  ) {
                    ((y = S[c][0]),
                      (b = S[c][1]),
                      (m.length = 0),
                      b <= 1
                        ? m.push({
                            s: g.totalShapeLength * y,
                            e: g.totalShapeLength * b,
                          })
                        : y >= 1
                          ? m.push({
                              s: g.totalShapeLength * (y - 1),
                              e: g.totalShapeLength * (b - 1),
                            })
                          : (m.push({
                              s: g.totalShapeLength * y,
                              e: g.totalShapeLength,
                            }),
                            m.push({ s: 0, e: g.totalShapeLength * (b - 1) })));
                    var C = this.addShapes(g, m[0]);
                    if (m[0].s !== m[0].e) {
                      if (m.length > 1)
                        if (g.shape.paths.shapes[g.shape.paths._length - 1].c) {
                          var T = C.pop();
                          (this.addPaths(C, _),
                            (C = this.addShapes(g, m[1], T)));
                        } else
                          (this.addPaths(C, _), (C = this.addShapes(g, m[1])));
                      this.addPaths(C, _);
                    }
                  }
                  g.shape.paths = _;
                }
            } else if (this._mdf)
              for (o = 0; o < s; o += 1)
                ((this.shapes[o].pathsData.length = 0),
                  (this.shapes[o].shape._mdf = !0));
          }),
          (TrimModifier.prototype.addPaths = function (e, t) {
            var n,
              r = e.length;
            for (n = 0; n < r; n += 1) t.addShape(e[n]);
          }),
          (TrimModifier.prototype.addSegment = function (e, t, n, r, i, a, o) {
            (i.setXYAt(t[0], t[1], `o`, a),
              i.setXYAt(n[0], n[1], `i`, a + 1),
              o && i.setXYAt(e[0], e[1], `v`, a),
              i.setXYAt(r[0], r[1], `v`, a + 1));
          }),
          (TrimModifier.prototype.addSegmentFromArray = function (e, t, n, r) {
            (t.setXYAt(e[1], e[5], `o`, n),
              t.setXYAt(e[2], e[6], `i`, n + 1),
              r && t.setXYAt(e[0], e[4], `v`, n),
              t.setXYAt(e[3], e[7], `v`, n + 1));
          }),
          (TrimModifier.prototype.addShapes = function (e, t, n) {
            var r = e.pathsData,
              i = e.shape.paths.shapes,
              a,
              o = e.shape.paths._length,
              s,
              c,
              l = 0,
              u,
              d,
              f,
              p,
              m = [],
              g,
              _ = !0;
            for (
              n
                ? ((d = n._length), (g = n._length))
                : ((n = shapePool.newElement()), (d = 0), (g = 0)),
                m.push(n),
                a = 0;
              a < o;
              a += 1
            ) {
              for (
                f = r[a].lengths,
                  n.c = i[a].c,
                  c = i[a].c ? f.length : f.length + 1,
                  s = 1;
                s < c;
                s += 1
              )
                if (((u = f[s - 1]), l + u.addedLength < t.s))
                  ((l += u.addedLength), (n.c = !1));
                else if (l > t.e) {
                  n.c = !1;
                  break;
                } else
                  (t.s <= l && t.e >= l + u.addedLength
                    ? (this.addSegment(
                        i[a].v[s - 1],
                        i[a].o[s - 1],
                        i[a].i[s],
                        i[a].v[s],
                        n,
                        d,
                        _,
                      ),
                      (_ = !1))
                    : ((p = bez.getNewSegment(
                        i[a].v[s - 1],
                        i[a].v[s],
                        i[a].o[s - 1],
                        i[a].i[s],
                        (t.s - l) / u.addedLength,
                        (t.e - l) / u.addedLength,
                        f[s - 1],
                      )),
                      this.addSegmentFromArray(p, n, d, _),
                      (_ = !1),
                      (n.c = !1)),
                    (l += u.addedLength),
                    (d += 1));
              if (i[a].c && f.length) {
                if (((u = f[s - 1]), l <= t.e)) {
                  var y = f[s - 1].addedLength;
                  t.s <= l && t.e >= l + y
                    ? (this.addSegment(
                        i[a].v[s - 1],
                        i[a].o[s - 1],
                        i[a].i[0],
                        i[a].v[0],
                        n,
                        d,
                        _,
                      ),
                      (_ = !1))
                    : ((p = bez.getNewSegment(
                        i[a].v[s - 1],
                        i[a].v[0],
                        i[a].o[s - 1],
                        i[a].i[0],
                        (t.s - l) / y,
                        (t.e - l) / y,
                        f[s - 1],
                      )),
                      this.addSegmentFromArray(p, n, d, _),
                      (_ = !1),
                      (n.c = !1));
                } else n.c = !1;
                ((l += u.addedLength), (d += 1));
              }
              if (
                (n._length &&
                  (n.setXYAt(n.v[g][0], n.v[g][1], `i`, g),
                  n.setXYAt(
                    n.v[n._length - 1][0],
                    n.v[n._length - 1][1],
                    `o`,
                    n._length - 1,
                  )),
                l > t.e)
              )
                break;
              a < o - 1 &&
                ((n = shapePool.newElement()), (_ = !0), m.push(n), (d = 0));
            }
            return m;
          }));
        function PuckerAndBloatModifier() {}
        (extendPrototype([ShapeModifier], PuckerAndBloatModifier),
          (PuckerAndBloatModifier.prototype.initModifierProperties = function (
            e,
            t,
          ) {
            ((this.getValue = this.processKeys),
              (this.amount = PropertyFactory.getProp(e, t.a, 0, null, this)),
              (this._isAnimated = !!this.amount.effectsSequence.length));
          }),
          (PuckerAndBloatModifier.prototype.processPath = function (e, t) {
            var n = t / 100,
              r = [0, 0],
              i = e._length,
              a = 0;
            for (a = 0; a < i; a += 1)
              ((r[0] += e.v[a][0]), (r[1] += e.v[a][1]));
            ((r[0] /= i), (r[1] /= i));
            var o = shapePool.newElement();
            o.c = e.c;
            var s, c, l, u, d, f;
            for (a = 0; a < i; a += 1)
              ((s = e.v[a][0] + (r[0] - e.v[a][0]) * n),
                (c = e.v[a][1] + (r[1] - e.v[a][1]) * n),
                (l = e.o[a][0] + (r[0] - e.o[a][0]) * -n),
                (u = e.o[a][1] + (r[1] - e.o[a][1]) * -n),
                (d = e.i[a][0] + (r[0] - e.i[a][0]) * -n),
                (f = e.i[a][1] + (r[1] - e.i[a][1]) * -n),
                o.setTripleAt(s, c, l, u, d, f, a));
            return o;
          }),
          (PuckerAndBloatModifier.prototype.processShapes = function (e) {
            var t,
              n,
              r = this.shapes.length,
              i,
              a,
              o = this.amount.v;
            if (o !== 0) {
              var s, c;
              for (n = 0; n < r; n += 1) {
                if (
                  ((s = this.shapes[n]),
                  (c = s.localShapeCollection),
                  !(!s.shape._mdf && !this._mdf && !e))
                )
                  for (
                    c.releaseShapes(),
                      s.shape._mdf = !0,
                      t = s.shape.paths.shapes,
                      a = s.shape.paths._length,
                      i = 0;
                    i < a;
                    i += 1
                  )
                    c.addShape(this.processPath(t[i], o));
                s.shape.paths = s.localShapeCollection;
              }
            }
            this.dynamicProperties.length || (this._mdf = !1);
          }));
        var TransformPropertyFactory = (function () {
          var e = [0, 0];
          function t(e) {
            var t = this._mdf;
            (this.iterateDynamicProperties(),
              (this._mdf = this._mdf || t),
              this.a && e.translate(-this.a.v[0], -this.a.v[1], this.a.v[2]),
              this.s && e.scale(this.s.v[0], this.s.v[1], this.s.v[2]),
              this.sk && e.skewFromAxis(-this.sk.v, this.sa.v),
              this.r
                ? e.rotate(-this.r.v)
                : e
                    .rotateZ(-this.rz.v)
                    .rotateY(this.ry.v)
                    .rotateX(this.rx.v)
                    .rotateZ(-this.or.v[2])
                    .rotateY(this.or.v[1])
                    .rotateX(this.or.v[0]),
              this.data.p.s
                ? this.data.p.z
                  ? e.translate(this.px.v, this.py.v, -this.pz.v)
                  : e.translate(this.px.v, this.py.v, 0)
                : e.translate(this.p.v[0], this.p.v[1], -this.p.v[2]));
          }
          function n(t) {
            if (this.elem.globalData.frameId !== this.frameId) {
              if (
                ((this._isDirty &&= (this.precalculateMatrix(), !1)),
                this.iterateDynamicProperties(),
                this._mdf || t)
              ) {
                var n;
                if (
                  (this.v.cloneFromProps(this.pre.props),
                  this.appliedTransformations < 1 &&
                    this.v.translate(-this.a.v[0], -this.a.v[1], this.a.v[2]),
                  this.appliedTransformations < 2 &&
                    this.v.scale(this.s.v[0], this.s.v[1], this.s.v[2]),
                  this.sk &&
                    this.appliedTransformations < 3 &&
                    this.v.skewFromAxis(-this.sk.v, this.sa.v),
                  this.r && this.appliedTransformations < 4
                    ? this.v.rotate(-this.r.v)
                    : !this.r &&
                      this.appliedTransformations < 4 &&
                      this.v
                        .rotateZ(-this.rz.v)
                        .rotateY(this.ry.v)
                        .rotateX(this.rx.v)
                        .rotateZ(-this.or.v[2])
                        .rotateY(this.or.v[1])
                        .rotateX(this.or.v[0]),
                  this.autoOriented)
                ) {
                  var r, i;
                  if (
                    ((n = this.elem.globalData.frameRate),
                    this.p && this.p.keyframes && this.p.getValueAtTime)
                  )
                    this.p._caching.lastFrame + this.p.offsetTime <=
                    this.p.keyframes[0].t
                      ? ((r = this.p.getValueAtTime(
                          (this.p.keyframes[0].t + 0.01) / n,
                          0,
                        )),
                        (i = this.p.getValueAtTime(
                          this.p.keyframes[0].t / n,
                          0,
                        )))
                      : this.p._caching.lastFrame + this.p.offsetTime >=
                          this.p.keyframes[this.p.keyframes.length - 1].t
                        ? ((r = this.p.getValueAtTime(
                            this.p.keyframes[this.p.keyframes.length - 1].t / n,
                            0,
                          )),
                          (i = this.p.getValueAtTime(
                            (this.p.keyframes[this.p.keyframes.length - 1].t -
                              0.05) /
                              n,
                            0,
                          )))
                        : ((r = this.p.pv),
                          (i = this.p.getValueAtTime(
                            (this.p._caching.lastFrame +
                              this.p.offsetTime -
                              0.01) /
                              n,
                            this.p.offsetTime,
                          )));
                  else if (
                    this.px &&
                    this.px.keyframes &&
                    this.py.keyframes &&
                    this.px.getValueAtTime &&
                    this.py.getValueAtTime
                  ) {
                    ((r = []), (i = []));
                    var a = this.px,
                      o = this.py;
                    a._caching.lastFrame + a.offsetTime <= a.keyframes[0].t
                      ? ((r[0] = a.getValueAtTime(
                          (a.keyframes[0].t + 0.01) / n,
                          0,
                        )),
                        (r[1] = o.getValueAtTime(
                          (o.keyframes[0].t + 0.01) / n,
                          0,
                        )),
                        (i[0] = a.getValueAtTime(a.keyframes[0].t / n, 0)),
                        (i[1] = o.getValueAtTime(o.keyframes[0].t / n, 0)))
                      : a._caching.lastFrame + a.offsetTime >=
                          a.keyframes[a.keyframes.length - 1].t
                        ? ((r[0] = a.getValueAtTime(
                            a.keyframes[a.keyframes.length - 1].t / n,
                            0,
                          )),
                          (r[1] = o.getValueAtTime(
                            o.keyframes[o.keyframes.length - 1].t / n,
                            0,
                          )),
                          (i[0] = a.getValueAtTime(
                            (a.keyframes[a.keyframes.length - 1].t - 0.01) / n,
                            0,
                          )),
                          (i[1] = o.getValueAtTime(
                            (o.keyframes[o.keyframes.length - 1].t - 0.01) / n,
                            0,
                          )))
                        : ((r = [a.pv, o.pv]),
                          (i[0] = a.getValueAtTime(
                            (a._caching.lastFrame + a.offsetTime - 0.01) / n,
                            a.offsetTime,
                          )),
                          (i[1] = o.getValueAtTime(
                            (o._caching.lastFrame + o.offsetTime - 0.01) / n,
                            o.offsetTime,
                          )));
                  } else ((i = e), (r = i));
                  this.v.rotate(-Math.atan2(r[1] - i[1], r[0] - i[0]));
                }
                this.data.p && this.data.p.s
                  ? this.data.p.z
                    ? this.v.translate(this.px.v, this.py.v, -this.pz.v)
                    : this.v.translate(this.px.v, this.py.v, 0)
                  : this.v.translate(this.p.v[0], this.p.v[1], -this.p.v[2]);
              }
              this.frameId = this.elem.globalData.frameId;
            }
          }
          function r() {
            if (
              ((this.appliedTransformations = 0),
              this.pre.reset(),
              !this.a.effectsSequence.length)
            )
              (this.pre.translate(-this.a.v[0], -this.a.v[1], this.a.v[2]),
                (this.appliedTransformations = 1));
            else return;
            if (!this.s.effectsSequence.length)
              (this.pre.scale(this.s.v[0], this.s.v[1], this.s.v[2]),
                (this.appliedTransformations = 2));
            else return;
            if (this.sk)
              if (
                !this.sk.effectsSequence.length &&
                !this.sa.effectsSequence.length
              )
                (this.pre.skewFromAxis(-this.sk.v, this.sa.v),
                  (this.appliedTransformations = 3));
              else return;
            this.r
              ? this.r.effectsSequence.length ||
                (this.pre.rotate(-this.r.v), (this.appliedTransformations = 4))
              : !this.rz.effectsSequence.length &&
                !this.ry.effectsSequence.length &&
                !this.rx.effectsSequence.length &&
                !this.or.effectsSequence.length &&
                (this.pre
                  .rotateZ(-this.rz.v)
                  .rotateY(this.ry.v)
                  .rotateX(this.rx.v)
                  .rotateZ(-this.or.v[2])
                  .rotateY(this.or.v[1])
                  .rotateX(this.or.v[0]),
                (this.appliedTransformations = 4));
          }
          function i() {}
          function a(e) {
            (this._addDynamicProperty(e),
              this.elem.addDynamicProperty(e),
              (this._isDirty = !0));
          }
          function o(e, t, n) {
            if (
              ((this.elem = e),
              (this.frameId = -1),
              (this.propType = `transform`),
              (this.data = t),
              (this.v = new Matrix()),
              (this.pre = new Matrix()),
              (this.appliedTransformations = 0),
              this.initDynamicPropertyContainer(n || e),
              t.p && t.p.s
                ? ((this.px = PropertyFactory.getProp(e, t.p.x, 0, 0, this)),
                  (this.py = PropertyFactory.getProp(e, t.p.y, 0, 0, this)),
                  t.p.z &&
                    (this.pz = PropertyFactory.getProp(e, t.p.z, 0, 0, this)))
                : (this.p = PropertyFactory.getProp(
                    e,
                    t.p || { k: [0, 0, 0] },
                    1,
                    0,
                    this,
                  )),
              t.rx)
            ) {
              if (
                ((this.rx = PropertyFactory.getProp(
                  e,
                  t.rx,
                  0,
                  degToRads,
                  this,
                )),
                (this.ry = PropertyFactory.getProp(
                  e,
                  t.ry,
                  0,
                  degToRads,
                  this,
                )),
                (this.rz = PropertyFactory.getProp(
                  e,
                  t.rz,
                  0,
                  degToRads,
                  this,
                )),
                t.or.k[0].ti)
              ) {
                var r,
                  i = t.or.k.length;
                for (r = 0; r < i; r += 1)
                  ((t.or.k[r].to = null), (t.or.k[r].ti = null));
              }
              ((this.or = PropertyFactory.getProp(e, t.or, 1, degToRads, this)),
                (this.or.sh = !0));
            } else
              this.r = PropertyFactory.getProp(
                e,
                t.r || { k: 0 },
                0,
                degToRads,
                this,
              );
            (t.sk &&
              ((this.sk = PropertyFactory.getProp(e, t.sk, 0, degToRads, this)),
              (this.sa = PropertyFactory.getProp(e, t.sa, 0, degToRads, this))),
              (this.a = PropertyFactory.getProp(
                e,
                t.a || { k: [0, 0, 0] },
                1,
                0,
                this,
              )),
              (this.s = PropertyFactory.getProp(
                e,
                t.s || { k: [100, 100, 100] },
                1,
                0.01,
                this,
              )),
              t.o
                ? (this.o = PropertyFactory.getProp(e, t.o, 0, 0.01, e))
                : (this.o = { _mdf: !1, v: 1 }),
              (this._isDirty = !0),
              this.dynamicProperties.length || this.getValue(!0));
          }
          ((o.prototype = {
            applyToMatrix: t,
            getValue: n,
            precalculateMatrix: r,
            autoOrient: i,
          }),
            extendPrototype([DynamicPropertyContainer], o),
            (o.prototype.addDynamicProperty = a),
            (o.prototype._addDynamicProperty =
              DynamicPropertyContainer.prototype.addDynamicProperty));
          function s(e, t, n) {
            return new o(e, t, n);
          }
          return { getTransformProperty: s };
        })();
        function RepeaterModifier() {}
        (extendPrototype([ShapeModifier], RepeaterModifier),
          (RepeaterModifier.prototype.initModifierProperties = function (e, t) {
            ((this.getValue = this.processKeys),
              (this.c = PropertyFactory.getProp(e, t.c, 0, null, this)),
              (this.o = PropertyFactory.getProp(e, t.o, 0, null, this)),
              (this.tr = TransformPropertyFactory.getTransformProperty(
                e,
                t.tr,
                this,
              )),
              (this.so = PropertyFactory.getProp(e, t.tr.so, 0, 0.01, this)),
              (this.eo = PropertyFactory.getProp(e, t.tr.eo, 0, 0.01, this)),
              (this.data = t),
              this.dynamicProperties.length || this.getValue(!0),
              (this._isAnimated = !!this.dynamicProperties.length),
              (this.pMatrix = new Matrix()),
              (this.rMatrix = new Matrix()),
              (this.sMatrix = new Matrix()),
              (this.tMatrix = new Matrix()),
              (this.matrix = new Matrix()));
          }),
          (RepeaterModifier.prototype.applyTransforms = function (
            e,
            t,
            n,
            r,
            i,
            a,
          ) {
            var o = a ? -1 : 1,
              s = r.s.v[0] + (1 - r.s.v[0]) * (1 - i),
              c = r.s.v[1] + (1 - r.s.v[1]) * (1 - i);
            (e.translate(r.p.v[0] * o * i, r.p.v[1] * o * i, r.p.v[2]),
              t.translate(-r.a.v[0], -r.a.v[1], r.a.v[2]),
              t.rotate(-r.r.v * o * i),
              t.translate(r.a.v[0], r.a.v[1], r.a.v[2]),
              n.translate(-r.a.v[0], -r.a.v[1], r.a.v[2]),
              n.scale(a ? 1 / s : s, a ? 1 / c : c),
              n.translate(r.a.v[0], r.a.v[1], r.a.v[2]));
          }),
          (RepeaterModifier.prototype.init = function (e, t, n, r) {
            for (
              this.elem = e,
                this.arr = t,
                this.pos = n,
                this.elemsData = r,
                this._currentCopies = 0,
                this._elements = [],
                this._groups = [],
                this.frameId = -1,
                this.initDynamicPropertyContainer(e),
                this.initModifierProperties(e, t[n]);
              n > 0;
            )
              (--n, this._elements.unshift(t[n]));
            this.dynamicProperties.length ? (this.k = !0) : this.getValue(!0);
          }),
          (RepeaterModifier.prototype.resetElements = function (e) {
            var t,
              n = e.length;
            for (t = 0; t < n; t += 1)
              ((e[t]._processed = !1),
                e[t].ty === `gr` && this.resetElements(e[t].it));
          }),
          (RepeaterModifier.prototype.cloneElements = function (e) {
            var t = JSON.parse(JSON.stringify(e));
            return (this.resetElements(t), t);
          }),
          (RepeaterModifier.prototype.changeGroupRender = function (e, t) {
            var n,
              r = e.length;
            for (n = 0; n < r; n += 1)
              ((e[n]._render = t),
                e[n].ty === `gr` && this.changeGroupRender(e[n].it, t));
          }),
          (RepeaterModifier.prototype.processShapes = function (e) {
            var t,
              n,
              r,
              i,
              a,
              o = !1;
            if (this._mdf || e) {
              var s = Math.ceil(this.c.v);
              if (this._groups.length < s) {
                for (; this._groups.length < s;) {
                  var c = { it: this.cloneElements(this._elements), ty: `gr` };
                  (c.it.push({
                    a: { a: 0, ix: 1, k: [0, 0] },
                    nm: `Transform`,
                    o: { a: 0, ix: 7, k: 100 },
                    p: { a: 0, ix: 2, k: [0, 0] },
                    r: {
                      a: 1,
                      ix: 6,
                      k: [
                        { s: 0, e: 0, t: 0 },
                        { s: 0, e: 0, t: 1 },
                      ],
                    },
                    s: { a: 0, ix: 3, k: [100, 100] },
                    sa: { a: 0, ix: 5, k: 0 },
                    sk: { a: 0, ix: 4, k: 0 },
                    ty: `tr`,
                  }),
                    this.arr.splice(0, 0, c),
                    this._groups.splice(0, 0, c),
                    (this._currentCopies += 1));
                }
                (this.elem.reloadShapes(), (o = !0));
              }
              a = 0;
              var l;
              for (r = 0; r <= this._groups.length - 1; r += 1) {
                if (
                  ((l = a < s),
                  (this._groups[r]._render = l),
                  this.changeGroupRender(this._groups[r].it, l),
                  !l)
                ) {
                  var u = this.elemsData[r].it,
                    d = u[u.length - 1];
                  d.transform.op.v === 0
                    ? (d.transform.op._mdf = !1)
                    : ((d.transform.op._mdf = !0), (d.transform.op.v = 0));
                }
                a += 1;
              }
              this._currentCopies = s;
              var f = this.o.v,
                p = f % 1,
                m = f > 0 ? Math.floor(f) : Math.ceil(f),
                g = this.pMatrix.props,
                _ = this.rMatrix.props,
                y = this.sMatrix.props;
              (this.pMatrix.reset(),
                this.rMatrix.reset(),
                this.sMatrix.reset(),
                this.tMatrix.reset(),
                this.matrix.reset());
              var b = 0;
              if (f > 0) {
                for (; b < m;)
                  (this.applyTransforms(
                    this.pMatrix,
                    this.rMatrix,
                    this.sMatrix,
                    this.tr,
                    1,
                    !1,
                  ),
                    (b += 1));
                p &&
                  (this.applyTransforms(
                    this.pMatrix,
                    this.rMatrix,
                    this.sMatrix,
                    this.tr,
                    p,
                    !1,
                  ),
                  (b += p));
              } else if (f < 0) {
                for (; b > m;)
                  (this.applyTransforms(
                    this.pMatrix,
                    this.rMatrix,
                    this.sMatrix,
                    this.tr,
                    1,
                    !0,
                  ),
                    --b);
                p &&
                  (this.applyTransforms(
                    this.pMatrix,
                    this.rMatrix,
                    this.sMatrix,
                    this.tr,
                    -p,
                    !0,
                  ),
                  (b -= p));
              }
              ((r = this.data.m === 1 ? 0 : this._currentCopies - 1),
                (i = this.data.m === 1 ? 1 : -1),
                (a = this._currentCopies));
              for (var x, S; a;) {
                if (
                  ((t = this.elemsData[r].it),
                  (n = t[t.length - 1].transform.mProps.v.props),
                  (S = n.length),
                  (t[t.length - 1].transform.mProps._mdf = !0),
                  (t[t.length - 1].transform.op._mdf = !0),
                  (t[t.length - 1].transform.op.v =
                    this._currentCopies === 1
                      ? this.so.v
                      : this.so.v +
                        (this.eo.v - this.so.v) *
                          (r / (this._currentCopies - 1))),
                  b !== 0)
                ) {
                  for (
                    ((r !== 0 && i === 1) ||
                      (r !== this._currentCopies - 1 && i === -1)) &&
                      this.applyTransforms(
                        this.pMatrix,
                        this.rMatrix,
                        this.sMatrix,
                        this.tr,
                        1,
                        !1,
                      ),
                      this.matrix.transform(
                        _[0],
                        _[1],
                        _[2],
                        _[3],
                        _[4],
                        _[5],
                        _[6],
                        _[7],
                        _[8],
                        _[9],
                        _[10],
                        _[11],
                        _[12],
                        _[13],
                        _[14],
                        _[15],
                      ),
                      this.matrix.transform(
                        y[0],
                        y[1],
                        y[2],
                        y[3],
                        y[4],
                        y[5],
                        y[6],
                        y[7],
                        y[8],
                        y[9],
                        y[10],
                        y[11],
                        y[12],
                        y[13],
                        y[14],
                        y[15],
                      ),
                      this.matrix.transform(
                        g[0],
                        g[1],
                        g[2],
                        g[3],
                        g[4],
                        g[5],
                        g[6],
                        g[7],
                        g[8],
                        g[9],
                        g[10],
                        g[11],
                        g[12],
                        g[13],
                        g[14],
                        g[15],
                      ),
                      x = 0;
                    x < S;
                    x += 1
                  )
                    n[x] = this.matrix.props[x];
                  this.matrix.reset();
                } else
                  for (this.matrix.reset(), x = 0; x < S; x += 1)
                    n[x] = this.matrix.props[x];
                ((b += 1), --a, (r += i));
              }
            } else
              for (a = this._currentCopies, r = 0, i = 1; a;)
                ((t = this.elemsData[r].it),
                  (n = t[t.length - 1].transform.mProps.v.props),
                  (t[t.length - 1].transform.mProps._mdf = !1),
                  (t[t.length - 1].transform.op._mdf = !1),
                  --a,
                  (r += i));
            return o;
          }),
          (RepeaterModifier.prototype.addShape = function () {}));
        function RoundCornersModifier() {}
        (extendPrototype([ShapeModifier], RoundCornersModifier),
          (RoundCornersModifier.prototype.initModifierProperties = function (
            e,
            t,
          ) {
            ((this.getValue = this.processKeys),
              (this.rd = PropertyFactory.getProp(e, t.r, 0, null, this)),
              (this._isAnimated = !!this.rd.effectsSequence.length));
          }),
          (RoundCornersModifier.prototype.processPath = function (e, t) {
            var n = shapePool.newElement();
            n.c = e.c;
            var r,
              i = e._length,
              a,
              o,
              s,
              c,
              l,
              u,
              d = 0,
              f,
              p,
              m,
              g,
              _,
              y;
            for (r = 0; r < i; r += 1)
              ((a = e.v[r]),
                (s = e.o[r]),
                (o = e.i[r]),
                a[0] === s[0] && a[1] === s[1] && a[0] === o[0] && a[1] === o[1]
                  ? (r === 0 || r === i - 1) && !e.c
                    ? (n.setTripleAt(a[0], a[1], s[0], s[1], o[0], o[1], d),
                      (d += 1))
                    : ((c = r === 0 ? e.v[i - 1] : e.v[r - 1]),
                      (l = Math.sqrt((a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2)),
                      (u = l ? Math.min(l / 2, t) / l : 0),
                      (_ = a[0] + (c[0] - a[0]) * u),
                      (f = _),
                      (y = a[1] - (a[1] - c[1]) * u),
                      (p = y),
                      (m = f - (f - a[0]) * roundCorner),
                      (g = p - (p - a[1]) * roundCorner),
                      n.setTripleAt(f, p, m, g, _, y, d),
                      (d += 1),
                      (c = r === i - 1 ? e.v[0] : e.v[r + 1]),
                      (l = Math.sqrt((a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2)),
                      (u = l ? Math.min(l / 2, t) / l : 0),
                      (m = a[0] + (c[0] - a[0]) * u),
                      (f = m),
                      (g = a[1] + (c[1] - a[1]) * u),
                      (p = g),
                      (_ = f - (f - a[0]) * roundCorner),
                      (y = p - (p - a[1]) * roundCorner),
                      n.setTripleAt(f, p, m, g, _, y, d),
                      (d += 1))
                  : (n.setTripleAt(
                      e.v[r][0],
                      e.v[r][1],
                      e.o[r][0],
                      e.o[r][1],
                      e.i[r][0],
                      e.i[r][1],
                      d,
                    ),
                    (d += 1)));
            return n;
          }),
          (RoundCornersModifier.prototype.processShapes = function (e) {
            var t,
              n,
              r = this.shapes.length,
              i,
              a,
              o = this.rd.v;
            if (o !== 0) {
              var s, c;
              for (n = 0; n < r; n += 1) {
                if (
                  ((s = this.shapes[n]),
                  (c = s.localShapeCollection),
                  !(!s.shape._mdf && !this._mdf && !e))
                )
                  for (
                    c.releaseShapes(),
                      s.shape._mdf = !0,
                      t = s.shape.paths.shapes,
                      a = s.shape.paths._length,
                      i = 0;
                    i < a;
                    i += 1
                  )
                    c.addShape(this.processPath(t[i], o));
                s.shape.paths = s.localShapeCollection;
              }
            }
            this.dynamicProperties.length || (this._mdf = !1);
          }));
        function floatEqual(e, t) {
          return Math.abs(e - t) * 1e5 <= Math.min(Math.abs(e), Math.abs(t));
        }
        function floatZero(e) {
          return Math.abs(e) <= 1e-5;
        }
        function lerp(e, t, n) {
          return e * (1 - n) + t * n;
        }
        function lerpPoint(e, t, n) {
          return [lerp(e[0], t[0], n), lerp(e[1], t[1], n)];
        }
        function quadRoots(e, t, n) {
          if (e === 0) return [];
          var r = t * t - 4 * e * n;
          if (r < 0) return [];
          var i = -t / (2 * e);
          if (r === 0) return [i];
          var a = Math.sqrt(r) / (2 * e);
          return [i - a, i + a];
        }
        function polynomialCoefficients(e, t, n, r) {
          return [
            -e + 3 * t - 3 * n + r,
            3 * e - 6 * t + 3 * n,
            -3 * e + 3 * t,
            e,
          ];
        }
        function singlePoint(e) {
          return new PolynomialBezier(e, e, e, e, !1);
        }
        function PolynomialBezier(e, t, n, r, i) {
          (i && pointEqual(e, t) && (t = lerpPoint(e, r, 1 / 3)),
            i && pointEqual(n, r) && (n = lerpPoint(e, r, 2 / 3)));
          var a = polynomialCoefficients(e[0], t[0], n[0], r[0]),
            o = polynomialCoefficients(e[1], t[1], n[1], r[1]);
          ((this.a = [a[0], o[0]]),
            (this.b = [a[1], o[1]]),
            (this.c = [a[2], o[2]]),
            (this.d = [a[3], o[3]]),
            (this.points = [e, t, n, r]));
        }
        ((PolynomialBezier.prototype.point = function (e) {
          return [
            ((this.a[0] * e + this.b[0]) * e + this.c[0]) * e + this.d[0],
            ((this.a[1] * e + this.b[1]) * e + this.c[1]) * e + this.d[1],
          ];
        }),
          (PolynomialBezier.prototype.derivative = function (e) {
            return [
              (3 * e * this.a[0] + 2 * this.b[0]) * e + this.c[0],
              (3 * e * this.a[1] + 2 * this.b[1]) * e + this.c[1],
            ];
          }),
          (PolynomialBezier.prototype.tangentAngle = function (e) {
            var t = this.derivative(e);
            return Math.atan2(t[1], t[0]);
          }),
          (PolynomialBezier.prototype.normalAngle = function (e) {
            var t = this.derivative(e);
            return Math.atan2(t[0], t[1]);
          }),
          (PolynomialBezier.prototype.inflectionPoints = function () {
            var e = this.a[1] * this.b[0] - this.a[0] * this.b[1];
            if (floatZero(e)) return [];
            var t =
                (-0.5 * (this.a[1] * this.c[0] - this.a[0] * this.c[1])) / e,
              n =
                t * t -
                ((1 / 3) * (this.b[1] * this.c[0] - this.b[0] * this.c[1])) / e;
            if (n < 0) return [];
            var r = Math.sqrt(n);
            return floatZero(r)
              ? r > 0 && r < 1
                ? [t]
                : []
              : [t - r, t + r].filter(function (e) {
                  return e > 0 && e < 1;
                });
          }),
          (PolynomialBezier.prototype.split = function (e) {
            if (e <= 0) return [singlePoint(this.points[0]), this];
            if (e >= 1)
              return [this, singlePoint(this.points[this.points.length - 1])];
            var t = lerpPoint(this.points[0], this.points[1], e),
              n = lerpPoint(this.points[1], this.points[2], e),
              r = lerpPoint(this.points[2], this.points[3], e),
              i = lerpPoint(t, n, e),
              a = lerpPoint(n, r, e),
              o = lerpPoint(i, a, e);
            return [
              new PolynomialBezier(this.points[0], t, i, o, !0),
              new PolynomialBezier(o, a, r, this.points[3], !0),
            ];
          }));
        function extrema(e, t) {
          var n = e.points[0][t],
            r = e.points[e.points.length - 1][t];
          if (n > r) {
            var i = r;
            ((r = n), (n = i));
          }
          for (
            var a = quadRoots(3 * e.a[t], 2 * e.b[t], e.c[t]), o = 0;
            o < a.length;
            o += 1
          )
            if (a[o] > 0 && a[o] < 1) {
              var s = e.point(a[o])[t];
              s < n ? (n = s) : s > r && (r = s);
            }
          return { min: n, max: r };
        }
        ((PolynomialBezier.prototype.bounds = function () {
          return { x: extrema(this, 0), y: extrema(this, 1) };
        }),
          (PolynomialBezier.prototype.boundingBox = function () {
            var e = this.bounds();
            return {
              left: e.x.min,
              right: e.x.max,
              top: e.y.min,
              bottom: e.y.max,
              width: e.x.max - e.x.min,
              height: e.y.max - e.y.min,
              cx: (e.x.max + e.x.min) / 2,
              cy: (e.y.max + e.y.min) / 2,
            };
          }));
        function intersectData(e, t, n) {
          var r = e.boundingBox();
          return {
            cx: r.cx,
            cy: r.cy,
            width: r.width,
            height: r.height,
            bez: e,
            t: (t + n) / 2,
            t1: t,
            t2: n,
          };
        }
        function splitData(e) {
          var t = e.bez.split(0.5);
          return [
            intersectData(t[0], e.t1, e.t),
            intersectData(t[1], e.t, e.t2),
          ];
        }
        function boxIntersect(e, t) {
          return (
            Math.abs(e.cx - t.cx) * 2 < e.width + t.width &&
            Math.abs(e.cy - t.cy) * 2 < e.height + t.height
          );
        }
        function intersectsImpl(e, t, n, r, i, a) {
          if (boxIntersect(e, t)) {
            if (
              n >= a ||
              (e.width <= r && e.height <= r && t.width <= r && t.height <= r)
            ) {
              i.push([e.t, t.t]);
              return;
            }
            var o = splitData(e),
              s = splitData(t);
            (intersectsImpl(o[0], s[0], n + 1, r, i, a),
              intersectsImpl(o[0], s[1], n + 1, r, i, a),
              intersectsImpl(o[1], s[0], n + 1, r, i, a),
              intersectsImpl(o[1], s[1], n + 1, r, i, a));
          }
        }
        ((PolynomialBezier.prototype.intersections = function (e, t, n) {
          (t === void 0 && (t = 2), n === void 0 && (n = 7));
          var r = [];
          return (
            intersectsImpl(
              intersectData(this, 0, 1),
              intersectData(e, 0, 1),
              0,
              t,
              r,
              n,
            ),
            r
          );
        }),
          (PolynomialBezier.shapeSegment = function (e, t) {
            var n = (t + 1) % e.length();
            return new PolynomialBezier(e.v[t], e.o[t], e.i[n], e.v[n], !0);
          }),
          (PolynomialBezier.shapeSegmentInverted = function (e, t) {
            var n = (t + 1) % e.length();
            return new PolynomialBezier(e.v[n], e.i[n], e.o[t], e.v[t], !0);
          }));
        function crossProduct(e, t) {
          return [
            e[1] * t[2] - e[2] * t[1],
            e[2] * t[0] - e[0] * t[2],
            e[0] * t[1] - e[1] * t[0],
          ];
        }
        function lineIntersection(e, t, n, r) {
          var i = [e[0], e[1], 1],
            a = [t[0], t[1], 1],
            o = [n[0], n[1], 1],
            s = [r[0], r[1], 1],
            c = crossProduct(crossProduct(i, a), crossProduct(o, s));
          return floatZero(c[2]) ? null : [c[0] / c[2], c[1] / c[2]];
        }
        function polarOffset(e, t, n) {
          return [e[0] + Math.cos(t) * n, e[1] - Math.sin(t) * n];
        }
        function pointDistance(e, t) {
          return Math.hypot(e[0] - t[0], e[1] - t[1]);
        }
        function pointEqual(e, t) {
          return floatEqual(e[0], t[0]) && floatEqual(e[1], t[1]);
        }
        function ZigZagModifier() {}
        (extendPrototype([ShapeModifier], ZigZagModifier),
          (ZigZagModifier.prototype.initModifierProperties = function (e, t) {
            ((this.getValue = this.processKeys),
              (this.amplitude = PropertyFactory.getProp(e, t.s, 0, null, this)),
              (this.frequency = PropertyFactory.getProp(e, t.r, 0, null, this)),
              (this.pointsType = PropertyFactory.getProp(
                e,
                t.pt,
                0,
                null,
                this,
              )),
              (this._isAnimated =
                this.amplitude.effectsSequence.length !== 0 ||
                this.frequency.effectsSequence.length !== 0 ||
                this.pointsType.effectsSequence.length !== 0));
          }));
        function setPoint(e, t, n, r, i, a, o) {
          var s = n - Math.PI / 2,
            c = n + Math.PI / 2,
            l = t[0] + Math.cos(n) * r * i,
            u = t[1] - Math.sin(n) * r * i;
          e.setTripleAt(
            l,
            u,
            l + Math.cos(s) * a,
            u - Math.sin(s) * a,
            l + Math.cos(c) * o,
            u - Math.sin(c) * o,
            e.length(),
          );
        }
        function getPerpendicularVector(e, t) {
          var n = [t[0] - e[0], t[1] - e[1]],
            r = -Math.PI * 0.5;
          return [
            Math.cos(r) * n[0] - Math.sin(r) * n[1],
            Math.sin(r) * n[0] + Math.cos(r) * n[1],
          ];
        }
        function getProjectingAngle(e, t) {
          var n = t === 0 ? e.length() - 1 : t - 1,
            r = (t + 1) % e.length(),
            i = e.v[n],
            a = e.v[r],
            o = getPerpendicularVector(i, a);
          return Math.atan2(0, 1) - Math.atan2(o[1], o[0]);
        }
        function zigZagCorner(e, t, n, r, i, a, o) {
          var s = getProjectingAngle(t, n),
            c = t.v[n % t._length],
            l = t.v[n === 0 ? t._length - 1 : n - 1],
            u = t.v[(n + 1) % t._length],
            d =
              a === 2 ? Math.sqrt((c[0] - l[0]) ** 2 + (c[1] - l[1]) ** 2) : 0,
            f =
              a === 2 ? Math.sqrt((c[0] - u[0]) ** 2 + (c[1] - u[1]) ** 2) : 0;
          setPoint(
            e,
            t.v[n % t._length],
            s,
            o,
            r,
            f / ((i + 1) * 2),
            d / ((i + 1) * 2),
            a,
          );
        }
        function zigZagSegment(e, t, n, r, i, a) {
          for (var o = 0; o < r; o += 1) {
            var s = (o + 1) / (r + 1),
              c =
                i === 2
                  ? Math.sqrt(
                      (t.points[3][0] - t.points[0][0]) ** 2 +
                        (t.points[3][1] - t.points[0][1]) ** 2,
                    )
                  : 0,
              l = t.normalAngle(s);
            (setPoint(
              e,
              t.point(s),
              l,
              a,
              n,
              c / ((r + 1) * 2),
              c / ((r + 1) * 2),
              i,
            ),
              (a = -a));
          }
          return a;
        }
        ((ZigZagModifier.prototype.processPath = function (e, t, n, r) {
          var i = e._length,
            a = shapePool.newElement();
          if (((a.c = e.c), e.c || --i, i === 0)) return a;
          var o = -1,
            s = PolynomialBezier.shapeSegment(e, 0);
          zigZagCorner(a, e, 0, t, n, r, o);
          for (var c = 0; c < i; c += 1)
            ((o = zigZagSegment(a, s, t, n, r, -o)),
              (s =
                c === i - 1 && !e.c
                  ? null
                  : PolynomialBezier.shapeSegment(e, (c + 1) % i)),
              zigZagCorner(a, e, c + 1, t, n, r, o));
          return a;
        }),
          (ZigZagModifier.prototype.processShapes = function (e) {
            var t,
              n,
              r = this.shapes.length,
              i,
              a,
              o = this.amplitude.v,
              s = Math.max(0, Math.round(this.frequency.v)),
              c = this.pointsType.v;
            if (o !== 0) {
              var l, u;
              for (n = 0; n < r; n += 1) {
                if (
                  ((l = this.shapes[n]),
                  (u = l.localShapeCollection),
                  !(!l.shape._mdf && !this._mdf && !e))
                )
                  for (
                    u.releaseShapes(),
                      l.shape._mdf = !0,
                      t = l.shape.paths.shapes,
                      a = l.shape.paths._length,
                      i = 0;
                    i < a;
                    i += 1
                  )
                    u.addShape(this.processPath(t[i], o, s, c));
                l.shape.paths = l.localShapeCollection;
              }
            }
            this.dynamicProperties.length || (this._mdf = !1);
          }));
        function linearOffset(e, t, n) {
          var r = Math.atan2(t[0] - e[0], t[1] - e[1]);
          return [polarOffset(e, r, n), polarOffset(t, r, n)];
        }
        function offsetSegment(e, t) {
          var n,
            r,
            i,
            a,
            o,
            s,
            c = linearOffset(e.points[0], e.points[1], t);
          ((n = c[0]),
            (r = c[1]),
            (c = linearOffset(e.points[1], e.points[2], t)),
            (i = c[0]),
            (a = c[1]),
            (c = linearOffset(e.points[2], e.points[3], t)),
            (o = c[0]),
            (s = c[1]));
          var l = lineIntersection(n, r, i, a);
          l === null && (l = r);
          var u = lineIntersection(o, s, i, a);
          return (u === null && (u = o), new PolynomialBezier(n, l, u, s));
        }
        function joinLines(e, t, n, r, i) {
          var a = t.points[3],
            o = n.points[0];
          if (r === 3 || pointEqual(a, o)) return a;
          if (r === 2) {
            var s = -t.tangentAngle(1),
              c = -n.tangentAngle(0) + Math.PI,
              l = lineIntersection(
                a,
                polarOffset(a, s + Math.PI / 2, 100),
                o,
                polarOffset(o, s + Math.PI / 2, 100),
              ),
              u = l ? pointDistance(l, a) : pointDistance(a, o) / 2,
              d = polarOffset(a, s, 2 * u * roundCorner);
            return (
              e.setXYAt(d[0], d[1], `o`, e.length() - 1),
              (d = polarOffset(o, c, 2 * u * roundCorner)),
              e.setTripleAt(o[0], o[1], o[0], o[1], d[0], d[1], e.length()),
              o
            );
          }
          var f = lineIntersection(
            pointEqual(a, t.points[2]) ? t.points[0] : t.points[2],
            a,
            o,
            pointEqual(o, n.points[1]) ? n.points[3] : n.points[1],
          );
          return f && pointDistance(f, a) < i
            ? (e.setTripleAt(f[0], f[1], f[0], f[1], f[0], f[1], e.length()), f)
            : a;
        }
        function getIntersection(e, t) {
          var n = e.intersections(t);
          return (
            n.length && floatEqual(n[0][0], 1) && n.shift(),
            n.length ? n[0] : null
          );
        }
        function pruneSegmentIntersection(e, t) {
          var n = e.slice(),
            r = t.slice(),
            i = getIntersection(e[e.length - 1], t[0]);
          return (
            i &&
              ((n[e.length - 1] = e[e.length - 1].split(i[0])[0]),
              (r[0] = t[0].split(i[1])[1])),
            e.length > 1 &&
            t.length > 1 &&
            ((i = getIntersection(e[0], t[t.length - 1])), i)
              ? [[e[0].split(i[0])[0]], [t[t.length - 1].split(i[1])[1]]]
              : [n, r]
          );
        }
        function pruneIntersections(e) {
          for (var t, n = 1; n < e.length; n += 1)
            ((t = pruneSegmentIntersection(e[n - 1], e[n])),
              (e[n - 1] = t[0]),
              (e[n] = t[1]));
          return (
            e.length > 1 &&
              ((t = pruneSegmentIntersection(e[e.length - 1], e[0])),
              (e[e.length - 1] = t[0]),
              (e[0] = t[1])),
            e
          );
        }
        function offsetSegmentSplit(e, t) {
          var n = e.inflectionPoints(),
            r,
            i,
            a,
            o;
          if (n.length === 0) return [offsetSegment(e, t)];
          if (n.length === 1 || floatEqual(n[1], 1))
            return (
              (a = e.split(n[0])),
              (r = a[0]),
              (i = a[1]),
              [offsetSegment(r, t), offsetSegment(i, t)]
            );
          ((a = e.split(n[0])), (r = a[0]));
          var s = (n[1] - n[0]) / (1 - n[0]);
          return (
            (a = a[1].split(s)),
            (o = a[0]),
            (i = a[1]),
            [offsetSegment(r, t), offsetSegment(o, t), offsetSegment(i, t)]
          );
        }
        function OffsetPathModifier() {}
        (extendPrototype([ShapeModifier], OffsetPathModifier),
          (OffsetPathModifier.prototype.initModifierProperties = function (
            e,
            t,
          ) {
            ((this.getValue = this.processKeys),
              (this.amount = PropertyFactory.getProp(e, t.a, 0, null, this)),
              (this.miterLimit = PropertyFactory.getProp(
                e,
                t.ml,
                0,
                null,
                this,
              )),
              (this.lineJoin = t.lj),
              (this._isAnimated = this.amount.effectsSequence.length !== 0));
          }),
          (OffsetPathModifier.prototype.processPath = function (e, t, n, r) {
            var i = shapePool.newElement();
            i.c = e.c;
            var a = e.length();
            e.c || --a;
            var o,
              s,
              c,
              l = [];
            for (o = 0; o < a; o += 1)
              ((c = PolynomialBezier.shapeSegment(e, o)),
                l.push(offsetSegmentSplit(c, t)));
            if (!e.c)
              for (o = a - 1; o >= 0; --o)
                ((c = PolynomialBezier.shapeSegmentInverted(e, o)),
                  l.push(offsetSegmentSplit(c, t)));
            l = pruneIntersections(l);
            var u = null,
              d = null;
            for (o = 0; o < l.length; o += 1) {
              var f = l[o];
              for (
                d && (u = joinLines(i, d, f[0], n, r)),
                  d = f[f.length - 1],
                  s = 0;
                s < f.length;
                s += 1
              )
                ((c = f[s]),
                  u && pointEqual(c.points[0], u)
                    ? i.setXYAt(
                        c.points[1][0],
                        c.points[1][1],
                        `o`,
                        i.length() - 1,
                      )
                    : i.setTripleAt(
                        c.points[0][0],
                        c.points[0][1],
                        c.points[1][0],
                        c.points[1][1],
                        c.points[0][0],
                        c.points[0][1],
                        i.length(),
                      ),
                  i.setTripleAt(
                    c.points[3][0],
                    c.points[3][1],
                    c.points[3][0],
                    c.points[3][1],
                    c.points[2][0],
                    c.points[2][1],
                    i.length(),
                  ),
                  (u = c.points[3]));
            }
            return (l.length && joinLines(i, d, l[0][0], n, r), i);
          }),
          (OffsetPathModifier.prototype.processShapes = function (e) {
            var t,
              n,
              r = this.shapes.length,
              i,
              a,
              o = this.amount.v,
              s = this.miterLimit.v,
              c = this.lineJoin;
            if (o !== 0) {
              var l, u;
              for (n = 0; n < r; n += 1) {
                if (
                  ((l = this.shapes[n]),
                  (u = l.localShapeCollection),
                  !(!l.shape._mdf && !this._mdf && !e))
                )
                  for (
                    u.releaseShapes(),
                      l.shape._mdf = !0,
                      t = l.shape.paths.shapes,
                      a = l.shape.paths._length,
                      i = 0;
                    i < a;
                    i += 1
                  )
                    u.addShape(this.processPath(t[i], o, c, s));
                l.shape.paths = l.localShapeCollection;
              }
            }
            this.dynamicProperties.length || (this._mdf = !1);
          }));
        function getFontProperties(e) {
          for (
            var t = e.fStyle ? e.fStyle.split(` `) : [],
              n = `normal`,
              r = `normal`,
              i = t.length,
              a,
              o = 0;
            o < i;
            o += 1
          )
            switch (((a = t[o].toLowerCase()), a)) {
              case `italic`:
                r = `italic`;
                break;
              case `bold`:
                n = `700`;
                break;
              case `black`:
                n = `900`;
                break;
              case `medium`:
                n = `500`;
                break;
              case `regular`:
              case `normal`:
                n = `400`;
                break;
              case `light`:
              case `thin`:
                n = `200`;
                break;
              default:
                break;
            }
          return { style: r, weight: e.fWeight || n };
        }
        var FontManager = (function () {
          var e = 5e3,
            t = { w: 0, size: 0, shapes: [], data: { shapes: [] } },
            n = [];
          n = n.concat([
            2304, 2305, 2306, 2307, 2362, 2363, 2364, 2364, 2366, 2367, 2368,
            2369, 2370, 2371, 2372, 2373, 2374, 2375, 2376, 2377, 2378, 2379,
            2380, 2381, 2382, 2383, 2387, 2388, 2389, 2390, 2391, 2402, 2403,
          ]);
          var r = 127988,
            i = 917631,
            a = 917601,
            o = 917626,
            s = 65039,
            c = 8205,
            l = 127462,
            u = 127487,
            d = [`d83cdffb`, `d83cdffc`, `d83cdffd`, `d83cdffe`, `d83cdfff`];
          function f(e) {
            var t = e.split(`,`),
              n,
              r = t.length,
              i = [];
            for (n = 0; n < r; n += 1)
              t[n] !== `sans-serif` && t[n] !== `monospace` && i.push(t[n]);
            return i.join(`,`);
          }
          function p(e, t) {
            var n = createTag(`span`);
            (n.setAttribute(`aria-hidden`, !0), (n.style.fontFamily = t));
            var r = createTag(`span`);
            ((r.innerText = `giItT1WQy@!-/#`),
              (n.style.position = `absolute`),
              (n.style.left = `-10000px`),
              (n.style.top = `-10000px`),
              (n.style.fontSize = `300px`),
              (n.style.fontVariant = `normal`),
              (n.style.fontStyle = `normal`),
              (n.style.fontWeight = `normal`),
              (n.style.letterSpacing = `0`),
              n.appendChild(r),
              document.body.appendChild(n));
            var i = r.offsetWidth;
            return (
              (r.style.fontFamily = f(e) + `, ` + t),
              { node: r, w: i, parent: n }
            );
          }
          function m() {
            var t,
              n = this.fonts.length,
              r,
              i,
              a = n;
            for (t = 0; t < n; t += 1)
              this.fonts[t].loaded
                ? --a
                : this.fonts[t].fOrigin === `n` || this.fonts[t].origin === 0
                  ? (this.fonts[t].loaded = !0)
                  : ((r = this.fonts[t].monoCase.node),
                    (i = this.fonts[t].monoCase.w),
                    r.offsetWidth === i
                      ? ((r = this.fonts[t].sansCase.node),
                        (i = this.fonts[t].sansCase.w),
                        r.offsetWidth !== i &&
                          (--a, (this.fonts[t].loaded = !0)))
                      : (--a, (this.fonts[t].loaded = !0)),
                    this.fonts[t].loaded &&
                      (this.fonts[t].sansCase.parent.parentNode.removeChild(
                        this.fonts[t].sansCase.parent,
                      ),
                      this.fonts[t].monoCase.parent.parentNode.removeChild(
                        this.fonts[t].monoCase.parent,
                      )));
            a !== 0 && Date.now() - this.initTime < e
              ? setTimeout(this.checkLoadedFontsBinded, 20)
              : setTimeout(this.setIsLoadedBinded, 10);
          }
          function g(e, t) {
            var n = document.body && t ? `svg` : `canvas`,
              r,
              i = getFontProperties(e);
            if (n === `svg`) {
              var a = createNS(`text`);
              ((a.style.fontSize = `100px`),
                a.setAttribute(`font-family`, e.fFamily),
                a.setAttribute(`font-style`, i.style),
                a.setAttribute(`font-weight`, i.weight),
                (a.textContent = `1`),
                e.fClass
                  ? ((a.style.fontFamily = `inherit`),
                    a.setAttribute(`class`, e.fClass))
                  : (a.style.fontFamily = e.fFamily),
                t.appendChild(a),
                (r = a));
            } else {
              var o = new OffscreenCanvas(500, 500).getContext(`2d`);
              ((o.font = i.style + ` ` + i.weight + ` 100px ` + e.fFamily),
                (r = o));
            }
            function s(e) {
              return n === `svg`
                ? ((r.textContent = e), r.getComputedTextLength())
                : r.measureText(e).width;
            }
            return { measureText: s };
          }
          function _(e, t) {
            if (!e) {
              this.isLoaded = !0;
              return;
            }
            if (this.chars) {
              ((this.isLoaded = !0), (this.fonts = e.list));
              return;
            }
            if (!document.body) {
              ((this.isLoaded = !0),
                e.list.forEach(function (e) {
                  ((e.helper = g(e)), (e.cache = {}));
                }),
                (this.fonts = e.list));
              return;
            }
            var n = e.list,
              r,
              i = n.length,
              a = i;
            for (r = 0; r < i; r += 1) {
              var o = !0,
                s,
                c;
              if (
                ((n[r].loaded = !1),
                (n[r].monoCase = p(n[r].fFamily, `monospace`)),
                (n[r].sansCase = p(n[r].fFamily, `sans-serif`)),
                !n[r].fPath)
              )
                ((n[r].loaded = !0), --a);
              else if (n[r].fOrigin === `p` || n[r].origin === 3) {
                if (
                  ((s = document.querySelectorAll(
                    `style[f-forigin="p"][f-family="` +
                      n[r].fFamily +
                      `"], style[f-origin="3"][f-family="` +
                      n[r].fFamily +
                      `"]`,
                  )),
                  s.length > 0 && (o = !1),
                  o)
                ) {
                  var l = createTag(`style`);
                  (l.setAttribute(`f-forigin`, n[r].fOrigin),
                    l.setAttribute(`f-origin`, n[r].origin),
                    l.setAttribute(`f-family`, n[r].fFamily),
                    (l.type = `text/css`),
                    (l.innerText =
                      `@font-face {font-family: ` +
                      n[r].fFamily +
                      `; font-style: normal; src: url('` +
                      n[r].fPath +
                      `');}`),
                    t.appendChild(l));
                }
              } else if (n[r].fOrigin === `g` || n[r].origin === 1) {
                for (
                  s = document.querySelectorAll(
                    `link[f-forigin="g"], link[f-origin="1"]`,
                  ),
                    c = 0;
                  c < s.length;
                  c += 1
                )
                  s[c].href.indexOf(n[r].fPath) !== -1 && (o = !1);
                if (o) {
                  var u = createTag(`link`);
                  (u.setAttribute(`f-forigin`, n[r].fOrigin),
                    u.setAttribute(`f-origin`, n[r].origin),
                    (u.type = `text/css`),
                    (u.rel = `stylesheet`),
                    (u.href = n[r].fPath),
                    document.body.appendChild(u));
                }
              } else if (n[r].fOrigin === `t` || n[r].origin === 2) {
                for (
                  s = document.querySelectorAll(
                    `script[f-forigin="t"], script[f-origin="2"]`,
                  ),
                    c = 0;
                  c < s.length;
                  c += 1
                )
                  n[r].fPath === s[c].src && (o = !1);
                if (o) {
                  var d = createTag(`link`);
                  (d.setAttribute(`f-forigin`, n[r].fOrigin),
                    d.setAttribute(`f-origin`, n[r].origin),
                    d.setAttribute(`rel`, `stylesheet`),
                    d.setAttribute(`href`, n[r].fPath),
                    t.appendChild(d));
                }
              }
              ((n[r].helper = g(n[r], t)),
                (n[r].cache = {}),
                this.fonts.push(n[r]));
            }
            a === 0
              ? (this.isLoaded = !0)
              : setTimeout(this.checkLoadedFonts.bind(this), 100);
          }
          function y(e) {
            if (e) {
              this.chars ||= [];
              var t,
                n = e.length,
                r,
                i = this.chars.length,
                a;
              for (t = 0; t < n; t += 1) {
                for (r = 0, a = !1; r < i;)
                  (this.chars[r].style === e[t].style &&
                    this.chars[r].fFamily === e[t].fFamily &&
                    this.chars[r].ch === e[t].ch &&
                    (a = !0),
                    (r += 1));
                a || (this.chars.push(e[t]), (i += 1));
              }
            }
          }
          function b(e, n, r) {
            for (var i = 0, a = this.chars.length; i < a;) {
              if (
                this.chars[i].ch === e &&
                this.chars[i].style === n &&
                this.chars[i].fFamily === r
              )
                return this.chars[i];
              i += 1;
            }
            return (
              ((typeof e == `string` && e.charCodeAt(0) !== 13) || !e) &&
                console &&
                console.warn &&
                !this._warned &&
                ((this._warned = !0),
                console.warn(
                  `Missing character from exported characters list: `,
                  e,
                  n,
                  r,
                )),
              t
            );
          }
          function x(e, t, n) {
            var r = this.getFontByName(t),
              i = e;
            if (!r.cache[i]) {
              var a = r.helper;
              if (e === ` `) {
                var o = a.measureText(`|` + e + `|`),
                  s = a.measureText(`||`);
                r.cache[i] = (o - s) / 100;
              } else r.cache[i] = a.measureText(e) / 100;
            }
            return r.cache[i] * n;
          }
          function S(e) {
            for (var t = 0, n = this.fonts.length; t < n;) {
              if (this.fonts[t].fName === e) return this.fonts[t];
              t += 1;
            }
            return this.fonts[0];
          }
          function C(e) {
            var t = 0,
              n = e.charCodeAt(0);
            if (n >= 55296 && n <= 56319) {
              var r = e.charCodeAt(1);
              r >= 56320 &&
                r <= 57343 &&
                (t = (n - 55296) * 1024 + r - 56320 + 65536);
            }
            return t;
          }
          function T(e, t) {
            var n = e.toString(16) + t.toString(16);
            return d.indexOf(n) !== -1;
          }
          function E(e) {
            return e === c;
          }
          function D(e) {
            return e === s;
          }
          function O(e) {
            var t = C(e);
            return t >= l && t <= u;
          }
          function k(e) {
            return O(e.substr(0, 2)) && O(e.substr(2, 2));
          }
          function A(e) {
            return n.indexOf(e) !== -1;
          }
          function j(e, t) {
            var n = C(e.substr(t, 2));
            if (n !== r) return !1;
            var s = 0;
            for (t += 2; s < 5;) {
              if (((n = C(e.substr(t, 2))), n < a || n > o)) return !1;
              ((s += 1), (t += 2));
            }
            return C(e.substr(t, 2)) === i;
          }
          function M() {
            this.isLoaded = !0;
          }
          var N = function () {
            ((this.fonts = []),
              (this.chars = null),
              (this.typekitLoaded = 0),
              (this.isLoaded = !1),
              (this._warned = !1),
              (this.initTime = Date.now()),
              (this.setIsLoadedBinded = this.setIsLoaded.bind(this)),
              (this.checkLoadedFontsBinded = this.checkLoadedFonts.bind(this)));
          };
          return (
            (N.isModifier = T),
            (N.isZeroWidthJoiner = E),
            (N.isFlagEmoji = k),
            (N.isRegionalCode = O),
            (N.isCombinedCharacter = A),
            (N.isRegionalFlag = j),
            (N.isVariationSelector = D),
            (N.BLACK_FLAG_CODE_POINT = r),
            (N.prototype = {
              addChars: y,
              addFonts: _,
              getCharData: b,
              getFontByName: S,
              measureText: x,
              checkLoadedFonts: m,
              setIsLoaded: M,
            }),
            N
          );
        })();
        function SlotManager(e) {
          this.animationData = e;
        }
        SlotManager.prototype.getProp = function (e) {
          return this.animationData.slots && this.animationData.slots[e.sid]
            ? Object.assign(e, this.animationData.slots[e.sid].p)
            : e;
        };
        function slotFactory(e) {
          return new SlotManager(e);
        }
        function RenderableElement() {}
        RenderableElement.prototype = {
          initRenderable: function () {
            ((this.isInRange = !1),
              (this.hidden = !1),
              (this.isTransparent = !1),
              (this.renderableComponents = []));
          },
          addRenderableComponent: function (e) {
            this.renderableComponents.indexOf(e) === -1 &&
              this.renderableComponents.push(e);
          },
          removeRenderableComponent: function (e) {
            this.renderableComponents.indexOf(e) !== -1 &&
              this.renderableComponents.splice(
                this.renderableComponents.indexOf(e),
                1,
              );
          },
          prepareRenderableFrame: function (e) {
            this.checkLayerLimits(e);
          },
          checkTransparency: function () {
            this.finalTransform.mProp.o.v <= 0
              ? !this.isTransparent &&
                this.globalData.renderConfig.hideOnTransparent &&
                ((this.isTransparent = !0), this.hide())
              : this.isTransparent && ((this.isTransparent = !1), this.show());
          },
          checkLayerLimits: function (e) {
            this.data.ip - this.data.st <= e && this.data.op - this.data.st > e
              ? this.isInRange !== !0 &&
                ((this.globalData._mdf = !0),
                (this._mdf = !0),
                (this.isInRange = !0),
                this.show())
              : this.isInRange !== !1 &&
                ((this.globalData._mdf = !0),
                (this.isInRange = !1),
                this.hide());
          },
          renderRenderable: function () {
            var e,
              t = this.renderableComponents.length;
            for (e = 0; e < t; e += 1)
              this.renderableComponents[e].renderFrame(this._isFirstFrame);
          },
          sourceRectAtTime: function () {
            return { top: 0, left: 0, width: 100, height: 100 };
          },
          getLayerSize: function () {
            return this.data.ty === 5
              ? { w: this.data.textData.width, h: this.data.textData.height }
              : { w: this.data.width, h: this.data.height };
          },
        };
        var getBlendMode = (function () {
          var e = {
            0: `source-over`,
            1: `multiply`,
            2: `screen`,
            3: `overlay`,
            4: `darken`,
            5: `lighten`,
            6: `color-dodge`,
            7: `color-burn`,
            8: `hard-light`,
            9: `soft-light`,
            10: `difference`,
            11: `exclusion`,
            12: `hue`,
            13: `saturation`,
            14: `color`,
            15: `luminosity`,
          };
          return function (t) {
            return e[t] || ``;
          };
        })();
        function SliderEffect(e, t, n) {
          this.p = PropertyFactory.getProp(t, e.v, 0, 0, n);
        }
        function AngleEffect(e, t, n) {
          this.p = PropertyFactory.getProp(t, e.v, 0, 0, n);
        }
        function ColorEffect(e, t, n) {
          this.p = PropertyFactory.getProp(t, e.v, 1, 0, n);
        }
        function PointEffect(e, t, n) {
          this.p = PropertyFactory.getProp(t, e.v, 1, 0, n);
        }
        function LayerIndexEffect(e, t, n) {
          this.p = PropertyFactory.getProp(t, e.v, 0, 0, n);
        }
        function MaskIndexEffect(e, t, n) {
          this.p = PropertyFactory.getProp(t, e.v, 0, 0, n);
        }
        function CheckboxEffect(e, t, n) {
          this.p = PropertyFactory.getProp(t, e.v, 0, 0, n);
        }
        function NoValueEffect() {
          this.p = {};
        }
        function EffectsManager(e, t) {
          var n = e.ef || [];
          this.effectElements = [];
          var r,
            i = n.length,
            a;
          for (r = 0; r < i; r += 1)
            ((a = new GroupEffect(n[r], t)), this.effectElements.push(a));
        }
        function GroupEffect(e, t) {
          this.init(e, t);
        }
        (extendPrototype([DynamicPropertyContainer], GroupEffect),
          (GroupEffect.prototype.getValue =
            GroupEffect.prototype.iterateDynamicProperties),
          (GroupEffect.prototype.init = function (e, t) {
            ((this.data = e),
              (this.effectElements = []),
              this.initDynamicPropertyContainer(t));
            var n,
              r = this.data.ef.length,
              i,
              a = this.data.ef;
            for (n = 0; n < r; n += 1) {
              switch (((i = null), a[n].ty)) {
                case 0:
                  i = new SliderEffect(a[n], t, this);
                  break;
                case 1:
                  i = new AngleEffect(a[n], t, this);
                  break;
                case 2:
                  i = new ColorEffect(a[n], t, this);
                  break;
                case 3:
                  i = new PointEffect(a[n], t, this);
                  break;
                case 4:
                case 7:
                  i = new CheckboxEffect(a[n], t, this);
                  break;
                case 10:
                  i = new LayerIndexEffect(a[n], t, this);
                  break;
                case 11:
                  i = new MaskIndexEffect(a[n], t, this);
                  break;
                case 5:
                  i = new EffectsManager(a[n], t, this);
                  break;
                default:
                  i = new NoValueEffect(a[n], t, this);
                  break;
              }
              i && this.effectElements.push(i);
            }
          }));
        function BaseElement() {}
        BaseElement.prototype = {
          checkMasks: function () {
            if (!this.data.hasMask) return !1;
            for (var e = 0, t = this.data.masksProperties.length; e < t;) {
              if (
                this.data.masksProperties[e].mode !== `n` &&
                this.data.masksProperties[e].cl !== !1
              )
                return !0;
              e += 1;
            }
            return !1;
          },
          initExpressions: function () {
            var e = getExpressionInterfaces();
            if (e) {
              var t = e(`layer`),
                n = e(`effects`),
                r = e(`shape`),
                i = e(`text`),
                a = e(`comp`);
              ((this.layerInterface = t(this)),
                this.data.hasMask &&
                  this.maskManager &&
                  this.layerInterface.registerMaskInterface(this.maskManager));
              var o = n.createEffectsInterface(this, this.layerInterface);
              (this.layerInterface.registerEffectsInterface(o),
                this.data.ty === 0 || this.data.xt
                  ? (this.compInterface = a(this))
                  : this.data.ty === 4
                    ? ((this.layerInterface.shapeInterface = r(
                        this.shapesData,
                        this.itemsData,
                        this.layerInterface,
                      )),
                      (this.layerInterface.content =
                        this.layerInterface.shapeInterface))
                    : this.data.ty === 5 &&
                      ((this.layerInterface.textInterface = i(this)),
                      (this.layerInterface.text =
                        this.layerInterface.textInterface)));
            }
          },
          setBlendMode: function () {
            var e = getBlendMode(this.data.bm),
              t = this.baseElement || this.layerElement;
            t.style[`mix-blend-mode`] = e;
          },
          initBaseData: function (e, t, n) {
            ((this.globalData = t),
              (this.comp = n),
              (this.data = e),
              (this.layerId = createElementID()),
              this.data.sr || (this.data.sr = 1),
              (this.effectsManager = new EffectsManager(
                this.data,
                this,
                this.dynamicProperties,
              )));
          },
          getType: function () {
            return this.type;
          },
          sourceRectAtTime: function () {},
        };
        function FrameElement() {}
        FrameElement.prototype = {
          initFrame: function () {
            ((this._isFirstFrame = !1),
              (this.dynamicProperties = []),
              (this._mdf = !1));
          },
          prepareProperties: function (e, t) {
            var n,
              r = this.dynamicProperties.length;
            for (n = 0; n < r; n += 1)
              (t ||
                (this._isParent &&
                  this.dynamicProperties[n].propType === `transform`)) &&
                (this.dynamicProperties[n].getValue(),
                this.dynamicProperties[n]._mdf &&
                  ((this.globalData._mdf = !0), (this._mdf = !0)));
          },
          addDynamicProperty: function (e) {
            this.dynamicProperties.indexOf(e) === -1 &&
              this.dynamicProperties.push(e);
          },
        };
        function FootageElement(e, t, n) {
          (this.initFrame(),
            this.initRenderable(),
            (this.assetData = t.getAssetData(e.refId)),
            (this.footageData = t.imageLoader.getAsset(this.assetData)),
            this.initBaseData(e, t, n));
        }
        ((FootageElement.prototype.prepareFrame = function () {}),
          extendPrototype(
            [RenderableElement, BaseElement, FrameElement],
            FootageElement,
          ),
          (FootageElement.prototype.getBaseElement = function () {
            return null;
          }),
          (FootageElement.prototype.renderFrame = function () {}),
          (FootageElement.prototype.destroy = function () {}),
          (FootageElement.prototype.initExpressions = function () {
            var e = getExpressionInterfaces();
            if (e) {
              var t = e(`footage`);
              this.layerInterface = t(this);
            }
          }),
          (FootageElement.prototype.getFootageData = function () {
            return this.footageData;
          }));
        function AudioElement(e, t, n) {
          (this.initFrame(),
            this.initRenderable(),
            (this.assetData = t.getAssetData(e.refId)),
            this.initBaseData(e, t, n),
            (this._isPlaying = !1),
            (this._canPlay = !1));
          var r = this.globalData.getAssetsPath(this.assetData);
          ((this.audio = this.globalData.audioController.createAudio(r)),
            (this._currentTime = 0),
            this.globalData.audioController.addAudio(this),
            (this._volumeMultiplier = 1),
            (this._volume = 1),
            (this._previousVolume = null),
            (this.tm = e.tm
              ? PropertyFactory.getProp(this, e.tm, 0, t.frameRate, this)
              : { _placeholder: !0 }),
            (this.lv = PropertyFactory.getProp(
              this,
              e.au && e.au.lv ? e.au.lv : { k: [100] },
              1,
              0.01,
              this,
            )));
        }
        ((AudioElement.prototype.prepareFrame = function (e) {
          if (
            (this.prepareRenderableFrame(e, !0),
            this.prepareProperties(e, !0),
            this.tm._placeholder)
          )
            this._currentTime = e / this.data.sr;
          else {
            var t = this.tm.v;
            this._currentTime = t;
          }
          this._volume = this.lv.v[0];
          var n = this._volume * this._volumeMultiplier;
          this._previousVolume !== n &&
            ((this._previousVolume = n), this.audio.volume(n));
        }),
          extendPrototype(
            [RenderableElement, BaseElement, FrameElement],
            AudioElement,
          ),
          (AudioElement.prototype.renderFrame = function () {
            this.isInRange &&
              this._canPlay &&
              (this._isPlaying
                ? (!this.audio.playing() ||
                    Math.abs(
                      this._currentTime / this.globalData.frameRate -
                        this.audio.seek(),
                    ) > 0.1) &&
                  this.audio.seek(this._currentTime / this.globalData.frameRate)
                : (this.audio.play(),
                  this.audio.seek(
                    this._currentTime / this.globalData.frameRate,
                  ),
                  (this._isPlaying = !0)));
          }),
          (AudioElement.prototype.show = function () {}),
          (AudioElement.prototype.hide = function () {
            (this.audio.pause(), (this._isPlaying = !1));
          }),
          (AudioElement.prototype.pause = function () {
            (this.audio.pause(), (this._isPlaying = !1), (this._canPlay = !1));
          }),
          (AudioElement.prototype.resume = function () {
            this._canPlay = !0;
          }),
          (AudioElement.prototype.setRate = function (e) {
            this.audio.rate(e);
          }),
          (AudioElement.prototype.volume = function (e) {
            ((this._volumeMultiplier = e),
              (this._previousVolume = e * this._volume),
              this.audio.volume(this._previousVolume));
          }),
          (AudioElement.prototype.getBaseElement = function () {
            return null;
          }),
          (AudioElement.prototype.destroy = function () {}),
          (AudioElement.prototype.sourceRectAtTime = function () {}),
          (AudioElement.prototype.initExpressions = function () {}));
        function BaseRenderer() {}
        ((BaseRenderer.prototype.checkLayers = function (e) {
          var t,
            n = this.layers.length,
            r;
          for (this.completeLayers = !0, t = n - 1; t >= 0; --t)
            (this.elements[t] ||
              ((r = this.layers[t]),
              r.ip - r.st <= e - this.layers[t].st &&
                r.op - r.st > e - this.layers[t].st &&
                this.buildItem(t)),
              (this.completeLayers = this.elements[t]
                ? this.completeLayers
                : !1));
          this.checkPendingElements();
        }),
          (BaseRenderer.prototype.createItem = function (e) {
            switch (e.ty) {
              case 2:
                return this.createImage(e);
              case 0:
                return this.createComp(e);
              case 1:
                return this.createSolid(e);
              case 3:
                return this.createNull(e);
              case 4:
                return this.createShape(e);
              case 5:
                return this.createText(e);
              case 6:
                return this.createAudio(e);
              case 13:
                return this.createCamera(e);
              case 15:
                return this.createFootage(e);
              default:
                return this.createNull(e);
            }
          }),
          (BaseRenderer.prototype.createCamera = function () {
            throw Error(`You're using a 3d camera. Try the html renderer.`);
          }),
          (BaseRenderer.prototype.createAudio = function (e) {
            return new AudioElement(e, this.globalData, this);
          }),
          (BaseRenderer.prototype.createFootage = function (e) {
            return new FootageElement(e, this.globalData, this);
          }),
          (BaseRenderer.prototype.buildAllItems = function () {
            var e,
              t = this.layers.length;
            for (e = 0; e < t; e += 1) this.buildItem(e);
            this.checkPendingElements();
          }),
          (BaseRenderer.prototype.includeLayers = function (e) {
            this.completeLayers = !1;
            var t,
              n = e.length,
              r,
              i = this.layers.length;
            for (t = 0; t < n; t += 1)
              for (r = 0; r < i;) {
                if (this.layers[r].id === e[t].id) {
                  this.layers[r] = e[t];
                  break;
                }
                r += 1;
              }
          }),
          (BaseRenderer.prototype.setProjectInterface = function (e) {
            this.globalData.projectInterface = e;
          }),
          (BaseRenderer.prototype.initItems = function () {
            this.globalData.progressiveLoad || this.buildAllItems();
          }),
          (BaseRenderer.prototype.buildElementParenting = function (e, t, n) {
            for (
              var r = this.elements, i = this.layers, a = 0, o = i.length;
              a < o;
            )
              (i[a].ind == t &&
                (!r[a] || r[a] === !0
                  ? (this.buildItem(a), this.addPendingElement(e))
                  : (n.push(r[a]),
                    r[a].setAsParent(),
                    i[a].parent === void 0
                      ? e.setHierarchy(n)
                      : this.buildElementParenting(e, i[a].parent, n))),
                (a += 1));
          }),
          (BaseRenderer.prototype.addPendingElement = function (e) {
            this.pendingElements.push(e);
          }),
          (BaseRenderer.prototype.searchExtraCompositions = function (e) {
            var t,
              n = e.length;
            for (t = 0; t < n; t += 1)
              if (e[t].xt) {
                var r = this.createComp(e[t]);
                (r.initExpressions(),
                  this.globalData.projectInterface.registerComposition(r));
              }
          }),
          (BaseRenderer.prototype.getElementById = function (e) {
            var t,
              n = this.elements.length;
            for (t = 0; t < n; t += 1)
              if (this.elements[t].data.ind === e) return this.elements[t];
            return null;
          }),
          (BaseRenderer.prototype.getElementByPath = function (e) {
            var t = e.shift(),
              n;
            if (typeof t == `number`) n = this.elements[t];
            else {
              var r,
                i = this.elements.length;
              for (r = 0; r < i; r += 1)
                if (this.elements[r].data.nm === t) {
                  n = this.elements[r];
                  break;
                }
            }
            return e.length === 0 ? n : n.getElementByPath(e);
          }),
          (BaseRenderer.prototype.setupGlobalData = function (e, t) {
            ((this.globalData.fontManager = new FontManager()),
              (this.globalData.slotManager = slotFactory(e)),
              this.globalData.fontManager.addChars(e.chars),
              this.globalData.fontManager.addFonts(e.fonts, t),
              (this.globalData.getAssetData =
                this.animationItem.getAssetData.bind(this.animationItem)),
              (this.globalData.getAssetsPath =
                this.animationItem.getAssetsPath.bind(this.animationItem)),
              (this.globalData.imageLoader = this.animationItem.imagePreloader),
              (this.globalData.audioController =
                this.animationItem.audioController),
              (this.globalData.frameId = 0),
              (this.globalData.frameRate = e.fr),
              (this.globalData.nm = e.nm),
              (this.globalData.compSize = { w: e.w, h: e.h }));
          }));
        var effectTypes = { TRANSFORM_EFFECT: `transformEFfect` };
        function TransformElement() {}
        TransformElement.prototype = {
          initTransform: function () {
            var e = new Matrix();
            ((this.finalTransform = {
              mProp: this.data.ks
                ? TransformPropertyFactory.getTransformProperty(
                    this,
                    this.data.ks,
                    this,
                  )
                : { o: 0 },
              _matMdf: !1,
              _localMatMdf: !1,
              _opMdf: !1,
              mat: e,
              localMat: e,
              localOpacity: 1,
            }),
              this.data.ao && (this.finalTransform.mProp.autoOriented = !0),
              this.data.ty);
          },
          renderTransform: function () {
            if (
              ((this.finalTransform._opMdf =
                this.finalTransform.mProp.o._mdf || this._isFirstFrame),
              (this.finalTransform._matMdf =
                this.finalTransform.mProp._mdf || this._isFirstFrame),
              this.hierarchy)
            ) {
              var e,
                t = this.finalTransform.mat,
                n = 0,
                r = this.hierarchy.length;
              if (!this.finalTransform._matMdf)
                for (; n < r;) {
                  if (this.hierarchy[n].finalTransform.mProp._mdf) {
                    this.finalTransform._matMdf = !0;
                    break;
                  }
                  n += 1;
                }
              if (this.finalTransform._matMdf)
                for (
                  e = this.finalTransform.mProp.v.props,
                    t.cloneFromProps(e),
                    n = 0;
                  n < r;
                  n += 1
                )
                  t.multiply(this.hierarchy[n].finalTransform.mProp.v);
            }
            ((!this.localTransforms || this.finalTransform._matMdf) &&
              (this.finalTransform._localMatMdf = this.finalTransform._matMdf),
              this.finalTransform._opMdf &&
                (this.finalTransform.localOpacity =
                  this.finalTransform.mProp.o.v));
          },
          renderLocalTransform: function () {
            if (this.localTransforms) {
              var e = 0,
                t = this.localTransforms.length;
              if (
                ((this.finalTransform._localMatMdf =
                  this.finalTransform._matMdf),
                !this.finalTransform._localMatMdf ||
                  !this.finalTransform._opMdf)
              )
                for (; e < t;)
                  (this.localTransforms[e]._mdf &&
                    (this.finalTransform._localMatMdf = !0),
                    this.localTransforms[e]._opMdf &&
                      !this.finalTransform._opMdf &&
                      ((this.finalTransform.localOpacity =
                        this.finalTransform.mProp.o.v),
                      (this.finalTransform._opMdf = !0)),
                    (e += 1));
              if (this.finalTransform._localMatMdf) {
                var n = this.finalTransform.localMat;
                for (
                  this.localTransforms[0].matrix.clone(n), e = 1;
                  e < t;
                  e += 1
                ) {
                  var r = this.localTransforms[e].matrix;
                  n.multiply(r);
                }
                n.multiply(this.finalTransform.mat);
              }
              if (this.finalTransform._opMdf) {
                var i = this.finalTransform.localOpacity;
                for (e = 0; e < t; e += 1)
                  i *= this.localTransforms[e].opacity * 0.01;
                this.finalTransform.localOpacity = i;
              }
            }
          },
          searchEffectTransforms: function () {
            if (this.renderableEffectsManager) {
              var e = this.renderableEffectsManager.getEffects(
                effectTypes.TRANSFORM_EFFECT,
              );
              if (e.length) {
                ((this.localTransforms = []),
                  (this.finalTransform.localMat = new Matrix()));
                var t = 0,
                  n = e.length;
                for (t = 0; t < n; t += 1) this.localTransforms.push(e[t]);
              }
            }
          },
          globalToLocal: function (e) {
            var t = [];
            t.push(this.finalTransform);
            for (var n = !0, r = this.comp; n;)
              r.finalTransform
                ? (r.data.hasMask && t.splice(0, 0, r.finalTransform),
                  (r = r.comp))
                : (n = !1);
            var i,
              a = t.length,
              o;
            for (i = 0; i < a; i += 1)
              ((o = t[i].mat.applyToPointArray(0, 0, 0)),
                (e = [e[0] - o[0], e[1] - o[1], 0]));
            return e;
          },
          mHelper: new Matrix(),
        };
        function MaskElement(e, t, n) {
          ((this.data = e),
            (this.element = t),
            (this.globalData = n),
            (this.storedData = []),
            (this.masksProperties = this.data.masksProperties || []),
            (this.maskElement = null));
          var r = this.globalData.defs,
            i,
            a = this.masksProperties ? this.masksProperties.length : 0;
          ((this.viewData = createSizedArray(a)), (this.solidPath = ``));
          var o,
            s = this.masksProperties,
            c = 0,
            l = [],
            u,
            d,
            f = createElementID(),
            p,
            m,
            g,
            _,
            y = `clipPath`,
            b = `clip-path`;
          for (i = 0; i < a; i += 1)
            if (
              (((s[i].mode !== `a` && s[i].mode !== `n`) ||
                s[i].inv ||
                s[i].o.k !== 100 ||
                s[i].o.x) &&
                ((y = `mask`), (b = `mask`)),
              (s[i].mode === `s` || s[i].mode === `i`) && c === 0
                ? ((p = createNS(`rect`)),
                  p.setAttribute(`fill`, `#ffffff`),
                  p.setAttribute(`width`, this.element.comp.data.w || 0),
                  p.setAttribute(`height`, this.element.comp.data.h || 0),
                  l.push(p))
                : (p = null),
              (o = createNS(`path`)),
              s[i].mode === `n`)
            )
              ((this.viewData[i] = {
                op: PropertyFactory.getProp(
                  this.element,
                  s[i].o,
                  0,
                  0.01,
                  this.element,
                ),
                prop: ShapePropertyFactory.getShapeProp(this.element, s[i], 3),
                elem: o,
                lastPath: ``,
              }),
                r.appendChild(o));
            else {
              ((c += 1),
                o.setAttribute(
                  `fill`,
                  s[i].mode === `s` ? `#000000` : `#ffffff`,
                ),
                o.setAttribute(`clip-rule`, `nonzero`));
              var x;
              if (
                (s[i].x.k === 0
                  ? ((g = null), (_ = null))
                  : ((y = `mask`),
                    (b = `mask`),
                    (_ = PropertyFactory.getProp(
                      this.element,
                      s[i].x,
                      0,
                      null,
                      this.element,
                    )),
                    (x = createElementID()),
                    (m = createNS(`filter`)),
                    m.setAttribute(`id`, x),
                    (g = createNS(`feMorphology`)),
                    g.setAttribute(`operator`, `erode`),
                    g.setAttribute(`in`, `SourceGraphic`),
                    g.setAttribute(`radius`, `0`),
                    m.appendChild(g),
                    r.appendChild(m),
                    o.setAttribute(
                      `stroke`,
                      s[i].mode === `s` ? `#000000` : `#ffffff`,
                    )),
                (this.storedData[i] = {
                  elem: o,
                  x: _,
                  expan: g,
                  lastPath: ``,
                  lastOperator: ``,
                  filterId: x,
                  lastRadius: 0,
                }),
                s[i].mode === `i`)
              ) {
                d = l.length;
                var S = createNS(`g`);
                for (u = 0; u < d; u += 1) S.appendChild(l[u]);
                var C = createNS(`mask`);
                (C.setAttribute(`mask-type`, `alpha`),
                  C.setAttribute(`id`, f + `_` + c),
                  C.appendChild(o),
                  r.appendChild(C),
                  S.setAttribute(
                    `mask`,
                    `url(` + getLocationHref() + `#` + f + `_` + c + `)`,
                  ),
                  (l.length = 0),
                  l.push(S));
              } else l.push(o);
              (s[i].inv &&
                !this.solidPath &&
                (this.solidPath = this.createLayerSolidPath()),
                (this.viewData[i] = {
                  elem: o,
                  lastPath: ``,
                  op: PropertyFactory.getProp(
                    this.element,
                    s[i].o,
                    0,
                    0.01,
                    this.element,
                  ),
                  prop: ShapePropertyFactory.getShapeProp(
                    this.element,
                    s[i],
                    3,
                  ),
                  invRect: p,
                }),
                this.viewData[i].prop.k ||
                  this.drawPath(
                    s[i],
                    this.viewData[i].prop.v,
                    this.viewData[i],
                  ));
            }
          for (
            this.maskElement = createNS(y), a = l.length, i = 0;
            i < a;
            i += 1
          )
            this.maskElement.appendChild(l[i]);
          (c > 0 &&
            (this.maskElement.setAttribute(`id`, f),
            this.element.maskedElement.setAttribute(
              b,
              `url(` + getLocationHref() + `#` + f + `)`,
            ),
            r.appendChild(this.maskElement)),
            this.viewData.length && this.element.addRenderableComponent(this));
        }
        ((MaskElement.prototype.getMaskProperty = function (e) {
          return this.viewData[e].prop;
        }),
          (MaskElement.prototype.renderFrame = function (e) {
            var t = this.element.finalTransform.mat,
              n,
              r = this.masksProperties.length;
            for (n = 0; n < r; n += 1)
              if (
                ((this.viewData[n].prop._mdf || e) &&
                  this.drawPath(
                    this.masksProperties[n],
                    this.viewData[n].prop.v,
                    this.viewData[n],
                  ),
                (this.viewData[n].op._mdf || e) &&
                  this.viewData[n].elem.setAttribute(
                    `fill-opacity`,
                    this.viewData[n].op.v,
                  ),
                this.masksProperties[n].mode !== `n` &&
                  (this.viewData[n].invRect &&
                    (this.element.finalTransform.mProp._mdf || e) &&
                    this.viewData[n].invRect.setAttribute(
                      `transform`,
                      t.getInverseMatrix().to2dCSS(),
                    ),
                  this.storedData[n].x && (this.storedData[n].x._mdf || e)))
              ) {
                var i = this.storedData[n].expan;
                this.storedData[n].x.v < 0
                  ? (this.storedData[n].lastOperator !== `erode` &&
                      ((this.storedData[n].lastOperator = `erode`),
                      this.storedData[n].elem.setAttribute(
                        `filter`,
                        `url(` +
                          getLocationHref() +
                          `#` +
                          this.storedData[n].filterId +
                          `)`,
                      )),
                    i.setAttribute(`radius`, -this.storedData[n].x.v))
                  : (this.storedData[n].lastOperator !== `dilate` &&
                      ((this.storedData[n].lastOperator = `dilate`),
                      this.storedData[n].elem.setAttribute(`filter`, null)),
                    this.storedData[n].elem.setAttribute(
                      `stroke-width`,
                      this.storedData[n].x.v * 2,
                    ));
              }
          }),
          (MaskElement.prototype.getMaskelement = function () {
            return this.maskElement;
          }),
          (MaskElement.prototype.createLayerSolidPath = function () {
            var e = `M0,0 `;
            return (
              (e += ` h` + this.globalData.compSize.w),
              (e += ` v` + this.globalData.compSize.h),
              (e += ` h-` + this.globalData.compSize.w),
              (e += ` v-` + this.globalData.compSize.h + ` `),
              e
            );
          }),
          (MaskElement.prototype.drawPath = function (e, t, n) {
            var r = ` M` + t.v[0][0] + `,` + t.v[0][1],
              i,
              a = t._length;
            for (i = 1; i < a; i += 1)
              r +=
                ` C` +
                t.o[i - 1][0] +
                `,` +
                t.o[i - 1][1] +
                ` ` +
                t.i[i][0] +
                `,` +
                t.i[i][1] +
                ` ` +
                t.v[i][0] +
                `,` +
                t.v[i][1];
            if (
              (t.c &&
                a > 1 &&
                (r +=
                  ` C` +
                  t.o[i - 1][0] +
                  `,` +
                  t.o[i - 1][1] +
                  ` ` +
                  t.i[0][0] +
                  `,` +
                  t.i[0][1] +
                  ` ` +
                  t.v[0][0] +
                  `,` +
                  t.v[0][1]),
              n.lastPath !== r)
            ) {
              var o = ``;
              (n.elem &&
                (t.c && (o = e.inv ? this.solidPath + r : r),
                n.elem.setAttribute(`d`, o)),
                (n.lastPath = r));
            }
          }),
          (MaskElement.prototype.destroy = function () {
            ((this.element = null),
              (this.globalData = null),
              (this.maskElement = null),
              (this.data = null),
              (this.masksProperties = null));
          }));
        var filtersFactory = (function () {
            var e = {};
            ((e.createFilter = t), (e.createAlphaToLuminanceFilter = n));
            function t(e, t) {
              var n = createNS(`filter`);
              return (
                n.setAttribute(`id`, e),
                t !== !0 &&
                  (n.setAttribute(`filterUnits`, `objectBoundingBox`),
                  n.setAttribute(`x`, `0%`),
                  n.setAttribute(`y`, `0%`),
                  n.setAttribute(`width`, `100%`),
                  n.setAttribute(`height`, `100%`)),
                n
              );
            }
            function n() {
              var e = createNS(`feColorMatrix`);
              return (
                e.setAttribute(`type`, `matrix`),
                e.setAttribute(`color-interpolation-filters`, `sRGB`),
                e.setAttribute(
                  `values`,
                  `0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 1 1`,
                ),
                e
              );
            }
            return e;
          })(),
          featureSupport = (function () {
            var e = {
              maskType: !0,
              svgLumaHidden: !0,
              offscreenCanvas: typeof OffscreenCanvas < `u`,
            };
            return (
              (/MSIE 10/i.test(navigator.userAgent) ||
                /MSIE 9/i.test(navigator.userAgent) ||
                /rv:11.0/i.test(navigator.userAgent) ||
                /Edge\/\d./i.test(navigator.userAgent)) &&
                (e.maskType = !1),
              /firefox/i.test(navigator.userAgent) && (e.svgLumaHidden = !1),
              e
            );
          })(),
          registeredEffects$1 = {},
          idPrefix = `filter_result_`;
        function SVGEffects(e) {
          var t,
            n = `SourceGraphic`,
            r = e.data.ef ? e.data.ef.length : 0,
            i = createElementID(),
            a = filtersFactory.createFilter(i, !0),
            o = 0;
          this.filters = [];
          var s;
          for (t = 0; t < r; t += 1) {
            s = null;
            var c = e.data.ef[t].ty;
            if (registeredEffects$1[c]) {
              var l = registeredEffects$1[c].effect;
              ((s = new l(
                a,
                e.effectsManager.effectElements[t],
                e,
                idPrefix + o,
                n,
              )),
                (n = idPrefix + o),
                registeredEffects$1[c].countsAsEffect && (o += 1));
            }
            s && this.filters.push(s);
          }
          (o &&
            (e.globalData.defs.appendChild(a),
            e.layerElement.setAttribute(
              `filter`,
              `url(` + getLocationHref() + `#` + i + `)`,
            )),
            this.filters.length && e.addRenderableComponent(this));
        }
        ((SVGEffects.prototype.renderFrame = function (e) {
          var t,
            n = this.filters.length;
          for (t = 0; t < n; t += 1) this.filters[t].renderFrame(e);
        }),
          (SVGEffects.prototype.getEffects = function (e) {
            var t,
              n = this.filters.length,
              r = [];
            for (t = 0; t < n; t += 1)
              this.filters[t].type === e && r.push(this.filters[t]);
            return r;
          }));
        function registerEffect$1(e, t, n) {
          registeredEffects$1[e] = { effect: t, countsAsEffect: n };
        }
        function SVGBaseElement() {}
        SVGBaseElement.prototype = {
          initRendererElement: function () {
            this.layerElement = createNS(`g`);
          },
          createContainerElements: function () {
            ((this.matteElement = createNS(`g`)),
              (this.transformedElement = this.layerElement),
              (this.maskedElement = this.layerElement),
              (this._sizeChanged = !1));
            var e = null;
            if (this.data.td) {
              this.matteMasks = {};
              var t = createNS(`g`);
              (t.setAttribute(`id`, this.layerId),
                t.appendChild(this.layerElement),
                (e = t),
                this.globalData.defs.appendChild(t));
            } else
              this.data.tt
                ? (this.matteElement.appendChild(this.layerElement),
                  (e = this.matteElement),
                  (this.baseElement = this.matteElement))
                : (this.baseElement = this.layerElement);
            if (
              (this.data.ln &&
                this.layerElement.setAttribute(`id`, this.data.ln),
              this.data.cl &&
                this.layerElement.setAttribute(`class`, this.data.cl),
              this.data.ty === 0 && !this.data.hd)
            ) {
              var n = createNS(`clipPath`),
                r = createNS(`path`);
              r.setAttribute(
                `d`,
                `M0,0 L` +
                  this.data.w +
                  `,0 L` +
                  this.data.w +
                  `,` +
                  this.data.h +
                  ` L0,` +
                  this.data.h +
                  `z`,
              );
              var i = createElementID();
              if (
                (n.setAttribute(`id`, i),
                n.appendChild(r),
                this.globalData.defs.appendChild(n),
                this.checkMasks())
              ) {
                var a = createNS(`g`);
                (a.setAttribute(
                  `clip-path`,
                  `url(` + getLocationHref() + `#` + i + `)`,
                ),
                  a.appendChild(this.layerElement),
                  (this.transformedElement = a),
                  e
                    ? e.appendChild(this.transformedElement)
                    : (this.baseElement = this.transformedElement));
              } else
                this.layerElement.setAttribute(
                  `clip-path`,
                  `url(` + getLocationHref() + `#` + i + `)`,
                );
            }
            this.data.bm !== 0 && this.setBlendMode();
          },
          renderElement: function () {
            (this.finalTransform._localMatMdf &&
              this.transformedElement.setAttribute(
                `transform`,
                this.finalTransform.localMat.to2dCSS(),
              ),
              this.finalTransform._opMdf &&
                this.transformedElement.setAttribute(
                  `opacity`,
                  this.finalTransform.localOpacity,
                ));
          },
          destroyBaseElement: function () {
            ((this.layerElement = null),
              (this.matteElement = null),
              this.maskManager.destroy());
          },
          getBaseElement: function () {
            return this.data.hd ? null : this.baseElement;
          },
          createRenderableComponents: function () {
            ((this.maskManager = new MaskElement(
              this.data,
              this,
              this.globalData,
            )),
              (this.renderableEffectsManager = new SVGEffects(this)),
              this.searchEffectTransforms());
          },
          getMatte: function (e) {
            if (((this.matteMasks ||= {}), !this.matteMasks[e])) {
              var t = this.layerId + `_` + e,
                n,
                r,
                i,
                a;
              if (e === 1 || e === 3) {
                var o = createNS(`mask`);
                (o.setAttribute(`id`, t),
                  o.setAttribute(`mask-type`, e === 3 ? `luminance` : `alpha`),
                  (i = createNS(`use`)),
                  i.setAttributeNS(
                    `http://www.w3.org/1999/xlink`,
                    `href`,
                    `#` + this.layerId,
                  ),
                  o.appendChild(i),
                  this.globalData.defs.appendChild(o),
                  !featureSupport.maskType &&
                    e === 1 &&
                    (o.setAttribute(`mask-type`, `luminance`),
                    (n = createElementID()),
                    (r = filtersFactory.createFilter(n)),
                    this.globalData.defs.appendChild(r),
                    r.appendChild(
                      filtersFactory.createAlphaToLuminanceFilter(),
                    ),
                    (a = createNS(`g`)),
                    a.appendChild(i),
                    o.appendChild(a),
                    a.setAttribute(
                      `filter`,
                      `url(` + getLocationHref() + `#` + n + `)`,
                    )));
              } else if (e === 2) {
                var s = createNS(`mask`);
                (s.setAttribute(`id`, t), s.setAttribute(`mask-type`, `alpha`));
                var c = createNS(`g`);
                (s.appendChild(c),
                  (n = createElementID()),
                  (r = filtersFactory.createFilter(n)));
                var l = createNS(`feComponentTransfer`);
                (l.setAttribute(`in`, `SourceGraphic`), r.appendChild(l));
                var u = createNS(`feFuncA`);
                (u.setAttribute(`type`, `table`),
                  u.setAttribute(`tableValues`, `1.0 0.0`),
                  l.appendChild(u),
                  this.globalData.defs.appendChild(r));
                var d = createNS(`rect`);
                (d.setAttribute(`width`, this.comp.data.w),
                  d.setAttribute(`height`, this.comp.data.h),
                  d.setAttribute(`x`, `0`),
                  d.setAttribute(`y`, `0`),
                  d.setAttribute(`fill`, `#ffffff`),
                  d.setAttribute(`opacity`, `0`),
                  c.setAttribute(
                    `filter`,
                    `url(` + getLocationHref() + `#` + n + `)`,
                  ),
                  c.appendChild(d),
                  (i = createNS(`use`)),
                  i.setAttributeNS(
                    `http://www.w3.org/1999/xlink`,
                    `href`,
                    `#` + this.layerId,
                  ),
                  c.appendChild(i),
                  featureSupport.maskType ||
                    (s.setAttribute(`mask-type`, `luminance`),
                    r.appendChild(
                      filtersFactory.createAlphaToLuminanceFilter(),
                    ),
                    (a = createNS(`g`)),
                    c.appendChild(d),
                    a.appendChild(this.layerElement),
                    c.appendChild(a)),
                  this.globalData.defs.appendChild(s));
              }
              this.matteMasks[e] = t;
            }
            return this.matteMasks[e];
          },
          setMatte: function (e) {
            this.matteElement &&
              this.matteElement.setAttribute(
                `mask`,
                `url(` + getLocationHref() + `#` + e + `)`,
              );
          },
        };
        function HierarchyElement() {}
        HierarchyElement.prototype = {
          initHierarchy: function () {
            ((this.hierarchy = []),
              (this._isParent = !1),
              this.checkParenting());
          },
          setHierarchy: function (e) {
            this.hierarchy = e;
          },
          setAsParent: function () {
            this._isParent = !0;
          },
          checkParenting: function () {
            this.data.parent !== void 0 &&
              this.comp.buildElementParenting(this, this.data.parent, []);
          },
        };
        function RenderableDOMElement() {}
        (function () {
          extendPrototype(
            [
              RenderableElement,
              createProxyFunction({
                initElement: function (e, t, n) {
                  (this.initFrame(),
                    this.initBaseData(e, t, n),
                    this.initTransform(e, t, n),
                    this.initHierarchy(),
                    this.initRenderable(),
                    this.initRendererElement(),
                    this.createContainerElements(),
                    this.createRenderableComponents(),
                    this.createContent(),
                    this.hide());
                },
                hide: function () {
                  if (!this.hidden && (!this.isInRange || this.isTransparent)) {
                    var e = this.baseElement || this.layerElement;
                    ((e.style.display = `none`), (this.hidden = !0));
                  }
                },
                show: function () {
                  if (this.isInRange && !this.isTransparent) {
                    if (!this.data.hd) {
                      var e = this.baseElement || this.layerElement;
                      e.style.display = `block`;
                    }
                    ((this.hidden = !1), (this._isFirstFrame = !0));
                  }
                },
                renderFrame: function () {
                  this.data.hd ||
                    this.hidden ||
                    (this.renderTransform(),
                    this.renderRenderable(),
                    this.renderLocalTransform(),
                    this.renderElement(),
                    this.renderInnerContent(),
                    (this._isFirstFrame &&= !1));
                },
                renderInnerContent: function () {},
                prepareFrame: function (e) {
                  ((this._mdf = !1),
                    this.prepareRenderableFrame(e),
                    this.prepareProperties(e, this.isInRange),
                    this.checkTransparency());
                },
                destroy: function () {
                  ((this.innerElem = null), this.destroyBaseElement());
                },
              }),
            ],
            RenderableDOMElement,
          );
        })();
        function IImageElement(e, t, n) {
          ((this.assetData = t.getAssetData(e.refId)),
            this.assetData &&
              this.assetData.sid &&
              (this.assetData = t.slotManager.getProp(this.assetData)),
            this.initElement(e, t, n),
            (this.sourceRect = {
              top: 0,
              left: 0,
              width: this.assetData.w,
              height: this.assetData.h,
            }));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            SVGBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableDOMElement,
          ],
          IImageElement,
        ),
          (IImageElement.prototype.createContent = function () {
            var e = this.globalData.getAssetsPath(this.assetData);
            ((this.innerElem = createNS(`image`)),
              this.innerElem.setAttribute(`width`, this.assetData.w + `px`),
              this.innerElem.setAttribute(`height`, this.assetData.h + `px`),
              this.innerElem.setAttribute(
                `preserveAspectRatio`,
                this.assetData.pr ||
                  this.globalData.renderConfig.imagePreserveAspectRatio,
              ),
              this.innerElem.setAttributeNS(
                `http://www.w3.org/1999/xlink`,
                `href`,
                e,
              ),
              this.layerElement.appendChild(this.innerElem));
          }),
          (IImageElement.prototype.sourceRectAtTime = function () {
            return this.sourceRect;
          }));
        function ProcessedElement(e, t) {
          ((this.elem = e), (this.pos = t));
        }
        function IShapeElement() {}
        IShapeElement.prototype = {
          addShapeToModifiers: function (e) {
            var t,
              n = this.shapeModifiers.length;
            for (t = 0; t < n; t += 1) this.shapeModifiers[t].addShape(e);
          },
          isShapeInAnimatedModifiers: function (e) {
            for (var t = 0, n = this.shapeModifiers.length; t < n;)
              if (this.shapeModifiers[t].isAnimatedWithShape(e)) return !0;
            return !1;
          },
          renderModifiers: function () {
            if (this.shapeModifiers.length) {
              var e,
                t = this.shapes.length;
              for (e = 0; e < t; e += 1) this.shapes[e].sh.reset();
              t = this.shapeModifiers.length;
              var n;
              for (
                e = t - 1;
                e >= 0 &&
                ((n = this.shapeModifiers[e].processShapes(this._isFirstFrame)),
                !n);
                --e
              );
            }
          },
          searchProcessedElement: function (e) {
            for (var t = this.processedElements, n = 0, r = t.length; n < r;) {
              if (t[n].elem === e) return t[n].pos;
              n += 1;
            }
            return 0;
          },
          addProcessedElement: function (e, t) {
            for (var n = this.processedElements, r = n.length; r;)
              if ((--r, n[r].elem === e)) {
                n[r].pos = t;
                return;
              }
            n.push(new ProcessedElement(e, t));
          },
          prepareFrame: function (e) {
            (this.prepareRenderableFrame(e),
              this.prepareProperties(e, this.isInRange));
          },
        };
        var lineCapEnum = { 1: `butt`, 2: `round`, 3: `square` },
          lineJoinEnum = { 1: `miter`, 2: `round`, 3: `bevel` };
        function SVGShapeData(e, t, n) {
          ((this.caches = []),
            (this.styles = []),
            (this.transformers = e),
            (this.lStr = ``),
            (this.sh = n),
            (this.lvl = t),
            (this._isAnimated = !!n.k));
          for (var r = 0, i = e.length; r < i;) {
            if (e[r].mProps.dynamicProperties.length) {
              this._isAnimated = !0;
              break;
            }
            r += 1;
          }
        }
        SVGShapeData.prototype.setAsAnimated = function () {
          this._isAnimated = !0;
        };
        function SVGStyleData(e, t) {
          ((this.data = e),
            (this.type = e.ty),
            (this.d = ``),
            (this.lvl = t),
            (this._mdf = !1),
            (this.closed = e.hd === !0),
            (this.pElem = createNS(`path`)),
            (this.msElem = null));
        }
        SVGStyleData.prototype.reset = function () {
          ((this.d = ``), (this._mdf = !1));
        };
        function DashProperty(e, t, n, r) {
          ((this.elem = e),
            (this.frameId = -1),
            (this.dataProps = createSizedArray(t.length)),
            (this.renderer = n),
            (this.k = !1),
            (this.dashStr = ``),
            (this.dashArray = createTypedArray(
              `float32`,
              t.length ? t.length - 1 : 0,
            )),
            (this.dashoffset = createTypedArray(`float32`, 1)),
            this.initDynamicPropertyContainer(r));
          var i,
            a = t.length || 0,
            o;
          for (i = 0; i < a; i += 1)
            ((o = PropertyFactory.getProp(e, t[i].v, 0, 0, this)),
              (this.k = o.k || this.k),
              (this.dataProps[i] = { n: t[i].n, p: o }));
          (this.k || this.getValue(!0), (this._isAnimated = this.k));
        }
        ((DashProperty.prototype.getValue = function (e) {
          if (
            !(this.elem.globalData.frameId === this.frameId && !e) &&
            ((this.frameId = this.elem.globalData.frameId),
            this.iterateDynamicProperties(),
            (this._mdf = this._mdf || e),
            this._mdf)
          ) {
            var t = 0,
              n = this.dataProps.length;
            for (
              this.renderer === `svg` && (this.dashStr = ``), t = 0;
              t < n;
              t += 1
            )
              this.dataProps[t].n === `o`
                ? (this.dashoffset[0] = this.dataProps[t].p.v)
                : this.renderer === `svg`
                  ? (this.dashStr += ` ` + this.dataProps[t].p.v)
                  : (this.dashArray[t] = this.dataProps[t].p.v);
          }
        }),
          extendPrototype([DynamicPropertyContainer], DashProperty));
        function SVGStrokeStyleData(e, t, n) {
          (this.initDynamicPropertyContainer(e),
            (this.getValue = this.iterateDynamicProperties),
            (this.o = PropertyFactory.getProp(e, t.o, 0, 0.01, this)),
            (this.w = PropertyFactory.getProp(e, t.w, 0, null, this)),
            (this.d = new DashProperty(e, t.d || {}, `svg`, this)),
            (this.c = PropertyFactory.getProp(e, t.c, 1, 255, this)),
            (this.style = n),
            (this._isAnimated = !!this._isAnimated));
        }
        extendPrototype([DynamicPropertyContainer], SVGStrokeStyleData);
        function SVGFillStyleData(e, t, n) {
          (this.initDynamicPropertyContainer(e),
            (this.getValue = this.iterateDynamicProperties),
            (this.o = PropertyFactory.getProp(e, t.o, 0, 0.01, this)),
            (this.c = PropertyFactory.getProp(e, t.c, 1, 255, this)),
            (this.style = n));
        }
        extendPrototype([DynamicPropertyContainer], SVGFillStyleData);
        function SVGNoStyleData(e, t, n) {
          (this.initDynamicPropertyContainer(e),
            (this.getValue = this.iterateDynamicProperties),
            (this.style = n));
        }
        extendPrototype([DynamicPropertyContainer], SVGNoStyleData);
        function GradientProperty(e, t, n) {
          ((this.data = t), (this.c = createTypedArray(`uint8c`, t.p * 4)));
          var r = t.k.k[0].s
            ? t.k.k[0].s.length - t.p * 4
            : t.k.k.length - t.p * 4;
          ((this.o = createTypedArray(`float32`, r)),
            (this._cmdf = !1),
            (this._omdf = !1),
            (this._collapsable = this.checkCollapsable()),
            (this._hasOpacity = r),
            this.initDynamicPropertyContainer(n),
            (this.prop = PropertyFactory.getProp(e, t.k, 1, null, this)),
            (this.k = this.prop.k),
            this.getValue(!0));
        }
        ((GradientProperty.prototype.comparePoints = function (e, t) {
          for (var n = 0, r = this.o.length / 2, i; n < r;) {
            if (((i = Math.abs(e[n * 4] - e[t * 4 + n * 2])), i > 0.01))
              return !1;
            n += 1;
          }
          return !0;
        }),
          (GradientProperty.prototype.checkCollapsable = function () {
            if (this.o.length / 2 != this.c.length / 4) return !1;
            if (this.data.k.k[0].s)
              for (var e = 0, t = this.data.k.k.length; e < t;) {
                if (!this.comparePoints(this.data.k.k[e].s, this.data.p))
                  return !1;
                e += 1;
              }
            else if (!this.comparePoints(this.data.k.k, this.data.p)) return !1;
            return !0;
          }),
          (GradientProperty.prototype.getValue = function (e) {
            if (
              (this.prop.getValue(),
              (this._mdf = !1),
              (this._cmdf = !1),
              (this._omdf = !1),
              this.prop._mdf || e)
            ) {
              var t,
                n = this.data.p * 4,
                r,
                i;
              for (t = 0; t < n; t += 1)
                ((r = t % 4 == 0 ? 100 : 255),
                  (i = Math.round(this.prop.v[t] * r)),
                  this.c[t] !== i && ((this.c[t] = i), (this._cmdf = !e)));
              if (this.o.length)
                for (n = this.prop.v.length, t = this.data.p * 4; t < n; t += 1)
                  ((r = t % 2 == 0 ? 100 : 1),
                    (i =
                      t % 2 == 0
                        ? Math.round(this.prop.v[t] * 100)
                        : this.prop.v[t]),
                    this.o[t - this.data.p * 4] !== i &&
                      ((this.o[t - this.data.p * 4] = i), (this._omdf = !e)));
              this._mdf = !e;
            }
          }),
          extendPrototype([DynamicPropertyContainer], GradientProperty));
        function SVGGradientFillStyleData(e, t, n) {
          (this.initDynamicPropertyContainer(e),
            (this.getValue = this.iterateDynamicProperties),
            this.initGradientData(e, t, n));
        }
        ((SVGGradientFillStyleData.prototype.initGradientData = function (
          e,
          t,
          n,
        ) {
          ((this.o = PropertyFactory.getProp(e, t.o, 0, 0.01, this)),
            (this.s = PropertyFactory.getProp(e, t.s, 1, null, this)),
            (this.e = PropertyFactory.getProp(e, t.e, 1, null, this)),
            (this.h = PropertyFactory.getProp(
              e,
              t.h || { k: 0 },
              0,
              0.01,
              this,
            )),
            (this.a = PropertyFactory.getProp(
              e,
              t.a || { k: 0 },
              0,
              degToRads,
              this,
            )),
            (this.g = new GradientProperty(e, t.g, this)),
            (this.style = n),
            (this.stops = []),
            this.setGradientData(n.pElem, t),
            this.setGradientOpacity(t, n),
            (this._isAnimated = !!this._isAnimated));
        }),
          (SVGGradientFillStyleData.prototype.setGradientData = function (
            e,
            t,
          ) {
            var n = createElementID(),
              r = createNS(t.t === 1 ? `linearGradient` : `radialGradient`);
            (r.setAttribute(`id`, n),
              r.setAttribute(`spreadMethod`, `pad`),
              r.setAttribute(`gradientUnits`, `userSpaceOnUse`));
            var i = [],
              a,
              o,
              s = t.g.p * 4;
            for (o = 0; o < s; o += 4)
              ((a = createNS(`stop`)), r.appendChild(a), i.push(a));
            (e.setAttribute(
              t.ty === `gf` ? `fill` : `stroke`,
              `url(` + getLocationHref() + `#` + n + `)`,
            ),
              (this.gf = r),
              (this.cst = i));
          }),
          (SVGGradientFillStyleData.prototype.setGradientOpacity = function (
            e,
            t,
          ) {
            if (this.g._hasOpacity && !this.g._collapsable) {
              var n,
                r,
                i,
                a = createNS(`mask`),
                o = createNS(`path`);
              a.appendChild(o);
              var s = createElementID(),
                c = createElementID();
              a.setAttribute(`id`, c);
              var l = createNS(e.t === 1 ? `linearGradient` : `radialGradient`);
              (l.setAttribute(`id`, s),
                l.setAttribute(`spreadMethod`, `pad`),
                l.setAttribute(`gradientUnits`, `userSpaceOnUse`),
                (i = e.g.k.k[0].s ? e.g.k.k[0].s.length : e.g.k.k.length));
              var u = this.stops;
              for (r = e.g.p * 4; r < i; r += 2)
                ((n = createNS(`stop`)),
                  n.setAttribute(`stop-color`, `rgb(255,255,255)`),
                  l.appendChild(n),
                  u.push(n));
              (o.setAttribute(
                e.ty === `gf` ? `fill` : `stroke`,
                `url(` + getLocationHref() + `#` + s + `)`,
              ),
                e.ty === `gs` &&
                  (o.setAttribute(`stroke-linecap`, lineCapEnum[e.lc || 2]),
                  o.setAttribute(`stroke-linejoin`, lineJoinEnum[e.lj || 2]),
                  e.lj === 1 && o.setAttribute(`stroke-miterlimit`, e.ml)),
                (this.of = l),
                (this.ms = a),
                (this.ost = u),
                (this.maskId = c),
                (t.msElem = o));
            }
          }),
          extendPrototype(
            [DynamicPropertyContainer],
            SVGGradientFillStyleData,
          ));
        function SVGGradientStrokeStyleData(e, t, n) {
          (this.initDynamicPropertyContainer(e),
            (this.getValue = this.iterateDynamicProperties),
            (this.w = PropertyFactory.getProp(e, t.w, 0, null, this)),
            (this.d = new DashProperty(e, t.d || {}, `svg`, this)),
            this.initGradientData(e, t, n),
            (this._isAnimated = !!this._isAnimated));
        }
        extendPrototype(
          [SVGGradientFillStyleData, DynamicPropertyContainer],
          SVGGradientStrokeStyleData,
        );
        function ShapeGroupData() {
          ((this.it = []), (this.prevViewData = []), (this.gr = createNS(`g`)));
        }
        function SVGTransformData(e, t, n) {
          ((this.transform = { mProps: e, op: t, container: n }),
            (this.elements = []),
            (this._isAnimated =
              this.transform.mProps.dynamicProperties.length ||
              this.transform.op.effectsSequence.length));
        }
        var buildShapeString = function (e, t, n, r) {
            if (t === 0) return ``;
            var i = e.o,
              a = e.i,
              o = e.v,
              s,
              c = ` M` + r.applyToPointStringified(o[0][0], o[0][1]);
            for (s = 1; s < t; s += 1)
              c +=
                ` C` +
                r.applyToPointStringified(i[s - 1][0], i[s - 1][1]) +
                ` ` +
                r.applyToPointStringified(a[s][0], a[s][1]) +
                ` ` +
                r.applyToPointStringified(o[s][0], o[s][1]);
            return (
              n &&
                t &&
                ((c +=
                  ` C` +
                  r.applyToPointStringified(i[s - 1][0], i[s - 1][1]) +
                  ` ` +
                  r.applyToPointStringified(a[0][0], a[0][1]) +
                  ` ` +
                  r.applyToPointStringified(o[0][0], o[0][1])),
                (c += `z`)),
              c
            );
          },
          SVGElementsRenderer = (function () {
            var e = new Matrix(),
              t = new Matrix(),
              n = { createRenderFunction: r };
            function r(e) {
              switch (e.ty) {
                case `fl`:
                  return s;
                case `gf`:
                  return l;
                case `gs`:
                  return c;
                case `st`:
                  return u;
                case `sh`:
                case `el`:
                case `rc`:
                case `sr`:
                  return o;
                case `tr`:
                  return i;
                case `no`:
                  return a;
                default:
                  return null;
              }
            }
            function i(e, t, n) {
              ((n || t.transform.op._mdf) &&
                t.transform.container.setAttribute(`opacity`, t.transform.op.v),
                (n || t.transform.mProps._mdf) &&
                  t.transform.container.setAttribute(
                    `transform`,
                    t.transform.mProps.v.to2dCSS(),
                  ));
            }
            function a() {}
            function o(n, r, i) {
              var a,
                o,
                s,
                c,
                l,
                u,
                d = r.styles.length,
                f = r.lvl,
                p,
                m,
                g,
                _;
              for (u = 0; u < d; u += 1) {
                if (((c = r.sh._mdf || i), r.styles[u].lvl < f)) {
                  for (
                    m = t.reset(),
                      g = f - r.styles[u].lvl,
                      _ = r.transformers.length - 1;
                    !c && g > 0;
                  )
                    ((c = r.transformers[_].mProps._mdf || c), --g, --_);
                  if (c)
                    for (
                      g = f - r.styles[u].lvl, _ = r.transformers.length - 1;
                      g > 0;
                    )
                      (m.multiply(r.transformers[_].mProps.v), --g, --_);
                } else m = e;
                if (((p = r.sh.paths), (o = p._length), c)) {
                  for (s = ``, a = 0; a < o; a += 1)
                    ((l = p.shapes[a]),
                      l &&
                        l._length &&
                        (s += buildShapeString(l, l._length, l.c, m)));
                  r.caches[u] = s;
                } else s = r.caches[u];
                ((r.styles[u].d += n.hd === !0 ? `` : s),
                  (r.styles[u]._mdf = c || r.styles[u]._mdf));
              }
            }
            function s(e, t, n) {
              var r = t.style;
              ((t.c._mdf || n) &&
                r.pElem.setAttribute(
                  `fill`,
                  `rgb(` +
                    bmFloor(t.c.v[0]) +
                    `,` +
                    bmFloor(t.c.v[1]) +
                    `,` +
                    bmFloor(t.c.v[2]) +
                    `)`,
                ),
                (t.o._mdf || n) && r.pElem.setAttribute(`fill-opacity`, t.o.v));
            }
            function c(e, t, n) {
              (l(e, t, n), u(e, t, n));
            }
            function l(e, t, n) {
              var r = t.gf,
                i = t.g._hasOpacity,
                a = t.s.v,
                o = t.e.v;
              if (t.o._mdf || n) {
                var s = e.ty === `gf` ? `fill-opacity` : `stroke-opacity`;
                t.style.pElem.setAttribute(s, t.o.v);
              }
              if (t.s._mdf || n) {
                var c = e.t === 1 ? `x1` : `cx`,
                  l = c === `x1` ? `y1` : `cy`;
                (r.setAttribute(c, a[0]),
                  r.setAttribute(l, a[1]),
                  i &&
                    !t.g._collapsable &&
                    (t.of.setAttribute(c, a[0]), t.of.setAttribute(l, a[1])));
              }
              var u, d, f, p;
              if (t.g._cmdf || n) {
                u = t.cst;
                var m = t.g.c;
                for (f = u.length, d = 0; d < f; d += 1)
                  ((p = u[d]),
                    p.setAttribute(`offset`, m[d * 4] + `%`),
                    p.setAttribute(
                      `stop-color`,
                      `rgb(` +
                        m[d * 4 + 1] +
                        `,` +
                        m[d * 4 + 2] +
                        `,` +
                        m[d * 4 + 3] +
                        `)`,
                    ));
              }
              if (i && (t.g._omdf || n)) {
                var g = t.g.o;
                for (
                  u = t.g._collapsable ? t.cst : t.ost, f = u.length, d = 0;
                  d < f;
                  d += 1
                )
                  ((p = u[d]),
                    t.g._collapsable ||
                      p.setAttribute(`offset`, g[d * 2] + `%`),
                    p.setAttribute(`stop-opacity`, g[d * 2 + 1]));
              }
              if (e.t === 1)
                (t.e._mdf || n) &&
                  (r.setAttribute(`x2`, o[0]),
                  r.setAttribute(`y2`, o[1]),
                  i &&
                    !t.g._collapsable &&
                    (t.of.setAttribute(`x2`, o[0]),
                    t.of.setAttribute(`y2`, o[1])));
              else {
                var _;
                if (
                  ((t.s._mdf || t.e._mdf || n) &&
                    ((_ = Math.sqrt((a[0] - o[0]) ** 2 + (a[1] - o[1]) ** 2)),
                    r.setAttribute(`r`, _),
                    i && !t.g._collapsable && t.of.setAttribute(`r`, _)),
                  t.s._mdf || t.e._mdf || t.h._mdf || t.a._mdf || n)
                ) {
                  _ ||= Math.sqrt((a[0] - o[0]) ** 2 + (a[1] - o[1]) ** 2);
                  var y = Math.atan2(o[1] - a[1], o[0] - a[0]),
                    b = t.h.v;
                  b >= 1 ? (b = 0.99) : b <= -1 && (b = -0.99);
                  var x = _ * b,
                    S = Math.cos(y + t.a.v) * x + a[0],
                    C = Math.sin(y + t.a.v) * x + a[1];
                  (r.setAttribute(`fx`, S),
                    r.setAttribute(`fy`, C),
                    i &&
                      !t.g._collapsable &&
                      (t.of.setAttribute(`fx`, S), t.of.setAttribute(`fy`, C)));
                }
              }
            }
            function u(e, t, n) {
              var r = t.style,
                i = t.d;
              (i &&
                (i._mdf || n) &&
                i.dashStr &&
                (r.pElem.setAttribute(`stroke-dasharray`, i.dashStr),
                r.pElem.setAttribute(`stroke-dashoffset`, i.dashoffset[0])),
                t.c &&
                  (t.c._mdf || n) &&
                  r.pElem.setAttribute(
                    `stroke`,
                    `rgb(` +
                      bmFloor(t.c.v[0]) +
                      `,` +
                      bmFloor(t.c.v[1]) +
                      `,` +
                      bmFloor(t.c.v[2]) +
                      `)`,
                  ),
                (t.o._mdf || n) &&
                  r.pElem.setAttribute(`stroke-opacity`, t.o.v),
                (t.w._mdf || n) &&
                  (r.pElem.setAttribute(`stroke-width`, t.w.v),
                  r.msElem && r.msElem.setAttribute(`stroke-width`, t.w.v)));
            }
            return n;
          })();
        function SVGShapeElement(e, t, n) {
          ((this.shapes = []),
            (this.shapesData = e.shapes),
            (this.stylesList = []),
            (this.shapeModifiers = []),
            (this.itemsData = []),
            (this.processedElements = []),
            (this.animatedContents = []),
            this.initElement(e, t, n),
            (this.prevViewData = []));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            SVGBaseElement,
            IShapeElement,
            HierarchyElement,
            FrameElement,
            RenderableDOMElement,
          ],
          SVGShapeElement,
        ),
          (SVGShapeElement.prototype.initSecondaryElement = function () {}),
          (SVGShapeElement.prototype.identityMatrix = new Matrix()),
          (SVGShapeElement.prototype.buildExpressionInterface = function () {}),
          (SVGShapeElement.prototype.createContent = function () {
            (this.searchShapes(
              this.shapesData,
              this.itemsData,
              this.prevViewData,
              this.layerElement,
              0,
              [],
              !0,
            ),
              this.filterUniqueShapes());
          }),
          (SVGShapeElement.prototype.filterUniqueShapes = function () {
            var e,
              t = this.shapes.length,
              n,
              r,
              i = this.stylesList.length,
              a,
              o = [],
              s = !1;
            for (r = 0; r < i; r += 1) {
              for (
                a = this.stylesList[r], s = !1, o.length = 0, e = 0;
                e < t;
                e += 1
              )
                ((n = this.shapes[e]),
                  n.styles.indexOf(a) !== -1 &&
                    (o.push(n), (s = n._isAnimated || s)));
              o.length > 1 && s && this.setShapesAsAnimated(o);
            }
          }),
          (SVGShapeElement.prototype.setShapesAsAnimated = function (e) {
            var t,
              n = e.length;
            for (t = 0; t < n; t += 1) e[t].setAsAnimated();
          }),
          (SVGShapeElement.prototype.createStyleElement = function (e, t) {
            var n,
              r = new SVGStyleData(e, t),
              i = r.pElem;
            return (
              e.ty === `st`
                ? (n = new SVGStrokeStyleData(this, e, r))
                : e.ty === `fl`
                  ? (n = new SVGFillStyleData(this, e, r))
                  : e.ty === `gf` || e.ty === `gs`
                    ? ((n = new (
                        e.ty === `gf`
                          ? SVGGradientFillStyleData
                          : SVGGradientStrokeStyleData
                      )(this, e, r)),
                      this.globalData.defs.appendChild(n.gf),
                      n.maskId &&
                        (this.globalData.defs.appendChild(n.ms),
                        this.globalData.defs.appendChild(n.of),
                        i.setAttribute(
                          `mask`,
                          `url(` + getLocationHref() + `#` + n.maskId + `)`,
                        )))
                    : e.ty === `no` && (n = new SVGNoStyleData(this, e, r)),
              (e.ty === `st` || e.ty === `gs`) &&
                (i.setAttribute(`stroke-linecap`, lineCapEnum[e.lc || 2]),
                i.setAttribute(`stroke-linejoin`, lineJoinEnum[e.lj || 2]),
                i.setAttribute(`fill-opacity`, `0`),
                e.lj === 1 && i.setAttribute(`stroke-miterlimit`, e.ml)),
              e.r === 2 && i.setAttribute(`fill-rule`, `evenodd`),
              e.ln && i.setAttribute(`id`, e.ln),
              e.cl && i.setAttribute(`class`, e.cl),
              e.bm && (i.style[`mix-blend-mode`] = getBlendMode(e.bm)),
              this.stylesList.push(r),
              this.addToAnimatedContents(e, n),
              n
            );
          }),
          (SVGShapeElement.prototype.createGroupElement = function (e) {
            var t = new ShapeGroupData();
            return (
              e.ln && t.gr.setAttribute(`id`, e.ln),
              e.cl && t.gr.setAttribute(`class`, e.cl),
              e.bm && (t.gr.style[`mix-blend-mode`] = getBlendMode(e.bm)),
              t
            );
          }),
          (SVGShapeElement.prototype.createTransformElement = function (e, t) {
            var n = TransformPropertyFactory.getTransformProperty(
                this,
                e,
                this,
              ),
              r = new SVGTransformData(n, n.o, t);
            return (this.addToAnimatedContents(e, r), r);
          }),
          (SVGShapeElement.prototype.createShapeElement = function (e, t, n) {
            var r = 4;
            e.ty === `rc`
              ? (r = 5)
              : e.ty === `el`
                ? (r = 6)
                : e.ty === `sr` && (r = 7);
            var i = new SVGShapeData(
              t,
              n,
              ShapePropertyFactory.getShapeProp(this, e, r, this),
            );
            return (
              this.shapes.push(i),
              this.addShapeToModifiers(i),
              this.addToAnimatedContents(e, i),
              i
            );
          }),
          (SVGShapeElement.prototype.addToAnimatedContents = function (e, t) {
            for (var n = 0, r = this.animatedContents.length; n < r;) {
              if (this.animatedContents[n].element === t) return;
              n += 1;
            }
            this.animatedContents.push({
              fn: SVGElementsRenderer.createRenderFunction(e),
              element: t,
              data: e,
            });
          }),
          (SVGShapeElement.prototype.setElementStyles = function (e) {
            var t = e.styles,
              n,
              r = this.stylesList.length;
            for (n = 0; n < r; n += 1)
              t.indexOf(this.stylesList[n]) === -1 &&
                !this.stylesList[n].closed &&
                t.push(this.stylesList[n]);
          }),
          (SVGShapeElement.prototype.reloadShapes = function () {
            this._isFirstFrame = !0;
            var e,
              t = this.itemsData.length;
            for (e = 0; e < t; e += 1) this.prevViewData[e] = this.itemsData[e];
            for (
              this.searchShapes(
                this.shapesData,
                this.itemsData,
                this.prevViewData,
                this.layerElement,
                0,
                [],
                !0,
              ),
                this.filterUniqueShapes(),
                t = this.dynamicProperties.length,
                e = 0;
              e < t;
              e += 1
            )
              this.dynamicProperties[e].getValue();
            this.renderModifiers();
          }),
          (SVGShapeElement.prototype.searchShapes = function (
            e,
            t,
            n,
            r,
            i,
            a,
            o,
          ) {
            var s = [].concat(a),
              c,
              l = e.length - 1,
              u,
              d,
              f = [],
              p = [],
              m,
              g,
              _;
            for (c = l; c >= 0; --c) {
              if (
                ((_ = this.searchProcessedElement(e[c])),
                _ ? (t[c] = n[_ - 1]) : (e[c]._render = o),
                e[c].ty === `fl` ||
                  e[c].ty === `st` ||
                  e[c].ty === `gf` ||
                  e[c].ty === `gs` ||
                  e[c].ty === `no`)
              )
                (_
                  ? (t[c].style.closed = e[c].hd)
                  : (t[c] = this.createStyleElement(e[c], i)),
                  e[c]._render &&
                    t[c].style.pElem.parentNode !== r &&
                    r.appendChild(t[c].style.pElem),
                  f.push(t[c].style));
              else if (e[c].ty === `gr`) {
                if (!_) t[c] = this.createGroupElement(e[c]);
                else
                  for (d = t[c].it.length, u = 0; u < d; u += 1)
                    t[c].prevViewData[u] = t[c].it[u];
                (this.searchShapes(
                  e[c].it,
                  t[c].it,
                  t[c].prevViewData,
                  t[c].gr,
                  i + 1,
                  s,
                  o,
                ),
                  e[c]._render &&
                    t[c].gr.parentNode !== r &&
                    r.appendChild(t[c].gr));
              } else
                e[c].ty === `tr`
                  ? (_ || (t[c] = this.createTransformElement(e[c], r)),
                    (m = t[c].transform),
                    s.push(m))
                  : e[c].ty === `sh` ||
                      e[c].ty === `rc` ||
                      e[c].ty === `el` ||
                      e[c].ty === `sr`
                    ? (_ || (t[c] = this.createShapeElement(e[c], s, i)),
                      this.setElementStyles(t[c]))
                    : e[c].ty === `tm` ||
                        e[c].ty === `rd` ||
                        e[c].ty === `ms` ||
                        e[c].ty === `pb` ||
                        e[c].ty === `zz` ||
                        e[c].ty === `op`
                      ? (_
                          ? ((g = t[c]), (g.closed = !1))
                          : ((g = ShapeModifiers.getModifier(e[c].ty)),
                            g.init(this, e[c]),
                            (t[c] = g),
                            this.shapeModifiers.push(g)),
                        p.push(g))
                      : e[c].ty === `rp` &&
                        (_
                          ? ((g = t[c]), (g.closed = !0))
                          : ((g = ShapeModifiers.getModifier(e[c].ty)),
                            (t[c] = g),
                            g.init(this, e, c, t),
                            this.shapeModifiers.push(g),
                            (o = !1)),
                        p.push(g));
              this.addProcessedElement(e[c], c + 1);
            }
            for (l = f.length, c = 0; c < l; c += 1) f[c].closed = !0;
            for (l = p.length, c = 0; c < l; c += 1) p[c].closed = !0;
          }),
          (SVGShapeElement.prototype.renderInnerContent = function () {
            this.renderModifiers();
            var e,
              t = this.stylesList.length;
            for (e = 0; e < t; e += 1) this.stylesList[e].reset();
            for (this.renderShape(), e = 0; e < t; e += 1)
              (this.stylesList[e]._mdf || this._isFirstFrame) &&
                (this.stylesList[e].msElem &&
                  (this.stylesList[e].msElem.setAttribute(
                    `d`,
                    this.stylesList[e].d,
                  ),
                  (this.stylesList[e].d = `M0 0` + this.stylesList[e].d)),
                this.stylesList[e].pElem.setAttribute(
                  `d`,
                  this.stylesList[e].d || `M0 0`,
                ));
          }),
          (SVGShapeElement.prototype.renderShape = function () {
            var e,
              t = this.animatedContents.length,
              n;
            for (e = 0; e < t; e += 1)
              ((n = this.animatedContents[e]),
                (this._isFirstFrame || n.element._isAnimated) &&
                  n.data !== !0 &&
                  n.fn(n.data, n.element, this._isFirstFrame));
          }),
          (SVGShapeElement.prototype.destroy = function () {
            (this.destroyBaseElement(),
              (this.shapesData = null),
              (this.itemsData = null));
          }));
        function LetterProps(e, t, n, r, i, a) {
          ((this.o = e),
            (this.sw = t),
            (this.sc = n),
            (this.fc = r),
            (this.m = i),
            (this.p = a),
            (this._mdf = { o: !0, sw: !!t, sc: !!n, fc: !!r, m: !0, p: !0 }));
        }
        LetterProps.prototype.update = function (e, t, n, r, i, a) {
          ((this._mdf.o = !1),
            (this._mdf.sw = !1),
            (this._mdf.sc = !1),
            (this._mdf.fc = !1),
            (this._mdf.m = !1),
            (this._mdf.p = !1));
          var o = !1;
          return (
            this.o !== e && ((this.o = e), (this._mdf.o = !0), (o = !0)),
            this.sw !== t && ((this.sw = t), (this._mdf.sw = !0), (o = !0)),
            this.sc !== n && ((this.sc = n), (this._mdf.sc = !0), (o = !0)),
            this.fc !== r && ((this.fc = r), (this._mdf.fc = !0), (o = !0)),
            this.m !== i && ((this.m = i), (this._mdf.m = !0), (o = !0)),
            a.length &&
              (this.p[0] !== a[0] ||
                this.p[1] !== a[1] ||
                this.p[4] !== a[4] ||
                this.p[5] !== a[5] ||
                this.p[12] !== a[12] ||
                this.p[13] !== a[13]) &&
              ((this.p = a), (this._mdf.p = !0), (o = !0)),
            o
          );
        };
        function TextProperty(e, t) {
          ((this._frameId = initialDefaultFrame),
            (this.pv = ``),
            (this.v = ``),
            (this.kf = !1),
            (this._isFirstFrame = !0),
            (this._mdf = !1),
            t.d && t.d.sid && (t.d = e.globalData.slotManager.getProp(t.d)),
            (this.data = t),
            (this.elem = e),
            (this.comp = this.elem.comp),
            (this.keysIndex = 0),
            (this.canResize = !1),
            (this.minimumFontSize = 1),
            (this.effectsSequence = []),
            (this.currentData = {
              ascent: 0,
              boxWidth: this.defaultBoxWidth,
              f: ``,
              fStyle: ``,
              fWeight: ``,
              fc: ``,
              j: ``,
              justifyOffset: ``,
              l: [],
              lh: 0,
              lineWidths: [],
              ls: ``,
              of: ``,
              s: ``,
              sc: ``,
              sw: 0,
              t: 0,
              tr: 0,
              sz: 0,
              ps: null,
              fillColorAnim: !1,
              strokeColorAnim: !1,
              strokeWidthAnim: !1,
              yOffset: 0,
              finalSize: 0,
              finalText: [],
              finalLineHeight: 0,
              __complete: !1,
            }),
            this.copyData(this.currentData, this.data.d.k[0].s),
            this.searchProperty() || this.completeTextData(this.currentData));
        }
        ((TextProperty.prototype.defaultBoxWidth = [0, 0]),
          (TextProperty.prototype.copyData = function (e, t) {
            for (var n in t)
              Object.prototype.hasOwnProperty.call(t, n) && (e[n] = t[n]);
            return e;
          }),
          (TextProperty.prototype.setCurrentData = function (e) {
            (e.__complete || this.completeTextData(e),
              (this.currentData = e),
              (this.currentData.boxWidth =
                this.currentData.boxWidth || this.defaultBoxWidth),
              (this._mdf = !0));
          }),
          (TextProperty.prototype.searchProperty = function () {
            return this.searchKeyframes();
          }),
          (TextProperty.prototype.searchKeyframes = function () {
            return (
              (this.kf = this.data.d.k.length > 1),
              this.kf && this.addEffect(this.getKeyframeValue.bind(this)),
              this.kf
            );
          }),
          (TextProperty.prototype.addEffect = function (e) {
            (this.effectsSequence.push(e), this.elem.addDynamicProperty(this));
          }),
          (TextProperty.prototype.getValue = function (e) {
            if (!(
              (this.elem.globalData.frameId === this.frameId ||
                !this.effectsSequence.length) &&
              !e
            )) {
              this.currentData.t = this.data.d.k[this.keysIndex].s.t;
              var t = this.currentData,
                n = this.keysIndex;
              if (this.lock) {
                this.setCurrentData(this.currentData);
                return;
              }
              ((this.lock = !0), (this._mdf = !1));
              var r,
                i = this.effectsSequence.length,
                a = e || this.data.d.k[this.keysIndex].s;
              for (r = 0; r < i; r += 1)
                a =
                  n === this.keysIndex
                    ? this.effectsSequence[r](this.currentData, a.t)
                    : this.effectsSequence[r](a, a.t);
              (t !== a && this.setCurrentData(a),
                (this.v = this.currentData),
                (this.pv = this.v),
                (this.lock = !1),
                (this.frameId = this.elem.globalData.frameId));
            }
          }),
          (TextProperty.prototype.getKeyframeValue = function () {
            for (
              var e = this.data.d.k,
                t = this.elem.comp.renderedFrame,
                n = 0,
                r = e.length;
              n <= r - 1 && !(n === r - 1 || e[n + 1].t > t);
            )
              n += 1;
            return (
              this.keysIndex !== n && (this.keysIndex = n),
              this.data.d.k[this.keysIndex].s
            );
          }),
          (TextProperty.prototype.buildFinalText = function (e) {
            for (
              var t = [], n = 0, r = e.length, i, a, o = !1, s = !1, c = ``;
              n < r;
            )
              ((o = s),
                (s = !1),
                (i = e.charCodeAt(n)),
                (c = e.charAt(n)),
                FontManager.isCombinedCharacter(i)
                  ? (o = !0)
                  : i >= 55296 && i <= 56319
                    ? FontManager.isRegionalFlag(e, n)
                      ? (c = e.substr(n, 14))
                      : ((a = e.charCodeAt(n + 1)),
                        a >= 56320 &&
                          a <= 57343 &&
                          (FontManager.isModifier(i, a)
                            ? ((c = e.substr(n, 2)), (o = !0))
                            : (c = FontManager.isFlagEmoji(e.substr(n, 4))
                                ? e.substr(n, 4)
                                : e.substr(n, 2))))
                    : i > 56319
                      ? ((a = e.charCodeAt(n + 1)),
                        FontManager.isVariationSelector(i) && (o = !0))
                      : FontManager.isZeroWidthJoiner(i) &&
                        ((o = !0), (s = !0)),
                o ? ((t[t.length - 1] += c), (o = !1)) : t.push(c),
                (n += c.length));
            return t;
          }),
          (TextProperty.prototype.completeTextData = function (e) {
            e.__complete = !0;
            var t = this.elem.globalData.fontManager,
              n = this.data,
              r = [],
              i,
              a,
              o,
              s = 0,
              c,
              l = n.m.g,
              u = 0,
              d = 0,
              f = 0,
              p = [],
              m = 0,
              g = 0,
              _,
              y,
              b = t.getFontByName(e.f),
              x,
              S = 0,
              C = getFontProperties(b);
            ((e.fWeight = C.weight),
              (e.fStyle = C.style),
              (e.finalSize = e.s),
              (e.finalText = this.buildFinalText(e.t)),
              (a = e.finalText.length),
              (e.finalLineHeight = e.lh));
            var T = (e.tr / 1e3) * e.finalSize,
              E;
            if (e.sz)
              for (var D = !0, O = e.sz[0], k = e.sz[1], A, j; D;) {
                ((j = this.buildFinalText(e.t)),
                  (A = 0),
                  (m = 0),
                  (a = j.length),
                  (T = (e.tr / 1e3) * e.finalSize));
                var M = -1;
                for (i = 0; i < a; i += 1)
                  ((E = j[i].charCodeAt(0)),
                    (o = !1),
                    j[i] === ` `
                      ? (M = i)
                      : (E === 13 || E === 3) &&
                        ((m = 0),
                        (o = !0),
                        (A += e.finalLineHeight || e.finalSize * 1.2)),
                    t.chars
                      ? ((x = t.getCharData(j[i], b.fStyle, b.fFamily)),
                        (S = o ? 0 : (x.w * e.finalSize) / 100))
                      : (S = t.measureText(j[i], e.f, e.finalSize)),
                    m + S > O && j[i] !== ` `
                      ? (M === -1 ? (a += 1) : (i = M),
                        (A += e.finalLineHeight || e.finalSize * 1.2),
                        j.splice(i, +(M === i), `\r`),
                        (M = -1),
                        (m = 0))
                      : ((m += S), (m += T)));
                ((A += (b.ascent * e.finalSize) / 100),
                  this.canResize && e.finalSize > this.minimumFontSize && k < A
                    ? (--e.finalSize,
                      (e.finalLineHeight = (e.finalSize * e.lh) / e.s))
                    : ((e.finalText = j), (a = e.finalText.length), (D = !1)));
              }
            ((m = -T), (S = 0));
            var N = 0,
              P;
            for (i = 0; i < a; i += 1)
              if (
                ((o = !1),
                (P = e.finalText[i]),
                (E = P.charCodeAt(0)),
                E === 13 || E === 3
                  ? ((N = 0),
                    p.push(m),
                    (g = m > g ? m : g),
                    (m = -2 * T),
                    (c = ``),
                    (o = !0),
                    (f += 1))
                  : (c = P),
                t.chars
                  ? ((x = t.getCharData(
                      P,
                      b.fStyle,
                      t.getFontByName(e.f).fFamily,
                    )),
                    (S = o ? 0 : (x.w * e.finalSize) / 100))
                  : (S = t.measureText(c, e.f, e.finalSize)),
                P === ` ` ? (N += S + T) : ((m += S + T + N), (N = 0)),
                r.push({
                  l: S,
                  an: S,
                  add: u,
                  n: o,
                  anIndexes: [],
                  val: c,
                  line: f,
                  animatorJustifyOffset: 0,
                }),
                l == 2)
              ) {
                if (((u += S), c === `` || c === ` ` || i === a - 1)) {
                  for ((c === `` || c === ` `) && (u -= S); d <= i;)
                    ((r[d].an = u), (r[d].ind = s), (r[d].extra = S), (d += 1));
                  ((s += 1), (u = 0));
                }
              } else if (l == 3) {
                if (((u += S), c === `` || i === a - 1)) {
                  for (c === `` && (u -= S); d <= i;)
                    ((r[d].an = u), (r[d].ind = s), (r[d].extra = S), (d += 1));
                  ((u = 0), (s += 1));
                }
              } else ((r[s].ind = s), (r[s].extra = 0), (s += 1));
            if (((e.l = r), (g = m > g ? m : g), p.push(m), e.sz))
              ((e.boxWidth = e.sz[0]), (e.justifyOffset = 0));
            else
              switch (((e.boxWidth = g), e.j)) {
                case 1:
                  e.justifyOffset = -e.boxWidth;
                  break;
                case 2:
                  e.justifyOffset = -e.boxWidth / 2;
                  break;
                default:
                  e.justifyOffset = 0;
              }
            e.lineWidths = p;
            var F = n.a,
              I,
              L;
            y = F.length;
            var R,
              z,
              B = [];
            for (_ = 0; _ < y; _ += 1) {
              for (
                I = F[_],
                  I.a.sc && (e.strokeColorAnim = !0),
                  I.a.sw && (e.strokeWidthAnim = !0),
                  (I.a.fc || I.a.fh || I.a.fs || I.a.fb) &&
                    (e.fillColorAnim = !0),
                  z = 0,
                  R = I.s.b,
                  i = 0;
                i < a;
                i += 1
              )
                ((L = r[i]),
                  (L.anIndexes[_] = z),
                  ((R == 1 && L.val !== ``) ||
                    (R == 2 && L.val !== `` && L.val !== ` `) ||
                    (R == 3 && (L.n || L.val == ` ` || i == a - 1)) ||
                    (R == 4 && (L.n || i == a - 1))) &&
                    (I.s.rn === 1 && B.push(z), (z += 1)));
              n.a[_].s.totalChars = z;
              var V = -1,
                H;
              if (I.s.rn === 1)
                for (i = 0; i < a; i += 1)
                  ((L = r[i]),
                    V != L.anIndexes[_] &&
                      ((V = L.anIndexes[_]),
                      (H = B.splice(
                        Math.floor(Math.random() * B.length),
                        1,
                      )[0])),
                    (L.anIndexes[_] = H));
            }
            ((e.yOffset = e.finalLineHeight || e.finalSize * 1.2),
              (e.ls = e.ls || 0),
              (e.ascent = (b.ascent * e.finalSize) / 100));
          }),
          (TextProperty.prototype.updateDocumentData = function (e, t) {
            t = t === void 0 ? this.keysIndex : t;
            var n = this.copyData({}, this.data.d.k[t].s);
            ((n = this.copyData(n, e)),
              (this.data.d.k[t].s = n),
              this.recalculate(t),
              this.setCurrentData(n),
              this.elem.addDynamicProperty(this));
          }),
          (TextProperty.prototype.recalculate = function (e) {
            var t = this.data.d.k[e].s;
            ((t.__complete = !1),
              (this.keysIndex = 0),
              (this._isFirstFrame = !0),
              this.getValue(t));
          }),
          (TextProperty.prototype.canResizeFont = function (e) {
            ((this.canResize = e),
              this.recalculate(this.keysIndex),
              this.elem.addDynamicProperty(this));
          }),
          (TextProperty.prototype.setMinimumFontSize = function (e) {
            ((this.minimumFontSize = Math.floor(e) || 1),
              this.recalculate(this.keysIndex),
              this.elem.addDynamicProperty(this));
          }));
        var TextSelectorProp = (function () {
          var e = Math.max,
            t = Math.min,
            n = Math.floor;
          function r(e, t) {
            ((this._currentTextLength = -1),
              (this.k = !1),
              (this.data = t),
              (this.elem = e),
              (this.comp = e.comp),
              (this.finalS = 0),
              (this.finalE = 0),
              this.initDynamicPropertyContainer(e),
              (this.s = PropertyFactory.getProp(
                e,
                t.s || { k: 0 },
                0,
                0,
                this,
              )),
              `e` in t
                ? (this.e = PropertyFactory.getProp(e, t.e, 0, 0, this))
                : (this.e = { v: 100 }),
              (this.o = PropertyFactory.getProp(
                e,
                t.o || { k: 0 },
                0,
                0,
                this,
              )),
              (this.xe = PropertyFactory.getProp(
                e,
                t.xe || { k: 0 },
                0,
                0,
                this,
              )),
              (this.ne = PropertyFactory.getProp(
                e,
                t.ne || { k: 0 },
                0,
                0,
                this,
              )),
              (this.sm = PropertyFactory.getProp(
                e,
                t.sm || { k: 100 },
                0,
                0,
                this,
              )),
              (this.a = PropertyFactory.getProp(e, t.a, 0, 0.01, this)),
              this.dynamicProperties.length || this.getValue());
          }
          ((r.prototype = {
            getMult: function (r) {
              this._currentTextLength !==
                this.elem.textProperty.currentData.l.length && this.getValue();
              var i = 0,
                a = 0,
                o = 1,
                s = 1;
              (this.ne.v > 0 ? (i = this.ne.v / 100) : (a = -this.ne.v / 100),
                this.xe.v > 0
                  ? (o = 1 - this.xe.v / 100)
                  : (s = 1 + this.xe.v / 100));
              var c = BezierFactory.getBezierEasing(i, a, o, s).get,
                l = 0,
                u = this.finalS,
                d = this.finalE,
                f = this.data.sh;
              if (f === 2)
                ((l =
                  d === u
                    ? +(r >= d)
                    : e(0, t(0.5 / (d - u) + (r - u) / (d - u), 1))),
                  (l = c(l)));
              else if (f === 3)
                ((l =
                  d === u
                    ? r >= d
                      ? 0
                      : 1
                    : 1 - e(0, t(0.5 / (d - u) + (r - u) / (d - u), 1))),
                  (l = c(l)));
              else if (f === 4)
                (d === u
                  ? (l = 0)
                  : ((l = e(0, t(0.5 / (d - u) + (r - u) / (d - u), 1))),
                    l < 0.5 ? (l *= 2) : (l = 1 - 2 * (l - 0.5))),
                  (l = c(l)));
              else if (f === 5) {
                if (d === u) l = 0;
                else {
                  var p = d - u;
                  r = t(e(0, r + 0.5 - u), d - u);
                  var m = -p / 2 + r,
                    g = p / 2;
                  l = Math.sqrt(1 - (m * m) / (g * g));
                }
                l = c(l);
              } else
                f === 6
                  ? (d === u
                      ? (l = 0)
                      : ((r = t(e(0, r + 0.5 - u), d - u)),
                        (l =
                          (1 +
                            Math.cos(Math.PI + (Math.PI * 2 * r) / (d - u))) /
                          2)),
                    (l = c(l)))
                  : (r >= n(u) &&
                      (l =
                        r - u < 0
                          ? e(0, t(t(d, 1) - (u - r), 1))
                          : e(0, t(d - r, 1))),
                    (l = c(l)));
              if (this.sm.v !== 100) {
                var _ = this.sm.v * 0.01;
                _ === 0 && (_ = 1e-8);
                var y = 0.5 - _ * 0.5;
                l < y ? (l = 0) : ((l = (l - y) / _), l > 1 && (l = 1));
              }
              return l * this.a.v;
            },
            getValue: function (e) {
              (this.iterateDynamicProperties(),
                (this._mdf = e || this._mdf),
                (this._currentTextLength =
                  this.elem.textProperty.currentData.l.length || 0),
                e && this.data.r === 2 && (this.e.v = this._currentTextLength));
              var t = this.data.r === 2 ? 1 : 100 / this.data.totalChars,
                n = this.o.v / t,
                r = this.s.v / t + n,
                i = this.e.v / t + n;
              if (r > i) {
                var a = r;
                ((r = i), (i = a));
              }
              ((this.finalS = r), (this.finalE = i));
            },
          }),
            extendPrototype([DynamicPropertyContainer], r));
          function i(e, t, n) {
            return new r(e, t, n);
          }
          return { getTextSelectorProp: i };
        })();
        function TextAnimatorDataProperty(e, t, n) {
          var r = { propType: !1 },
            i = PropertyFactory.getProp,
            a = t.a;
          ((this.a = {
            r: a.r ? i(e, a.r, 0, degToRads, n) : r,
            rx: a.rx ? i(e, a.rx, 0, degToRads, n) : r,
            ry: a.ry ? i(e, a.ry, 0, degToRads, n) : r,
            sk: a.sk ? i(e, a.sk, 0, degToRads, n) : r,
            sa: a.sa ? i(e, a.sa, 0, degToRads, n) : r,
            s: a.s ? i(e, a.s, 1, 0.01, n) : r,
            a: a.a ? i(e, a.a, 1, 0, n) : r,
            o: a.o ? i(e, a.o, 0, 0.01, n) : r,
            p: a.p ? i(e, a.p, 1, 0, n) : r,
            sw: a.sw ? i(e, a.sw, 0, 0, n) : r,
            sc: a.sc ? i(e, a.sc, 1, 0, n) : r,
            fc: a.fc ? i(e, a.fc, 1, 0, n) : r,
            fh: a.fh ? i(e, a.fh, 0, 0, n) : r,
            fs: a.fs ? i(e, a.fs, 0, 0.01, n) : r,
            fb: a.fb ? i(e, a.fb, 0, 0.01, n) : r,
            t: a.t ? i(e, a.t, 0, 0, n) : r,
          }),
            (this.s = TextSelectorProp.getTextSelectorProp(e, t.s, n)),
            (this.s.t = t.s.t));
        }
        function TextAnimatorProperty(e, t, n) {
          ((this._isFirstFrame = !0),
            (this._hasMaskedPath = !1),
            (this._frameId = -1),
            (this._textData = e),
            (this._renderType = t),
            (this._elem = n),
            (this._animatorsData = createSizedArray(this._textData.a.length)),
            (this._pathData = {}),
            (this._moreOptions = { alignment: {} }),
            (this.renderedLetters = []),
            (this.lettersChangedFlag = !1),
            this.initDynamicPropertyContainer(n));
        }
        ((TextAnimatorProperty.prototype.searchProperties = function () {
          var e,
            t = this._textData.a.length,
            n,
            r = PropertyFactory.getProp;
          for (e = 0; e < t; e += 1)
            ((n = this._textData.a[e]),
              (this._animatorsData[e] = new TextAnimatorDataProperty(
                this._elem,
                n,
                this,
              )));
          (this._textData.p && `m` in this._textData.p
            ? ((this._pathData = {
                a: r(this._elem, this._textData.p.a, 0, 0, this),
                f: r(this._elem, this._textData.p.f, 0, 0, this),
                l: r(this._elem, this._textData.p.l, 0, 0, this),
                r: r(this._elem, this._textData.p.r, 0, 0, this),
                p: r(this._elem, this._textData.p.p, 0, 0, this),
                m: this._elem.maskManager.getMaskProperty(this._textData.p.m),
              }),
              (this._hasMaskedPath = !0))
            : (this._hasMaskedPath = !1),
            (this._moreOptions.alignment = r(
              this._elem,
              this._textData.m.a,
              1,
              0,
              this,
            )));
        }),
          (TextAnimatorProperty.prototype.getMeasures = function (e, t) {
            if (
              ((this.lettersChangedFlag = t),
              !(
                !this._mdf &&
                !this._isFirstFrame &&
                !t &&
                (!this._hasMaskedPath || !this._pathData.m._mdf)
              ))
            ) {
              this._isFirstFrame = !1;
              var n = this._moreOptions.alignment.v,
                r = this._animatorsData,
                i = this._textData,
                a = this.mHelper,
                o = this._renderType,
                s = this.renderedLetters.length,
                c,
                l,
                u,
                d,
                f = e.l,
                p,
                m,
                g,
                _,
                y,
                b,
                x,
                S,
                C,
                T,
                E,
                D,
                O,
                k,
                A;
              if (this._hasMaskedPath) {
                if (
                  ((A = this._pathData.m),
                  !this._pathData.n || this._pathData._mdf)
                ) {
                  var j = A.v;
                  (this._pathData.r.v && (j = j.reverse()),
                    (p = { tLength: 0, segments: [] }),
                    (d = j._length - 1));
                  var M;
                  for (D = 0, u = 0; u < d; u += 1)
                    ((M = bez.buildBezierData(
                      j.v[u],
                      j.v[u + 1],
                      [j.o[u][0] - j.v[u][0], j.o[u][1] - j.v[u][1]],
                      [
                        j.i[u + 1][0] - j.v[u + 1][0],
                        j.i[u + 1][1] - j.v[u + 1][1],
                      ],
                    )),
                      (p.tLength += M.segmentLength),
                      p.segments.push(M),
                      (D += M.segmentLength));
                  ((u = d),
                    A.v.c &&
                      ((M = bez.buildBezierData(
                        j.v[u],
                        j.v[0],
                        [j.o[u][0] - j.v[u][0], j.o[u][1] - j.v[u][1]],
                        [j.i[0][0] - j.v[0][0], j.i[0][1] - j.v[0][1]],
                      )),
                      (p.tLength += M.segmentLength),
                      p.segments.push(M),
                      (D += M.segmentLength)),
                    (this._pathData.pi = p));
                }
                if (
                  ((p = this._pathData.pi),
                  (m = this._pathData.f.v),
                  (x = 0),
                  (b = 1),
                  (_ = 0),
                  (y = !0),
                  (T = p.segments),
                  m < 0 && A.v.c)
                )
                  for (
                    p.tLength < Math.abs(m) && (m = -Math.abs(m) % p.tLength),
                      x = T.length - 1,
                      C = T[x].points,
                      b = C.length - 1;
                    m < 0;
                  )
                    ((m += C[b].partialLength),
                      --b,
                      b < 0 && (--x, (C = T[x].points), (b = C.length - 1)));
                ((C = T[x].points),
                  (S = C[b - 1]),
                  (g = C[b]),
                  (E = g.partialLength));
              }
              ((d = f.length), (c = 0), (l = 0));
              var N = e.finalSize * 1.2 * 0.714,
                P = !0,
                F,
                I,
                L,
                R = r.length,
                z,
                B,
                V = -1,
                H,
                U,
                W,
                ee = m,
                te = x,
                ne = b,
                re = -1,
                G,
                K,
                q,
                J,
                Y,
                X,
                ie,
                Z,
                Q = ``,
                ae = this.defaultPropsArray,
                oe;
              if (e.j === 2 || e.j === 1) {
                var $ = 0,
                  se = 0,
                  ce = e.j === 2 ? -0.5 : -1,
                  le = 0,
                  ue = !0;
                for (u = 0; u < d; u += 1)
                  if (f[u].n) {
                    for ($ && ($ += se); le < u;)
                      ((f[le].animatorJustifyOffset = $), (le += 1));
                    (($ = 0), (ue = !0));
                  } else {
                    for (L = 0; L < R; L += 1)
                      ((F = r[L].a),
                        F.t.propType &&
                          (ue && e.j === 2 && (se += F.t.v * ce),
                          (I = r[L].s),
                          (B = I.getMult(
                            f[u].anIndexes[L],
                            i.a[L].s.totalChars,
                          )),
                          B.length
                            ? ($ += F.t.v * B[0] * ce)
                            : ($ += F.t.v * B * ce)));
                    ue = !1;
                  }
                for ($ && ($ += se); le < u;)
                  ((f[le].animatorJustifyOffset = $), (le += 1));
              }
              for (u = 0; u < d; u += 1) {
                if ((a.reset(), (G = 1), f[u].n))
                  ((c = 0),
                    (l += e.yOffset),
                    (l += +!!P),
                    (m = ee),
                    (P = !1),
                    this._hasMaskedPath &&
                      ((x = te),
                      (b = ne),
                      (C = T[x].points),
                      (S = C[b - 1]),
                      (g = C[b]),
                      (E = g.partialLength),
                      (_ = 0)),
                    (Q = ``),
                    (Z = ``),
                    (X = ``),
                    (oe = ``),
                    (ae = this.defaultPropsArray));
                else {
                  if (this._hasMaskedPath) {
                    if (re !== f[u].line) {
                      switch (e.j) {
                        case 1:
                          m += D - e.lineWidths[f[u].line];
                          break;
                        case 2:
                          m += (D - e.lineWidths[f[u].line]) / 2;
                          break;
                        default:
                          break;
                      }
                      re = f[u].line;
                    }
                    (V !== f[u].ind &&
                      (f[V] && (m += f[V].extra),
                      (m += f[u].an / 2),
                      (V = f[u].ind)),
                      (m += n[0] * f[u].an * 0.005));
                    var de = 0;
                    for (L = 0; L < R; L += 1)
                      ((F = r[L].a),
                        F.p.propType &&
                          ((I = r[L].s),
                          (B = I.getMult(
                            f[u].anIndexes[L],
                            i.a[L].s.totalChars,
                          )),
                          B.length
                            ? (de += F.p.v[0] * B[0])
                            : (de += F.p.v[0] * B)),
                        F.a.propType &&
                          ((I = r[L].s),
                          (B = I.getMult(
                            f[u].anIndexes[L],
                            i.a[L].s.totalChars,
                          )),
                          B.length
                            ? (de += F.a.v[0] * B[0])
                            : (de += F.a.v[0] * B)));
                    for (
                      y = !0,
                        this._pathData.a.v &&
                          ((m =
                            f[0].an * 0.5 +
                            ((D -
                              this._pathData.f.v -
                              f[0].an * 0.5 -
                              f[f.length - 1].an * 0.5) *
                              V) /
                              (d - 1)),
                          (m += this._pathData.f.v));
                      y;
                    )
                      _ + E >= m + de || !C
                        ? ((O = (m + de - _) / g.partialLength),
                          (U = S.point[0] + (g.point[0] - S.point[0]) * O),
                          (W = S.point[1] + (g.point[1] - S.point[1]) * O),
                          a.translate(
                            -n[0] * f[u].an * 0.005,
                            -(n[1] * N) * 0.01,
                          ),
                          (y = !1))
                        : C &&
                          ((_ += g.partialLength),
                          (b += 1),
                          b >= C.length &&
                            ((b = 0),
                            (x += 1),
                            T[x]
                              ? (C = T[x].points)
                              : A.v.c
                                ? ((b = 0), (x = 0), (C = T[x].points))
                                : ((_ -= g.partialLength), (C = null))),
                          C && ((S = g), (g = C[b]), (E = g.partialLength)));
                    ((H = f[u].an / 2 - f[u].add), a.translate(-H, 0, 0));
                  } else
                    ((H = f[u].an / 2 - f[u].add),
                      a.translate(-H, 0, 0),
                      a.translate(
                        -n[0] * f[u].an * 0.005,
                        -n[1] * N * 0.01,
                        0,
                      ));
                  for (L = 0; L < R; L += 1)
                    ((F = r[L].a),
                      F.t.propType &&
                        ((I = r[L].s),
                        (B = I.getMult(f[u].anIndexes[L], i.a[L].s.totalChars)),
                        (c !== 0 || e.j !== 0) &&
                          (this._hasMaskedPath
                            ? B.length
                              ? (m += F.t.v * B[0])
                              : (m += F.t.v * B)
                            : B.length
                              ? (c += F.t.v * B[0])
                              : (c += F.t.v * B))));
                  for (
                    e.strokeWidthAnim && (q = e.sw || 0),
                      e.strokeColorAnim &&
                        (K = e.sc ? [e.sc[0], e.sc[1], e.sc[2]] : [0, 0, 0]),
                      e.fillColorAnim &&
                        e.fc &&
                        (J = [e.fc[0], e.fc[1], e.fc[2]]),
                      L = 0;
                    L < R;
                    L += 1
                  )
                    ((F = r[L].a),
                      F.a.propType &&
                        ((I = r[L].s),
                        (B = I.getMult(f[u].anIndexes[L], i.a[L].s.totalChars)),
                        B.length
                          ? a.translate(
                              -F.a.v[0] * B[0],
                              -F.a.v[1] * B[1],
                              F.a.v[2] * B[2],
                            )
                          : a.translate(
                              -F.a.v[0] * B,
                              -F.a.v[1] * B,
                              F.a.v[2] * B,
                            )));
                  for (L = 0; L < R; L += 1)
                    ((F = r[L].a),
                      F.s.propType &&
                        ((I = r[L].s),
                        (B = I.getMult(f[u].anIndexes[L], i.a[L].s.totalChars)),
                        B.length
                          ? a.scale(
                              1 + (F.s.v[0] - 1) * B[0],
                              1 + (F.s.v[1] - 1) * B[1],
                              1,
                            )
                          : a.scale(
                              1 + (F.s.v[0] - 1) * B,
                              1 + (F.s.v[1] - 1) * B,
                              1,
                            )));
                  for (L = 0; L < R; L += 1) {
                    if (
                      ((F = r[L].a),
                      (I = r[L].s),
                      (B = I.getMult(f[u].anIndexes[L], i.a[L].s.totalChars)),
                      F.sk.propType &&
                        (B.length
                          ? a.skewFromAxis(-F.sk.v * B[0], F.sa.v * B[1])
                          : a.skewFromAxis(-F.sk.v * B, F.sa.v * B)),
                      F.r.propType &&
                        (B.length
                          ? a.rotateZ(-F.r.v * B[2])
                          : a.rotateZ(-F.r.v * B)),
                      F.ry.propType &&
                        (B.length
                          ? a.rotateY(F.ry.v * B[1])
                          : a.rotateY(F.ry.v * B)),
                      F.rx.propType &&
                        (B.length
                          ? a.rotateX(F.rx.v * B[0])
                          : a.rotateX(F.rx.v * B)),
                      F.o.propType &&
                        (B.length
                          ? (G += (F.o.v * B[0] - G) * B[0])
                          : (G += (F.o.v * B - G) * B)),
                      e.strokeWidthAnim &&
                        F.sw.propType &&
                        (B.length ? (q += F.sw.v * B[0]) : (q += F.sw.v * B)),
                      e.strokeColorAnim && F.sc.propType)
                    )
                      for (Y = 0; Y < 3; Y += 1)
                        B.length
                          ? (K[Y] += (F.sc.v[Y] - K[Y]) * B[0])
                          : (K[Y] += (F.sc.v[Y] - K[Y]) * B);
                    if (e.fillColorAnim && e.fc) {
                      if (F.fc.propType)
                        for (Y = 0; Y < 3; Y += 1)
                          B.length
                            ? (J[Y] += (F.fc.v[Y] - J[Y]) * B[0])
                            : (J[Y] += (F.fc.v[Y] - J[Y]) * B);
                      (F.fh.propType &&
                        (J = B.length
                          ? addHueToRGB(J, F.fh.v * B[0])
                          : addHueToRGB(J, F.fh.v * B)),
                        F.fs.propType &&
                          (J = B.length
                            ? addSaturationToRGB(J, F.fs.v * B[0])
                            : addSaturationToRGB(J, F.fs.v * B)),
                        F.fb.propType &&
                          (J = B.length
                            ? addBrightnessToRGB(J, F.fb.v * B[0])
                            : addBrightnessToRGB(J, F.fb.v * B)));
                    }
                  }
                  for (L = 0; L < R; L += 1)
                    ((F = r[L].a),
                      F.p.propType &&
                        ((I = r[L].s),
                        (B = I.getMult(f[u].anIndexes[L], i.a[L].s.totalChars)),
                        this._hasMaskedPath
                          ? B.length
                            ? a.translate(0, F.p.v[1] * B[0], -F.p.v[2] * B[1])
                            : a.translate(0, F.p.v[1] * B, -F.p.v[2] * B)
                          : B.length
                            ? a.translate(
                                F.p.v[0] * B[0],
                                F.p.v[1] * B[1],
                                -F.p.v[2] * B[2],
                              )
                            : a.translate(
                                F.p.v[0] * B,
                                F.p.v[1] * B,
                                -F.p.v[2] * B,
                              )));
                  if (
                    (e.strokeWidthAnim && (X = q < 0 ? 0 : q),
                    e.strokeColorAnim &&
                      (ie =
                        `rgb(` +
                        Math.round(K[0] * 255) +
                        `,` +
                        Math.round(K[1] * 255) +
                        `,` +
                        Math.round(K[2] * 255) +
                        `)`),
                    e.fillColorAnim &&
                      e.fc &&
                      (Z =
                        `rgb(` +
                        Math.round(J[0] * 255) +
                        `,` +
                        Math.round(J[1] * 255) +
                        `,` +
                        Math.round(J[2] * 255) +
                        `)`),
                    this._hasMaskedPath)
                  ) {
                    if (
                      (a.translate(0, -e.ls),
                      a.translate(0, n[1] * N * 0.01 + l, 0),
                      this._pathData.p.v)
                    ) {
                      k = (g.point[1] - S.point[1]) / (g.point[0] - S.point[0]);
                      var fe = (Math.atan(k) * 180) / Math.PI;
                      (g.point[0] < S.point[0] && (fe += 180),
                        a.rotate((-fe * Math.PI) / 180));
                    }
                    (a.translate(U, W, 0),
                      (m -= n[0] * f[u].an * 0.005),
                      f[u + 1] &&
                        V !== f[u + 1].ind &&
                        ((m += f[u].an / 2),
                        (m += e.tr * 0.001 * e.finalSize)));
                  } else {
                    switch (
                      (a.translate(c, l, 0),
                      e.ps && a.translate(e.ps[0], e.ps[1] + e.ascent, 0),
                      e.j)
                    ) {
                      case 1:
                        a.translate(
                          f[u].animatorJustifyOffset +
                            e.justifyOffset +
                            (e.boxWidth - e.lineWidths[f[u].line]),
                          0,
                          0,
                        );
                        break;
                      case 2:
                        a.translate(
                          f[u].animatorJustifyOffset +
                            e.justifyOffset +
                            (e.boxWidth - e.lineWidths[f[u].line]) / 2,
                          0,
                          0,
                        );
                        break;
                      default:
                        break;
                    }
                    (a.translate(0, -e.ls),
                      a.translate(H, 0, 0),
                      a.translate(n[0] * f[u].an * 0.005, n[1] * N * 0.01, 0),
                      (c += f[u].l + e.tr * 0.001 * e.finalSize));
                  }
                  (o === `html`
                    ? (Q = a.toCSS())
                    : o === `svg`
                      ? (Q = a.to2dCSS())
                      : (ae = [
                          a.props[0],
                          a.props[1],
                          a.props[2],
                          a.props[3],
                          a.props[4],
                          a.props[5],
                          a.props[6],
                          a.props[7],
                          a.props[8],
                          a.props[9],
                          a.props[10],
                          a.props[11],
                          a.props[12],
                          a.props[13],
                          a.props[14],
                          a.props[15],
                        ]),
                    (oe = G));
                }
                s <= u
                  ? ((z = new LetterProps(oe, X, ie, Z, Q, ae)),
                    this.renderedLetters.push(z),
                    (s += 1),
                    (this.lettersChangedFlag = !0))
                  : ((z = this.renderedLetters[u]),
                    (this.lettersChangedFlag =
                      z.update(oe, X, ie, Z, Q, ae) ||
                      this.lettersChangedFlag));
              }
            }
          }),
          (TextAnimatorProperty.prototype.getValue = function () {
            this._elem.globalData.frameId !== this._frameId &&
              ((this._frameId = this._elem.globalData.frameId),
              this.iterateDynamicProperties());
          }),
          (TextAnimatorProperty.prototype.mHelper = new Matrix()),
          (TextAnimatorProperty.prototype.defaultPropsArray = []),
          extendPrototype([DynamicPropertyContainer], TextAnimatorProperty));
        function ITextElement() {}
        ((ITextElement.prototype.initElement = function (e, t, n) {
          ((this.lettersChangedFlag = !0),
            this.initFrame(),
            this.initBaseData(e, t, n),
            (this.textProperty = new TextProperty(
              this,
              e.t,
              this.dynamicProperties,
            )),
            (this.textAnimator = new TextAnimatorProperty(
              e.t,
              this.renderType,
              this,
            )),
            this.initTransform(e, t, n),
            this.initHierarchy(),
            this.initRenderable(),
            this.initRendererElement(),
            this.createContainerElements(),
            this.createRenderableComponents(),
            this.createContent(),
            this.hide(),
            this.textAnimator.searchProperties(this.dynamicProperties));
        }),
          (ITextElement.prototype.prepareFrame = function (e) {
            ((this._mdf = !1),
              this.prepareRenderableFrame(e),
              this.prepareProperties(e, this.isInRange));
          }),
          (ITextElement.prototype.createPathShape = function (e, t) {
            var n,
              r = t.length,
              i,
              a = ``;
            for (n = 0; n < r; n += 1)
              t[n].ty === `sh` &&
                ((i = t[n].ks.k),
                (a += buildShapeString(i, i.i.length, !0, e)));
            return a;
          }),
          (ITextElement.prototype.updateDocumentData = function (e, t) {
            this.textProperty.updateDocumentData(e, t);
          }),
          (ITextElement.prototype.canResizeFont = function (e) {
            this.textProperty.canResizeFont(e);
          }),
          (ITextElement.prototype.setMinimumFontSize = function (e) {
            this.textProperty.setMinimumFontSize(e);
          }),
          (ITextElement.prototype.applyTextPropertiesToMatrix = function (
            e,
            t,
            n,
            r,
            i,
          ) {
            switch (
              (e.ps && t.translate(e.ps[0], e.ps[1] + e.ascent, 0),
              t.translate(0, -e.ls, 0),
              e.j)
            ) {
              case 1:
                t.translate(
                  e.justifyOffset + (e.boxWidth - e.lineWidths[n]),
                  0,
                  0,
                );
                break;
              case 2:
                t.translate(
                  e.justifyOffset + (e.boxWidth - e.lineWidths[n]) / 2,
                  0,
                  0,
                );
                break;
              default:
                break;
            }
            t.translate(r, i, 0);
          }),
          (ITextElement.prototype.buildColor = function (e) {
            return (
              `rgb(` +
              Math.round(e[0] * 255) +
              `,` +
              Math.round(e[1] * 255) +
              `,` +
              Math.round(e[2] * 255) +
              `)`
            );
          }),
          (ITextElement.prototype.emptyProp = new LetterProps()),
          (ITextElement.prototype.destroy = function () {}),
          (ITextElement.prototype.validateText = function () {
            (this.textProperty._mdf || this.textProperty._isFirstFrame) &&
              (this.buildNewText(),
              (this.textProperty._isFirstFrame = !1),
              (this.textProperty._mdf = !1));
          }));
        var emptyShapeData = { shapes: [] };
        function SVGTextLottieElement(e, t, n) {
          ((this.textSpans = []),
            (this.renderType = `svg`),
            this.initElement(e, t, n));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            SVGBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableDOMElement,
            ITextElement,
          ],
          SVGTextLottieElement,
        ),
          (SVGTextLottieElement.prototype.createContent = function () {
            this.data.singleShape &&
              !this.globalData.fontManager.chars &&
              (this.textContainer = createNS(`text`));
          }),
          (SVGTextLottieElement.prototype.buildTextContents = function (e) {
            for (var t = 0, n = e.length, r = [], i = ``; t < n;)
              (e[t] === `\r` || e[t] === ``
                ? (r.push(i), (i = ``))
                : (i += e[t]),
                (t += 1));
            return (r.push(i), r);
          }),
          (SVGTextLottieElement.prototype.buildShapeData = function (e, t) {
            if (e.shapes && e.shapes.length) {
              var n = e.shapes[0];
              if (n.it) {
                var r = n.it[n.it.length - 1];
                r.s && ((r.s.k[0] = t), (r.s.k[1] = t));
              }
            }
            return e;
          }),
          (SVGTextLottieElement.prototype.buildNewText = function () {
            this.addDynamicProperty(this);
            var e,
              t,
              n = this.textProperty.currentData;
            ((this.renderedLetters = createSizedArray(n ? n.l.length : 0)),
              n.fc
                ? this.layerElement.setAttribute(`fill`, this.buildColor(n.fc))
                : this.layerElement.setAttribute(`fill`, `rgba(0,0,0,0)`),
              n.sc &&
                (this.layerElement.setAttribute(
                  `stroke`,
                  this.buildColor(n.sc),
                ),
                this.layerElement.setAttribute(`stroke-width`, n.sw)),
              this.layerElement.setAttribute(`font-size`, n.finalSize));
            var r = this.globalData.fontManager.getFontByName(n.f);
            if (r.fClass) this.layerElement.setAttribute(`class`, r.fClass);
            else {
              this.layerElement.setAttribute(`font-family`, r.fFamily);
              var i = n.fWeight,
                a = n.fStyle;
              (this.layerElement.setAttribute(`font-style`, a),
                this.layerElement.setAttribute(`font-weight`, i));
            }
            this.layerElement.setAttribute(`aria-label`, n.t);
            var o = n.l || [],
              s = !!this.globalData.fontManager.chars;
            t = o.length;
            var c,
              l = this.mHelper,
              u = ``,
              d = this.data.singleShape,
              f = 0,
              p = 0,
              m = !0,
              g = n.tr * 0.001 * n.finalSize;
            if (d && !s && !n.sz) {
              var _ = this.textContainer,
                y = `start`;
              switch (n.j) {
                case 1:
                  y = `end`;
                  break;
                case 2:
                  y = `middle`;
                  break;
                default:
                  y = `start`;
                  break;
              }
              (_.setAttribute(`text-anchor`, y),
                _.setAttribute(`letter-spacing`, g));
              var b = this.buildTextContents(n.finalText);
              for (
                t = b.length, p = n.ps ? n.ps[1] + n.ascent : 0, e = 0;
                e < t;
                e += 1
              )
                ((c = this.textSpans[e].span || createNS(`tspan`)),
                  (c.textContent = b[e]),
                  c.setAttribute(`x`, 0),
                  c.setAttribute(`y`, p),
                  (c.style.display = `inherit`),
                  _.appendChild(c),
                  this.textSpans[e] ||
                    (this.textSpans[e] = { span: null, glyph: null }),
                  (this.textSpans[e].span = c),
                  (p += n.finalLineHeight));
              this.layerElement.appendChild(_);
            } else {
              var x = this.textSpans.length,
                S;
              for (e = 0; e < t; e += 1) {
                if (
                  (this.textSpans[e] ||
                    (this.textSpans[e] = {
                      span: null,
                      childSpan: null,
                      glyph: null,
                    }),
                  !s || !d || e === 0)
                ) {
                  if (
                    ((c =
                      x > e
                        ? this.textSpans[e].span
                        : createNS(s ? `g` : `text`)),
                    x <= e)
                  ) {
                    if (
                      (c.setAttribute(`stroke-linecap`, `butt`),
                      c.setAttribute(`stroke-linejoin`, `round`),
                      c.setAttribute(`stroke-miterlimit`, `4`),
                      (this.textSpans[e].span = c),
                      s)
                    ) {
                      var C = createNS(`g`);
                      (c.appendChild(C), (this.textSpans[e].childSpan = C));
                    }
                    ((this.textSpans[e].span = c),
                      this.layerElement.appendChild(c));
                  }
                  c.style.display = `inherit`;
                }
                if (
                  (l.reset(),
                  d &&
                    (o[e].n &&
                      ((f = -g), (p += n.yOffset), (p += +!!m), (m = !1)),
                    this.applyTextPropertiesToMatrix(n, l, o[e].line, f, p),
                    (f += o[e].l || 0),
                    (f += g)),
                  s)
                ) {
                  S = this.globalData.fontManager.getCharData(
                    n.finalText[e],
                    r.fStyle,
                    this.globalData.fontManager.getFontByName(n.f).fFamily,
                  );
                  var T;
                  if (S.t === 1)
                    T = new SVGCompElement(S.data, this.globalData, this);
                  else {
                    var E = emptyShapeData;
                    (S.data &&
                      S.data.shapes &&
                      (E = this.buildShapeData(S.data, n.finalSize)),
                      (T = new SVGShapeElement(E, this.globalData, this)));
                  }
                  if (this.textSpans[e].glyph) {
                    var D = this.textSpans[e].glyph;
                    (this.textSpans[e].childSpan.removeChild(D.layerElement),
                      D.destroy());
                  }
                  ((this.textSpans[e].glyph = T),
                    (T._debug = !0),
                    T.prepareFrame(0),
                    T.renderFrame(),
                    this.textSpans[e].childSpan.appendChild(T.layerElement),
                    S.t === 1 &&
                      this.textSpans[e].childSpan.setAttribute(
                        `transform`,
                        `scale(` +
                          n.finalSize / 100 +
                          `,` +
                          n.finalSize / 100 +
                          `)`,
                      ));
                } else
                  (d &&
                    c.setAttribute(
                      `transform`,
                      `translate(` + l.props[12] + `,` + l.props[13] + `)`,
                    ),
                    (c.textContent = o[e].val),
                    c.setAttributeNS(
                      `http://www.w3.org/XML/1998/namespace`,
                      `xml:space`,
                      `preserve`,
                    ));
              }
              d && c && c.setAttribute(`d`, u);
            }
            for (; e < this.textSpans.length;)
              ((this.textSpans[e].span.style.display = `none`), (e += 1));
            this._sizeChanged = !0;
          }),
          (SVGTextLottieElement.prototype.sourceRectAtTime = function () {
            if (
              (this.prepareFrame(this.comp.renderedFrame - this.data.st),
              this.renderInnerContent(),
              this._sizeChanged)
            ) {
              this._sizeChanged = !1;
              var e = this.layerElement.getBBox();
              this.bbox = {
                top: e.y,
                left: e.x,
                width: e.width,
                height: e.height,
              };
            }
            return this.bbox;
          }),
          (SVGTextLottieElement.prototype.getValue = function () {
            var e,
              t = this.textSpans.length,
              n;
            for (
              this.renderedFrame = this.comp.renderedFrame, e = 0;
              e < t;
              e += 1
            )
              ((n = this.textSpans[e].glyph),
                n &&
                  (n.prepareFrame(this.comp.renderedFrame - this.data.st),
                  n._mdf && (this._mdf = !0)));
          }),
          (SVGTextLottieElement.prototype.renderInnerContent = function () {
            if (
              (this.validateText(),
              (!this.data.singleShape || this._mdf) &&
                (this.textAnimator.getMeasures(
                  this.textProperty.currentData,
                  this.lettersChangedFlag,
                ),
                this.lettersChangedFlag ||
                  this.textAnimator.lettersChangedFlag))
            ) {
              this._sizeChanged = !0;
              var e,
                t,
                n = this.textAnimator.renderedLetters,
                r = this.textProperty.currentData.l;
              t = r.length;
              var i, a, o;
              for (e = 0; e < t; e += 1)
                r[e].n ||
                  ((i = n[e]),
                  (a = this.textSpans[e].span),
                  (o = this.textSpans[e].glyph),
                  o && o.renderFrame(),
                  i._mdf.m && a.setAttribute(`transform`, i.m),
                  i._mdf.o && a.setAttribute(`opacity`, i.o),
                  i._mdf.sw && a.setAttribute(`stroke-width`, i.sw),
                  i._mdf.sc && a.setAttribute(`stroke`, i.sc),
                  i._mdf.fc && a.setAttribute(`fill`, i.fc));
            }
          }));
        function ISolidElement(e, t, n) {
          this.initElement(e, t, n);
        }
        (extendPrototype([IImageElement], ISolidElement),
          (ISolidElement.prototype.createContent = function () {
            var e = createNS(`rect`);
            (e.setAttribute(`width`, this.data.sw),
              e.setAttribute(`height`, this.data.sh),
              e.setAttribute(`fill`, this.data.sc),
              this.layerElement.appendChild(e));
          }));
        function NullElement(e, t, n) {
          (this.initFrame(),
            this.initBaseData(e, t, n),
            this.initFrame(),
            this.initTransform(e, t, n),
            this.initHierarchy());
        }
        ((NullElement.prototype.prepareFrame = function (e) {
          this.prepareProperties(e, !0);
        }),
          (NullElement.prototype.renderFrame = function () {}),
          (NullElement.prototype.getBaseElement = function () {
            return null;
          }),
          (NullElement.prototype.destroy = function () {}),
          (NullElement.prototype.sourceRectAtTime = function () {}),
          (NullElement.prototype.hide = function () {}),
          extendPrototype(
            [BaseElement, TransformElement, HierarchyElement, FrameElement],
            NullElement,
          ));
        function SVGRendererBase() {}
        (extendPrototype([BaseRenderer], SVGRendererBase),
          (SVGRendererBase.prototype.createNull = function (e) {
            return new NullElement(e, this.globalData, this);
          }),
          (SVGRendererBase.prototype.createShape = function (e) {
            return new SVGShapeElement(e, this.globalData, this);
          }),
          (SVGRendererBase.prototype.createText = function (e) {
            return new SVGTextLottieElement(e, this.globalData, this);
          }),
          (SVGRendererBase.prototype.createImage = function (e) {
            return new IImageElement(e, this.globalData, this);
          }),
          (SVGRendererBase.prototype.createSolid = function (e) {
            return new ISolidElement(e, this.globalData, this);
          }),
          (SVGRendererBase.prototype.configAnimation = function (e) {
            (this.svgElement.setAttribute(
              `xmlns`,
              `http://www.w3.org/2000/svg`,
            ),
              this.svgElement.setAttribute(
                `xmlns:xlink`,
                `http://www.w3.org/1999/xlink`,
              ),
              this.renderConfig.viewBoxSize
                ? this.svgElement.setAttribute(
                    `viewBox`,
                    this.renderConfig.viewBoxSize,
                  )
                : this.svgElement.setAttribute(
                    `viewBox`,
                    `0 0 ` + e.w + ` ` + e.h,
                  ),
              this.renderConfig.viewBoxOnly ||
                (this.svgElement.setAttribute(`width`, e.w),
                this.svgElement.setAttribute(`height`, e.h),
                (this.svgElement.style.width = `100%`),
                (this.svgElement.style.height = `100%`),
                (this.svgElement.style.transform = `translate3d(0,0,0)`),
                (this.svgElement.style.contentVisibility =
                  this.renderConfig.contentVisibility)),
              this.renderConfig.width &&
                this.svgElement.setAttribute(`width`, this.renderConfig.width),
              this.renderConfig.height &&
                this.svgElement.setAttribute(
                  `height`,
                  this.renderConfig.height,
                ),
              this.renderConfig.className &&
                this.svgElement.setAttribute(
                  `class`,
                  this.renderConfig.className,
                ),
              this.renderConfig.id &&
                this.svgElement.setAttribute(`id`, this.renderConfig.id),
              this.renderConfig.focusable !== void 0 &&
                this.svgElement.setAttribute(
                  `focusable`,
                  this.renderConfig.focusable,
                ),
              this.svgElement.setAttribute(
                `preserveAspectRatio`,
                this.renderConfig.preserveAspectRatio,
              ),
              this.animationItem.wrapper.appendChild(this.svgElement));
            var t = this.globalData.defs;
            (this.setupGlobalData(e, t),
              (this.globalData.progressiveLoad =
                this.renderConfig.progressiveLoad),
              (this.data = e));
            var n = createNS(`clipPath`),
              r = createNS(`rect`);
            (r.setAttribute(`width`, e.w),
              r.setAttribute(`height`, e.h),
              r.setAttribute(`x`, 0),
              r.setAttribute(`y`, 0));
            var i = createElementID();
            (n.setAttribute(`id`, i),
              n.appendChild(r),
              this.layerElement.setAttribute(
                `clip-path`,
                `url(` + getLocationHref() + `#` + i + `)`,
              ),
              t.appendChild(n),
              (this.layers = e.layers),
              (this.elements = createSizedArray(e.layers.length)));
          }),
          (SVGRendererBase.prototype.destroy = function () {
            (this.animationItem.wrapper &&
              (this.animationItem.wrapper.innerText = ``),
              (this.layerElement = null),
              (this.globalData.defs = null));
            var e,
              t = this.layers ? this.layers.length : 0;
            for (e = 0; e < t; e += 1)
              this.elements[e] &&
                this.elements[e].destroy &&
                this.elements[e].destroy();
            ((this.elements.length = 0),
              (this.destroyed = !0),
              (this.animationItem = null));
          }),
          (SVGRendererBase.prototype.updateContainerSize = function () {}),
          (SVGRendererBase.prototype.findIndexByInd = function (e) {
            var t = 0,
              n = this.layers.length;
            for (t = 0; t < n; t += 1) if (this.layers[t].ind === e) return t;
            return -1;
          }),
          (SVGRendererBase.prototype.buildItem = function (e) {
            var t = this.elements;
            if (!(t[e] || this.layers[e].ty === 99)) {
              t[e] = !0;
              var n = this.createItem(this.layers[e]);
              if (
                ((t[e] = n),
                getExpressionsPlugin() &&
                  (this.layers[e].ty === 0 &&
                    this.globalData.projectInterface.registerComposition(n),
                  n.initExpressions()),
                this.appendElementInPos(n, e),
                this.layers[e].tt)
              ) {
                var r =
                  `tp` in this.layers[e]
                    ? this.findIndexByInd(this.layers[e].tp)
                    : e - 1;
                if (r === -1) return;
                if (!this.elements[r] || this.elements[r] === !0)
                  (this.buildItem(r), this.addPendingElement(n));
                else {
                  var i = t[r].getMatte(this.layers[e].tt);
                  n.setMatte(i);
                }
              }
            }
          }),
          (SVGRendererBase.prototype.checkPendingElements = function () {
            for (; this.pendingElements.length;) {
              var e = this.pendingElements.pop();
              if ((e.checkParenting(), e.data.tt))
                for (var t = 0, n = this.elements.length; t < n;) {
                  if (this.elements[t] === e) {
                    var r =
                        `tp` in e.data ? this.findIndexByInd(e.data.tp) : t - 1,
                      i = this.elements[r].getMatte(this.layers[t].tt);
                    e.setMatte(i);
                    break;
                  }
                  t += 1;
                }
            }
          }),
          (SVGRendererBase.prototype.renderFrame = function (e) {
            if (!(this.renderedFrame === e || this.destroyed)) {
              (e === null ? (e = this.renderedFrame) : (this.renderedFrame = e),
                (this.globalData.frameNum = e),
                (this.globalData.frameId += 1),
                (this.globalData.projectInterface.currentFrame = e),
                (this.globalData._mdf = !1));
              var t,
                n = this.layers.length;
              for (
                this.completeLayers || this.checkLayers(e), t = n - 1;
                t >= 0;
                --t
              )
                (this.completeLayers || this.elements[t]) &&
                  this.elements[t].prepareFrame(e - this.layers[t].st);
              if (this.globalData._mdf)
                for (t = 0; t < n; t += 1)
                  (this.completeLayers || this.elements[t]) &&
                    this.elements[t].renderFrame();
            }
          }),
          (SVGRendererBase.prototype.appendElementInPos = function (e, t) {
            var n = e.getBaseElement();
            if (n) {
              for (var r = 0, i; r < t;)
                (this.elements[r] &&
                  this.elements[r] !== !0 &&
                  this.elements[r].getBaseElement() &&
                  (i = this.elements[r].getBaseElement()),
                  (r += 1));
              i
                ? this.layerElement.insertBefore(n, i)
                : this.layerElement.appendChild(n);
            }
          }),
          (SVGRendererBase.prototype.hide = function () {
            this.layerElement.style.display = `none`;
          }),
          (SVGRendererBase.prototype.show = function () {
            this.layerElement.style.display = `block`;
          }));
        function ICompElement() {}
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            HierarchyElement,
            FrameElement,
            RenderableDOMElement,
          ],
          ICompElement,
        ),
          (ICompElement.prototype.initElement = function (e, t, n) {
            (this.initFrame(),
              this.initBaseData(e, t, n),
              this.initTransform(e, t, n),
              this.initRenderable(),
              this.initHierarchy(),
              this.initRendererElement(),
              this.createContainerElements(),
              this.createRenderableComponents(),
              (this.data.xt || !t.progressiveLoad) && this.buildAllItems(),
              this.hide());
          }),
          (ICompElement.prototype.prepareFrame = function (e) {
            if (
              ((this._mdf = !1),
              this.prepareRenderableFrame(e),
              this.prepareProperties(e, this.isInRange),
              !(!this.isInRange && !this.data.xt))
            ) {
              if (this.tm._placeholder) this.renderedFrame = e / this.data.sr;
              else {
                var t = this.tm.v;
                (t === this.data.op && (t = this.data.op - 1),
                  (this.renderedFrame = t));
              }
              var n,
                r = this.elements.length;
              for (
                this.completeLayers || this.checkLayers(this.renderedFrame),
                  n = r - 1;
                n >= 0;
                --n
              )
                (this.completeLayers || this.elements[n]) &&
                  (this.elements[n].prepareFrame(
                    this.renderedFrame - this.layers[n].st,
                  ),
                  this.elements[n]._mdf && (this._mdf = !0));
            }
          }),
          (ICompElement.prototype.renderInnerContent = function () {
            var e,
              t = this.layers.length;
            for (e = 0; e < t; e += 1)
              (this.completeLayers || this.elements[e]) &&
                this.elements[e].renderFrame();
          }),
          (ICompElement.prototype.setElements = function (e) {
            this.elements = e;
          }),
          (ICompElement.prototype.getElements = function () {
            return this.elements;
          }),
          (ICompElement.prototype.destroyElements = function () {
            var e,
              t = this.layers.length;
            for (e = 0; e < t; e += 1)
              this.elements[e] && this.elements[e].destroy();
          }),
          (ICompElement.prototype.destroy = function () {
            (this.destroyElements(), this.destroyBaseElement());
          }));
        function SVGCompElement(e, t, n) {
          ((this.layers = e.layers),
            (this.supports3d = !0),
            (this.completeLayers = !1),
            (this.pendingElements = []),
            (this.elements = this.layers
              ? createSizedArray(this.layers.length)
              : []),
            this.initElement(e, t, n),
            (this.tm = e.tm
              ? PropertyFactory.getProp(this, e.tm, 0, t.frameRate, this)
              : { _placeholder: !0 }));
        }
        (extendPrototype(
          [SVGRendererBase, ICompElement, SVGBaseElement],
          SVGCompElement,
        ),
          (SVGCompElement.prototype.createComp = function (e) {
            return new SVGCompElement(e, this.globalData, this);
          }));
        function SVGRenderer(e, t) {
          ((this.animationItem = e),
            (this.layers = null),
            (this.renderedFrame = -1),
            (this.svgElement = createNS(`svg`)));
          var n = ``;
          if (t && t.title) {
            var r = createNS(`title`),
              i = createElementID();
            (r.setAttribute(`id`, i),
              (r.textContent = t.title),
              this.svgElement.appendChild(r),
              (n += i));
          }
          if (t && t.description) {
            var a = createNS(`desc`),
              o = createElementID();
            (a.setAttribute(`id`, o),
              (a.textContent = t.description),
              this.svgElement.appendChild(a),
              (n += ` ` + o));
          }
          n && this.svgElement.setAttribute(`aria-labelledby`, n);
          var s = createNS(`defs`);
          this.svgElement.appendChild(s);
          var c = createNS(`g`);
          (this.svgElement.appendChild(c),
            (this.layerElement = c),
            (this.renderConfig = {
              preserveAspectRatio:
                (t && t.preserveAspectRatio) || `xMidYMid meet`,
              imagePreserveAspectRatio:
                (t && t.imagePreserveAspectRatio) || `xMidYMid slice`,
              contentVisibility: (t && t.contentVisibility) || `visible`,
              progressiveLoad: (t && t.progressiveLoad) || !1,
              hideOnTransparent: !(t && t.hideOnTransparent === !1),
              viewBoxOnly: (t && t.viewBoxOnly) || !1,
              viewBoxSize: (t && t.viewBoxSize) || !1,
              className: (t && t.className) || ``,
              id: (t && t.id) || ``,
              focusable: t && t.focusable,
              filterSize: {
                width: (t && t.filterSize && t.filterSize.width) || `100%`,
                height: (t && t.filterSize && t.filterSize.height) || `100%`,
                x: (t && t.filterSize && t.filterSize.x) || `0%`,
                y: (t && t.filterSize && t.filterSize.y) || `0%`,
              },
              width: t && t.width,
              height: t && t.height,
              runExpressions:
                !t || t.runExpressions === void 0 || t.runExpressions,
            }),
            (this.globalData = {
              _mdf: !1,
              frameNum: -1,
              defs: s,
              renderConfig: this.renderConfig,
            }),
            (this.elements = []),
            (this.pendingElements = []),
            (this.destroyed = !1),
            (this.rendererType = `svg`));
        }
        (extendPrototype([SVGRendererBase], SVGRenderer),
          (SVGRenderer.prototype.createComp = function (e) {
            return new SVGCompElement(e, this.globalData, this);
          }));
        function ShapeTransformManager() {
          ((this.sequences = {}),
            (this.sequenceList = []),
            (this.transform_key_count = 0));
        }
        ShapeTransformManager.prototype = {
          addTransformSequence: function (e) {
            var t,
              n = e.length,
              r = `_`;
            for (t = 0; t < n; t += 1) r += e[t].transform.key + `_`;
            var i = this.sequences[r];
            return (
              i ||
                ((i = {
                  transforms: [].concat(e),
                  finalTransform: new Matrix(),
                  _mdf: !1,
                }),
                (this.sequences[r] = i),
                this.sequenceList.push(i)),
              i
            );
          },
          processSequence: function (e, t) {
            for (var n = 0, r = e.transforms.length, i = t; n < r && !t;) {
              if (e.transforms[n].transform.mProps._mdf) {
                i = !0;
                break;
              }
              n += 1;
            }
            if (i)
              for (e.finalTransform.reset(), n = r - 1; n >= 0; --n)
                e.finalTransform.multiply(e.transforms[n].transform.mProps.v);
            e._mdf = i;
          },
          processSequences: function (e) {
            var t,
              n = this.sequenceList.length;
            for (t = 0; t < n; t += 1)
              this.processSequence(this.sequenceList[t], e);
          },
          getNewKey: function () {
            return (
              (this.transform_key_count += 1),
              `_` + this.transform_key_count
            );
          },
        };
        var lumaLoader = function () {
          var e = `__lottie_element_luma_buffer`,
            t = null,
            n = null,
            r = null;
          function i() {
            var t = createNS(`svg`),
              n = createNS(`filter`),
              r = createNS(`feColorMatrix`);
            return (
              n.setAttribute(`id`, e),
              r.setAttribute(`type`, `matrix`),
              r.setAttribute(`color-interpolation-filters`, `sRGB`),
              r.setAttribute(
                `values`,
                `0.3, 0.3, 0.3, 0, 0, 0.3, 0.3, 0.3, 0, 0, 0.3, 0.3, 0.3, 0, 0, 0.3, 0.3, 0.3, 0, 0`,
              ),
              n.appendChild(r),
              t.appendChild(n),
              t.setAttribute(`id`, e + `_svg`),
              featureSupport.svgLumaHidden && (t.style.display = `none`),
              t
            );
          }
          function a() {
            t ||
              ((r = i()),
              document.body.appendChild(r),
              (t = createTag(`canvas`)),
              (n = t.getContext(`2d`)),
              (n.filter = `url(#` + e + `)`),
              (n.fillStyle = `rgba(0,0,0,0)`),
              n.fillRect(0, 0, 1, 1));
          }
          function o(r) {
            return (
              t || a(),
              (t.width = r.width),
              (t.height = r.height),
              (n.filter = `url(#` + e + `)`),
              t
            );
          }
          return { load: a, get: o };
        };
        function createCanvas(e, t) {
          if (featureSupport.offscreenCanvas) return new OffscreenCanvas(e, t);
          var n = createTag(`canvas`);
          return ((n.width = e), (n.height = t), n);
        }
        var assetLoader = (function () {
            return {
              loadLumaCanvas: lumaLoader.load,
              getLumaCanvas: lumaLoader.get,
              createCanvas,
            };
          })(),
          registeredEffects = {};
        function CVEffects(e) {
          var t,
            n = e.data.ef ? e.data.ef.length : 0;
          this.filters = [];
          var r;
          for (t = 0; t < n; t += 1) {
            r = null;
            var i = e.data.ef[t].ty;
            if (registeredEffects[i]) {
              var a = registeredEffects[i].effect;
              r = new a(e.effectsManager.effectElements[t], e);
            }
            r && this.filters.push(r);
          }
          this.filters.length && e.addRenderableComponent(this);
        }
        ((CVEffects.prototype.renderFrame = function (e) {
          var t,
            n = this.filters.length;
          for (t = 0; t < n; t += 1) this.filters[t].renderFrame(e);
        }),
          (CVEffects.prototype.getEffects = function (e) {
            var t,
              n = this.filters.length,
              r = [];
            for (t = 0; t < n; t += 1)
              this.filters[t].type === e && r.push(this.filters[t]);
            return r;
          }));
        function registerEffect(e, t) {
          registeredEffects[e] = { effect: t };
        }
        function CVMaskElement(e, t) {
          ((this.data = e),
            (this.element = t),
            (this.masksProperties = this.data.masksProperties || []),
            (this.viewData = createSizedArray(this.masksProperties.length)));
          var n,
            r = this.masksProperties.length,
            i = !1;
          for (n = 0; n < r; n += 1)
            (this.masksProperties[n].mode !== `n` && (i = !0),
              (this.viewData[n] = ShapePropertyFactory.getShapeProp(
                this.element,
                this.masksProperties[n],
                3,
              )));
          ((this.hasMasks = i), i && this.element.addRenderableComponent(this));
        }
        ((CVMaskElement.prototype.renderFrame = function () {
          if (this.hasMasks) {
            var e = this.element.finalTransform.mat,
              t = this.element.canvasContext,
              n,
              r = this.masksProperties.length,
              i,
              a,
              o;
            for (t.beginPath(), n = 0; n < r; n += 1)
              if (this.masksProperties[n].mode !== `n`) {
                (this.masksProperties[n].inv &&
                  (t.moveTo(0, 0),
                  t.lineTo(this.element.globalData.compSize.w, 0),
                  t.lineTo(
                    this.element.globalData.compSize.w,
                    this.element.globalData.compSize.h,
                  ),
                  t.lineTo(0, this.element.globalData.compSize.h),
                  t.lineTo(0, 0)),
                  (o = this.viewData[n].v),
                  (i = e.applyToPointArray(o.v[0][0], o.v[0][1], 0)),
                  t.moveTo(i[0], i[1]));
                var s,
                  c = o._length;
                for (s = 1; s < c; s += 1)
                  ((a = e.applyToTriplePoints(o.o[s - 1], o.i[s], o.v[s])),
                    t.bezierCurveTo(a[0], a[1], a[2], a[3], a[4], a[5]));
                ((a = e.applyToTriplePoints(o.o[s - 1], o.i[0], o.v[0])),
                  t.bezierCurveTo(a[0], a[1], a[2], a[3], a[4], a[5]));
              }
            (this.element.globalData.renderer.save(!0), t.clip());
          }
        }),
          (CVMaskElement.prototype.getMaskProperty =
            MaskElement.prototype.getMaskProperty),
          (CVMaskElement.prototype.destroy = function () {
            this.element = null;
          }));
        function CVBaseElement() {}
        var operationsMap = {
          1: `source-in`,
          2: `source-out`,
          3: `source-in`,
          4: `source-out`,
        };
        ((CVBaseElement.prototype = {
          createElements: function () {},
          initRendererElement: function () {},
          createContainerElements: function () {
            if (this.data.tt >= 1) {
              this.buffers = [];
              var e = this.globalData.canvasContext,
                t = assetLoader.createCanvas(e.canvas.width, e.canvas.height);
              this.buffers.push(t);
              var n = assetLoader.createCanvas(e.canvas.width, e.canvas.height);
              (this.buffers.push(n),
                this.data.tt >= 3 &&
                  !document._isProxy &&
                  assetLoader.loadLumaCanvas());
            }
            ((this.canvasContext = this.globalData.canvasContext),
              (this.transformCanvas = this.globalData.transformCanvas),
              (this.renderableEffectsManager = new CVEffects(this)),
              this.searchEffectTransforms());
          },
          createContent: function () {},
          setBlendMode: function () {
            var e = this.globalData;
            if (e.blendMode !== this.data.bm) {
              e.blendMode = this.data.bm;
              var t = getBlendMode(this.data.bm);
              e.canvasContext.globalCompositeOperation = t;
            }
          },
          createRenderableComponents: function () {
            ((this.maskManager = new CVMaskElement(this.data, this)),
              (this.transformEffects = this.renderableEffectsManager.getEffects(
                effectTypes.TRANSFORM_EFFECT,
              )));
          },
          hideElement: function () {
            !this.hidden &&
              (!this.isInRange || this.isTransparent) &&
              (this.hidden = !0);
          },
          showElement: function () {
            this.isInRange &&
              !this.isTransparent &&
              ((this.hidden = !1),
              (this._isFirstFrame = !0),
              (this.maskManager._isFirstFrame = !0));
          },
          clearCanvas: function (e) {
            e.clearRect(
              this.transformCanvas.tx,
              this.transformCanvas.ty,
              this.transformCanvas.w * this.transformCanvas.sx,
              this.transformCanvas.h * this.transformCanvas.sy,
            );
          },
          prepareLayer: function () {
            if (this.data.tt >= 1) {
              var e = this.buffers[0].getContext(`2d`);
              (this.clearCanvas(e),
                e.drawImage(this.canvasContext.canvas, 0, 0),
                (this.currentTransform = this.canvasContext.getTransform()),
                this.canvasContext.setTransform(1, 0, 0, 1, 0, 0),
                this.clearCanvas(this.canvasContext),
                this.canvasContext.setTransform(this.currentTransform));
            }
          },
          exitLayer: function () {
            if (this.data.tt >= 1) {
              var e = this.buffers[1],
                t = e.getContext(`2d`);
              if (
                (this.clearCanvas(t),
                t.drawImage(this.canvasContext.canvas, 0, 0),
                this.canvasContext.setTransform(1, 0, 0, 1, 0, 0),
                this.clearCanvas(this.canvasContext),
                this.canvasContext.setTransform(this.currentTransform),
                this.comp
                  .getElementById(
                    `tp` in this.data ? this.data.tp : this.data.ind - 1,
                  )
                  .renderFrame(!0),
                this.canvasContext.setTransform(1, 0, 0, 1, 0, 0),
                this.data.tt >= 3 && !document._isProxy)
              ) {
                var n = assetLoader.getLumaCanvas(this.canvasContext.canvas);
                (n.getContext(`2d`).drawImage(this.canvasContext.canvas, 0, 0),
                  this.clearCanvas(this.canvasContext),
                  this.canvasContext.drawImage(n, 0, 0));
              }
              ((this.canvasContext.globalCompositeOperation =
                operationsMap[this.data.tt]),
                this.canvasContext.drawImage(e, 0, 0),
                (this.canvasContext.globalCompositeOperation = `destination-over`),
                this.canvasContext.drawImage(this.buffers[0], 0, 0),
                this.canvasContext.setTransform(this.currentTransform),
                (this.canvasContext.globalCompositeOperation = `source-over`));
            }
          },
          renderFrame: function (e) {
            if (!(this.hidden || this.data.hd) && !(this.data.td === 1 && !e)) {
              (this.renderTransform(),
                this.renderRenderable(),
                this.renderLocalTransform(),
                this.setBlendMode());
              var t = this.data.ty === 0;
              (this.prepareLayer(),
                this.globalData.renderer.save(t),
                this.globalData.renderer.ctxTransform(
                  this.finalTransform.localMat.props,
                ),
                this.globalData.renderer.ctxOpacity(
                  this.finalTransform.localOpacity,
                ),
                this.renderInnerContent(),
                this.globalData.renderer.restore(t),
                this.exitLayer(),
                this.maskManager.hasMasks &&
                  this.globalData.renderer.restore(!0),
                (this._isFirstFrame &&= !1));
            }
          },
          destroy: function () {
            ((this.canvasContext = null),
              (this.data = null),
              (this.globalData = null),
              this.maskManager.destroy());
          },
          mHelper: new Matrix(),
        }),
          (CVBaseElement.prototype.hide = CVBaseElement.prototype.hideElement),
          (CVBaseElement.prototype.show = CVBaseElement.prototype.showElement));
        function CVShapeData(e, t, n, r) {
          ((this.styledShapes = []), (this.tr = [0, 0, 0, 0, 0, 0]));
          var i = 4;
          (t.ty === `rc`
            ? (i = 5)
            : t.ty === `el`
              ? (i = 6)
              : t.ty === `sr` && (i = 7),
            (this.sh = ShapePropertyFactory.getShapeProp(e, t, i, e)));
          var a,
            o = n.length,
            s;
          for (a = 0; a < o; a += 1)
            n[a].closed ||
              ((s = {
                transforms: r.addTransformSequence(n[a].transforms),
                trNodes: [],
              }),
              this.styledShapes.push(s),
              n[a].elements.push(s));
        }
        CVShapeData.prototype.setAsAnimated =
          SVGShapeData.prototype.setAsAnimated;
        function CVShapeElement(e, t, n) {
          ((this.shapes = []),
            (this.shapesData = e.shapes),
            (this.stylesList = []),
            (this.itemsData = []),
            (this.prevViewData = []),
            (this.shapeModifiers = []),
            (this.processedElements = []),
            (this.transformsManager = new ShapeTransformManager()),
            this.initElement(e, t, n));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            CVBaseElement,
            IShapeElement,
            HierarchyElement,
            FrameElement,
            RenderableElement,
          ],
          CVShapeElement,
        ),
          (CVShapeElement.prototype.initElement =
            RenderableDOMElement.prototype.initElement),
          (CVShapeElement.prototype.transformHelper = {
            opacity: 1,
            _opMdf: !1,
          }),
          (CVShapeElement.prototype.dashResetter = []),
          (CVShapeElement.prototype.createContent = function () {
            this.searchShapes(
              this.shapesData,
              this.itemsData,
              this.prevViewData,
              !0,
              [],
            );
          }),
          (CVShapeElement.prototype.createStyleElement = function (e, t) {
            var n = {
                data: e,
                type: e.ty,
                preTransforms: this.transformsManager.addTransformSequence(t),
                transforms: [],
                elements: [],
                closed: e.hd === !0,
              },
              r = {};
            return (
              e.ty === `fl` || e.ty === `st`
                ? ((r.c = PropertyFactory.getProp(this, e.c, 1, 255, this)),
                  r.c.k ||
                    (n.co =
                      `rgb(` +
                      bmFloor(r.c.v[0]) +
                      `,` +
                      bmFloor(r.c.v[1]) +
                      `,` +
                      bmFloor(r.c.v[2]) +
                      `)`))
                : (e.ty === `gf` || e.ty === `gs`) &&
                  ((r.s = PropertyFactory.getProp(this, e.s, 1, null, this)),
                  (r.e = PropertyFactory.getProp(this, e.e, 1, null, this)),
                  (r.h = PropertyFactory.getProp(
                    this,
                    e.h || { k: 0 },
                    0,
                    0.01,
                    this,
                  )),
                  (r.a = PropertyFactory.getProp(
                    this,
                    e.a || { k: 0 },
                    0,
                    degToRads,
                    this,
                  )),
                  (r.g = new GradientProperty(this, e.g, this))),
              (r.o = PropertyFactory.getProp(this, e.o, 0, 0.01, this)),
              e.ty === `st` || e.ty === `gs`
                ? ((n.lc = lineCapEnum[e.lc || 2]),
                  (n.lj = lineJoinEnum[e.lj || 2]),
                  e.lj == 1 && (n.ml = e.ml),
                  (r.w = PropertyFactory.getProp(this, e.w, 0, null, this)),
                  r.w.k || (n.wi = r.w.v),
                  e.d &&
                    ((r.d = new DashProperty(this, e.d, `canvas`, this)),
                    r.d.k ||
                      ((n.da = r.d.dashArray), (n.do = r.d.dashoffset[0]))))
                : (n.r = e.r === 2 ? `evenodd` : `nonzero`),
              this.stylesList.push(n),
              (r.style = n),
              r
            );
          }),
          (CVShapeElement.prototype.createGroupElement = function () {
            return { it: [], prevViewData: [] };
          }),
          (CVShapeElement.prototype.createTransformElement = function (e) {
            return {
              transform: {
                opacity: 1,
                _opMdf: !1,
                key: this.transformsManager.getNewKey(),
                op: PropertyFactory.getProp(this, e.o, 0, 0.01, this),
                mProps: TransformPropertyFactory.getTransformProperty(
                  this,
                  e,
                  this,
                ),
              },
            };
          }),
          (CVShapeElement.prototype.createShapeElement = function (e) {
            var t = new CVShapeData(
              this,
              e,
              this.stylesList,
              this.transformsManager,
            );
            return (this.shapes.push(t), this.addShapeToModifiers(t), t);
          }),
          (CVShapeElement.prototype.reloadShapes = function () {
            this._isFirstFrame = !0;
            var e,
              t = this.itemsData.length;
            for (e = 0; e < t; e += 1) this.prevViewData[e] = this.itemsData[e];
            for (
              this.searchShapes(
                this.shapesData,
                this.itemsData,
                this.prevViewData,
                !0,
                [],
              ),
                t = this.dynamicProperties.length,
                e = 0;
              e < t;
              e += 1
            )
              this.dynamicProperties[e].getValue();
            (this.renderModifiers(),
              this.transformsManager.processSequences(this._isFirstFrame));
          }),
          (CVShapeElement.prototype.addTransformToStyleList = function (e) {
            var t,
              n = this.stylesList.length;
            for (t = 0; t < n; t += 1)
              this.stylesList[t].closed ||
                this.stylesList[t].transforms.push(e);
          }),
          (CVShapeElement.prototype.removeTransformFromStyleList = function () {
            var e,
              t = this.stylesList.length;
            for (e = 0; e < t; e += 1)
              this.stylesList[e].closed || this.stylesList[e].transforms.pop();
          }),
          (CVShapeElement.prototype.closeStyles = function (e) {
            var t,
              n = e.length;
            for (t = 0; t < n; t += 1) e[t].closed = !0;
          }),
          (CVShapeElement.prototype.searchShapes = function (e, t, n, r, i) {
            var a,
              o = e.length - 1,
              s,
              c,
              l = [],
              u = [],
              d,
              f,
              p,
              m = [].concat(i);
            for (a = o; a >= 0; --a) {
              if (
                ((d = this.searchProcessedElement(e[a])),
                d ? (t[a] = n[d - 1]) : (e[a]._shouldRender = r),
                e[a].ty === `fl` ||
                  e[a].ty === `st` ||
                  e[a].ty === `gf` ||
                  e[a].ty === `gs`)
              )
                (d
                  ? (t[a].style.closed = !1)
                  : (t[a] = this.createStyleElement(e[a], m)),
                  l.push(t[a].style));
              else if (e[a].ty === `gr`) {
                if (!d) t[a] = this.createGroupElement(e[a]);
                else
                  for (c = t[a].it.length, s = 0; s < c; s += 1)
                    t[a].prevViewData[s] = t[a].it[s];
                this.searchShapes(e[a].it, t[a].it, t[a].prevViewData, r, m);
              } else
                e[a].ty === `tr`
                  ? (d || ((p = this.createTransformElement(e[a])), (t[a] = p)),
                    m.push(t[a]),
                    this.addTransformToStyleList(t[a]))
                  : e[a].ty === `sh` ||
                      e[a].ty === `rc` ||
                      e[a].ty === `el` ||
                      e[a].ty === `sr`
                    ? d || (t[a] = this.createShapeElement(e[a]))
                    : e[a].ty === `tm` ||
                        e[a].ty === `rd` ||
                        e[a].ty === `pb` ||
                        e[a].ty === `zz` ||
                        e[a].ty === `op`
                      ? (d
                          ? ((f = t[a]), (f.closed = !1))
                          : ((f = ShapeModifiers.getModifier(e[a].ty)),
                            f.init(this, e[a]),
                            (t[a] = f),
                            this.shapeModifiers.push(f)),
                        u.push(f))
                      : e[a].ty === `rp` &&
                        (d
                          ? ((f = t[a]), (f.closed = !0))
                          : ((f = ShapeModifiers.getModifier(e[a].ty)),
                            (t[a] = f),
                            f.init(this, e, a, t),
                            this.shapeModifiers.push(f),
                            (r = !1)),
                        u.push(f));
              this.addProcessedElement(e[a], a + 1);
            }
            for (
              this.removeTransformFromStyleList(),
                this.closeStyles(l),
                o = u.length,
                a = 0;
              a < o;
              a += 1
            )
              u[a].closed = !0;
          }),
          (CVShapeElement.prototype.renderInnerContent = function () {
            ((this.transformHelper.opacity = 1),
              (this.transformHelper._opMdf = !1),
              this.renderModifiers(),
              this.transformsManager.processSequences(this._isFirstFrame),
              this.renderShape(
                this.transformHelper,
                this.shapesData,
                this.itemsData,
                !0,
              ));
          }),
          (CVShapeElement.prototype.renderShapeTransform = function (e, t) {
            (e._opMdf || t.op._mdf || this._isFirstFrame) &&
              ((t.opacity = e.opacity), (t.opacity *= t.op.v), (t._opMdf = !0));
          }),
          (CVShapeElement.prototype.drawLayer = function () {
            var e,
              t = this.stylesList.length,
              n,
              r,
              i,
              a,
              o,
              s,
              c = this.globalData.renderer,
              l = this.globalData.canvasContext,
              u,
              d;
            for (e = 0; e < t; e += 1)
              if (
                ((d = this.stylesList[e]),
                (u = d.type),
                !(
                  ((u === `st` || u === `gs`) && d.wi === 0) ||
                  !d.data._shouldRender ||
                  d.coOp === 0 ||
                  this.globalData.currentGlobalAlpha === 0
                ))
              ) {
                for (
                  c.save(),
                    o = d.elements,
                    u === `st` || u === `gs`
                      ? (c.ctxStrokeStyle(u === `st` ? d.co : d.grd),
                        c.ctxLineWidth(d.wi),
                        c.ctxLineCap(d.lc),
                        c.ctxLineJoin(d.lj),
                        c.ctxMiterLimit(d.ml || 0))
                      : c.ctxFillStyle(u === `fl` ? d.co : d.grd),
                    c.ctxOpacity(d.coOp),
                    u !== `st` && u !== `gs` && l.beginPath(),
                    c.ctxTransform(d.preTransforms.finalTransform.props),
                    r = o.length,
                    n = 0;
                  n < r;
                  n += 1
                ) {
                  for (
                    (u === `st` || u === `gs`) &&
                      (l.beginPath(),
                      d.da && (l.setLineDash(d.da), (l.lineDashOffset = d.do))),
                      s = o[n].trNodes,
                      a = s.length,
                      i = 0;
                    i < a;
                    i += 1
                  )
                    s[i].t === `m`
                      ? l.moveTo(s[i].p[0], s[i].p[1])
                      : s[i].t === `c`
                        ? l.bezierCurveTo(
                            s[i].pts[0],
                            s[i].pts[1],
                            s[i].pts[2],
                            s[i].pts[3],
                            s[i].pts[4],
                            s[i].pts[5],
                          )
                        : l.closePath();
                  (u === `st` || u === `gs`) &&
                    (c.ctxStroke(), d.da && l.setLineDash(this.dashResetter));
                }
                (u !== `st` &&
                  u !== `gs` &&
                  this.globalData.renderer.ctxFill(d.r),
                  c.restore());
              }
          }),
          (CVShapeElement.prototype.renderShape = function (e, t, n, r) {
            var i,
              a = t.length - 1,
              o = e;
            for (i = a; i >= 0; --i)
              t[i].ty === `tr`
                ? ((o = n[i].transform), this.renderShapeTransform(e, o))
                : t[i].ty === `sh` ||
                    t[i].ty === `el` ||
                    t[i].ty === `rc` ||
                    t[i].ty === `sr`
                  ? this.renderPath(t[i], n[i])
                  : t[i].ty === `fl`
                    ? this.renderFill(t[i], n[i], o)
                    : t[i].ty === `st`
                      ? this.renderStroke(t[i], n[i], o)
                      : t[i].ty === `gf` || t[i].ty === `gs`
                        ? this.renderGradientFill(t[i], n[i], o)
                        : t[i].ty === `gr`
                          ? this.renderShape(o, t[i].it, n[i].it)
                          : t[i].ty;
            r && this.drawLayer();
          }),
          (CVShapeElement.prototype.renderStyledShape = function (e, t) {
            if (this._isFirstFrame || t._mdf || e.transforms._mdf) {
              var n = e.trNodes,
                r = t.paths,
                i,
                a,
                o,
                s = r._length;
              n.length = 0;
              var c = e.transforms.finalTransform;
              for (o = 0; o < s; o += 1) {
                var l = r.shapes[o];
                if (l && l.v) {
                  for (a = l._length, i = 1; i < a; i += 1)
                    (i === 1 &&
                      n.push({
                        t: `m`,
                        p: c.applyToPointArray(l.v[0][0], l.v[0][1], 0),
                      }),
                      n.push({
                        t: `c`,
                        pts: c.applyToTriplePoints(l.o[i - 1], l.i[i], l.v[i]),
                      }));
                  (a === 1 &&
                    n.push({
                      t: `m`,
                      p: c.applyToPointArray(l.v[0][0], l.v[0][1], 0),
                    }),
                    l.c &&
                      a &&
                      (n.push({
                        t: `c`,
                        pts: c.applyToTriplePoints(l.o[i - 1], l.i[0], l.v[0]),
                      }),
                      n.push({ t: `z` })));
                }
              }
              e.trNodes = n;
            }
          }),
          (CVShapeElement.prototype.renderPath = function (e, t) {
            if (e.hd !== !0 && e._shouldRender) {
              var n,
                r = t.styledShapes.length;
              for (n = 0; n < r; n += 1)
                this.renderStyledShape(t.styledShapes[n], t.sh);
            }
          }),
          (CVShapeElement.prototype.renderFill = function (e, t, n) {
            var r = t.style;
            ((t.c._mdf || this._isFirstFrame) &&
              (r.co =
                `rgb(` +
                bmFloor(t.c.v[0]) +
                `,` +
                bmFloor(t.c.v[1]) +
                `,` +
                bmFloor(t.c.v[2]) +
                `)`),
              (t.o._mdf || n._opMdf || this._isFirstFrame) &&
                (r.coOp = t.o.v * n.opacity));
          }),
          (CVShapeElement.prototype.renderGradientFill = function (e, t, n) {
            var r = t.style,
              i;
            if (
              !r.grd ||
              t.g._mdf ||
              t.s._mdf ||
              t.e._mdf ||
              (e.t !== 1 && (t.h._mdf || t.a._mdf))
            ) {
              var a = this.globalData.canvasContext,
                o = t.s.v,
                s = t.e.v;
              if (e.t === 1) i = a.createLinearGradient(o[0], o[1], s[0], s[1]);
              else {
                var c = Math.sqrt((o[0] - s[0]) ** 2 + (o[1] - s[1]) ** 2),
                  l = Math.atan2(s[1] - o[1], s[0] - o[0]),
                  u = t.h.v;
                u >= 1 ? (u = 0.99) : u <= -1 && (u = -0.99);
                var d = c * u,
                  f = Math.cos(l + t.a.v) * d + o[0],
                  p = Math.sin(l + t.a.v) * d + o[1];
                i = a.createRadialGradient(f, p, 0, o[0], o[1], c);
              }
              var m,
                g = e.g.p,
                _ = t.g.c,
                y = 1;
              for (m = 0; m < g; m += 1)
                (t.g._hasOpacity && t.g._collapsable && (y = t.g.o[m * 2 + 1]),
                  i.addColorStop(
                    _[m * 4] / 100,
                    `rgba(` +
                      _[m * 4 + 1] +
                      `,` +
                      _[m * 4 + 2] +
                      `,` +
                      _[m * 4 + 3] +
                      `,` +
                      y +
                      `)`,
                  ));
              r.grd = i;
            }
            r.coOp = t.o.v * n.opacity;
          }),
          (CVShapeElement.prototype.renderStroke = function (e, t, n) {
            var r = t.style,
              i = t.d;
            (i &&
              (i._mdf || this._isFirstFrame) &&
              ((r.da = i.dashArray), (r.do = i.dashoffset[0])),
              (t.c._mdf || this._isFirstFrame) &&
                (r.co =
                  `rgb(` +
                  bmFloor(t.c.v[0]) +
                  `,` +
                  bmFloor(t.c.v[1]) +
                  `,` +
                  bmFloor(t.c.v[2]) +
                  `)`),
              (t.o._mdf || n._opMdf || this._isFirstFrame) &&
                (r.coOp = t.o.v * n.opacity),
              (t.w._mdf || this._isFirstFrame) && (r.wi = t.w.v));
          }),
          (CVShapeElement.prototype.destroy = function () {
            ((this.shapesData = null),
              (this.globalData = null),
              (this.canvasContext = null),
              (this.stylesList.length = 0),
              (this.itemsData.length = 0));
          }));
        function CVTextElement(e, t, n) {
          ((this.textSpans = []),
            (this.yOffset = 0),
            (this.fillColorAnim = !1),
            (this.strokeColorAnim = !1),
            (this.strokeWidthAnim = !1),
            (this.stroke = !1),
            (this.fill = !1),
            (this.justifyOffset = 0),
            (this.currentRender = null),
            (this.renderType = `canvas`),
            (this.values = {
              fill: `rgba(0,0,0,0)`,
              stroke: `rgba(0,0,0,0)`,
              sWidth: 0,
              fValue: ``,
            }),
            this.initElement(e, t, n));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            CVBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableElement,
            ITextElement,
          ],
          CVTextElement,
        ),
          (CVTextElement.prototype.tHelper =
            createTag(`canvas`).getContext(`2d`)),
          (CVTextElement.prototype.buildNewText = function () {
            var e = this.textProperty.currentData;
            this.renderedLetters = createSizedArray(e.l ? e.l.length : 0);
            var t = !1;
            (e.fc
              ? ((t = !0), (this.values.fill = this.buildColor(e.fc)))
              : (this.values.fill = `rgba(0,0,0,0)`),
              (this.fill = t));
            var n = !1;
            e.sc &&
              ((n = !0),
              (this.values.stroke = this.buildColor(e.sc)),
              (this.values.sWidth = e.sw));
            var r = this.globalData.fontManager.getFontByName(e.f),
              i,
              a,
              o = e.l,
              s = this.mHelper;
            ((this.stroke = n),
              (this.values.fValue =
                e.finalSize +
                `px ` +
                this.globalData.fontManager.getFontByName(e.f).fFamily),
              (a = e.finalText.length));
            var c,
              l,
              u,
              d,
              f,
              p,
              m,
              g,
              _,
              y,
              b = this.data.singleShape,
              x = e.tr * 0.001 * e.finalSize,
              S = 0,
              C = 0,
              T = !0,
              E = 0;
            for (i = 0; i < a; i += 1) {
              ((c = this.globalData.fontManager.getCharData(
                e.finalText[i],
                r.fStyle,
                this.globalData.fontManager.getFontByName(e.f).fFamily,
              )),
                (l = (c && c.data) || {}),
                s.reset(),
                b &&
                  o[i].n &&
                  ((S = -x), (C += e.yOffset), (C += +!!T), (T = !1)),
                (f = l.shapes ? l.shapes[0].it : []),
                (m = f.length),
                s.scale(e.finalSize / 100, e.finalSize / 100),
                b && this.applyTextPropertiesToMatrix(e, s, o[i].line, S, C),
                (_ = createSizedArray(m - 1)));
              var D = 0;
              for (p = 0; p < m; p += 1)
                if (f[p].ty === `sh`) {
                  for (
                    d = f[p].ks.k.i.length, g = f[p].ks.k, y = [], u = 1;
                    u < d;
                    u += 1
                  )
                    (u === 1 &&
                      y.push(
                        s.applyToX(g.v[0][0], g.v[0][1], 0),
                        s.applyToY(g.v[0][0], g.v[0][1], 0),
                      ),
                      y.push(
                        s.applyToX(g.o[u - 1][0], g.o[u - 1][1], 0),
                        s.applyToY(g.o[u - 1][0], g.o[u - 1][1], 0),
                        s.applyToX(g.i[u][0], g.i[u][1], 0),
                        s.applyToY(g.i[u][0], g.i[u][1], 0),
                        s.applyToX(g.v[u][0], g.v[u][1], 0),
                        s.applyToY(g.v[u][0], g.v[u][1], 0),
                      ));
                  (y.push(
                    s.applyToX(g.o[u - 1][0], g.o[u - 1][1], 0),
                    s.applyToY(g.o[u - 1][0], g.o[u - 1][1], 0),
                    s.applyToX(g.i[0][0], g.i[0][1], 0),
                    s.applyToY(g.i[0][0], g.i[0][1], 0),
                    s.applyToX(g.v[0][0], g.v[0][1], 0),
                    s.applyToY(g.v[0][0], g.v[0][1], 0),
                  ),
                    (_[D] = y),
                    (D += 1));
                }
              (b && ((S += o[i].l), (S += x)),
                this.textSpans[E]
                  ? (this.textSpans[E].elem = _)
                  : (this.textSpans[E] = { elem: _ }),
                (E += 1));
            }
          }),
          (CVTextElement.prototype.renderInnerContent = function () {
            this.validateText();
            var e = this.canvasContext;
            ((e.font = this.values.fValue),
              this.globalData.renderer.ctxLineCap(`butt`),
              this.globalData.renderer.ctxLineJoin(`miter`),
              this.globalData.renderer.ctxMiterLimit(4),
              this.data.singleShape ||
                this.textAnimator.getMeasures(
                  this.textProperty.currentData,
                  this.lettersChangedFlag,
                ));
            var t,
              n,
              r,
              i,
              a,
              o,
              s = this.textAnimator.renderedLetters,
              c = this.textProperty.currentData.l;
            n = c.length;
            var l,
              u = null,
              d = null,
              f = null,
              p,
              m,
              g = this.globalData.renderer;
            for (t = 0; t < n; t += 1)
              if (!c[t].n) {
                if (
                  ((l = s[t]),
                  l && (g.save(), g.ctxTransform(l.p), g.ctxOpacity(l.o)),
                  this.fill)
                ) {
                  for (
                    l && l.fc
                      ? u !== l.fc && (g.ctxFillStyle(l.fc), (u = l.fc))
                      : u !== this.values.fill &&
                        ((u = this.values.fill),
                        g.ctxFillStyle(this.values.fill)),
                      p = this.textSpans[t].elem,
                      i = p.length,
                      this.globalData.canvasContext.beginPath(),
                      r = 0;
                    r < i;
                    r += 1
                  )
                    for (
                      m = p[r],
                        o = m.length,
                        this.globalData.canvasContext.moveTo(m[0], m[1]),
                        a = 2;
                      a < o;
                      a += 6
                    )
                      this.globalData.canvasContext.bezierCurveTo(
                        m[a],
                        m[a + 1],
                        m[a + 2],
                        m[a + 3],
                        m[a + 4],
                        m[a + 5],
                      );
                  (this.globalData.canvasContext.closePath(), g.ctxFill());
                }
                if (this.stroke) {
                  for (
                    l && l.sw
                      ? f !== l.sw && ((f = l.sw), g.ctxLineWidth(l.sw))
                      : f !== this.values.sWidth &&
                        ((f = this.values.sWidth),
                        g.ctxLineWidth(this.values.sWidth)),
                      l && l.sc
                        ? d !== l.sc && ((d = l.sc), g.ctxStrokeStyle(l.sc))
                        : d !== this.values.stroke &&
                          ((d = this.values.stroke),
                          g.ctxStrokeStyle(this.values.stroke)),
                      p = this.textSpans[t].elem,
                      i = p.length,
                      this.globalData.canvasContext.beginPath(),
                      r = 0;
                    r < i;
                    r += 1
                  )
                    for (
                      m = p[r],
                        o = m.length,
                        this.globalData.canvasContext.moveTo(m[0], m[1]),
                        a = 2;
                      a < o;
                      a += 6
                    )
                      this.globalData.canvasContext.bezierCurveTo(
                        m[a],
                        m[a + 1],
                        m[a + 2],
                        m[a + 3],
                        m[a + 4],
                        m[a + 5],
                      );
                  (this.globalData.canvasContext.closePath(), g.ctxStroke());
                }
                l && this.globalData.renderer.restore();
              }
          }));
        function CVImageElement(e, t, n) {
          ((this.assetData = t.getAssetData(e.refId)),
            (this.img = t.imageLoader.getAsset(this.assetData)),
            this.initElement(e, t, n));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            CVBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableElement,
          ],
          CVImageElement,
        ),
          (CVImageElement.prototype.initElement =
            SVGShapeElement.prototype.initElement),
          (CVImageElement.prototype.prepareFrame =
            IImageElement.prototype.prepareFrame),
          (CVImageElement.prototype.createContent = function () {
            if (
              this.img.width &&
              (this.assetData.w !== this.img.width ||
                this.assetData.h !== this.img.height)
            ) {
              var e = createTag(`canvas`);
              ((e.width = this.assetData.w), (e.height = this.assetData.h));
              var t = e.getContext(`2d`),
                n = this.img.width,
                r = this.img.height,
                i = n / r,
                a = this.assetData.w / this.assetData.h,
                o,
                s,
                c =
                  this.assetData.pr ||
                  this.globalData.renderConfig.imagePreserveAspectRatio;
              ((i > a && c === `xMidYMid slice`) ||
              (i < a && c !== `xMidYMid slice`)
                ? ((s = r), (o = s * a))
                : ((o = n), (s = o / a)),
                t.drawImage(
                  this.img,
                  (n - o) / 2,
                  (r - s) / 2,
                  o,
                  s,
                  0,
                  0,
                  this.assetData.w,
                  this.assetData.h,
                ),
                (this.img = e));
            }
          }),
          (CVImageElement.prototype.renderInnerContent = function () {
            this.canvasContext.drawImage(this.img, 0, 0);
          }),
          (CVImageElement.prototype.destroy = function () {
            this.img = null;
          }));
        function CVSolidElement(e, t, n) {
          this.initElement(e, t, n);
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            CVBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableElement,
          ],
          CVSolidElement,
        ),
          (CVSolidElement.prototype.initElement =
            SVGShapeElement.prototype.initElement),
          (CVSolidElement.prototype.prepareFrame =
            IImageElement.prototype.prepareFrame),
          (CVSolidElement.prototype.renderInnerContent = function () {
            (this.globalData.renderer.ctxFillStyle(this.data.sc),
              this.globalData.renderer.ctxFillRect(
                0,
                0,
                this.data.sw,
                this.data.sh,
              ));
          }));
        function CanvasRendererBase() {}
        (extendPrototype([BaseRenderer], CanvasRendererBase),
          (CanvasRendererBase.prototype.createShape = function (e) {
            return new CVShapeElement(e, this.globalData, this);
          }),
          (CanvasRendererBase.prototype.createText = function (e) {
            return new CVTextElement(e, this.globalData, this);
          }),
          (CanvasRendererBase.prototype.createImage = function (e) {
            return new CVImageElement(e, this.globalData, this);
          }),
          (CanvasRendererBase.prototype.createSolid = function (e) {
            return new CVSolidElement(e, this.globalData, this);
          }),
          (CanvasRendererBase.prototype.createNull =
            SVGRenderer.prototype.createNull),
          (CanvasRendererBase.prototype.ctxTransform = function (e) {
            (e[0] === 1 &&
              e[1] === 0 &&
              e[4] === 0 &&
              e[5] === 1 &&
              e[12] === 0 &&
              e[13] === 0) ||
              this.canvasContext.transform(
                e[0],
                e[1],
                e[4],
                e[5],
                e[12],
                e[13],
              );
          }),
          (CanvasRendererBase.prototype.ctxOpacity = function (e) {
            this.canvasContext.globalAlpha *= e < 0 ? 0 : e;
          }),
          (CanvasRendererBase.prototype.ctxFillStyle = function (e) {
            this.canvasContext.fillStyle = e;
          }),
          (CanvasRendererBase.prototype.ctxStrokeStyle = function (e) {
            this.canvasContext.strokeStyle = e;
          }),
          (CanvasRendererBase.prototype.ctxLineWidth = function (e) {
            this.canvasContext.lineWidth = e;
          }),
          (CanvasRendererBase.prototype.ctxLineCap = function (e) {
            this.canvasContext.lineCap = e;
          }),
          (CanvasRendererBase.prototype.ctxLineJoin = function (e) {
            this.canvasContext.lineJoin = e;
          }),
          (CanvasRendererBase.prototype.ctxMiterLimit = function (e) {
            this.canvasContext.miterLimit = e;
          }),
          (CanvasRendererBase.prototype.ctxFill = function (e) {
            this.canvasContext.fill(e);
          }),
          (CanvasRendererBase.prototype.ctxFillRect = function (e, t, n, r) {
            this.canvasContext.fillRect(e, t, n, r);
          }),
          (CanvasRendererBase.prototype.ctxStroke = function () {
            this.canvasContext.stroke();
          }),
          (CanvasRendererBase.prototype.reset = function () {
            if (!this.renderConfig.clearCanvas) {
              this.canvasContext.restore();
              return;
            }
            this.contextData.reset();
          }),
          (CanvasRendererBase.prototype.save = function () {
            this.canvasContext.save();
          }),
          (CanvasRendererBase.prototype.restore = function (e) {
            if (!this.renderConfig.clearCanvas) {
              this.canvasContext.restore();
              return;
            }
            (e && (this.globalData.blendMode = `source-over`),
              this.contextData.restore(e));
          }),
          (CanvasRendererBase.prototype.configAnimation = function (e) {
            if (this.animationItem.wrapper) {
              this.animationItem.container = createTag(`canvas`);
              var t = this.animationItem.container.style;
              ((t.width = `100%`), (t.height = `100%`));
              var n = `0px 0px 0px`;
              ((t.transformOrigin = n),
                (t.mozTransformOrigin = n),
                (t.webkitTransformOrigin = n),
                (t[`-webkit-transform`] = n),
                (t.contentVisibility = this.renderConfig.contentVisibility),
                this.animationItem.wrapper.appendChild(
                  this.animationItem.container,
                ),
                (this.canvasContext =
                  this.animationItem.container.getContext(`2d`)),
                this.renderConfig.className &&
                  this.animationItem.container.setAttribute(
                    `class`,
                    this.renderConfig.className,
                  ),
                this.renderConfig.id &&
                  this.animationItem.container.setAttribute(
                    `id`,
                    this.renderConfig.id,
                  ));
            } else this.canvasContext = this.renderConfig.context;
            (this.contextData.setContext(this.canvasContext),
              (this.data = e),
              (this.layers = e.layers),
              (this.transformCanvas = {
                w: e.w,
                h: e.h,
                sx: 0,
                sy: 0,
                tx: 0,
                ty: 0,
              }),
              this.setupGlobalData(e, document.body),
              (this.globalData.canvasContext = this.canvasContext),
              (this.globalData.renderer = this),
              (this.globalData.isDashed = !1),
              (this.globalData.progressiveLoad =
                this.renderConfig.progressiveLoad),
              (this.globalData.transformCanvas = this.transformCanvas),
              (this.elements = createSizedArray(e.layers.length)),
              this.updateContainerSize());
          }),
          (CanvasRendererBase.prototype.updateContainerSize = function (e, t) {
            this.reset();
            var n, r;
            e
              ? ((n = e),
                (r = t),
                (this.canvasContext.canvas.width = n),
                (this.canvasContext.canvas.height = r))
              : (this.animationItem.wrapper && this.animationItem.container
                  ? ((n = this.animationItem.wrapper.offsetWidth),
                    (r = this.animationItem.wrapper.offsetHeight))
                  : ((n = this.canvasContext.canvas.width),
                    (r = this.canvasContext.canvas.height)),
                (this.canvasContext.canvas.width = n * this.renderConfig.dpr),
                (this.canvasContext.canvas.height = r * this.renderConfig.dpr));
            var i, a;
            if (
              this.renderConfig.preserveAspectRatio.indexOf(`meet`) !== -1 ||
              this.renderConfig.preserveAspectRatio.indexOf(`slice`) !== -1
            ) {
              var o = this.renderConfig.preserveAspectRatio.split(` `),
                s = o[1] || `meet`,
                c = o[0] || `xMidYMid`,
                l = c.substr(0, 4),
                u = c.substr(4);
              ((i = n / r),
                (a = this.transformCanvas.w / this.transformCanvas.h),
                (a > i && s === `meet`) || (a < i && s === `slice`)
                  ? ((this.transformCanvas.sx =
                      n / (this.transformCanvas.w / this.renderConfig.dpr)),
                    (this.transformCanvas.sy =
                      n / (this.transformCanvas.w / this.renderConfig.dpr)))
                  : ((this.transformCanvas.sx =
                      r / (this.transformCanvas.h / this.renderConfig.dpr)),
                    (this.transformCanvas.sy =
                      r / (this.transformCanvas.h / this.renderConfig.dpr))),
                l === `xMid` &&
                ((a < i && s === `meet`) || (a > i && s === `slice`))
                  ? (this.transformCanvas.tx =
                      ((n -
                        this.transformCanvas.w * (r / this.transformCanvas.h)) /
                        2) *
                      this.renderConfig.dpr)
                  : l === `xMax` &&
                      ((a < i && s === `meet`) || (a > i && s === `slice`))
                    ? (this.transformCanvas.tx =
                        (n -
                          this.transformCanvas.w *
                            (r / this.transformCanvas.h)) *
                        this.renderConfig.dpr)
                    : (this.transformCanvas.tx = 0),
                u === `YMid` &&
                ((a > i && s === `meet`) || (a < i && s === `slice`))
                  ? (this.transformCanvas.ty =
                      ((r -
                        this.transformCanvas.h * (n / this.transformCanvas.w)) /
                        2) *
                      this.renderConfig.dpr)
                  : u === `YMax` &&
                      ((a > i && s === `meet`) || (a < i && s === `slice`))
                    ? (this.transformCanvas.ty =
                        (r -
                          this.transformCanvas.h *
                            (n / this.transformCanvas.w)) *
                        this.renderConfig.dpr)
                    : (this.transformCanvas.ty = 0));
            } else
              this.renderConfig.preserveAspectRatio === `none`
                ? ((this.transformCanvas.sx =
                    n / (this.transformCanvas.w / this.renderConfig.dpr)),
                  (this.transformCanvas.sy =
                    r / (this.transformCanvas.h / this.renderConfig.dpr)),
                  (this.transformCanvas.tx = 0),
                  (this.transformCanvas.ty = 0))
                : ((this.transformCanvas.sx = this.renderConfig.dpr),
                  (this.transformCanvas.sy = this.renderConfig.dpr),
                  (this.transformCanvas.tx = 0),
                  (this.transformCanvas.ty = 0));
            ((this.transformCanvas.props = [
              this.transformCanvas.sx,
              0,
              0,
              0,
              0,
              this.transformCanvas.sy,
              0,
              0,
              0,
              0,
              1,
              0,
              this.transformCanvas.tx,
              this.transformCanvas.ty,
              0,
              1,
            ]),
              this.ctxTransform(this.transformCanvas.props),
              this.canvasContext.beginPath(),
              this.canvasContext.rect(
                0,
                0,
                this.transformCanvas.w,
                this.transformCanvas.h,
              ),
              this.canvasContext.closePath(),
              this.canvasContext.clip(),
              this.renderFrame(this.renderedFrame, !0));
          }),
          (CanvasRendererBase.prototype.destroy = function () {
            this.renderConfig.clearCanvas &&
              this.animationItem.wrapper &&
              (this.animationItem.wrapper.innerText = ``);
            var e;
            for (e = (this.layers ? this.layers.length : 0) - 1; e >= 0; --e)
              this.elements[e] &&
                this.elements[e].destroy &&
                this.elements[e].destroy();
            ((this.elements.length = 0),
              (this.globalData.canvasContext = null),
              (this.animationItem.container = null),
              (this.destroyed = !0));
          }),
          (CanvasRendererBase.prototype.renderFrame = function (e, t) {
            if (!(
              (this.renderedFrame === e &&
                this.renderConfig.clearCanvas === !0 &&
                !t) ||
              this.destroyed ||
              e === -1
            )) {
              ((this.renderedFrame = e),
                (this.globalData.frameNum =
                  e - this.animationItem._isFirstFrame),
                (this.globalData.frameId += 1),
                (this.globalData._mdf = !this.renderConfig.clearCanvas || t),
                (this.globalData.projectInterface.currentFrame = e));
              var n,
                r = this.layers.length;
              for (
                this.completeLayers || this.checkLayers(e), n = r - 1;
                n >= 0;
                --n
              )
                (this.completeLayers || this.elements[n]) &&
                  this.elements[n].prepareFrame(e - this.layers[n].st);
              if (this.globalData._mdf) {
                for (
                  this.renderConfig.clearCanvas === !0
                    ? this.canvasContext.clearRect(
                        0,
                        0,
                        this.transformCanvas.w,
                        this.transformCanvas.h,
                      )
                    : this.save(),
                    n = r - 1;
                  n >= 0;
                  --n
                )
                  (this.completeLayers || this.elements[n]) &&
                    this.elements[n].renderFrame();
                this.renderConfig.clearCanvas !== !0 && this.restore();
              }
            }
          }),
          (CanvasRendererBase.prototype.buildItem = function (e) {
            var t = this.elements;
            if (!(t[e] || this.layers[e].ty === 99)) {
              var n = this.createItem(this.layers[e], this, this.globalData);
              ((t[e] = n), n.initExpressions());
            }
          }),
          (CanvasRendererBase.prototype.checkPendingElements = function () {
            for (; this.pendingElements.length;)
              this.pendingElements.pop().checkParenting();
          }),
          (CanvasRendererBase.prototype.hide = function () {
            this.animationItem.container.style.display = `none`;
          }),
          (CanvasRendererBase.prototype.show = function () {
            this.animationItem.container.style.display = `block`;
          }));
        function CanvasContext() {
          ((this.opacity = -1),
            (this.transform = createTypedArray(`float32`, 16)),
            (this.fillStyle = ``),
            (this.strokeStyle = ``),
            (this.lineWidth = ``),
            (this.lineCap = ``),
            (this.lineJoin = ``),
            (this.miterLimit = ``),
            (this.id = Math.random()));
        }
        function CVContextData() {
          ((this.stack = []), (this.cArrPos = 0), (this.cTr = new Matrix()));
          var e,
            t = 15;
          for (e = 0; e < t; e += 1) {
            var n = new CanvasContext();
            this.stack[e] = n;
          }
          ((this._length = t),
            (this.nativeContext = null),
            (this.transformMat = new Matrix()),
            (this.currentOpacity = 1),
            (this.currentFillStyle = ``),
            (this.appliedFillStyle = ``),
            (this.currentStrokeStyle = ``),
            (this.appliedStrokeStyle = ``),
            (this.currentLineWidth = ``),
            (this.appliedLineWidth = ``),
            (this.currentLineCap = ``),
            (this.appliedLineCap = ``),
            (this.currentLineJoin = ``),
            (this.appliedLineJoin = ``),
            (this.appliedMiterLimit = ``),
            (this.currentMiterLimit = ``));
        }
        ((CVContextData.prototype.duplicate = function () {
          var e = this._length * 2,
            t = 0;
          for (t = this._length; t < e; t += 1)
            this.stack[t] = new CanvasContext();
          this._length = e;
        }),
          (CVContextData.prototype.reset = function () {
            ((this.cArrPos = 0),
              this.cTr.reset(),
              (this.stack[this.cArrPos].opacity = 1));
          }),
          (CVContextData.prototype.restore = function (e) {
            --this.cArrPos;
            var t = this.stack[this.cArrPos],
              n = t.transform,
              r,
              i = this.cTr.props;
            for (r = 0; r < 16; r += 1) i[r] = n[r];
            if (e) {
              this.nativeContext.restore();
              var a = this.stack[this.cArrPos + 1];
              ((this.appliedFillStyle = a.fillStyle),
                (this.appliedStrokeStyle = a.strokeStyle),
                (this.appliedLineWidth = a.lineWidth),
                (this.appliedLineCap = a.lineCap),
                (this.appliedLineJoin = a.lineJoin),
                (this.appliedMiterLimit = a.miterLimit));
            }
            (this.nativeContext.setTransform(
              n[0],
              n[1],
              n[4],
              n[5],
              n[12],
              n[13],
            ),
              (e || (t.opacity !== -1 && this.currentOpacity !== t.opacity)) &&
                ((this.nativeContext.globalAlpha = t.opacity),
                (this.currentOpacity = t.opacity)),
              (this.currentFillStyle = t.fillStyle),
              (this.currentStrokeStyle = t.strokeStyle),
              (this.currentLineWidth = t.lineWidth),
              (this.currentLineCap = t.lineCap),
              (this.currentLineJoin = t.lineJoin),
              (this.currentMiterLimit = t.miterLimit));
          }),
          (CVContextData.prototype.save = function (e) {
            e && this.nativeContext.save();
            var t = this.cTr.props;
            this._length <= this.cArrPos && this.duplicate();
            var n = this.stack[this.cArrPos],
              r;
            for (r = 0; r < 16; r += 1) n.transform[r] = t[r];
            this.cArrPos += 1;
            var i = this.stack[this.cArrPos];
            ((i.opacity = n.opacity),
              (i.fillStyle = n.fillStyle),
              (i.strokeStyle = n.strokeStyle),
              (i.lineWidth = n.lineWidth),
              (i.lineCap = n.lineCap),
              (i.lineJoin = n.lineJoin),
              (i.miterLimit = n.miterLimit));
          }),
          (CVContextData.prototype.setOpacity = function (e) {
            this.stack[this.cArrPos].opacity = e;
          }),
          (CVContextData.prototype.setContext = function (e) {
            this.nativeContext = e;
          }),
          (CVContextData.prototype.fillStyle = function (e) {
            this.stack[this.cArrPos].fillStyle !== e &&
              ((this.currentFillStyle = e),
              (this.stack[this.cArrPos].fillStyle = e));
          }),
          (CVContextData.prototype.strokeStyle = function (e) {
            this.stack[this.cArrPos].strokeStyle !== e &&
              ((this.currentStrokeStyle = e),
              (this.stack[this.cArrPos].strokeStyle = e));
          }),
          (CVContextData.prototype.lineWidth = function (e) {
            this.stack[this.cArrPos].lineWidth !== e &&
              ((this.currentLineWidth = e),
              (this.stack[this.cArrPos].lineWidth = e));
          }),
          (CVContextData.prototype.lineCap = function (e) {
            this.stack[this.cArrPos].lineCap !== e &&
              ((this.currentLineCap = e),
              (this.stack[this.cArrPos].lineCap = e));
          }),
          (CVContextData.prototype.lineJoin = function (e) {
            this.stack[this.cArrPos].lineJoin !== e &&
              ((this.currentLineJoin = e),
              (this.stack[this.cArrPos].lineJoin = e));
          }),
          (CVContextData.prototype.miterLimit = function (e) {
            this.stack[this.cArrPos].miterLimit !== e &&
              ((this.currentMiterLimit = e),
              (this.stack[this.cArrPos].miterLimit = e));
          }),
          (CVContextData.prototype.transform = function (e) {
            this.transformMat.cloneFromProps(e);
            var t = this.cTr;
            (this.transformMat.multiply(t),
              t.cloneFromProps(this.transformMat.props));
            var n = t.props;
            this.nativeContext.setTransform(
              n[0],
              n[1],
              n[4],
              n[5],
              n[12],
              n[13],
            );
          }),
          (CVContextData.prototype.opacity = function (e) {
            var t = this.stack[this.cArrPos].opacity;
            ((t *= e < 0 ? 0 : e),
              this.stack[this.cArrPos].opacity !== t &&
                (this.currentOpacity !== e &&
                  ((this.nativeContext.globalAlpha = e),
                  (this.currentOpacity = e)),
                (this.stack[this.cArrPos].opacity = t)));
          }),
          (CVContextData.prototype.fill = function (e) {
            (this.appliedFillStyle !== this.currentFillStyle &&
              ((this.appliedFillStyle = this.currentFillStyle),
              (this.nativeContext.fillStyle = this.appliedFillStyle)),
              this.nativeContext.fill(e));
          }),
          (CVContextData.prototype.fillRect = function (e, t, n, r) {
            (this.appliedFillStyle !== this.currentFillStyle &&
              ((this.appliedFillStyle = this.currentFillStyle),
              (this.nativeContext.fillStyle = this.appliedFillStyle)),
              this.nativeContext.fillRect(e, t, n, r));
          }),
          (CVContextData.prototype.stroke = function () {
            (this.appliedStrokeStyle !== this.currentStrokeStyle &&
              ((this.appliedStrokeStyle = this.currentStrokeStyle),
              (this.nativeContext.strokeStyle = this.appliedStrokeStyle)),
              this.appliedLineWidth !== this.currentLineWidth &&
                ((this.appliedLineWidth = this.currentLineWidth),
                (this.nativeContext.lineWidth = this.appliedLineWidth)),
              this.appliedLineCap !== this.currentLineCap &&
                ((this.appliedLineCap = this.currentLineCap),
                (this.nativeContext.lineCap = this.appliedLineCap)),
              this.appliedLineJoin !== this.currentLineJoin &&
                ((this.appliedLineJoin = this.currentLineJoin),
                (this.nativeContext.lineJoin = this.appliedLineJoin)),
              this.appliedMiterLimit !== this.currentMiterLimit &&
                ((this.appliedMiterLimit = this.currentMiterLimit),
                (this.nativeContext.miterLimit = this.appliedMiterLimit)),
              this.nativeContext.stroke());
          }));
        function CVCompElement(e, t, n) {
          ((this.completeLayers = !1),
            (this.layers = e.layers),
            (this.pendingElements = []),
            (this.elements = createSizedArray(this.layers.length)),
            this.initElement(e, t, n),
            (this.tm = e.tm
              ? PropertyFactory.getProp(this, e.tm, 0, t.frameRate, this)
              : { _placeholder: !0 }));
        }
        (extendPrototype(
          [CanvasRendererBase, ICompElement, CVBaseElement],
          CVCompElement,
        ),
          (CVCompElement.prototype.renderInnerContent = function () {
            var e = this.canvasContext;
            (e.beginPath(),
              e.moveTo(0, 0),
              e.lineTo(this.data.w, 0),
              e.lineTo(this.data.w, this.data.h),
              e.lineTo(0, this.data.h),
              e.lineTo(0, 0),
              e.clip());
            var t;
            for (t = this.layers.length - 1; t >= 0; --t)
              (this.completeLayers || this.elements[t]) &&
                this.elements[t].renderFrame();
          }),
          (CVCompElement.prototype.destroy = function () {
            var e;
            for (e = this.layers.length - 1; e >= 0; --e)
              this.elements[e] && this.elements[e].destroy();
            ((this.layers = null), (this.elements = null));
          }),
          (CVCompElement.prototype.createComp = function (e) {
            return new CVCompElement(e, this.globalData, this);
          }));
        function CanvasRenderer(e, t) {
          ((this.animationItem = e),
            (this.renderConfig = {
              clearCanvas: t && t.clearCanvas !== void 0 ? t.clearCanvas : !0,
              context: (t && t.context) || null,
              progressiveLoad: (t && t.progressiveLoad) || !1,
              preserveAspectRatio:
                (t && t.preserveAspectRatio) || `xMidYMid meet`,
              imagePreserveAspectRatio:
                (t && t.imagePreserveAspectRatio) || `xMidYMid slice`,
              contentVisibility: (t && t.contentVisibility) || `visible`,
              className: (t && t.className) || ``,
              id: (t && t.id) || ``,
              runExpressions:
                !t || t.runExpressions === void 0 || t.runExpressions,
            }),
            (this.renderConfig.dpr = (t && t.dpr) || 1),
            this.animationItem.wrapper &&
              (this.renderConfig.dpr =
                (t && t.dpr) || window.devicePixelRatio || 1),
            (this.renderedFrame = -1),
            (this.globalData = {
              frameNum: -1,
              _mdf: !1,
              renderConfig: this.renderConfig,
              currentGlobalAlpha: -1,
            }),
            (this.contextData = new CVContextData()),
            (this.elements = []),
            (this.pendingElements = []),
            (this.transformMat = new Matrix()),
            (this.completeLayers = !1),
            (this.rendererType = `canvas`),
            this.renderConfig.clearCanvas &&
              ((this.ctxTransform = this.contextData.transform.bind(
                this.contextData,
              )),
              (this.ctxOpacity = this.contextData.opacity.bind(
                this.contextData,
              )),
              (this.ctxFillStyle = this.contextData.fillStyle.bind(
                this.contextData,
              )),
              (this.ctxStrokeStyle = this.contextData.strokeStyle.bind(
                this.contextData,
              )),
              (this.ctxLineWidth = this.contextData.lineWidth.bind(
                this.contextData,
              )),
              (this.ctxLineCap = this.contextData.lineCap.bind(
                this.contextData,
              )),
              (this.ctxLineJoin = this.contextData.lineJoin.bind(
                this.contextData,
              )),
              (this.ctxMiterLimit = this.contextData.miterLimit.bind(
                this.contextData,
              )),
              (this.ctxFill = this.contextData.fill.bind(this.contextData)),
              (this.ctxFillRect = this.contextData.fillRect.bind(
                this.contextData,
              )),
              (this.ctxStroke = this.contextData.stroke.bind(this.contextData)),
              (this.save = this.contextData.save.bind(this.contextData))));
        }
        (extendPrototype([CanvasRendererBase], CanvasRenderer),
          (CanvasRenderer.prototype.createComp = function (e) {
            return new CVCompElement(e, this.globalData, this);
          }));
        function HBaseElement() {}
        ((HBaseElement.prototype = {
          checkBlendMode: function () {},
          initRendererElement: function () {
            ((this.baseElement = createTag(this.data.tg || `div`)),
              this.data.hasMask
                ? ((this.svgElement = createNS(`svg`)),
                  (this.layerElement = createNS(`g`)),
                  (this.maskedElement = this.layerElement),
                  this.svgElement.appendChild(this.layerElement),
                  this.baseElement.appendChild(this.svgElement))
                : (this.layerElement = this.baseElement),
              styleDiv(this.baseElement));
          },
          createContainerElements: function () {
            ((this.renderableEffectsManager = new CVEffects(this)),
              (this.transformedElement = this.baseElement),
              (this.maskedElement = this.layerElement),
              this.data.ln &&
                this.layerElement.setAttribute(`id`, this.data.ln),
              this.data.cl &&
                this.layerElement.setAttribute(`class`, this.data.cl),
              this.data.bm !== 0 && this.setBlendMode());
          },
          renderElement: function () {
            var e = this.transformedElement
              ? this.transformedElement.style
              : {};
            if (this.finalTransform._matMdf) {
              var t = this.finalTransform.mat.toCSS();
              ((e.transform = t), (e.webkitTransform = t));
            }
            this.finalTransform._opMdf &&
              (e.opacity = this.finalTransform.mProp.o.v);
          },
          renderFrame: function () {
            this.data.hd ||
              this.hidden ||
              (this.renderTransform(),
              this.renderRenderable(),
              this.renderElement(),
              this.renderInnerContent(),
              (this._isFirstFrame &&= !1));
          },
          destroy: function () {
            ((this.layerElement = null),
              (this.transformedElement = null),
              (this.matteElement &&= null),
              (this.maskManager &&= (this.maskManager.destroy(), null)));
          },
          createRenderableComponents: function () {
            this.maskManager = new MaskElement(
              this.data,
              this,
              this.globalData,
            );
          },
          addEffects: function () {},
          setMatte: function () {},
        }),
          (HBaseElement.prototype.getBaseElement =
            SVGBaseElement.prototype.getBaseElement),
          (HBaseElement.prototype.destroyBaseElement =
            HBaseElement.prototype.destroy),
          (HBaseElement.prototype.buildElementParenting =
            BaseRenderer.prototype.buildElementParenting));
        function HSolidElement(e, t, n) {
          this.initElement(e, t, n);
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            HBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableDOMElement,
          ],
          HSolidElement,
        ),
          (HSolidElement.prototype.createContent = function () {
            var e;
            (this.data.hasMask
              ? ((e = createNS(`rect`)),
                e.setAttribute(`width`, this.data.sw),
                e.setAttribute(`height`, this.data.sh),
                e.setAttribute(`fill`, this.data.sc),
                this.svgElement.setAttribute(`width`, this.data.sw),
                this.svgElement.setAttribute(`height`, this.data.sh))
              : ((e = createTag(`div`)),
                (e.style.width = this.data.sw + `px`),
                (e.style.height = this.data.sh + `px`),
                (e.style.backgroundColor = this.data.sc)),
              this.layerElement.appendChild(e));
          }));
        function HShapeElement(e, t, n) {
          ((this.shapes = []),
            (this.shapesData = e.shapes),
            (this.stylesList = []),
            (this.shapeModifiers = []),
            (this.itemsData = []),
            (this.processedElements = []),
            (this.animatedContents = []),
            (this.shapesContainer = createNS(`g`)),
            this.initElement(e, t, n),
            (this.prevViewData = []),
            (this.currentBBox = { x: 999999, y: -999999, h: 0, w: 0 }));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            HSolidElement,
            SVGShapeElement,
            HBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableElement,
          ],
          HShapeElement,
        ),
          (HShapeElement.prototype._renderShapeFrame =
            HShapeElement.prototype.renderInnerContent),
          (HShapeElement.prototype.createContent = function () {
            var e;
            if (((this.baseElement.style.fontSize = 0), this.data.hasMask))
              (this.layerElement.appendChild(this.shapesContainer),
                (e = this.svgElement));
            else {
              e = createNS(`svg`);
              var t = this.comp.data
                ? this.comp.data
                : this.globalData.compSize;
              (e.setAttribute(`width`, t.w),
                e.setAttribute(`height`, t.h),
                e.appendChild(this.shapesContainer),
                this.layerElement.appendChild(e));
            }
            (this.searchShapes(
              this.shapesData,
              this.itemsData,
              this.prevViewData,
              this.shapesContainer,
              0,
              [],
              !0,
            ),
              this.filterUniqueShapes(),
              (this.shapeCont = e));
          }),
          (HShapeElement.prototype.getTransformedPoint = function (e, t) {
            var n,
              r = e.length;
            for (n = 0; n < r; n += 1)
              t = e[n].mProps.v.applyToPointArray(t[0], t[1], 0);
            return t;
          }),
          (HShapeElement.prototype.calculateShapeBoundingBox = function (e, t) {
            var n = e.sh.v,
              r = e.transformers,
              i,
              a = n._length,
              o,
              s,
              c,
              l;
            if (!(a <= 1)) {
              for (i = 0; i < a - 1; i += 1)
                ((o = this.getTransformedPoint(r, n.v[i])),
                  (s = this.getTransformedPoint(r, n.o[i])),
                  (c = this.getTransformedPoint(r, n.i[i + 1])),
                  (l = this.getTransformedPoint(r, n.v[i + 1])),
                  this.checkBounds(o, s, c, l, t));
              n.c &&
                ((o = this.getTransformedPoint(r, n.v[i])),
                (s = this.getTransformedPoint(r, n.o[i])),
                (c = this.getTransformedPoint(r, n.i[0])),
                (l = this.getTransformedPoint(r, n.v[0])),
                this.checkBounds(o, s, c, l, t));
            }
          }),
          (HShapeElement.prototype.checkBounds = function (e, t, n, r, i) {
            this.getBoundsOfCurve(e, t, n, r);
            var a = this.shapeBoundingBox;
            ((i.x = bmMin(a.left, i.x)),
              (i.xMax = bmMax(a.right, i.xMax)),
              (i.y = bmMin(a.top, i.y)),
              (i.yMax = bmMax(a.bottom, i.yMax)));
          }),
          (HShapeElement.prototype.shapeBoundingBox = {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
          }),
          (HShapeElement.prototype.tempBoundingBox = {
            x: 0,
            xMax: 0,
            y: 0,
            yMax: 0,
            width: 0,
            height: 0,
          }),
          (HShapeElement.prototype.getBoundsOfCurve = function (e, t, n, r) {
            for (
              var i = [
                  [e[0], r[0]],
                  [e[1], r[1]],
                ],
                a,
                o,
                s,
                c,
                l,
                u,
                d,
                f = 0;
              f < 2;
              ++f
            )
              ((o = 6 * e[f] - 12 * t[f] + 6 * n[f]),
                (a = -3 * e[f] + 9 * t[f] - 9 * n[f] + 3 * r[f]),
                (s = 3 * t[f] - 3 * e[f]),
                (o |= 0),
                (a |= 0),
                (s |= 0),
                (a === 0 && o === 0) ||
                  (a === 0
                    ? ((c = -s / o),
                      c > 0 &&
                        c < 1 &&
                        i[f].push(this.calculateF(c, e, t, n, r, f)))
                    : ((l = o * o - 4 * s * a),
                      l >= 0 &&
                        ((u = (-o + bmSqrt(l)) / (2 * a)),
                        u > 0 &&
                          u < 1 &&
                          i[f].push(this.calculateF(u, e, t, n, r, f)),
                        (d = (-o - bmSqrt(l)) / (2 * a)),
                        d > 0 &&
                          d < 1 &&
                          i[f].push(this.calculateF(d, e, t, n, r, f))))));
            ((this.shapeBoundingBox.left = bmMin.apply(null, i[0])),
              (this.shapeBoundingBox.top = bmMin.apply(null, i[1])),
              (this.shapeBoundingBox.right = bmMax.apply(null, i[0])),
              (this.shapeBoundingBox.bottom = bmMax.apply(null, i[1])));
          }),
          (HShapeElement.prototype.calculateF = function (e, t, n, r, i, a) {
            return (
              bmPow(1 - e, 3) * t[a] +
              3 * bmPow(1 - e, 2) * e * n[a] +
              3 * (1 - e) * bmPow(e, 2) * r[a] +
              bmPow(e, 3) * i[a]
            );
          }),
          (HShapeElement.prototype.calculateBoundingBox = function (e, t) {
            var n,
              r = e.length;
            for (n = 0; n < r; n += 1)
              e[n] && e[n].sh
                ? this.calculateShapeBoundingBox(e[n], t)
                : e[n] && e[n].it
                  ? this.calculateBoundingBox(e[n].it, t)
                  : e[n] &&
                    e[n].style &&
                    e[n].w &&
                    this.expandStrokeBoundingBox(e[n].w, t);
          }),
          (HShapeElement.prototype.expandStrokeBoundingBox = function (e, t) {
            var n = 0;
            if (e.keyframes) {
              for (var r = 0; r < e.keyframes.length; r += 1) {
                var i = e.keyframes[r].s;
                i > n && (n = i);
              }
              n *= e.mult;
            } else n = e.v * e.mult;
            ((t.x -= n), (t.xMax += n), (t.y -= n), (t.yMax += n));
          }),
          (HShapeElement.prototype.currentBoxContains = function (e) {
            return (
              this.currentBBox.x <= e.x &&
              this.currentBBox.y <= e.y &&
              this.currentBBox.width + this.currentBBox.x >= e.x + e.width &&
              this.currentBBox.height + this.currentBBox.y >= e.y + e.height
            );
          }),
          (HShapeElement.prototype.renderInnerContent = function () {
            if (
              (this._renderShapeFrame(),
              !this.hidden && (this._isFirstFrame || this._mdf))
            ) {
              var e = this.tempBoundingBox,
                t = 999999;
              if (
                ((e.x = t),
                (e.xMax = -t),
                (e.y = t),
                (e.yMax = -t),
                this.calculateBoundingBox(this.itemsData, e),
                (e.width = e.xMax < e.x ? 0 : e.xMax - e.x),
                (e.height = e.yMax < e.y ? 0 : e.yMax - e.y),
                this.currentBoxContains(e))
              )
                return;
              var n = !1;
              if (
                (this.currentBBox.w !== e.width &&
                  ((this.currentBBox.w = e.width),
                  this.shapeCont.setAttribute(`width`, e.width),
                  (n = !0)),
                this.currentBBox.h !== e.height &&
                  ((this.currentBBox.h = e.height),
                  this.shapeCont.setAttribute(`height`, e.height),
                  (n = !0)),
                n || this.currentBBox.x !== e.x || this.currentBBox.y !== e.y)
              ) {
                ((this.currentBBox.w = e.width),
                  (this.currentBBox.h = e.height),
                  (this.currentBBox.x = e.x),
                  (this.currentBBox.y = e.y),
                  this.shapeCont.setAttribute(
                    `viewBox`,
                    this.currentBBox.x +
                      ` ` +
                      this.currentBBox.y +
                      ` ` +
                      this.currentBBox.w +
                      ` ` +
                      this.currentBBox.h,
                  ));
                var r = this.shapeCont.style,
                  i =
                    `translate(` +
                    this.currentBBox.x +
                    `px,` +
                    this.currentBBox.y +
                    `px)`;
                ((r.transform = i), (r.webkitTransform = i));
              }
            }
          }));
        function HTextElement(e, t, n) {
          ((this.textSpans = []),
            (this.textPaths = []),
            (this.currentBBox = { x: 999999, y: -999999, h: 0, w: 0 }),
            (this.renderType = `svg`),
            (this.isMasked = !1),
            this.initElement(e, t, n));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            HBaseElement,
            HierarchyElement,
            FrameElement,
            RenderableDOMElement,
            ITextElement,
          ],
          HTextElement,
        ),
          (HTextElement.prototype.createContent = function () {
            if (((this.isMasked = this.checkMasks()), this.isMasked)) {
              ((this.renderType = `svg`),
                (this.compW = this.comp.data.w),
                (this.compH = this.comp.data.h),
                this.svgElement.setAttribute(`width`, this.compW),
                this.svgElement.setAttribute(`height`, this.compH));
              var e = createNS(`g`);
              (this.maskedElement.appendChild(e), (this.innerElem = e));
            } else
              ((this.renderType = `html`),
                (this.innerElem = this.layerElement));
            this.checkParenting();
          }),
          (HTextElement.prototype.buildNewText = function () {
            var e = this.textProperty.currentData;
            this.renderedLetters = createSizedArray(e.l ? e.l.length : 0);
            var t = this.innerElem.style,
              n = e.fc ? this.buildColor(e.fc) : `rgba(0,0,0,0)`;
            ((t.fill = n),
              (t.color = n),
              e.sc &&
                ((t.stroke = this.buildColor(e.sc)),
                (t.strokeWidth = e.sw + `px`)));
            var r = this.globalData.fontManager.getFontByName(e.f);
            if (!this.globalData.fontManager.chars)
              if (
                ((t.fontSize = e.finalSize + `px`),
                (t.lineHeight = e.finalSize + `px`),
                r.fClass)
              )
                this.innerElem.className = r.fClass;
              else {
                t.fontFamily = r.fFamily;
                var i = e.fWeight;
                ((t.fontStyle = e.fStyle), (t.fontWeight = i));
              }
            var a,
              o,
              s = e.l;
            o = s.length;
            var c,
              l,
              u,
              d = this.mHelper,
              f,
              p = ``,
              m = 0;
            for (a = 0; a < o; a += 1) {
              if (
                (this.globalData.fontManager.chars
                  ? (this.textPaths[m]
                      ? (c = this.textPaths[m])
                      : ((c = createNS(`path`)),
                        c.setAttribute(`stroke-linecap`, lineCapEnum[1]),
                        c.setAttribute(`stroke-linejoin`, lineJoinEnum[2]),
                        c.setAttribute(`stroke-miterlimit`, `4`)),
                    this.isMasked ||
                      (this.textSpans[m]
                        ? ((l = this.textSpans[m]), (u = l.children[0]))
                        : ((l = createTag(`div`)),
                          (l.style.lineHeight = 0),
                          (u = createNS(`svg`)),
                          u.appendChild(c),
                          styleDiv(l))))
                  : this.isMasked
                    ? (c = this.textPaths[m]
                        ? this.textPaths[m]
                        : createNS(`text`))
                    : this.textSpans[m]
                      ? ((l = this.textSpans[m]), (c = this.textPaths[m]))
                      : ((l = createTag(`span`)),
                        styleDiv(l),
                        (c = createTag(`span`)),
                        styleDiv(c),
                        l.appendChild(c)),
                this.globalData.fontManager.chars)
              ) {
                var g = this.globalData.fontManager.getCharData(
                    e.finalText[a],
                    r.fStyle,
                    this.globalData.fontManager.getFontByName(e.f).fFamily,
                  ),
                  _ = g ? g.data : null;
                if (
                  (d.reset(),
                  _ &&
                    _.shapes &&
                    _.shapes.length &&
                    ((f = _.shapes[0].it),
                    d.scale(e.finalSize / 100, e.finalSize / 100),
                    (p = this.createPathShape(d, f)),
                    c.setAttribute(`d`, p)),
                  this.isMasked)
                )
                  this.innerElem.appendChild(c);
                else {
                  if ((this.innerElem.appendChild(l), _ && _.shapes)) {
                    document.body.appendChild(u);
                    var y = u.getBBox();
                    (u.setAttribute(`width`, y.width + 2),
                      u.setAttribute(`height`, y.height + 2),
                      u.setAttribute(
                        `viewBox`,
                        y.x -
                          1 +
                          ` ` +
                          (y.y - 1) +
                          ` ` +
                          (y.width + 2) +
                          ` ` +
                          (y.height + 2),
                      ));
                    var b = u.style,
                      x = `translate(` + (y.x - 1) + `px,` + (y.y - 1) + `px)`;
                    ((b.transform = x),
                      (b.webkitTransform = x),
                      (s[a].yOffset = y.y - 1));
                  } else
                    (u.setAttribute(`width`, 1), u.setAttribute(`height`, 1));
                  l.appendChild(u);
                }
              } else if (
                ((c.textContent = s[a].val),
                c.setAttributeNS(
                  `http://www.w3.org/XML/1998/namespace`,
                  `xml:space`,
                  `preserve`,
                ),
                this.isMasked)
              )
                this.innerElem.appendChild(c);
              else {
                this.innerElem.appendChild(l);
                var S = c.style,
                  C = `translate3d(0,` + -e.finalSize / 1.2 + `px,0)`;
                ((S.transform = C), (S.webkitTransform = C));
              }
              (this.isMasked
                ? (this.textSpans[m] = c)
                : (this.textSpans[m] = l),
                (this.textSpans[m].style.display = `block`),
                (this.textPaths[m] = c),
                (m += 1));
            }
            for (; m < this.textSpans.length;)
              ((this.textSpans[m].style.display = `none`), (m += 1));
          }),
          (HTextElement.prototype.renderInnerContent = function () {
            this.validateText();
            var e;
            if (this.data.singleShape) {
              if (!this._isFirstFrame && !this.lettersChangedFlag) return;
              if (this.isMasked && this.finalTransform._matMdf) {
                (this.svgElement.setAttribute(
                  `viewBox`,
                  -this.finalTransform.mProp.p.v[0] +
                    ` ` +
                    -this.finalTransform.mProp.p.v[1] +
                    ` ` +
                    this.compW +
                    ` ` +
                    this.compH,
                ),
                  (e = this.svgElement.style));
                var t =
                  `translate(` +
                  -this.finalTransform.mProp.p.v[0] +
                  `px,` +
                  -this.finalTransform.mProp.p.v[1] +
                  `px)`;
                ((e.transform = t), (e.webkitTransform = t));
              }
            }
            if (
              (this.textAnimator.getMeasures(
                this.textProperty.currentData,
                this.lettersChangedFlag,
              ),
              !(
                !this.lettersChangedFlag &&
                !this.textAnimator.lettersChangedFlag
              ))
            ) {
              var n,
                r,
                i = 0,
                a = this.textAnimator.renderedLetters,
                o = this.textProperty.currentData.l;
              r = o.length;
              var s, c, l;
              for (n = 0; n < r; n += 1)
                o[n].n
                  ? (i += 1)
                  : ((c = this.textSpans[n]),
                    (l = this.textPaths[n]),
                    (s = a[i]),
                    (i += 1),
                    s._mdf.m &&
                      (this.isMasked
                        ? c.setAttribute(`transform`, s.m)
                        : ((c.style.webkitTransform = s.m),
                          (c.style.transform = s.m))),
                    (c.style.opacity = s.o),
                    s.sw && s._mdf.sw && l.setAttribute(`stroke-width`, s.sw),
                    s.sc && s._mdf.sc && l.setAttribute(`stroke`, s.sc),
                    s.fc &&
                      s._mdf.fc &&
                      (l.setAttribute(`fill`, s.fc), (l.style.color = s.fc)));
              if (
                this.innerElem.getBBox &&
                !this.hidden &&
                (this._isFirstFrame || this._mdf)
              ) {
                var u = this.innerElem.getBBox();
                (this.currentBBox.w !== u.width &&
                  ((this.currentBBox.w = u.width),
                  this.svgElement.setAttribute(`width`, u.width)),
                  this.currentBBox.h !== u.height &&
                    ((this.currentBBox.h = u.height),
                    this.svgElement.setAttribute(`height`, u.height)));
                var d = 1;
                if (
                  this.currentBBox.w !== u.width + d * 2 ||
                  this.currentBBox.h !== u.height + d * 2 ||
                  this.currentBBox.x !== u.x - d ||
                  this.currentBBox.y !== u.y - d
                ) {
                  ((this.currentBBox.w = u.width + d * 2),
                    (this.currentBBox.h = u.height + d * 2),
                    (this.currentBBox.x = u.x - d),
                    (this.currentBBox.y = u.y - d),
                    this.svgElement.setAttribute(
                      `viewBox`,
                      this.currentBBox.x +
                        ` ` +
                        this.currentBBox.y +
                        ` ` +
                        this.currentBBox.w +
                        ` ` +
                        this.currentBBox.h,
                    ),
                    (e = this.svgElement.style));
                  var f =
                    `translate(` +
                    this.currentBBox.x +
                    `px,` +
                    this.currentBBox.y +
                    `px)`;
                  ((e.transform = f), (e.webkitTransform = f));
                }
              }
            }
          }));
        function HCameraElement(e, t, n) {
          (this.initFrame(), this.initBaseData(e, t, n), this.initHierarchy());
          var r = PropertyFactory.getProp;
          if (
            ((this.pe = r(this, e.pe, 0, 0, this)),
            e.ks.p.s
              ? ((this.px = r(this, e.ks.p.x, 1, 0, this)),
                (this.py = r(this, e.ks.p.y, 1, 0, this)),
                (this.pz = r(this, e.ks.p.z, 1, 0, this)))
              : (this.p = r(this, e.ks.p, 1, 0, this)),
            e.ks.a && (this.a = r(this, e.ks.a, 1, 0, this)),
            e.ks.or.k.length && e.ks.or.k[0].to)
          ) {
            var i,
              a = e.ks.or.k.length;
            for (i = 0; i < a; i += 1)
              ((e.ks.or.k[i].to = null), (e.ks.or.k[i].ti = null));
          }
          ((this.or = r(this, e.ks.or, 1, degToRads, this)),
            (this.or.sh = !0),
            (this.rx = r(this, e.ks.rx, 0, degToRads, this)),
            (this.ry = r(this, e.ks.ry, 0, degToRads, this)),
            (this.rz = r(this, e.ks.rz, 0, degToRads, this)),
            (this.mat = new Matrix()),
            (this._prevMat = new Matrix()),
            (this._isFirstFrame = !0),
            (this.finalTransform = { mProp: this }));
        }
        (extendPrototype(
          [BaseElement, FrameElement, HierarchyElement],
          HCameraElement,
        ),
          (HCameraElement.prototype.setup = function () {
            var e,
              t = this.comp.threeDElements.length,
              n,
              r,
              i;
            for (e = 0; e < t; e += 1)
              if (((n = this.comp.threeDElements[e]), n.type === `3d`)) {
                ((r = n.perspectiveElem.style), (i = n.container.style));
                var a = this.pe.v + `px`,
                  o = `0px 0px 0px`,
                  s = `matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)`;
                ((r.perspective = a),
                  (r.webkitPerspective = a),
                  (i.transformOrigin = o),
                  (i.mozTransformOrigin = o),
                  (i.webkitTransformOrigin = o),
                  (r.transform = s),
                  (r.webkitTransform = s));
              }
          }),
          (HCameraElement.prototype.createElements = function () {}),
          (HCameraElement.prototype.hide = function () {}),
          (HCameraElement.prototype.renderFrame = function () {
            var e = this._isFirstFrame,
              t,
              n;
            if (this.hierarchy)
              for (n = this.hierarchy.length, t = 0; t < n; t += 1)
                e = this.hierarchy[t].finalTransform.mProp._mdf || e;
            if (
              e ||
              this.pe._mdf ||
              (this.p && this.p._mdf) ||
              (this.px && (this.px._mdf || this.py._mdf || this.pz._mdf)) ||
              this.rx._mdf ||
              this.ry._mdf ||
              this.rz._mdf ||
              this.or._mdf ||
              (this.a && this.a._mdf)
            ) {
              if ((this.mat.reset(), this.hierarchy))
                for (n = this.hierarchy.length - 1, t = n; t >= 0; --t) {
                  var r = this.hierarchy[t].finalTransform.mProp;
                  (this.mat.translate(-r.p.v[0], -r.p.v[1], r.p.v[2]),
                    this.mat
                      .rotateX(-r.or.v[0])
                      .rotateY(-r.or.v[1])
                      .rotateZ(r.or.v[2]),
                    this.mat.rotateX(-r.rx.v).rotateY(-r.ry.v).rotateZ(r.rz.v),
                    this.mat.scale(1 / r.s.v[0], 1 / r.s.v[1], 1 / r.s.v[2]),
                    this.mat.translate(r.a.v[0], r.a.v[1], r.a.v[2]));
                }
              if (
                (this.p
                  ? this.mat.translate(-this.p.v[0], -this.p.v[1], this.p.v[2])
                  : this.mat.translate(-this.px.v, -this.py.v, this.pz.v),
                this.a)
              ) {
                var i = this.p
                    ? [
                        this.p.v[0] - this.a.v[0],
                        this.p.v[1] - this.a.v[1],
                        this.p.v[2] - this.a.v[2],
                      ]
                    : [
                        this.px.v - this.a.v[0],
                        this.py.v - this.a.v[1],
                        this.pz.v - this.a.v[2],
                      ],
                  a = Math.sqrt(i[0] ** 2 + i[1] ** 2 + i[2] ** 2),
                  o = [i[0] / a, i[1] / a, i[2] / a],
                  s = Math.sqrt(o[2] * o[2] + o[0] * o[0]),
                  c = Math.atan2(o[1], s),
                  l = Math.atan2(o[0], -o[2]);
                this.mat.rotateY(l).rotateX(-c);
              }
              (this.mat
                .rotateX(-this.rx.v)
                .rotateY(-this.ry.v)
                .rotateZ(this.rz.v),
                this.mat
                  .rotateX(-this.or.v[0])
                  .rotateY(-this.or.v[1])
                  .rotateZ(this.or.v[2]),
                this.mat.translate(
                  this.globalData.compSize.w / 2,
                  this.globalData.compSize.h / 2,
                  0,
                ),
                this.mat.translate(0, 0, this.pe.v));
              var u = !this._prevMat.equals(this.mat);
              if ((u || this.pe._mdf) && this.comp.threeDElements) {
                n = this.comp.threeDElements.length;
                var d, f, p;
                for (t = 0; t < n; t += 1)
                  if (((d = this.comp.threeDElements[t]), d.type === `3d`)) {
                    if (u) {
                      var m = this.mat.toCSS();
                      ((p = d.container.style),
                        (p.transform = m),
                        (p.webkitTransform = m));
                    }
                    this.pe._mdf &&
                      ((f = d.perspectiveElem.style),
                      (f.perspective = this.pe.v + `px`),
                      (f.webkitPerspective = this.pe.v + `px`));
                  }
                this.mat.clone(this._prevMat);
              }
            }
            this._isFirstFrame = !1;
          }),
          (HCameraElement.prototype.prepareFrame = function (e) {
            this.prepareProperties(e, !0);
          }),
          (HCameraElement.prototype.destroy = function () {}),
          (HCameraElement.prototype.getBaseElement = function () {
            return null;
          }));
        function HImageElement(e, t, n) {
          ((this.assetData = t.getAssetData(e.refId)),
            this.initElement(e, t, n));
        }
        (extendPrototype(
          [
            BaseElement,
            TransformElement,
            HBaseElement,
            HSolidElement,
            HierarchyElement,
            FrameElement,
            RenderableElement,
          ],
          HImageElement,
        ),
          (HImageElement.prototype.createContent = function () {
            var e = this.globalData.getAssetsPath(this.assetData),
              t = new Image();
            (this.data.hasMask
              ? ((this.imageElem = createNS(`image`)),
                this.imageElem.setAttribute(`width`, this.assetData.w + `px`),
                this.imageElem.setAttribute(`height`, this.assetData.h + `px`),
                this.imageElem.setAttributeNS(
                  `http://www.w3.org/1999/xlink`,
                  `href`,
                  e,
                ),
                this.layerElement.appendChild(this.imageElem),
                this.baseElement.setAttribute(`width`, this.assetData.w),
                this.baseElement.setAttribute(`height`, this.assetData.h))
              : this.layerElement.appendChild(t),
              (t.crossOrigin = `anonymous`),
              (t.src = e),
              this.data.ln &&
                this.baseElement.setAttribute(`id`, this.data.ln));
          }));
        function HybridRendererBase(e, t) {
          ((this.animationItem = e),
            (this.layers = null),
            (this.renderedFrame = -1),
            (this.renderConfig = {
              className: (t && t.className) || ``,
              imagePreserveAspectRatio:
                (t && t.imagePreserveAspectRatio) || `xMidYMid slice`,
              hideOnTransparent: !(t && t.hideOnTransparent === !1),
              filterSize: {
                width: (t && t.filterSize && t.filterSize.width) || `400%`,
                height: (t && t.filterSize && t.filterSize.height) || `400%`,
                x: (t && t.filterSize && t.filterSize.x) || `-100%`,
                y: (t && t.filterSize && t.filterSize.y) || `-100%`,
              },
            }),
            (this.globalData = {
              _mdf: !1,
              frameNum: -1,
              renderConfig: this.renderConfig,
            }),
            (this.pendingElements = []),
            (this.elements = []),
            (this.threeDElements = []),
            (this.destroyed = !1),
            (this.camera = null),
            (this.supports3d = !0),
            (this.rendererType = `html`));
        }
        (extendPrototype([BaseRenderer], HybridRendererBase),
          (HybridRendererBase.prototype.buildItem =
            SVGRenderer.prototype.buildItem),
          (HybridRendererBase.prototype.checkPendingElements = function () {
            for (; this.pendingElements.length;)
              this.pendingElements.pop().checkParenting();
          }),
          (HybridRendererBase.prototype.appendElementInPos = function (e, t) {
            var n = e.getBaseElement();
            if (n) {
              var r = this.layers[t];
              if (!r.ddd || !this.supports3d)
                if (this.threeDElements) this.addTo3dContainer(n, t);
                else {
                  for (var i = 0, a, o, s; i < t;)
                    (this.elements[i] &&
                      this.elements[i] !== !0 &&
                      this.elements[i].getBaseElement &&
                      ((o = this.elements[i]),
                      (s = this.layers[i].ddd
                        ? this.getThreeDContainerByPos(i)
                        : o.getBaseElement()),
                      (a = s || a)),
                      (i += 1));
                  a
                    ? (!r.ddd || !this.supports3d) &&
                      this.layerElement.insertBefore(n, a)
                    : (!r.ddd || !this.supports3d) &&
                      this.layerElement.appendChild(n);
                }
              else this.addTo3dContainer(n, t);
            }
          }),
          (HybridRendererBase.prototype.createShape = function (e) {
            return this.supports3d
              ? new HShapeElement(e, this.globalData, this)
              : new SVGShapeElement(e, this.globalData, this);
          }),
          (HybridRendererBase.prototype.createText = function (e) {
            return this.supports3d
              ? new HTextElement(e, this.globalData, this)
              : new SVGTextLottieElement(e, this.globalData, this);
          }),
          (HybridRendererBase.prototype.createCamera = function (e) {
            return (
              (this.camera = new HCameraElement(e, this.globalData, this)),
              this.camera
            );
          }),
          (HybridRendererBase.prototype.createImage = function (e) {
            return this.supports3d
              ? new HImageElement(e, this.globalData, this)
              : new IImageElement(e, this.globalData, this);
          }),
          (HybridRendererBase.prototype.createSolid = function (e) {
            return this.supports3d
              ? new HSolidElement(e, this.globalData, this)
              : new ISolidElement(e, this.globalData, this);
          }),
          (HybridRendererBase.prototype.createNull =
            SVGRenderer.prototype.createNull),
          (HybridRendererBase.prototype.getThreeDContainerByPos = function (e) {
            for (var t = 0, n = this.threeDElements.length; t < n;) {
              if (
                this.threeDElements[t].startPos <= e &&
                this.threeDElements[t].endPos >= e
              )
                return this.threeDElements[t].perspectiveElem;
              t += 1;
            }
            return null;
          }),
          (HybridRendererBase.prototype.createThreeDContainer = function (
            e,
            t,
          ) {
            var n = createTag(`div`),
              r,
              i;
            styleDiv(n);
            var a = createTag(`div`);
            if ((styleDiv(a), t === `3d`)) {
              ((r = n.style),
                (r.width = this.globalData.compSize.w + `px`),
                (r.height = this.globalData.compSize.h + `px`));
              var o = `50% 50%`;
              ((r.webkitTransformOrigin = o),
                (r.mozTransformOrigin = o),
                (r.transformOrigin = o),
                (i = a.style));
              var s = `matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)`;
              ((i.transform = s), (i.webkitTransform = s));
            }
            n.appendChild(a);
            var c = {
              container: a,
              perspectiveElem: n,
              startPos: e,
              endPos: e,
              type: t,
            };
            return (this.threeDElements.push(c), c);
          }),
          (HybridRendererBase.prototype.build3dContainers = function () {
            var e,
              t = this.layers.length,
              n,
              r = ``;
            for (e = 0; e < t; e += 1)
              this.layers[e].ddd && this.layers[e].ty !== 3
                ? (r !== `3d` &&
                    ((r = `3d`), (n = this.createThreeDContainer(e, `3d`))),
                  (n.endPos = Math.max(n.endPos, e)))
                : (r !== `2d` &&
                    ((r = `2d`), (n = this.createThreeDContainer(e, `2d`))),
                  (n.endPos = Math.max(n.endPos, e)));
            for (t = this.threeDElements.length, e = t - 1; e >= 0; --e)
              this.resizerElem.appendChild(
                this.threeDElements[e].perspectiveElem,
              );
          }),
          (HybridRendererBase.prototype.addTo3dContainer = function (e, t) {
            for (var n = 0, r = this.threeDElements.length; n < r;) {
              if (t <= this.threeDElements[n].endPos) {
                for (var i = this.threeDElements[n].startPos, a; i < t;)
                  (this.elements[i] &&
                    this.elements[i].getBaseElement &&
                    (a = this.elements[i].getBaseElement()),
                    (i += 1));
                a
                  ? this.threeDElements[n].container.insertBefore(e, a)
                  : this.threeDElements[n].container.appendChild(e);
                break;
              }
              n += 1;
            }
          }),
          (HybridRendererBase.prototype.configAnimation = function (e) {
            var t = createTag(`div`),
              n = this.animationItem.wrapper,
              r = t.style;
            ((r.width = e.w + `px`),
              (r.height = e.h + `px`),
              (this.resizerElem = t),
              styleDiv(t),
              (r.transformStyle = `flat`),
              (r.mozTransformStyle = `flat`),
              (r.webkitTransformStyle = `flat`),
              this.renderConfig.className &&
                t.setAttribute(`class`, this.renderConfig.className),
              n.appendChild(t),
              (r.overflow = `hidden`));
            var i = createNS(`svg`);
            (i.setAttribute(`width`, `1`),
              i.setAttribute(`height`, `1`),
              styleDiv(i),
              this.resizerElem.appendChild(i));
            var a = createNS(`defs`);
            (i.appendChild(a),
              (this.data = e),
              this.setupGlobalData(e, i),
              (this.globalData.defs = a),
              (this.layers = e.layers),
              (this.layerElement = this.resizerElem),
              this.build3dContainers(),
              this.updateContainerSize());
          }),
          (HybridRendererBase.prototype.destroy = function () {
            (this.animationItem.wrapper &&
              (this.animationItem.wrapper.innerText = ``),
              (this.animationItem.container = null),
              (this.globalData.defs = null));
            var e,
              t = this.layers ? this.layers.length : 0;
            for (e = 0; e < t; e += 1)
              this.elements[e] &&
                this.elements[e].destroy &&
                this.elements[e].destroy();
            ((this.elements.length = 0),
              (this.destroyed = !0),
              (this.animationItem = null));
          }),
          (HybridRendererBase.prototype.updateContainerSize = function () {
            var e = this.animationItem.wrapper.offsetWidth,
              t = this.animationItem.wrapper.offsetHeight,
              n = e / t,
              r = this.globalData.compSize.w / this.globalData.compSize.h,
              i,
              a,
              o,
              s;
            r > n
              ? ((i = e / this.globalData.compSize.w),
                (a = e / this.globalData.compSize.w),
                (o = 0),
                (s =
                  (t -
                    this.globalData.compSize.h *
                      (e / this.globalData.compSize.w)) /
                  2))
              : ((i = t / this.globalData.compSize.h),
                (a = t / this.globalData.compSize.h),
                (o =
                  (e -
                    this.globalData.compSize.w *
                      (t / this.globalData.compSize.h)) /
                  2),
                (s = 0));
            var c = this.resizerElem.style;
            ((c.webkitTransform =
              `matrix3d(` +
              i +
              `,0,0,0,0,` +
              a +
              `,0,0,0,0,1,0,` +
              o +
              `,` +
              s +
              `,0,1)`),
              (c.transform = c.webkitTransform));
          }),
          (HybridRendererBase.prototype.renderFrame =
            SVGRenderer.prototype.renderFrame),
          (HybridRendererBase.prototype.hide = function () {
            this.resizerElem.style.display = `none`;
          }),
          (HybridRendererBase.prototype.show = function () {
            this.resizerElem.style.display = `block`;
          }),
          (HybridRendererBase.prototype.initItems = function () {
            if ((this.buildAllItems(), this.camera)) this.camera.setup();
            else {
              var e = this.globalData.compSize.w,
                t = this.globalData.compSize.h,
                n,
                r = this.threeDElements.length;
              for (n = 0; n < r; n += 1) {
                var i = this.threeDElements[n].perspectiveElem.style;
                ((i.webkitPerspective = Math.sqrt(e ** 2 + t ** 2) + `px`),
                  (i.perspective = i.webkitPerspective));
              }
            }
          }),
          (HybridRendererBase.prototype.searchExtraCompositions = function (e) {
            var t,
              n = e.length,
              r = createTag(`div`);
            for (t = 0; t < n; t += 1)
              if (e[t].xt) {
                var i = this.createComp(e[t], r, this.globalData.comp, null);
                (i.initExpressions(),
                  this.globalData.projectInterface.registerComposition(i));
              }
          }));
        function HCompElement(e, t, n) {
          ((this.layers = e.layers),
            (this.supports3d = !e.hasMask),
            (this.completeLayers = !1),
            (this.pendingElements = []),
            (this.elements = this.layers
              ? createSizedArray(this.layers.length)
              : []),
            this.initElement(e, t, n),
            (this.tm = e.tm
              ? PropertyFactory.getProp(this, e.tm, 0, t.frameRate, this)
              : { _placeholder: !0 }));
        }
        (extendPrototype(
          [HybridRendererBase, ICompElement, HBaseElement],
          HCompElement,
        ),
          (HCompElement.prototype._createBaseContainerElements =
            HCompElement.prototype.createContainerElements),
          (HCompElement.prototype.createContainerElements = function () {
            (this._createBaseContainerElements(),
              this.data.hasMask
                ? (this.svgElement.setAttribute(`width`, this.data.w),
                  this.svgElement.setAttribute(`height`, this.data.h),
                  (this.transformedElement = this.baseElement))
                : (this.transformedElement = this.layerElement));
          }),
          (HCompElement.prototype.addTo3dContainer = function (e, t) {
            for (var n = 0, r; n < t;)
              (this.elements[n] &&
                this.elements[n].getBaseElement &&
                (r = this.elements[n].getBaseElement()),
                (n += 1));
            r
              ? this.layerElement.insertBefore(e, r)
              : this.layerElement.appendChild(e);
          }),
          (HCompElement.prototype.createComp = function (e) {
            return this.supports3d
              ? new HCompElement(e, this.globalData, this)
              : new SVGCompElement(e, this.globalData, this);
          }));
        function HybridRenderer(e, t) {
          ((this.animationItem = e),
            (this.layers = null),
            (this.renderedFrame = -1),
            (this.renderConfig = {
              className: (t && t.className) || ``,
              imagePreserveAspectRatio:
                (t && t.imagePreserveAspectRatio) || `xMidYMid slice`,
              hideOnTransparent: !(t && t.hideOnTransparent === !1),
              filterSize: {
                width: (t && t.filterSize && t.filterSize.width) || `400%`,
                height: (t && t.filterSize && t.filterSize.height) || `400%`,
                x: (t && t.filterSize && t.filterSize.x) || `-100%`,
                y: (t && t.filterSize && t.filterSize.y) || `-100%`,
              },
              runExpressions:
                !t || t.runExpressions === void 0 || t.runExpressions,
            }),
            (this.globalData = {
              _mdf: !1,
              frameNum: -1,
              renderConfig: this.renderConfig,
            }),
            (this.pendingElements = []),
            (this.elements = []),
            (this.threeDElements = []),
            (this.destroyed = !1),
            (this.camera = null),
            (this.supports3d = !0),
            (this.rendererType = `html`));
        }
        (extendPrototype([HybridRendererBase], HybridRenderer),
          (HybridRenderer.prototype.createComp = function (e) {
            return this.supports3d
              ? new HCompElement(e, this.globalData, this)
              : new SVGCompElement(e, this.globalData, this);
          }));
        var CompExpressionInterface = (function () {
          return function (e) {
            function t(t) {
              for (var n = 0, r = e.layers.length; n < r;) {
                if (e.layers[n].nm === t || e.layers[n].ind === t)
                  return e.elements[n].layerInterface;
                n += 1;
              }
              return null;
            }
            return (
              Object.defineProperty(t, "_name", { value: e.data.nm }),
              (t.layer = t),
              (t.pixelAspect = 1),
              (t.height = e.data.h || e.globalData.compSize.h),
              (t.width = e.data.w || e.globalData.compSize.w),
              (t.pixelAspect = 1),
              (t.frameDuration = 1 / e.globalData.frameRate),
              (t.displayStartTime = 0),
              (t.numLayers = e.layers.length),
              t
            );
          };
        })();
        function _typeof$2(e) {
          "@babel/helpers - typeof";
          return (
            (_typeof$2 =
              typeof Symbol == `function` && typeof Symbol.iterator == `symbol`
                ? function (e) {
                    return typeof e;
                  }
                : function (e) {
                    return e &&
                      typeof Symbol == `function` &&
                      e.constructor === Symbol &&
                      e !== Symbol.prototype
                      ? `symbol`
                      : typeof e;
                  }),
            _typeof$2(e)
          );
        }
        function seedRandom(e, t) {
          var n = this,
            r = 256,
            i = 6,
            a = 52,
            o = `random`,
            s = t.pow(r, i),
            c = t.pow(2, a),
            l = c * 2,
            u = r - 1,
            d;
          function f(n, a, u) {
            var d = [];
            a = a === !0 ? { entropy: !0 } : a || {};
            var f = _(g(a.entropy ? [n, b(e)] : n === null ? y() : n, 3), d),
              x = new p(d),
              S = function () {
                for (var e = x.g(i), t = s, n = 0; e < c;)
                  ((e = (e + n) * r), (t *= r), (n = x.g(1)));
                for (; e >= l;) ((e /= 2), (t /= 2), (n >>>= 1));
                return (e + n) / t;
              };
            return (
              (S.int32 = function () {
                return x.g(4) | 0;
              }),
              (S.quick = function () {
                return x.g(4) / 4294967296;
              }),
              (S.double = S),
              _(b(x.S), e),
              (
                a.pass ||
                u ||
                function (e, n, r, i) {
                  return (
                    i &&
                      (i.S && m(i, x),
                      (e.state = function () {
                        return m(x, {});
                      })),
                    r ? ((t[o] = e), n) : e
                  );
                }
              )(S, f, `global` in a ? a.global : this == t, a.state)
            );
          }
          t[`seed` + o] = f;
          function p(e) {
            var t,
              n = e.length,
              i = this,
              a = 0,
              o = (i.i = i.j = 0),
              s = (i.S = []);
            for (n || (e = [n++]); a < r;) s[a] = a++;
            for (a = 0; a < r; a++)
              ((s[a] = s[(o = u & (o + e[a % n] + (t = s[a])))]), (s[o] = t));
            i.g = function (e) {
              for (var t, n = 0, a = i.i, o = i.j, s = i.S; e--;)
                ((t = s[(a = u & (a + 1))]),
                  (n =
                    n * r +
                    s[u & ((s[a] = s[(o = u & (o + t))]) + (s[o] = t))]));
              return ((i.i = a), (i.j = o), n);
            };
          }
          function m(e, t) {
            return ((t.i = e.i), (t.j = e.j), (t.S = e.S.slice()), t);
          }
          function g(e, t) {
            var n = [],
              r = _typeof$2(e),
              i;
            if (t && r == `object`)
              for (i in e)
                try {
                  n.push(g(e[i], t - 1));
                } catch {}
            return n.length ? n : r == `string` ? e : e + `\0`;
          }
          function _(e, t) {
            for (var n = e + ``, r, i = 0; i < n.length;)
              t[u & i] = u & ((r ^= t[u & i] * 19) + n.charCodeAt(i++));
            return b(t);
          }
          function y() {
            try {
              if (d) return b(d.randomBytes(r));
              var t = new Uint8Array(r);
              return ((n.crypto || n.msCrypto).getRandomValues(t), b(t));
            } catch {
              var i = n.navigator,
                a = i && i.plugins;
              return [+new Date(), n, a, n.screen, b(e)];
            }
          }
          function b(e) {
            return String.fromCharCode.apply(0, e);
          }
          _(t.random(), e);
        }
        function initialize$2(e) {
          seedRandom([], e);
        }
        var propTypes = { SHAPE: `shape` };
        function _typeof$1(e) {
          "@babel/helpers - typeof";
          return (
            (_typeof$1 =
              typeof Symbol == `function` && typeof Symbol.iterator == `symbol`
                ? function (e) {
                    return typeof e;
                  }
                : function (e) {
                    return e &&
                      typeof Symbol == `function` &&
                      e.constructor === Symbol &&
                      e !== Symbol.prototype
                      ? `symbol`
                      : typeof e;
                  }),
            _typeof$1(e)
          );
        }
        var ExpressionManager = (function () {
            var ob = {},
              Math = BMMath,
              window = null,
              document = null,
              XMLHttpRequest = null,
              fetch = null,
              frames = null,
              _lottieGlobal = {};
            initialize$2(BMMath);
            function resetFrame() {
              _lottieGlobal = {};
            }
            function $bm_isInstanceOfArray(e) {
              return e.constructor === Array || e.constructor === Float32Array;
            }
            function isNumerable(e, t) {
              return (
                e === `number` ||
                t instanceof Number ||
                e === `boolean` ||
                e === `string`
              );
            }
            function $bm_neg(e) {
              var t = _typeof$1(e);
              if (t === `number` || e instanceof Number || t === `boolean`)
                return -e;
              if ($bm_isInstanceOfArray(e)) {
                var n,
                  r = e.length,
                  i = [];
                for (n = 0; n < r; n += 1) i[n] = -e[n];
                return i;
              }
              return e.propType ? e.v : -e;
            }
            var easeInBez = BezierFactory.getBezierEasing(
                0.333,
                0,
                0.833,
                0.833,
                `easeIn`,
              ).get,
              easeOutBez = BezierFactory.getBezierEasing(
                0.167,
                0.167,
                0.667,
                1,
                `easeOut`,
              ).get,
              easeInOutBez = BezierFactory.getBezierEasing(
                0.33,
                0,
                0.667,
                1,
                `easeInOut`,
              ).get;
            function sum(e, t) {
              var n = _typeof$1(e),
                r = _typeof$1(t);
              if (
                (isNumerable(n, e) && isNumerable(r, t)) ||
                n === `string` ||
                r === `string`
              )
                return e + t;
              if ($bm_isInstanceOfArray(e) && isNumerable(r, t))
                return ((e = e.slice(0)), (e[0] += t), e);
              if (isNumerable(n, e) && $bm_isInstanceOfArray(t))
                return ((t = t.slice(0)), (t[0] = e + t[0]), t);
              if ($bm_isInstanceOfArray(e) && $bm_isInstanceOfArray(t)) {
                for (
                  var i = 0, a = e.length, o = t.length, s = [];
                  i < a || i < o;
                )
                  ((typeof e[i] == `number` || e[i] instanceof Number) &&
                  (typeof t[i] == `number` || t[i] instanceof Number)
                    ? (s[i] = e[i] + t[i])
                    : (s[i] = t[i] === void 0 ? e[i] : e[i] || t[i]),
                    (i += 1));
                return s;
              }
              return 0;
            }
            var add = sum;
            function sub(e, t) {
              var n = _typeof$1(e),
                r = _typeof$1(t);
              if (isNumerable(n, e) && isNumerable(r, t))
                return (
                  n === `string` && (e = parseInt(e, 10)),
                  r === `string` && (t = parseInt(t, 10)),
                  e - t
                );
              if ($bm_isInstanceOfArray(e) && isNumerable(r, t))
                return ((e = e.slice(0)), (e[0] -= t), e);
              if (isNumerable(n, e) && $bm_isInstanceOfArray(t))
                return ((t = t.slice(0)), (t[0] = e - t[0]), t);
              if ($bm_isInstanceOfArray(e) && $bm_isInstanceOfArray(t)) {
                for (
                  var i = 0, a = e.length, o = t.length, s = [];
                  i < a || i < o;
                )
                  ((typeof e[i] == `number` || e[i] instanceof Number) &&
                  (typeof t[i] == `number` || t[i] instanceof Number)
                    ? (s[i] = e[i] - t[i])
                    : (s[i] = t[i] === void 0 ? e[i] : e[i] || t[i]),
                    (i += 1));
                return s;
              }
              return 0;
            }
            function mul(e, t) {
              var n = _typeof$1(e),
                r = _typeof$1(t),
                i;
              if (isNumerable(n, e) && isNumerable(r, t)) return e * t;
              var a, o;
              if ($bm_isInstanceOfArray(e) && isNumerable(r, t)) {
                for (
                  o = e.length, i = createTypedArray(`float32`, o), a = 0;
                  a < o;
                  a += 1
                )
                  i[a] = e[a] * t;
                return i;
              }
              if (isNumerable(n, e) && $bm_isInstanceOfArray(t)) {
                for (
                  o = t.length, i = createTypedArray(`float32`, o), a = 0;
                  a < o;
                  a += 1
                )
                  i[a] = e * t[a];
                return i;
              }
              return 0;
            }
            function div(e, t) {
              var n = _typeof$1(e),
                r = _typeof$1(t),
                i;
              if (isNumerable(n, e) && isNumerable(r, t)) return e / t;
              var a, o;
              if ($bm_isInstanceOfArray(e) && isNumerable(r, t)) {
                for (
                  o = e.length, i = createTypedArray(`float32`, o), a = 0;
                  a < o;
                  a += 1
                )
                  i[a] = e[a] / t;
                return i;
              }
              if (isNumerable(n, e) && $bm_isInstanceOfArray(t)) {
                for (
                  o = t.length, i = createTypedArray(`float32`, o), a = 0;
                  a < o;
                  a += 1
                )
                  i[a] = e / t[a];
                return i;
              }
              return 0;
            }
            function mod(e, t) {
              return (
                typeof e == `string` && (e = parseInt(e, 10)),
                typeof t == `string` && (t = parseInt(t, 10)),
                e % t
              );
            }
            var $bm_sum = sum,
              $bm_sub = sub,
              $bm_mul = mul,
              $bm_div = div,
              $bm_mod = mod;
            function clamp(e, t, n) {
              if (t > n) {
                var r = n;
                ((n = t), (t = r));
              }
              return Math.min(Math.max(e, t), n);
            }
            function radiansToDegrees(e) {
              return e / degToRads;
            }
            var radians_to_degrees = radiansToDegrees;
            function degreesToRadians(e) {
              return e * degToRads;
            }
            var degrees_to_radians = radiansToDegrees,
              helperLengthArray = [0, 0, 0, 0, 0, 0];
            function length(e, t) {
              if (typeof e == `number` || e instanceof Number)
                return ((t ||= 0), Math.abs(e - t));
              t ||= helperLengthArray;
              var n,
                r = Math.min(e.length, t.length),
                i = 0;
              for (n = 0; n < r; n += 1) i += Math.pow(t[n] - e[n], 2);
              return Math.sqrt(i);
            }
            function normalize(e) {
              return div(e, length(e));
            }
            function rgbToHsl(e) {
              var t = e[0],
                n = e[1],
                r = e[2],
                i = Math.max(t, n, r),
                a = Math.min(t, n, r),
                o,
                s,
                c = (i + a) / 2;
              if (i === a) ((o = 0), (s = 0));
              else {
                var l = i - a;
                switch (((s = c > 0.5 ? l / (2 - i - a) : l / (i + a)), i)) {
                  case t:
                    o = (n - r) / l + (n < r ? 6 : 0);
                    break;
                  case n:
                    o = (r - t) / l + 2;
                    break;
                  case r:
                    o = (t - n) / l + 4;
                    break;
                  default:
                    break;
                }
                o /= 6;
              }
              return [o, s, c, e[3]];
            }
            function hue2rgb(e, t, n) {
              return (
                n < 0 && (n += 1),
                n > 1 && --n,
                n < 1 / 6
                  ? e + (t - e) * 6 * n
                  : n < 1 / 2
                    ? t
                    : n < 2 / 3
                      ? e + (t - e) * (2 / 3 - n) * 6
                      : e
              );
            }
            function hslToRgb(e) {
              var t = e[0],
                n = e[1],
                r = e[2],
                i,
                a,
                o;
              if (n === 0) ((i = r), (o = r), (a = r));
              else {
                var s = r < 0.5 ? r * (1 + n) : r + n - r * n,
                  c = 2 * r - s;
                ((i = hue2rgb(c, s, t + 1 / 3)),
                  (a = hue2rgb(c, s, t)),
                  (o = hue2rgb(c, s, t - 1 / 3)));
              }
              return [i, a, o, e[3]];
            }
            function linear(e, t, n, r, i) {
              if (
                ((r === void 0 || i === void 0) &&
                  ((r = t), (i = n), (t = 0), (n = 1)),
                n < t)
              ) {
                var a = n;
                ((n = t), (t = a));
              }
              if (e <= t) return r;
              if (e >= n) return i;
              var o = n === t ? 0 : (e - t) / (n - t);
              if (!r.length) return r + (i - r) * o;
              var s,
                c = r.length,
                l = createTypedArray(`float32`, c);
              for (s = 0; s < c; s += 1) l[s] = r[s] + (i[s] - r[s]) * o;
              return l;
            }
            function random(e, t) {
              if (
                (t === void 0 &&
                  (e === void 0 ? ((e = 0), (t = 1)) : ((t = e), (e = void 0))),
                t.length)
              ) {
                var n,
                  r = t.length;
                e ||= createTypedArray(`float32`, r);
                var i = createTypedArray(`float32`, r),
                  a = BMMath.random();
                for (n = 0; n < r; n += 1) i[n] = e[n] + a * (t[n] - e[n]);
                return i;
              }
              e === void 0 && (e = 0);
              var o = BMMath.random();
              return e + o * (t - e);
            }
            function createPath(e, t, n, r) {
              var i,
                a = e.length,
                o = shapePool.newElement();
              o.setPathData(!!r, a);
              var s = [0, 0],
                c,
                l;
              for (i = 0; i < a; i += 1)
                ((c = t && t[i] ? t[i] : s),
                  (l = n && n[i] ? n[i] : s),
                  o.setTripleAt(
                    e[i][0],
                    e[i][1],
                    l[0] + e[i][0],
                    l[1] + e[i][1],
                    c[0] + e[i][0],
                    c[1] + e[i][1],
                    i,
                    !0,
                  ));
              return o;
            }
            function initiateExpression(elem, data, property) {
              function noOp(e) {
                return e;
              }
              if (!elem.globalData.renderConfig.runExpressions) return noOp;
              var val = data.x,
                needsVelocity = /velocity(?![\w\d])/.test(val),
                _needsRandom = val.indexOf(`random`) !== -1,
                elemType = elem.data.ty,
                transform,
                $bm_transform,
                content,
                effect,
                thisProperty = property;
              ((thisProperty._name = elem.data.nm),
                (thisProperty.valueAtTime = thisProperty.getValueAtTime),
                Object.defineProperty(thisProperty, "value", {
                  get: function () {
                    return thisProperty.v;
                  },
                }),
                (elem.comp.frameDuration = 1 / elem.comp.globalData.frameRate),
                (elem.comp.displayStartTime = 0));
              var inPoint = elem.data.ip / elem.comp.globalData.frameRate,
                outPoint = elem.data.op / elem.comp.globalData.frameRate,
                width = elem.data.sw ? elem.data.sw : 0,
                height = elem.data.sh ? elem.data.sh : 0,
                name = elem.data.nm,
                loopIn,
                loop_in,
                loopOut,
                loop_out,
                smooth,
                toWorld,
                fromWorld,
                fromComp,
                toComp,
                fromCompToSurface,
                position,
                rotation,
                anchorPoint,
                scale,
                thisLayer,
                thisComp,
                mask,
                valueAtTime,
                velocityAtTime,
                scoped_bm_rt,
                expression_function = eval(
                  `[function _expression_function(){` +
                    val +
                    `;scoped_bm_rt=$bm_rt}]`,
                )[0],
                numKeys = property.kf ? data.k.length : 0,
                active = !this.data || this.data.hd !== !0,
                wiggle = function (e, t) {
                  var n,
                    r,
                    i = this.pv.length ? this.pv.length : 1,
                    a = createTypedArray(`float32`, i);
                  e = 5;
                  var o = Math.floor(time * e);
                  for (n = 0, r = 0; n < o;) {
                    for (r = 0; r < i; r += 1)
                      a[r] += -t + t * 2 * BMMath.random();
                    n += 1;
                  }
                  var s = time * e,
                    c = s - Math.floor(s),
                    l = createTypedArray(`float32`, i);
                  if (i > 1) {
                    for (r = 0; r < i; r += 1)
                      l[r] =
                        this.pv[r] + a[r] + (-t + t * 2 * BMMath.random()) * c;
                    return l;
                  }
                  return this.pv + a[0] + (-t + t * 2 * BMMath.random()) * c;
                }.bind(this);
              (thisProperty.loopIn &&
                ((loopIn = thisProperty.loopIn.bind(thisProperty)),
                (loop_in = loopIn)),
                thisProperty.loopOut &&
                  ((loopOut = thisProperty.loopOut.bind(thisProperty)),
                  (loop_out = loopOut)),
                thisProperty.smooth &&
                  (smooth = thisProperty.smooth.bind(thisProperty)));
              function loopInDuration(e, t) {
                return loopIn(e, t, !0);
              }
              function loopOutDuration(e, t) {
                return loopOut(e, t, !0);
              }
              (this.getValueAtTime &&
                (valueAtTime = this.getValueAtTime.bind(this)),
                this.getVelocityAtTime &&
                  (velocityAtTime = this.getVelocityAtTime.bind(this)));
              var comp = elem.comp.globalData.projectInterface.bind(
                elem.comp.globalData.projectInterface,
              );
              function lookAt(e, t) {
                var n = [t[0] - e[0], t[1] - e[1], t[2] - e[2]],
                  r =
                    Math.atan2(n[0], Math.sqrt(n[1] * n[1] + n[2] * n[2])) /
                    degToRads;
                return [-Math.atan2(n[1], n[2]) / degToRads, r, 0];
              }
              function easeOut(e, t, n, r, i) {
                return applyEase(easeOutBez, e, t, n, r, i);
              }
              function easeIn(e, t, n, r, i) {
                return applyEase(easeInBez, e, t, n, r, i);
              }
              function ease(e, t, n, r, i) {
                return applyEase(easeInOutBez, e, t, n, r, i);
              }
              function applyEase(e, t, n, r, i, a) {
                (i === void 0 ? ((i = n), (a = r)) : (t = (t - n) / (r - n)),
                  t > 1 ? (t = 1) : t < 0 && (t = 0));
                var o = e(t);
                if ($bm_isInstanceOfArray(i)) {
                  var s,
                    c = i.length,
                    l = createTypedArray(`float32`, c);
                  for (s = 0; s < c; s += 1) l[s] = (a[s] - i[s]) * o + i[s];
                  return l;
                }
                return (a - i) * o + i;
              }
              function nearestKey(e) {
                var t,
                  n = data.k.length,
                  r,
                  i;
                if (!data.k.length || typeof data.k[0] == `number`)
                  ((r = 0), (i = 0));
                else if (
                  ((r = -1),
                  (e *= elem.comp.globalData.frameRate),
                  e < data.k[0].t)
                )
                  ((r = 1), (i = data.k[0].t));
                else {
                  for (t = 0; t < n - 1; t += 1)
                    if (e === data.k[t].t) {
                      ((r = t + 1), (i = data.k[t].t));
                      break;
                    } else if (e > data.k[t].t && e < data.k[t + 1].t) {
                      e - data.k[t].t > data.k[t + 1].t - e
                        ? ((r = t + 2), (i = data.k[t + 1].t))
                        : ((r = t + 1), (i = data.k[t].t));
                      break;
                    }
                  r === -1 && ((r = t + 1), (i = data.k[t].t));
                }
                var a = {};
                return (
                  (a.index = r),
                  (a.time = i / elem.comp.globalData.frameRate),
                  a
                );
              }
              function key(e) {
                var t, n, r;
                if (!data.k.length || typeof data.k[0] == `number`)
                  throw Error(`The property has no keyframe at index ` + e);
                (--e,
                  (t = {
                    time: data.k[e].t / elem.comp.globalData.frameRate,
                    value: [],
                  }));
                var i = Object.prototype.hasOwnProperty.call(data.k[e], `s`)
                  ? data.k[e].s
                  : data.k[e - 1].e;
                for (r = i.length, n = 0; n < r; n += 1)
                  ((t[n] = i[n]), (t.value[n] = i[n]));
                return t;
              }
              function framesToTime(e, t) {
                return ((t ||= elem.comp.globalData.frameRate), e / t);
              }
              function timeToFrames(e, t) {
                return (
                  !e && e !== 0 && (e = time),
                  (t ||= elem.comp.globalData.frameRate),
                  e * t
                );
              }
              function seedRandom(e) {
                BMMath.seedrandom(randSeed + e);
              }
              function sourceRectAtTime() {
                return elem.sourceRectAtTime();
              }
              function substring(e, t) {
                return typeof value == `string`
                  ? t === void 0
                    ? value.substring(e)
                    : value.substring(e, t)
                  : ``;
              }
              function substr(e, t) {
                return typeof value == `string`
                  ? t === void 0
                    ? value.substr(e)
                    : value.substr(e, t)
                  : ``;
              }
              function posterizeTime(e) {
                ((time = e === 0 ? 0 : Math.floor(time * e) / e),
                  (value = valueAtTime(time)));
              }
              var time,
                velocity,
                value,
                text,
                textIndex,
                textTotal,
                selectorValue,
                index = elem.data.ind,
                hasParent = !!(elem.hierarchy && elem.hierarchy.length),
                parent,
                randSeed = Math.floor(Math.random() * 1e6),
                globalData = elem.globalData;
              function executeExpression(e) {
                return (
                  (value = e),
                  this.frameExpressionId === elem.globalData.frameId &&
                  this.propType !== `textSelector`
                    ? value
                    : (this.propType === `textSelector` &&
                        ((textIndex = this.textIndex),
                        (textTotal = this.textTotal),
                        (selectorValue = this.selectorValue)),
                      thisLayer ||
                        ((text = elem.layerInterface.text),
                        (thisLayer = elem.layerInterface),
                        (thisComp = elem.comp.compInterface),
                        (toWorld = thisLayer.toWorld.bind(thisLayer)),
                        (fromWorld = thisLayer.fromWorld.bind(thisLayer)),
                        (fromComp = thisLayer.fromComp.bind(thisLayer)),
                        (toComp = thisLayer.toComp.bind(thisLayer)),
                        (mask = thisLayer.mask
                          ? thisLayer.mask.bind(thisLayer)
                          : null),
                        (fromCompToSurface = fromComp)),
                      transform ||
                        ((transform =
                          elem.layerInterface(`ADBE Transform Group`)),
                        ($bm_transform = transform),
                        transform && (anchorPoint = transform.anchorPoint)),
                      elemType === 4 &&
                        !content &&
                        (content = thisLayer(`ADBE Root Vectors Group`)),
                      (effect ||= thisLayer(4)),
                      (hasParent = !!(elem.hierarchy && elem.hierarchy.length)),
                      hasParent &&
                        !parent &&
                        (parent = elem.hierarchy[0].layerInterface),
                      (time =
                        this.comp.renderedFrame /
                        this.comp.globalData.frameRate),
                      _needsRandom && seedRandom(randSeed + time),
                      needsVelocity && (velocity = velocityAtTime(time)),
                      expression_function(),
                      (this.frameExpressionId = elem.globalData.frameId),
                      (scoped_bm_rt =
                        scoped_bm_rt.propType === propTypes.SHAPE
                          ? scoped_bm_rt.v
                          : scoped_bm_rt),
                      scoped_bm_rt)
                );
              }
              return (
                (executeExpression.__preventDeadCodeRemoval = [
                  $bm_transform,
                  anchorPoint,
                  time,
                  velocity,
                  inPoint,
                  outPoint,
                  width,
                  height,
                  name,
                  loop_in,
                  loop_out,
                  smooth,
                  toComp,
                  fromCompToSurface,
                  toWorld,
                  fromWorld,
                  mask,
                  position,
                  rotation,
                  scale,
                  thisComp,
                  numKeys,
                  active,
                  wiggle,
                  loopInDuration,
                  loopOutDuration,
                  comp,
                  lookAt,
                  easeOut,
                  easeIn,
                  ease,
                  nearestKey,
                  key,
                  text,
                  textIndex,
                  textTotal,
                  selectorValue,
                  framesToTime,
                  timeToFrames,
                  sourceRectAtTime,
                  substring,
                  substr,
                  posterizeTime,
                  index,
                  globalData,
                ]),
                executeExpression
              );
            }
            return (
              (ob.initiateExpression = initiateExpression),
              (ob.__preventDeadCodeRemoval = [
                window,
                document,
                XMLHttpRequest,
                fetch,
                frames,
                $bm_neg,
                add,
                $bm_sum,
                $bm_sub,
                $bm_mul,
                $bm_div,
                $bm_mod,
                clamp,
                radians_to_degrees,
                degreesToRadians,
                degrees_to_radians,
                normalize,
                rgbToHsl,
                hslToRgb,
                linear,
                random,
                createPath,
                _lottieGlobal,
              ]),
              (ob.resetFrame = resetFrame),
              ob
            );
          })(),
          Expressions = (function () {
            var e = {};
            ((e.initExpressions = t),
              (e.resetFrame = ExpressionManager.resetFrame));
            function t(e) {
              var t = 0,
                n = [];
              function r() {
                t += 1;
              }
              function i() {
                (--t, t === 0 && o());
              }
              function a(e) {
                n.indexOf(e) === -1 && n.push(e);
              }
              function o() {
                var e,
                  t = n.length;
                for (e = 0; e < t; e += 1) n[e].release();
                n.length = 0;
              }
              ((e.renderer.compInterface = CompExpressionInterface(e.renderer)),
                e.renderer.globalData.projectInterface.registerComposition(
                  e.renderer,
                ),
                (e.renderer.globalData.pushExpression = r),
                (e.renderer.globalData.popExpression = i),
                (e.renderer.globalData.registerExpressionProperty = a));
            }
            return e;
          })(),
          MaskManagerInterface = (function () {
            function e(e, t) {
              ((this._mask = e), (this._data = t));
            }
            return (
              Object.defineProperty(e.prototype, "maskPath", {
                get: function () {
                  return (
                    this._mask.prop.k && this._mask.prop.getValue(),
                    this._mask.prop
                  );
                },
              }),
              Object.defineProperty(e.prototype, "maskOpacity", {
                get: function () {
                  return (
                    this._mask.op.k && this._mask.op.getValue(),
                    this._mask.op.v * 100
                  );
                },
              }),
              function (t) {
                var n = createSizedArray(t.viewData.length),
                  r,
                  i = t.viewData.length;
                for (r = 0; r < i; r += 1)
                  n[r] = new e(t.viewData[r], t.masksProperties[r]);
                return function (e) {
                  for (r = 0; r < i;) {
                    if (t.masksProperties[r].nm === e) return n[r];
                    r += 1;
                  }
                  return null;
                };
              }
            );
          })(),
          ExpressionPropertyInterface = (function () {
            var e = { pv: 0, v: 0, mult: 1 },
              t = { pv: [0, 0, 0], v: [0, 0, 0], mult: 1 };
            function n(e, t, n) {
              (Object.defineProperty(e, "velocity", {
                get: function () {
                  return t.getVelocityAtTime(t.comp.currentFrame);
                },
              }),
                (e.numKeys = t.keyframes ? t.keyframes.length : 0),
                (e.key = function (r) {
                  if (!e.numKeys) return 0;
                  var i = ``;
                  i =
                    `s` in t.keyframes[r - 1]
                      ? t.keyframes[r - 1].s
                      : `e` in t.keyframes[r - 2]
                        ? t.keyframes[r - 2].e
                        : t.keyframes[r - 2].s;
                  var a =
                    n === `unidimensional`
                      ? new Number(i)
                      : Object.assign({}, i);
                  return (
                    (a.time =
                      t.keyframes[r - 1].t / t.elem.comp.globalData.frameRate),
                    (a.value = n === `unidimensional` ? i[0] : i),
                    a
                  );
                }),
                (e.valueAtTime = t.getValueAtTime),
                (e.speedAtTime = t.getSpeedAtTime),
                (e.velocityAtTime = t.getVelocityAtTime),
                (e.propertyGroup = t.propertyGroup));
            }
            function r(t) {
              (!t || !(`pv` in t)) && (t = e);
              var r = 1 / t.mult,
                i = t.pv * r,
                a = new Number(i);
              return (
                (a.value = i),
                n(a, t, `unidimensional`),
                function () {
                  return (
                    t.k && t.getValue(),
                    (i = t.v * r),
                    a.value !== i &&
                      ((a = new Number(i)),
                      (a.value = i),
                      (a[0] = i),
                      n(a, t, `unidimensional`)),
                    a
                  );
                }
              );
            }
            function i(e) {
              (!e || !(`pv` in e)) && (e = t);
              var r = 1 / e.mult,
                i = (e.data && e.data.l) || e.pv.length,
                a = createTypedArray(`float32`, i),
                o = createTypedArray(`float32`, i);
              return (
                (a.value = o),
                n(a, e, `multidimensional`),
                function () {
                  e.k && e.getValue();
                  for (var t = 0; t < i; t += 1)
                    ((o[t] = e.v[t] * r), (a[t] = o[t]));
                  return a;
                }
              );
            }
            function a() {
              return e;
            }
            return function (e) {
              return e ? (e.propType === `unidimensional` ? r(e) : i(e)) : a;
            };
          })(),
          TransformExpressionInterface = (function () {
            return function (e) {
              function t(e) {
                switch (e) {
                  case `scale`:
                  case `Scale`:
                  case `ADBE Scale`:
                  case 6:
                    return t.scale;
                  case `rotation`:
                  case `Rotation`:
                  case `ADBE Rotation`:
                  case `ADBE Rotate Z`:
                  case 10:
                    return t.rotation;
                  case `ADBE Rotate X`:
                    return t.xRotation;
                  case `ADBE Rotate Y`:
                    return t.yRotation;
                  case `position`:
                  case `Position`:
                  case `ADBE Position`:
                  case 2:
                    return t.position;
                  case `ADBE Position_0`:
                    return t.xPosition;
                  case `ADBE Position_1`:
                    return t.yPosition;
                  case `ADBE Position_2`:
                    return t.zPosition;
                  case `anchorPoint`:
                  case `AnchorPoint`:
                  case `Anchor Point`:
                  case `ADBE AnchorPoint`:
                  case 1:
                    return t.anchorPoint;
                  case `opacity`:
                  case `Opacity`:
                  case 11:
                    return t.opacity;
                  default:
                    return null;
                }
              }
              (Object.defineProperty(t, "rotation", {
                get: ExpressionPropertyInterface(e.r || e.rz),
              }),
                Object.defineProperty(t, "zRotation", {
                  get: ExpressionPropertyInterface(e.rz || e.r),
                }),
                Object.defineProperty(t, "xRotation", {
                  get: ExpressionPropertyInterface(e.rx),
                }),
                Object.defineProperty(t, "yRotation", {
                  get: ExpressionPropertyInterface(e.ry),
                }),
                Object.defineProperty(t, "scale", {
                  get: ExpressionPropertyInterface(e.s),
                }));
              var n, r, i, a;
              return (
                e.p
                  ? (a = ExpressionPropertyInterface(e.p))
                  : ((n = ExpressionPropertyInterface(e.px)),
                    (r = ExpressionPropertyInterface(e.py)),
                    e.pz && (i = ExpressionPropertyInterface(e.pz))),
                Object.defineProperty(t, "position", {
                  get: function () {
                    return e.p ? a() : [n(), r(), i ? i() : 0];
                  },
                }),
                Object.defineProperty(t, "xPosition", {
                  get: ExpressionPropertyInterface(e.px),
                }),
                Object.defineProperty(t, "yPosition", {
                  get: ExpressionPropertyInterface(e.py),
                }),
                Object.defineProperty(t, "zPosition", {
                  get: ExpressionPropertyInterface(e.pz),
                }),
                Object.defineProperty(t, "anchorPoint", {
                  get: ExpressionPropertyInterface(e.a),
                }),
                Object.defineProperty(t, "opacity", {
                  get: ExpressionPropertyInterface(e.o),
                }),
                Object.defineProperty(t, "skew", {
                  get: ExpressionPropertyInterface(e.sk),
                }),
                Object.defineProperty(t, "skewAxis", {
                  get: ExpressionPropertyInterface(e.sa),
                }),
                Object.defineProperty(t, "orientation", {
                  get: ExpressionPropertyInterface(e.or),
                }),
                t
              );
            };
          })(),
          LayerExpressionInterface = (function () {
            function e(e) {
              var t = new Matrix();
              return (
                e === void 0
                  ? this._elem.finalTransform.mProp.applyToMatrix(t)
                  : this._elem.finalTransform.mProp.getValueAtTime(e).clone(t),
                t
              );
            }
            function t(e, t) {
              var n = this.getMatrix(t);
              return (
                (n.props[12] = 0),
                (n.props[13] = 0),
                (n.props[14] = 0),
                this.applyPoint(n, e)
              );
            }
            function n(e, t) {
              var n = this.getMatrix(t);
              return this.applyPoint(n, e);
            }
            function r(e, t) {
              var n = this.getMatrix(t);
              return (
                (n.props[12] = 0),
                (n.props[13] = 0),
                (n.props[14] = 0),
                this.invertPoint(n, e)
              );
            }
            function i(e, t) {
              var n = this.getMatrix(t);
              return this.invertPoint(n, e);
            }
            function a(e, t) {
              if (this._elem.hierarchy && this._elem.hierarchy.length) {
                var n,
                  r = this._elem.hierarchy.length;
                for (n = 0; n < r; n += 1)
                  this._elem.hierarchy[n].finalTransform.mProp.applyToMatrix(e);
              }
              return e.applyToPointArray(t[0], t[1], t[2] || 0);
            }
            function o(e, t) {
              if (this._elem.hierarchy && this._elem.hierarchy.length) {
                var n,
                  r = this._elem.hierarchy.length;
                for (n = 0; n < r; n += 1)
                  this._elem.hierarchy[n].finalTransform.mProp.applyToMatrix(e);
              }
              return e.inversePoint(t);
            }
            function s(e) {
              var t = new Matrix();
              if (
                (t.reset(),
                this._elem.finalTransform.mProp.applyToMatrix(t),
                this._elem.hierarchy && this._elem.hierarchy.length)
              ) {
                var n,
                  r = this._elem.hierarchy.length;
                for (n = 0; n < r; n += 1)
                  this._elem.hierarchy[n].finalTransform.mProp.applyToMatrix(t);
                return t.inversePoint(e);
              }
              return t.inversePoint(e);
            }
            function c() {
              return [1, 1, 1, 1];
            }
            return function (l) {
              var u;
              function d(e) {
                p.mask = new MaskManagerInterface(e, l);
              }
              function f(e) {
                p.effect = e;
              }
              function p(e) {
                switch (e) {
                  case `ADBE Root Vectors Group`:
                  case `Contents`:
                  case 2:
                    return p.shapeInterface;
                  case 1:
                  case 6:
                  case `Transform`:
                  case `transform`:
                  case `ADBE Transform Group`:
                    return u;
                  case 4:
                  case `ADBE Effect Parade`:
                  case `effects`:
                  case `Effects`:
                    return p.effect;
                  case `ADBE Text Properties`:
                    return p.textInterface;
                  default:
                    return null;
                }
              }
              ((p.getMatrix = e),
                (p.invertPoint = o),
                (p.applyPoint = a),
                (p.toWorld = n),
                (p.toWorldVec = t),
                (p.fromWorld = i),
                (p.fromWorldVec = r),
                (p.toComp = n),
                (p.fromComp = s),
                (p.sampleImage = c),
                (p.sourceRectAtTime = l.sourceRectAtTime.bind(l)),
                (p._elem = l),
                (u = TransformExpressionInterface(l.finalTransform.mProp)));
              var m = getDescriptor(u, `anchorPoint`);
              return (
                Object.defineProperties(p, {
                  hasParent: {
                    get: function () {
                      return l.hierarchy.length;
                    },
                  },
                  parent: {
                    get: function () {
                      return l.hierarchy[0].layerInterface;
                    },
                  },
                  rotation: getDescriptor(u, `rotation`),
                  scale: getDescriptor(u, `scale`),
                  position: getDescriptor(u, `position`),
                  opacity: getDescriptor(u, `opacity`),
                  anchorPoint: m,
                  anchor_point: m,
                  transform: {
                    get: function () {
                      return u;
                    },
                  },
                  active: {
                    get: function () {
                      return l.isInRange;
                    },
                  },
                }),
                (p.startTime = l.data.st),
                (p.index = l.data.ind),
                (p.source = l.data.refId),
                (p.height = l.data.ty === 0 ? l.data.h : 100),
                (p.width = l.data.ty === 0 ? l.data.w : 100),
                (p.inPoint = l.data.ip / l.comp.globalData.frameRate),
                (p.outPoint = l.data.op / l.comp.globalData.frameRate),
                (p._name = l.data.nm),
                (p.registerMaskInterface = d),
                (p.registerEffectsInterface = f),
                p
              );
            };
          })(),
          propertyGroupFactory = (function () {
            return function (e, t) {
              return function (n) {
                return ((n = n === void 0 ? 1 : n), n <= 0 ? e : t(n - 1));
              };
            };
          })(),
          PropertyInterface = (function () {
            return function (e, t) {
              var n = { _name: e };
              function r(e) {
                return ((e = e === void 0 ? 1 : e), e <= 0 ? n : t(e - 1));
              }
              return r;
            };
          })(),
          EffectsExpressionInterface = (function () {
            var e = { createEffectsInterface: t };
            function t(e, t) {
              if (e.effectsManager) {
                var r = [],
                  i = e.data.ef,
                  a,
                  o = e.effectsManager.effectElements.length;
                for (a = 0; a < o; a += 1)
                  r.push(n(i[a], e.effectsManager.effectElements[a], t, e));
                var s = e.data.ef || [],
                  c = function (e) {
                    for (a = 0, o = s.length; a < o;) {
                      if (e === s[a].nm || e === s[a].mn || e === s[a].ix)
                        return r[a];
                      a += 1;
                    }
                    return null;
                  };
                return (
                  Object.defineProperty(c, "numProperties", {
                    get: function () {
                      return s.length;
                    },
                  }),
                  c
                );
              }
              return null;
            }
            function n(e, t, i, a) {
              function o(t) {
                for (var n = e.ef, r = 0, i = n.length; r < i;) {
                  if (t === n[r].nm || t === n[r].mn || t === n[r].ix)
                    return n[r].ty === 5 ? c[r] : c[r]();
                  r += 1;
                }
                throw Error();
              }
              var s = propertyGroupFactory(o, i),
                c = [],
                l,
                u = e.ef.length;
              for (l = 0; l < u; l += 1)
                e.ef[l].ty === 5
                  ? c.push(
                      n(
                        e.ef[l],
                        t.effectElements[l],
                        t.effectElements[l].propertyGroup,
                        a,
                      ),
                    )
                  : c.push(r(t.effectElements[l], e.ef[l].ty, a, s));
              return (
                e.mn === `ADBE Color Control` &&
                  Object.defineProperty(o, "color", {
                    get: function () {
                      return c[0]();
                    },
                  }),
                Object.defineProperties(o, {
                  numProperties: {
                    get: function () {
                      return e.np;
                    },
                  },
                  _name: { value: e.nm },
                  propertyGroup: { value: s },
                }),
                (o.enabled = e.en !== 0),
                (o.active = o.enabled),
                o
              );
            }
            function r(e, t, n, r) {
              var i = ExpressionPropertyInterface(e.p);
              function a() {
                return t === 10 ? n.comp.compInterface(e.p.v) : i();
              }
              return (
                e.p.setGroupProperty &&
                  e.p.setGroupProperty(PropertyInterface(``, r)),
                a
              );
            }
            return e;
          })(),
          ShapePathInterface = (function () {
            return function (e, t, n) {
              var r = t.sh;
              function i(e) {
                return e === `Shape` ||
                  e === `shape` ||
                  e === `Path` ||
                  e === `path` ||
                  e === `ADBE Vector Shape` ||
                  e === 2
                  ? i.path
                  : null;
              }
              var a = propertyGroupFactory(i, n);
              return (
                r.setGroupProperty(PropertyInterface(`Path`, a)),
                Object.defineProperties(i, {
                  path: {
                    get: function () {
                      return (r.k && r.getValue(), r);
                    },
                  },
                  shape: {
                    get: function () {
                      return (r.k && r.getValue(), r);
                    },
                  },
                  _name: { value: e.nm },
                  ix: { value: e.ix },
                  propertyIndex: { value: e.ix },
                  mn: { value: e.mn },
                  propertyGroup: { value: n },
                }),
                i
              );
            };
          })(),
          ShapeExpressionInterface = (function () {
            function e(e, t, c) {
              var m = [],
                g,
                _ = e ? e.length : 0;
              for (g = 0; g < _; g += 1)
                e[g].ty === `gr`
                  ? m.push(n(e[g], t[g], c))
                  : e[g].ty === `fl`
                    ? m.push(r(e[g], t[g], c))
                    : e[g].ty === `st`
                      ? m.push(o(e[g], t[g], c))
                      : e[g].ty === `tm`
                        ? m.push(s(e[g], t[g], c))
                        : e[g].ty === `tr` ||
                          (e[g].ty === `el`
                            ? m.push(l(e[g], t[g], c))
                            : e[g].ty === `sr`
                              ? m.push(u(e[g], t[g], c))
                              : e[g].ty === `sh`
                                ? m.push(ShapePathInterface(e[g], t[g], c))
                                : e[g].ty === `rc`
                                  ? m.push(d(e[g], t[g], c))
                                  : e[g].ty === `rd`
                                    ? m.push(f(e[g], t[g], c))
                                    : e[g].ty === `rp`
                                      ? m.push(p(e[g], t[g], c))
                                      : e[g].ty === `gf`
                                        ? m.push(i(e[g], t[g], c))
                                        : m.push(a(e[g], t[g], c)));
              return m;
            }
            function t(t, n, r) {
              var i,
                a = function (e) {
                  for (var t = 0, n = i.length; t < n;) {
                    if (
                      i[t]._name === e ||
                      i[t].mn === e ||
                      i[t].propertyIndex === e ||
                      i[t].ix === e ||
                      i[t].ind === e
                    )
                      return i[t];
                    t += 1;
                  }
                  return typeof e == `number` ? i[e - 1] : null;
                };
              return (
                (a.propertyGroup = propertyGroupFactory(a, r)),
                (i = e(t.it, n.it, a.propertyGroup)),
                (a.numProperties = i.length),
                (a.transform = c(
                  t.it[t.it.length - 1],
                  n.it[n.it.length - 1],
                  a.propertyGroup,
                )),
                (a.propertyIndex = t.cix),
                (a._name = t.nm),
                a
              );
            }
            function n(e, n, r) {
              var i = function (e) {
                switch (e) {
                  case `ADBE Vectors Group`:
                  case `Contents`:
                  case 2:
                    return i.content;
                  default:
                    return i.transform;
                }
              };
              i.propertyGroup = propertyGroupFactory(i, r);
              var a = t(e, n, i.propertyGroup),
                o = c(
                  e.it[e.it.length - 1],
                  n.it[n.it.length - 1],
                  i.propertyGroup,
                );
              return (
                (i.content = a),
                (i.transform = o),
                Object.defineProperty(i, "_name", {
                  get: function () {
                    return e.nm;
                  },
                }),
                (i.numProperties = e.np),
                (i.propertyIndex = e.ix),
                (i.nm = e.nm),
                (i.mn = e.mn),
                i
              );
            }
            function r(e, t, n) {
              function r(e) {
                return e === `Color` || e === `color`
                  ? r.color
                  : e === `Opacity` || e === `opacity`
                    ? r.opacity
                    : null;
              }
              return (
                Object.defineProperties(r, {
                  color: { get: ExpressionPropertyInterface(t.c) },
                  opacity: { get: ExpressionPropertyInterface(t.o) },
                  _name: { value: e.nm },
                  mn: { value: e.mn },
                }),
                t.c.setGroupProperty(PropertyInterface(`Color`, n)),
                t.o.setGroupProperty(PropertyInterface(`Opacity`, n)),
                r
              );
            }
            function i(e, t, n) {
              function r(e) {
                return e === `Start Point` || e === `start point`
                  ? r.startPoint
                  : e === `End Point` || e === `end point`
                    ? r.endPoint
                    : e === `Opacity` || e === `opacity`
                      ? r.opacity
                      : null;
              }
              return (
                Object.defineProperties(r, {
                  startPoint: { get: ExpressionPropertyInterface(t.s) },
                  endPoint: { get: ExpressionPropertyInterface(t.e) },
                  opacity: { get: ExpressionPropertyInterface(t.o) },
                  type: {
                    get: function () {
                      return `a`;
                    },
                  },
                  _name: { value: e.nm },
                  mn: { value: e.mn },
                }),
                t.s.setGroupProperty(PropertyInterface(`Start Point`, n)),
                t.e.setGroupProperty(PropertyInterface(`End Point`, n)),
                t.o.setGroupProperty(PropertyInterface(`Opacity`, n)),
                r
              );
            }
            function a() {
              function e() {
                return null;
              }
              return e;
            }
            function o(e, t, n) {
              var r = propertyGroupFactory(l, n),
                i = propertyGroupFactory(c, r);
              function a(n) {
                Object.defineProperty(c, e.d[n].nm, {
                  get: ExpressionPropertyInterface(t.d.dataProps[n].p),
                });
              }
              var o,
                s = e.d ? e.d.length : 0,
                c = {};
              for (o = 0; o < s; o += 1)
                (a(o), t.d.dataProps[o].p.setGroupProperty(i));
              function l(e) {
                return e === `Color` || e === `color`
                  ? l.color
                  : e === `Opacity` || e === `opacity`
                    ? l.opacity
                    : e === `Stroke Width` || e === `stroke width`
                      ? l.strokeWidth
                      : null;
              }
              return (
                Object.defineProperties(l, {
                  color: { get: ExpressionPropertyInterface(t.c) },
                  opacity: { get: ExpressionPropertyInterface(t.o) },
                  strokeWidth: { get: ExpressionPropertyInterface(t.w) },
                  dash: {
                    get: function () {
                      return c;
                    },
                  },
                  _name: { value: e.nm },
                  mn: { value: e.mn },
                }),
                t.c.setGroupProperty(PropertyInterface(`Color`, r)),
                t.o.setGroupProperty(PropertyInterface(`Opacity`, r)),
                t.w.setGroupProperty(PropertyInterface(`Stroke Width`, r)),
                l
              );
            }
            function s(e, t, n) {
              function r(t) {
                return t === e.e.ix || t === `End` || t === `end`
                  ? r.end
                  : t === e.s.ix
                    ? r.start
                    : t === e.o.ix
                      ? r.offset
                      : null;
              }
              var i = propertyGroupFactory(r, n);
              return (
                (r.propertyIndex = e.ix),
                t.s.setGroupProperty(PropertyInterface(`Start`, i)),
                t.e.setGroupProperty(PropertyInterface(`End`, i)),
                t.o.setGroupProperty(PropertyInterface(`Offset`, i)),
                (r.propertyIndex = e.ix),
                (r.propertyGroup = n),
                Object.defineProperties(r, {
                  start: { get: ExpressionPropertyInterface(t.s) },
                  end: { get: ExpressionPropertyInterface(t.e) },
                  offset: { get: ExpressionPropertyInterface(t.o) },
                  _name: { value: e.nm },
                }),
                (r.mn = e.mn),
                r
              );
            }
            function c(e, t, n) {
              function r(t) {
                return e.a.ix === t || t === `Anchor Point`
                  ? r.anchorPoint
                  : e.o.ix === t || t === `Opacity`
                    ? r.opacity
                    : e.p.ix === t || t === `Position`
                      ? r.position
                      : e.r.ix === t ||
                          t === `Rotation` ||
                          t === `ADBE Vector Rotation`
                        ? r.rotation
                        : e.s.ix === t || t === `Scale`
                          ? r.scale
                          : (e.sk && e.sk.ix === t) || t === `Skew`
                            ? r.skew
                            : (e.sa && e.sa.ix === t) || t === `Skew Axis`
                              ? r.skewAxis
                              : null;
              }
              var i = propertyGroupFactory(r, n);
              return (
                t.transform.mProps.o.setGroupProperty(
                  PropertyInterface(`Opacity`, i),
                ),
                t.transform.mProps.p.setGroupProperty(
                  PropertyInterface(`Position`, i),
                ),
                t.transform.mProps.a.setGroupProperty(
                  PropertyInterface(`Anchor Point`, i),
                ),
                t.transform.mProps.s.setGroupProperty(
                  PropertyInterface(`Scale`, i),
                ),
                t.transform.mProps.r.setGroupProperty(
                  PropertyInterface(`Rotation`, i),
                ),
                t.transform.mProps.sk &&
                  (t.transform.mProps.sk.setGroupProperty(
                    PropertyInterface(`Skew`, i),
                  ),
                  t.transform.mProps.sa.setGroupProperty(
                    PropertyInterface(`Skew Angle`, i),
                  )),
                t.transform.op.setGroupProperty(
                  PropertyInterface(`Opacity`, i),
                ),
                Object.defineProperties(r, {
                  opacity: {
                    get: ExpressionPropertyInterface(t.transform.mProps.o),
                  },
                  position: {
                    get: ExpressionPropertyInterface(t.transform.mProps.p),
                  },
                  anchorPoint: {
                    get: ExpressionPropertyInterface(t.transform.mProps.a),
                  },
                  scale: {
                    get: ExpressionPropertyInterface(t.transform.mProps.s),
                  },
                  rotation: {
                    get: ExpressionPropertyInterface(t.transform.mProps.r),
                  },
                  skew: {
                    get: ExpressionPropertyInterface(t.transform.mProps.sk),
                  },
                  skewAxis: {
                    get: ExpressionPropertyInterface(t.transform.mProps.sa),
                  },
                  _name: { value: e.nm },
                }),
                (r.ty = `tr`),
                (r.mn = e.mn),
                (r.propertyGroup = n),
                r
              );
            }
            function l(e, t, n) {
              function r(t) {
                return e.p.ix === t ? r.position : e.s.ix === t ? r.size : null;
              }
              var i = propertyGroupFactory(r, n);
              r.propertyIndex = e.ix;
              var a = t.sh.ty === `tm` ? t.sh.prop : t.sh;
              return (
                a.s.setGroupProperty(PropertyInterface(`Size`, i)),
                a.p.setGroupProperty(PropertyInterface(`Position`, i)),
                Object.defineProperties(r, {
                  size: { get: ExpressionPropertyInterface(a.s) },
                  position: { get: ExpressionPropertyInterface(a.p) },
                  _name: { value: e.nm },
                }),
                (r.mn = e.mn),
                r
              );
            }
            function u(e, t, n) {
              function r(t) {
                return e.p.ix === t
                  ? r.position
                  : e.r.ix === t
                    ? r.rotation
                    : e.pt.ix === t
                      ? r.points
                      : e.or.ix === t || t === `ADBE Vector Star Outer Radius`
                        ? r.outerRadius
                        : e.os.ix === t
                          ? r.outerRoundness
                          : e.ir &&
                              (e.ir.ix === t ||
                                t === `ADBE Vector Star Inner Radius`)
                            ? r.innerRadius
                            : e.is && e.is.ix === t
                              ? r.innerRoundness
                              : null;
              }
              var i = propertyGroupFactory(r, n),
                a = t.sh.ty === `tm` ? t.sh.prop : t.sh;
              return (
                (r.propertyIndex = e.ix),
                a.or.setGroupProperty(PropertyInterface(`Outer Radius`, i)),
                a.os.setGroupProperty(PropertyInterface(`Outer Roundness`, i)),
                a.pt.setGroupProperty(PropertyInterface(`Points`, i)),
                a.p.setGroupProperty(PropertyInterface(`Position`, i)),
                a.r.setGroupProperty(PropertyInterface(`Rotation`, i)),
                e.ir &&
                  (a.ir.setGroupProperty(PropertyInterface(`Inner Radius`, i)),
                  a.is.setGroupProperty(
                    PropertyInterface(`Inner Roundness`, i),
                  )),
                Object.defineProperties(r, {
                  position: { get: ExpressionPropertyInterface(a.p) },
                  rotation: { get: ExpressionPropertyInterface(a.r) },
                  points: { get: ExpressionPropertyInterface(a.pt) },
                  outerRadius: { get: ExpressionPropertyInterface(a.or) },
                  outerRoundness: { get: ExpressionPropertyInterface(a.os) },
                  innerRadius: { get: ExpressionPropertyInterface(a.ir) },
                  innerRoundness: { get: ExpressionPropertyInterface(a.is) },
                  _name: { value: e.nm },
                }),
                (r.mn = e.mn),
                r
              );
            }
            function d(e, t, n) {
              function r(t) {
                return e.p.ix === t
                  ? r.position
                  : e.r.ix === t
                    ? r.roundness
                    : e.s.ix === t ||
                        t === `Size` ||
                        t === `ADBE Vector Rect Size`
                      ? r.size
                      : null;
              }
              var i = propertyGroupFactory(r, n),
                a = t.sh.ty === `tm` ? t.sh.prop : t.sh;
              return (
                (r.propertyIndex = e.ix),
                a.p.setGroupProperty(PropertyInterface(`Position`, i)),
                a.s.setGroupProperty(PropertyInterface(`Size`, i)),
                a.r.setGroupProperty(PropertyInterface(`Rotation`, i)),
                Object.defineProperties(r, {
                  position: { get: ExpressionPropertyInterface(a.p) },
                  roundness: { get: ExpressionPropertyInterface(a.r) },
                  size: { get: ExpressionPropertyInterface(a.s) },
                  _name: { value: e.nm },
                }),
                (r.mn = e.mn),
                r
              );
            }
            function f(e, t, n) {
              function r(t) {
                return e.r.ix === t || t === `Round Corners 1`
                  ? r.radius
                  : null;
              }
              var i = propertyGroupFactory(r, n),
                a = t;
              return (
                (r.propertyIndex = e.ix),
                a.rd.setGroupProperty(PropertyInterface(`Radius`, i)),
                Object.defineProperties(r, {
                  radius: { get: ExpressionPropertyInterface(a.rd) },
                  _name: { value: e.nm },
                }),
                (r.mn = e.mn),
                r
              );
            }
            function p(e, t, n) {
              function r(t) {
                return e.c.ix === t || t === `Copies`
                  ? r.copies
                  : e.o.ix === t || t === `Offset`
                    ? r.offset
                    : null;
              }
              var i = propertyGroupFactory(r, n),
                a = t;
              return (
                (r.propertyIndex = e.ix),
                a.c.setGroupProperty(PropertyInterface(`Copies`, i)),
                a.o.setGroupProperty(PropertyInterface(`Offset`, i)),
                Object.defineProperties(r, {
                  copies: { get: ExpressionPropertyInterface(a.c) },
                  offset: { get: ExpressionPropertyInterface(a.o) },
                  _name: { value: e.nm },
                }),
                (r.mn = e.mn),
                r
              );
            }
            return function (t, n, r) {
              var i;
              function a(e) {
                if (typeof e == `number`)
                  return ((e = e === void 0 ? 1 : e), e === 0 ? r : i[e - 1]);
                for (var t = 0, n = i.length; t < n;) {
                  if (i[t]._name === e) return i[t];
                  t += 1;
                }
                return null;
              }
              function o() {
                return r;
              }
              return (
                (a.propertyGroup = propertyGroupFactory(a, o)),
                (i = e(t, n, a.propertyGroup)),
                (a.numProperties = i.length),
                (a._name = `Contents`),
                a
              );
            };
          })(),
          TextExpressionInterface = (function () {
            return function (e) {
              var t;
              function n(e) {
                switch (e) {
                  case `ADBE Text Document`:
                    return n.sourceText;
                  default:
                    return null;
                }
              }
              return (
                Object.defineProperty(n, "sourceText", {
                  get: function () {
                    e.textProperty.getValue();
                    var n = e.textProperty.currentData.t;
                    return (
                      (!t || n !== t.value) &&
                        ((t = new String(n)),
                        (t.value = n || new String(n)),
                        Object.defineProperty(t, "style", {
                          get: function () {
                            return { fillColor: e.textProperty.currentData.fc };
                          },
                        })),
                      t
                    );
                  },
                }),
                n
              );
            };
          })();
        function _typeof(e) {
          "@babel/helpers - typeof";
          return (
            (_typeof =
              typeof Symbol == `function` && typeof Symbol.iterator == `symbol`
                ? function (e) {
                    return typeof e;
                  }
                : function (e) {
                    return e &&
                      typeof Symbol == `function` &&
                      e.constructor === Symbol &&
                      e !== Symbol.prototype
                      ? `symbol`
                      : typeof e;
                  }),
            _typeof(e)
          );
        }
        var FootageInterface = (function () {
            var e = function (e) {
                var t = ``,
                  n = e.getFootageData();
                function r() {
                  return ((t = ``), (n = e.getFootageData()), i);
                }
                function i(e) {
                  if (n[e])
                    return (
                      (t = e),
                      (n = n[e]),
                      _typeof(n) === `object` ? i : n
                    );
                  var r = e.indexOf(t);
                  if (r !== -1) {
                    var a = parseInt(e.substr(r + t.length), 10);
                    return ((n = n[a]), _typeof(n) === `object` ? i : n);
                  }
                  return ``;
                }
                return r;
              },
              t = function (t) {
                function n(e) {
                  return e === `Outline` ? n.outlineInterface() : null;
                }
                return ((n._name = `Outline`), (n.outlineInterface = e(t)), n);
              };
            return function (e) {
              function n(e) {
                return e === `Data` ? n.dataInterface : null;
              }
              return ((n._name = `Data`), (n.dataInterface = t(e)), n);
            };
          })(),
          interfaces = {
            layer: LayerExpressionInterface,
            effects: EffectsExpressionInterface,
            comp: CompExpressionInterface,
            shape: ShapeExpressionInterface,
            text: TextExpressionInterface,
            footage: FootageInterface,
          };
        function getInterface(e) {
          return interfaces[e] || null;
        }
        var expressionHelpers = (function () {
          function e(e, t, n) {
            t.x &&
              ((n.k = !0),
              (n.x = !0),
              (n.initiateExpression = ExpressionManager.initiateExpression),
              n.effectsSequence.push(n.initiateExpression(e, t, n).bind(n)));
          }
          function t(e) {
            return (
              (e *= this.elem.globalData.frameRate),
              (e -= this.offsetTime),
              e !== this._cachingAtTime.lastFrame &&
                ((this._cachingAtTime.lastIndex =
                  this._cachingAtTime.lastFrame < e
                    ? this._cachingAtTime.lastIndex
                    : 0),
                (this._cachingAtTime.value = this.interpolateValue(
                  e,
                  this._cachingAtTime,
                )),
                (this._cachingAtTime.lastFrame = e)),
              this._cachingAtTime.value
            );
          }
          function n(e) {
            var t = -0.01,
              n = this.getValueAtTime(e),
              r = this.getValueAtTime(e + t),
              i = 0;
            if (n.length) {
              var a;
              for (a = 0; a < n.length; a += 1) i += (r[a] - n[a]) ** 2;
              i = Math.sqrt(i) * 100;
            } else i = 0;
            return i;
          }
          function r(e) {
            if (this.vel !== void 0) return this.vel;
            var t = -0.001,
              n = this.getValueAtTime(e),
              r = this.getValueAtTime(e + t),
              i;
            if (n.length) {
              i = createTypedArray(`float32`, n.length);
              var a;
              for (a = 0; a < n.length; a += 1) i[a] = (r[a] - n[a]) / t;
            } else i = (r - n) / t;
            return i;
          }
          function i() {
            return this.pv;
          }
          function a(e) {
            this.propertyGroup = e;
          }
          return {
            searchExpressions: e,
            getSpeedAtTime: n,
            getVelocityAtTime: r,
            getValueAtTime: t,
            getStaticValueAtTime: i,
            setGroupProperty: a,
          };
        })();
        function addPropertyDecorator() {
          function e(e, t, n) {
            if (!this.k || !this.keyframes) return this.pv;
            e = e ? e.toLowerCase() : ``;
            var r = this.comp.renderedFrame,
              i = this.keyframes,
              a = i[i.length - 1].t;
            if (r <= a) return this.pv;
            var o, s;
            n
              ? ((o = t
                  ? Math.abs(a - this.elem.comp.globalData.frameRate * t)
                  : Math.max(0, a - this.elem.data.ip)),
                (s = a - o))
              : ((!t || t > i.length - 1) && (t = i.length - 1),
                (s = i[i.length - 1 - t].t),
                (o = a - s));
            var c, l, u;
            if (e === `pingpong`) {
              if (Math.floor((r - s) / o) % 2 != 0)
                return this.getValueAtTime(
                  (o - ((r - s) % o) + s) / this.comp.globalData.frameRate,
                  0,
                );
            } else if (e === `offset`) {
              var d = this.getValueAtTime(
                  s / this.comp.globalData.frameRate,
                  0,
                ),
                f = this.getValueAtTime(a / this.comp.globalData.frameRate, 0),
                p = this.getValueAtTime(
                  (((r - s) % o) + s) / this.comp.globalData.frameRate,
                  0,
                ),
                m = Math.floor((r - s) / o);
              if (this.pv.length) {
                for (u = Array(d.length), l = u.length, c = 0; c < l; c += 1)
                  u[c] = (f[c] - d[c]) * m + p[c];
                return u;
              }
              return (f - d) * m + p;
            } else if (e === `continue`) {
              var g = this.getValueAtTime(
                  a / this.comp.globalData.frameRate,
                  0,
                ),
                _ = this.getValueAtTime(
                  (a - 0.001) / this.comp.globalData.frameRate,
                  0,
                );
              if (this.pv.length) {
                for (u = Array(g.length), l = u.length, c = 0; c < l; c += 1)
                  u[c] =
                    g[c] +
                    ((g[c] - _[c]) *
                      ((r - a) / this.comp.globalData.frameRate)) /
                      5e-4;
                return u;
              }
              return g + (g - _) * ((r - a) / 0.001);
            }
            return this.getValueAtTime(
              (((r - s) % o) + s) / this.comp.globalData.frameRate,
              0,
            );
          }
          function t(e, t, n) {
            if (!this.k) return this.pv;
            e = e ? e.toLowerCase() : ``;
            var r = this.comp.renderedFrame,
              i = this.keyframes,
              a = i[0].t;
            if (r >= a) return this.pv;
            var o, s;
            n
              ? ((o = t
                  ? Math.abs(this.elem.comp.globalData.frameRate * t)
                  : Math.max(0, this.elem.data.op - a)),
                (s = a + o))
              : ((!t || t > i.length - 1) && (t = i.length - 1),
                (s = i[t].t),
                (o = s - a));
            var c, l, u;
            if (e === `pingpong`) {
              if (Math.floor((a - r) / o) % 2 == 0)
                return this.getValueAtTime(
                  (((a - r) % o) + a) / this.comp.globalData.frameRate,
                  0,
                );
            } else if (e === `offset`) {
              var d = this.getValueAtTime(
                  a / this.comp.globalData.frameRate,
                  0,
                ),
                f = this.getValueAtTime(s / this.comp.globalData.frameRate, 0),
                p = this.getValueAtTime(
                  (o - ((a - r) % o) + a) / this.comp.globalData.frameRate,
                  0,
                ),
                m = Math.floor((a - r) / o) + 1;
              if (this.pv.length) {
                for (u = Array(d.length), l = u.length, c = 0; c < l; c += 1)
                  u[c] = p[c] - (f[c] - d[c]) * m;
                return u;
              }
              return p - (f - d) * m;
            } else if (e === `continue`) {
              var g = this.getValueAtTime(
                  a / this.comp.globalData.frameRate,
                  0,
                ),
                _ = this.getValueAtTime(
                  (a + 0.001) / this.comp.globalData.frameRate,
                  0,
                );
              if (this.pv.length) {
                for (u = Array(g.length), l = u.length, c = 0; c < l; c += 1)
                  u[c] = g[c] + ((g[c] - _[c]) * (a - r)) / 0.001;
                return u;
              }
              return g + ((g - _) * (a - r)) / 0.001;
            }
            return this.getValueAtTime(
              (o - (((a - r) % o) + a)) / this.comp.globalData.frameRate,
              0,
            );
          }
          function n(e, t) {
            if (
              !this.k ||
              ((e = (e || 0.4) * 0.5), (t = Math.floor(t || 5)), t <= 1)
            )
              return this.pv;
            for (
              var n = this.comp.renderedFrame / this.comp.globalData.frameRate,
                r = n - e,
                i = n + e,
                a = t > 1 ? (i - r) / (t - 1) : 1,
                o = 0,
                s = 0,
                c = this.pv.length
                  ? createTypedArray(`float32`, this.pv.length)
                  : 0,
                l;
              o < t;
            ) {
              if (((l = this.getValueAtTime(r + o * a)), this.pv.length))
                for (s = 0; s < this.pv.length; s += 1) c[s] += l[s];
              else c += l;
              o += 1;
            }
            if (this.pv.length)
              for (s = 0; s < this.pv.length; s += 1) c[s] /= t;
            else c /= t;
            return c;
          }
          function r(e) {
            this._transformCachingAtTime ||= { v: new Matrix() };
            var t = this._transformCachingAtTime.v;
            if (
              (t.cloneFromProps(this.pre.props),
              this.appliedTransformations < 1)
            ) {
              var n = this.a.getValueAtTime(e);
              t.translate(
                -n[0] * this.a.mult,
                -n[1] * this.a.mult,
                n[2] * this.a.mult,
              );
            }
            if (this.appliedTransformations < 2) {
              var r = this.s.getValueAtTime(e);
              t.scale(
                r[0] * this.s.mult,
                r[1] * this.s.mult,
                r[2] * this.s.mult,
              );
            }
            if (this.sk && this.appliedTransformations < 3) {
              var i = this.sk.getValueAtTime(e),
                a = this.sa.getValueAtTime(e);
              t.skewFromAxis(-i * this.sk.mult, a * this.sa.mult);
            }
            if (this.r && this.appliedTransformations < 4) {
              var o = this.r.getValueAtTime(e);
              t.rotate(-o * this.r.mult);
            } else if (!this.r && this.appliedTransformations < 4) {
              var s = this.rz.getValueAtTime(e),
                c = this.ry.getValueAtTime(e),
                l = this.rx.getValueAtTime(e),
                u = this.or.getValueAtTime(e);
              t.rotateZ(-s * this.rz.mult)
                .rotateY(c * this.ry.mult)
                .rotateX(l * this.rx.mult)
                .rotateZ(-u[2] * this.or.mult)
                .rotateY(u[1] * this.or.mult)
                .rotateX(u[0] * this.or.mult);
            }
            if (this.data.p && this.data.p.s) {
              var d = this.px.getValueAtTime(e),
                f = this.py.getValueAtTime(e);
              if (this.data.p.z) {
                var p = this.pz.getValueAtTime(e);
                t.translate(
                  d * this.px.mult,
                  f * this.py.mult,
                  -p * this.pz.mult,
                );
              } else t.translate(d * this.px.mult, f * this.py.mult, 0);
            } else {
              var m = this.p.getValueAtTime(e);
              t.translate(
                m[0] * this.p.mult,
                m[1] * this.p.mult,
                -m[2] * this.p.mult,
              );
            }
            return t;
          }
          function i() {
            return this.v.clone(new Matrix());
          }
          var a = TransformPropertyFactory.getTransformProperty;
          TransformPropertyFactory.getTransformProperty = function (e, t, n) {
            var o = a(e, t, n);
            return (
              o.dynamicProperties.length
                ? (o.getValueAtTime = r.bind(o))
                : (o.getValueAtTime = i.bind(o)),
              (o.setGroupProperty = expressionHelpers.setGroupProperty),
              o
            );
          };
          var o = PropertyFactory.getProp;
          PropertyFactory.getProp = function (r, i, a, s, c) {
            var l = o(r, i, a, s, c);
            (l.kf
              ? (l.getValueAtTime = expressionHelpers.getValueAtTime.bind(l))
              : (l.getValueAtTime =
                  expressionHelpers.getStaticValueAtTime.bind(l)),
              (l.setGroupProperty = expressionHelpers.setGroupProperty),
              (l.loopOut = e),
              (l.loopIn = t),
              (l.smooth = n),
              (l.getVelocityAtTime =
                expressionHelpers.getVelocityAtTime.bind(l)),
              (l.getSpeedAtTime = expressionHelpers.getSpeedAtTime.bind(l)),
              (l.numKeys = i.a === 1 ? i.k.length : 0),
              (l.propertyIndex = i.ix));
            var u = 0;
            return (
              a !== 0 &&
                (u = createTypedArray(
                  `float32`,
                  i.a === 1 ? i.k[0].s.length : i.k.length,
                )),
              (l._cachingAtTime = {
                lastFrame: initialDefaultFrame,
                lastIndex: 0,
                value: u,
              }),
              expressionHelpers.searchExpressions(r, i, l),
              l.k && c.addDynamicProperty(l),
              l
            );
          };
          function s(e) {
            return (
              (this._cachingAtTime ||= {
                shapeValue: shapePool.clone(this.pv),
                lastIndex: 0,
                lastTime: initialDefaultFrame,
              }),
              (e *= this.elem.globalData.frameRate),
              (e -= this.offsetTime),
              e !== this._cachingAtTime.lastTime &&
                ((this._cachingAtTime.lastIndex =
                  this._cachingAtTime.lastTime < e
                    ? this._caching.lastIndex
                    : 0),
                (this._cachingAtTime.lastTime = e),
                this.interpolateShape(
                  e,
                  this._cachingAtTime.shapeValue,
                  this._cachingAtTime,
                )),
              this._cachingAtTime.shapeValue
            );
          }
          var c = ShapePropertyFactory.getConstructorFunction(),
            l = ShapePropertyFactory.getKeyframedConstructorFunction();
          function u() {}
          ((u.prototype = {
            vertices: function (e, t) {
              this.k && this.getValue();
              var n = this.v;
              t !== void 0 && (n = this.getValueAtTime(t, 0));
              var r,
                i = n._length,
                a = n[e],
                o = n.v,
                s = createSizedArray(i);
              for (r = 0; r < i; r += 1)
                e === `i` || e === `o`
                  ? (s[r] = [a[r][0] - o[r][0], a[r][1] - o[r][1]])
                  : (s[r] = [a[r][0], a[r][1]]);
              return s;
            },
            points: function (e) {
              return this.vertices(`v`, e);
            },
            inTangents: function (e) {
              return this.vertices(`i`, e);
            },
            outTangents: function (e) {
              return this.vertices(`o`, e);
            },
            isClosed: function () {
              return this.v.c;
            },
            pointOnPath: function (e, t) {
              var n = this.v;
              (t !== void 0 && (n = this.getValueAtTime(t, 0)),
                (this._segmentsLength ||= bez.getSegmentsLength(n)));
              for (
                var r = this._segmentsLength,
                  i = r.lengths,
                  a = r.totalLength * e,
                  o = 0,
                  s = i.length,
                  c = 0,
                  l;
                o < s;
              ) {
                if (c + i[o].addedLength > a) {
                  var u = o,
                    d = n.c && o === s - 1 ? 0 : o + 1,
                    f = (a - c) / i[o].addedLength;
                  l = bez.getPointInSegment(
                    n.v[u],
                    n.v[d],
                    n.o[u],
                    n.i[d],
                    f,
                    i[o],
                  );
                  break;
                } else c += i[o].addedLength;
                o += 1;
              }
              return (
                (l ||= n.c
                  ? [n.v[0][0], n.v[0][1]]
                  : [n.v[n._length - 1][0], n.v[n._length - 1][1]]),
                l
              );
            },
            vectorOnPath: function (e, t, n) {
              e == 1 ? (e = this.v.c) : e == 0 && (e = 0.999);
              var r = this.pointOnPath(e, t),
                i = this.pointOnPath(e + 0.001, t),
                a = i[0] - r[0],
                o = i[1] - r[1],
                s = Math.sqrt(a ** 2 + o ** 2);
              return s === 0
                ? [0, 0]
                : n === `tangent`
                  ? [a / s, o / s]
                  : [-o / s, a / s];
            },
            tangentOnPath: function (e, t) {
              return this.vectorOnPath(e, t, `tangent`);
            },
            normalOnPath: function (e, t) {
              return this.vectorOnPath(e, t, `normal`);
            },
            setGroupProperty: expressionHelpers.setGroupProperty,
            getValueAtTime: expressionHelpers.getStaticValueAtTime,
          }),
            extendPrototype([u], c),
            extendPrototype([u], l),
            (l.prototype.getValueAtTime = s),
            (l.prototype.initiateExpression =
              ExpressionManager.initiateExpression));
          var d = ShapePropertyFactory.getShapeProp;
          ShapePropertyFactory.getShapeProp = function (e, t, n, r, i) {
            var a = d(e, t, n, r, i);
            return (
              (a.propertyIndex = t.ix),
              (a.lock = !1),
              n === 3
                ? expressionHelpers.searchExpressions(e, t.pt, a)
                : n === 4 && expressionHelpers.searchExpressions(e, t.ks, a),
              a.k && e.addDynamicProperty(a),
              a
            );
          };
        }
        function initialize$1() {
          addPropertyDecorator();
        }
        function addDecorator() {
          function e() {
            return this.data.d.x
              ? ((this.calculateExpression =
                  ExpressionManager.initiateExpression.bind(this)(
                    this.elem,
                    this.data.d,
                    this,
                  )),
                this.addEffect(this.getExpressionValue.bind(this)),
                !0)
              : null;
          }
          ((TextProperty.prototype.getExpressionValue = function (e, t) {
            var n = this.calculateExpression(t);
            if (e.t !== n) {
              var r = {};
              return (
                this.copyData(r, e),
                (r.t = n.toString()),
                (r.__complete = !1),
                r
              );
            }
            return e;
          }),
            (TextProperty.prototype.searchProperty = function () {
              var e = this.searchKeyframes(),
                t = this.searchExpressions();
              return ((this.kf = e || t), this.kf);
            }),
            (TextProperty.prototype.searchExpressions = e));
        }
        function initialize() {
          addDecorator();
        }
        function SVGComposableEffect() {}
        SVGComposableEffect.prototype = {
          createMergeNode: function (e, t) {
            var n = createNS(`feMerge`);
            n.setAttribute(`result`, e);
            var r, i;
            for (i = 0; i < t.length; i += 1)
              ((r = createNS(`feMergeNode`)),
                r.setAttribute(`in`, t[i]),
                n.appendChild(r),
                n.appendChild(r));
            return n;
          },
        };
        var linearFilterValue = `0.3333 0.3333 0.3333 0 0 0.3333 0.3333 0.3333 0 0 0.3333 0.3333 0.3333 0 0 0 0 0`;
        function SVGTintFilter(e, t, n, r, i) {
          this.filterManager = t;
          var a = createNS(`feColorMatrix`);
          (a.setAttribute(`type`, `matrix`),
            a.setAttribute(`color-interpolation-filters`, `linearRGB`),
            a.setAttribute(`values`, linearFilterValue + ` 1 0`),
            (this.linearFilter = a),
            a.setAttribute(`result`, r + `_tint_1`),
            e.appendChild(a),
            (a = createNS(`feColorMatrix`)),
            a.setAttribute(`type`, `matrix`),
            a.setAttribute(`color-interpolation-filters`, `sRGB`),
            a.setAttribute(`values`, `1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0`),
            a.setAttribute(`result`, r + `_tint_2`),
            e.appendChild(a),
            (this.matrixFilter = a));
          var o = this.createMergeNode(r, [i, r + `_tint_1`, r + `_tint_2`]);
          e.appendChild(o);
        }
        (extendPrototype([SVGComposableEffect], SVGTintFilter),
          (SVGTintFilter.prototype.renderFrame = function (e) {
            if (e || this.filterManager._mdf) {
              var t = this.filterManager.effectElements[0].p.v,
                n = this.filterManager.effectElements[1].p.v,
                r = this.filterManager.effectElements[2].p.v / 100;
              (this.linearFilter.setAttribute(
                `values`,
                linearFilterValue + ` ` + r + ` 0`,
              ),
                this.matrixFilter.setAttribute(
                  `values`,
                  n[0] -
                    t[0] +
                    ` 0 0 0 ` +
                    t[0] +
                    ` ` +
                    (n[1] - t[1]) +
                    ` 0 0 0 ` +
                    t[1] +
                    ` ` +
                    (n[2] - t[2]) +
                    ` 0 0 0 ` +
                    t[2] +
                    ` 0 0 0 1 0`,
                ));
            }
          }));
        function SVGFillFilter(e, t, n, r) {
          this.filterManager = t;
          var i = createNS(`feColorMatrix`);
          (i.setAttribute(`type`, `matrix`),
            i.setAttribute(`color-interpolation-filters`, `sRGB`),
            i.setAttribute(`values`, `1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0`),
            i.setAttribute(`result`, r),
            e.appendChild(i),
            (this.matrixFilter = i));
        }
        SVGFillFilter.prototype.renderFrame = function (e) {
          if (e || this.filterManager._mdf) {
            var t = this.filterManager.effectElements[2].p.v,
              n = this.filterManager.effectElements[6].p.v;
            this.matrixFilter.setAttribute(
              `values`,
              `0 0 0 0 ` +
                t[0] +
                ` 0 0 0 0 ` +
                t[1] +
                ` 0 0 0 0 ` +
                t[2] +
                ` 0 0 0 ` +
                n +
                ` 0`,
            );
          }
        };
        function SVGStrokeEffect(e, t, n) {
          ((this.initialized = !1),
            (this.filterManager = t),
            (this.elem = n),
            (this.paths = []));
        }
        ((SVGStrokeEffect.prototype.initialize = function () {
          var e =
              this.elem.layerElement.children ||
              this.elem.layerElement.childNodes,
            t,
            n,
            r,
            i;
          for (
            this.filterManager.effectElements[1].p.v === 1
              ? ((i = this.elem.maskManager.masksProperties.length), (r = 0))
              : ((r = this.filterManager.effectElements[0].p.v - 1),
                (i = r + 1)),
              n = createNS(`g`),
              n.setAttribute(`fill`, `none`),
              n.setAttribute(`stroke-linecap`, `round`),
              n.setAttribute(`stroke-dashoffset`, 1);
            r < i;
            r += 1
          )
            ((t = createNS(`path`)),
              n.appendChild(t),
              this.paths.push({ p: t, m: r }));
          if (this.filterManager.effectElements[10].p.v === 3) {
            var a = createNS(`mask`),
              o = createElementID();
            (a.setAttribute(`id`, o),
              a.setAttribute(`mask-type`, `alpha`),
              a.appendChild(n),
              this.elem.globalData.defs.appendChild(a));
            var s = createNS(`g`);
            for (
              s.setAttribute(
                `mask`,
                `url(` + getLocationHref() + `#` + o + `)`,
              );
              e[0];
            )
              s.appendChild(e[0]);
            (this.elem.layerElement.appendChild(s),
              (this.masker = a),
              n.setAttribute(`stroke`, `#fff`));
          } else if (
            this.filterManager.effectElements[10].p.v === 1 ||
            this.filterManager.effectElements[10].p.v === 2
          ) {
            if (this.filterManager.effectElements[10].p.v === 2)
              for (
                e =
                  this.elem.layerElement.children ||
                  this.elem.layerElement.childNodes;
                e.length;
              )
                this.elem.layerElement.removeChild(e[0]);
            (this.elem.layerElement.appendChild(n),
              this.elem.layerElement.removeAttribute(`mask`),
              n.setAttribute(`stroke`, `#fff`));
          }
          ((this.initialized = !0), (this.pathMasker = n));
        }),
          (SVGStrokeEffect.prototype.renderFrame = function (e) {
            this.initialized || this.initialize();
            var t,
              n = this.paths.length,
              r,
              i;
            for (t = 0; t < n; t += 1)
              if (
                this.paths[t].m !== -1 &&
                ((r = this.elem.maskManager.viewData[this.paths[t].m]),
                (i = this.paths[t].p),
                (e || this.filterManager._mdf || r.prop._mdf) &&
                  i.setAttribute(`d`, r.lastPath),
                e ||
                  this.filterManager.effectElements[9].p._mdf ||
                  this.filterManager.effectElements[4].p._mdf ||
                  this.filterManager.effectElements[7].p._mdf ||
                  this.filterManager.effectElements[8].p._mdf ||
                  r.prop._mdf)
              ) {
                var a;
                if (
                  this.filterManager.effectElements[7].p.v !== 0 ||
                  this.filterManager.effectElements[8].p.v !== 100
                ) {
                  var o =
                      Math.min(
                        this.filterManager.effectElements[7].p.v,
                        this.filterManager.effectElements[8].p.v,
                      ) * 0.01,
                    s =
                      Math.max(
                        this.filterManager.effectElements[7].p.v,
                        this.filterManager.effectElements[8].p.v,
                      ) * 0.01,
                    c = i.getTotalLength();
                  a = `0 0 0 ` + c * o + ` `;
                  var l = c * (s - o),
                    u =
                      1 +
                      this.filterManager.effectElements[4].p.v *
                        2 *
                        this.filterManager.effectElements[9].p.v *
                        0.01,
                    d = Math.floor(l / u),
                    f;
                  for (f = 0; f < d; f += 1)
                    a +=
                      `1 ` +
                      this.filterManager.effectElements[4].p.v *
                        2 *
                        this.filterManager.effectElements[9].p.v *
                        0.01 +
                      ` `;
                  a += `0 ` + c * 10 + ` 0 0`;
                } else
                  a =
                    `1 ` +
                    this.filterManager.effectElements[4].p.v *
                      2 *
                      this.filterManager.effectElements[9].p.v *
                      0.01;
                i.setAttribute(`stroke-dasharray`, a);
              }
            if (
              ((e || this.filterManager.effectElements[4].p._mdf) &&
                this.pathMasker.setAttribute(
                  `stroke-width`,
                  this.filterManager.effectElements[4].p.v * 2,
                ),
              (e || this.filterManager.effectElements[6].p._mdf) &&
                this.pathMasker.setAttribute(
                  `opacity`,
                  this.filterManager.effectElements[6].p.v,
                ),
              (this.filterManager.effectElements[10].p.v === 1 ||
                this.filterManager.effectElements[10].p.v === 2) &&
                (e || this.filterManager.effectElements[3].p._mdf))
            ) {
              var p = this.filterManager.effectElements[3].p.v;
              this.pathMasker.setAttribute(
                `stroke`,
                `rgb(` +
                  bmFloor(p[0] * 255) +
                  `,` +
                  bmFloor(p[1] * 255) +
                  `,` +
                  bmFloor(p[2] * 255) +
                  `)`,
              );
            }
          }));
        function SVGTritoneFilter(e, t, n, r) {
          this.filterManager = t;
          var i = createNS(`feColorMatrix`);
          (i.setAttribute(`type`, `matrix`),
            i.setAttribute(`color-interpolation-filters`, `linearRGB`),
            i.setAttribute(
              `values`,
              `0.3333 0.3333 0.3333 0 0 0.3333 0.3333 0.3333 0 0 0.3333 0.3333 0.3333 0 0 0 0 0 1 0`,
            ),
            e.appendChild(i));
          var a = createNS(`feComponentTransfer`);
          (a.setAttribute(`color-interpolation-filters`, `sRGB`),
            a.setAttribute(`result`, r),
            (this.matrixFilter = a));
          var o = createNS(`feFuncR`);
          (o.setAttribute(`type`, `table`),
            a.appendChild(o),
            (this.feFuncR = o));
          var s = createNS(`feFuncG`);
          (s.setAttribute(`type`, `table`),
            a.appendChild(s),
            (this.feFuncG = s));
          var c = createNS(`feFuncB`);
          (c.setAttribute(`type`, `table`),
            a.appendChild(c),
            (this.feFuncB = c),
            e.appendChild(a));
        }
        SVGTritoneFilter.prototype.renderFrame = function (e) {
          if (e || this.filterManager._mdf) {
            var t = this.filterManager.effectElements[0].p.v,
              n = this.filterManager.effectElements[1].p.v,
              r = this.filterManager.effectElements[2].p.v,
              i = r[0] + ` ` + n[0] + ` ` + t[0],
              a = r[1] + ` ` + n[1] + ` ` + t[1],
              o = r[2] + ` ` + n[2] + ` ` + t[2];
            (this.feFuncR.setAttribute(`tableValues`, i),
              this.feFuncG.setAttribute(`tableValues`, a),
              this.feFuncB.setAttribute(`tableValues`, o));
          }
        };
        function SVGProLevelsFilter(e, t, n, r) {
          this.filterManager = t;
          var i = this.filterManager.effectElements,
            a = createNS(`feComponentTransfer`);
          ((i[10].p.k ||
            i[10].p.v !== 0 ||
            i[11].p.k ||
            i[11].p.v !== 1 ||
            i[12].p.k ||
            i[12].p.v !== 1 ||
            i[13].p.k ||
            i[13].p.v !== 0 ||
            i[14].p.k ||
            i[14].p.v !== 1) &&
            (this.feFuncR = this.createFeFunc(`feFuncR`, a)),
            (i[17].p.k ||
              i[17].p.v !== 0 ||
              i[18].p.k ||
              i[18].p.v !== 1 ||
              i[19].p.k ||
              i[19].p.v !== 1 ||
              i[20].p.k ||
              i[20].p.v !== 0 ||
              i[21].p.k ||
              i[21].p.v !== 1) &&
              (this.feFuncG = this.createFeFunc(`feFuncG`, a)),
            (i[24].p.k ||
              i[24].p.v !== 0 ||
              i[25].p.k ||
              i[25].p.v !== 1 ||
              i[26].p.k ||
              i[26].p.v !== 1 ||
              i[27].p.k ||
              i[27].p.v !== 0 ||
              i[28].p.k ||
              i[28].p.v !== 1) &&
              (this.feFuncB = this.createFeFunc(`feFuncB`, a)),
            (i[31].p.k ||
              i[31].p.v !== 0 ||
              i[32].p.k ||
              i[32].p.v !== 1 ||
              i[33].p.k ||
              i[33].p.v !== 1 ||
              i[34].p.k ||
              i[34].p.v !== 0 ||
              i[35].p.k ||
              i[35].p.v !== 1) &&
              (this.feFuncA = this.createFeFunc(`feFuncA`, a)),
            (this.feFuncR || this.feFuncG || this.feFuncB || this.feFuncA) &&
              (a.setAttribute(`color-interpolation-filters`, `sRGB`),
              e.appendChild(a)),
            (i[3].p.k ||
              i[3].p.v !== 0 ||
              i[4].p.k ||
              i[4].p.v !== 1 ||
              i[5].p.k ||
              i[5].p.v !== 1 ||
              i[6].p.k ||
              i[6].p.v !== 0 ||
              i[7].p.k ||
              i[7].p.v !== 1) &&
              ((a = createNS(`feComponentTransfer`)),
              a.setAttribute(`color-interpolation-filters`, `sRGB`),
              a.setAttribute(`result`, r),
              e.appendChild(a),
              (this.feFuncRComposed = this.createFeFunc(`feFuncR`, a)),
              (this.feFuncGComposed = this.createFeFunc(`feFuncG`, a)),
              (this.feFuncBComposed = this.createFeFunc(`feFuncB`, a))));
        }
        ((SVGProLevelsFilter.prototype.createFeFunc = function (e, t) {
          var n = createNS(e);
          return (n.setAttribute(`type`, `table`), t.appendChild(n), n);
        }),
          (SVGProLevelsFilter.prototype.getTableValue = function (
            e,
            t,
            n,
            r,
            i,
          ) {
            for (
              var a = 0,
                o = 256,
                s,
                c = Math.min(e, t),
                l = Math.max(e, t),
                u = Array.call(null, { length: o }),
                d,
                f = 0,
                p = i - r,
                m = t - e;
              a <= 256;
            )
              ((s = a / 256),
                (d =
                  s <= c
                    ? m < 0
                      ? i
                      : r
                    : s >= l
                      ? m < 0
                        ? r
                        : i
                      : r + p * ((s - e) / m) ** (1 / n)),
                (u[f] = d),
                (f += 1),
                (a += 256 / (o - 1)));
            return u.join(` `);
          }),
          (SVGProLevelsFilter.prototype.renderFrame = function (e) {
            if (e || this.filterManager._mdf) {
              var t,
                n = this.filterManager.effectElements;
              (this.feFuncRComposed &&
                (e ||
                  n[3].p._mdf ||
                  n[4].p._mdf ||
                  n[5].p._mdf ||
                  n[6].p._mdf ||
                  n[7].p._mdf) &&
                ((t = this.getTableValue(
                  n[3].p.v,
                  n[4].p.v,
                  n[5].p.v,
                  n[6].p.v,
                  n[7].p.v,
                )),
                this.feFuncRComposed.setAttribute(`tableValues`, t),
                this.feFuncGComposed.setAttribute(`tableValues`, t),
                this.feFuncBComposed.setAttribute(`tableValues`, t)),
                this.feFuncR &&
                  (e ||
                    n[10].p._mdf ||
                    n[11].p._mdf ||
                    n[12].p._mdf ||
                    n[13].p._mdf ||
                    n[14].p._mdf) &&
                  ((t = this.getTableValue(
                    n[10].p.v,
                    n[11].p.v,
                    n[12].p.v,
                    n[13].p.v,
                    n[14].p.v,
                  )),
                  this.feFuncR.setAttribute(`tableValues`, t)),
                this.feFuncG &&
                  (e ||
                    n[17].p._mdf ||
                    n[18].p._mdf ||
                    n[19].p._mdf ||
                    n[20].p._mdf ||
                    n[21].p._mdf) &&
                  ((t = this.getTableValue(
                    n[17].p.v,
                    n[18].p.v,
                    n[19].p.v,
                    n[20].p.v,
                    n[21].p.v,
                  )),
                  this.feFuncG.setAttribute(`tableValues`, t)),
                this.feFuncB &&
                  (e ||
                    n[24].p._mdf ||
                    n[25].p._mdf ||
                    n[26].p._mdf ||
                    n[27].p._mdf ||
                    n[28].p._mdf) &&
                  ((t = this.getTableValue(
                    n[24].p.v,
                    n[25].p.v,
                    n[26].p.v,
                    n[27].p.v,
                    n[28].p.v,
                  )),
                  this.feFuncB.setAttribute(`tableValues`, t)),
                this.feFuncA &&
                  (e ||
                    n[31].p._mdf ||
                    n[32].p._mdf ||
                    n[33].p._mdf ||
                    n[34].p._mdf ||
                    n[35].p._mdf) &&
                  ((t = this.getTableValue(
                    n[31].p.v,
                    n[32].p.v,
                    n[33].p.v,
                    n[34].p.v,
                    n[35].p.v,
                  )),
                  this.feFuncA.setAttribute(`tableValues`, t)));
            }
          }));
        function SVGDropShadowEffect(e, t, n, r, i) {
          var a = t.container.globalData.renderConfig.filterSize,
            o = t.data.fs || a;
          (e.setAttribute(`x`, o.x || a.x),
            e.setAttribute(`y`, o.y || a.y),
            e.setAttribute(`width`, o.width || a.width),
            e.setAttribute(`height`, o.height || a.height),
            (this.filterManager = t));
          var s = createNS(`feGaussianBlur`);
          (s.setAttribute(`in`, `SourceAlpha`),
            s.setAttribute(`result`, r + `_drop_shadow_1`),
            s.setAttribute(`stdDeviation`, `0`),
            (this.feGaussianBlur = s),
            e.appendChild(s));
          var c = createNS(`feOffset`);
          (c.setAttribute(`dx`, `25`),
            c.setAttribute(`dy`, `0`),
            c.setAttribute(`in`, r + `_drop_shadow_1`),
            c.setAttribute(`result`, r + `_drop_shadow_2`),
            (this.feOffset = c),
            e.appendChild(c));
          var l = createNS(`feFlood`);
          (l.setAttribute(`flood-color`, `#00ff00`),
            l.setAttribute(`flood-opacity`, `1`),
            l.setAttribute(`result`, r + `_drop_shadow_3`),
            (this.feFlood = l),
            e.appendChild(l));
          var u = createNS(`feComposite`);
          (u.setAttribute(`in`, r + `_drop_shadow_3`),
            u.setAttribute(`in2`, r + `_drop_shadow_2`),
            u.setAttribute(`operator`, `in`),
            u.setAttribute(`result`, r + `_drop_shadow_4`),
            e.appendChild(u));
          var d = this.createMergeNode(r, [r + `_drop_shadow_4`, i]);
          e.appendChild(d);
        }
        (extendPrototype([SVGComposableEffect], SVGDropShadowEffect),
          (SVGDropShadowEffect.prototype.renderFrame = function (e) {
            if (e || this.filterManager._mdf) {
              if (
                ((e || this.filterManager.effectElements[4].p._mdf) &&
                  this.feGaussianBlur.setAttribute(
                    `stdDeviation`,
                    this.filterManager.effectElements[4].p.v / 4,
                  ),
                e || this.filterManager.effectElements[0].p._mdf)
              ) {
                var t = this.filterManager.effectElements[0].p.v;
                this.feFlood.setAttribute(
                  `flood-color`,
                  rgbToHex(
                    Math.round(t[0] * 255),
                    Math.round(t[1] * 255),
                    Math.round(t[2] * 255),
                  ),
                );
              }
              if (
                ((e || this.filterManager.effectElements[1].p._mdf) &&
                  this.feFlood.setAttribute(
                    `flood-opacity`,
                    this.filterManager.effectElements[1].p.v / 255,
                  ),
                e ||
                  this.filterManager.effectElements[2].p._mdf ||
                  this.filterManager.effectElements[3].p._mdf)
              ) {
                var n = this.filterManager.effectElements[3].p.v,
                  r =
                    (this.filterManager.effectElements[2].p.v - 90) * degToRads,
                  i = n * Math.cos(r),
                  a = n * Math.sin(r);
                (this.feOffset.setAttribute(`dx`, i),
                  this.feOffset.setAttribute(`dy`, a));
              }
            }
          }));
        var _svgMatteSymbols = [];
        function SVGMatte3Effect(e, t, n) {
          ((this.initialized = !1),
            (this.filterManager = t),
            (this.filterElem = e),
            (this.elem = n),
            (n.matteElement = createNS(`g`)),
            n.matteElement.appendChild(n.layerElement),
            n.matteElement.appendChild(n.transformedElement),
            (n.baseElement = n.matteElement));
        }
        ((SVGMatte3Effect.prototype.findSymbol = function (e) {
          for (var t = 0, n = _svgMatteSymbols.length; t < n;) {
            if (_svgMatteSymbols[t] === e) return _svgMatteSymbols[t];
            t += 1;
          }
          return null;
        }),
          (SVGMatte3Effect.prototype.replaceInParent = function (e, t) {
            var n = e.layerElement.parentNode;
            if (n) {
              for (
                var r = n.children, i = 0, a = r.length;
                i < a && r[i] !== e.layerElement;
              )
                i += 1;
              var o;
              i <= a - 2 && (o = r[i + 1]);
              var s = createNS(`use`);
              (s.setAttribute(`href`, `#` + t),
                o ? n.insertBefore(s, o) : n.appendChild(s));
            }
          }),
          (SVGMatte3Effect.prototype.setElementAsMask = function (e, t) {
            if (!this.findSymbol(t)) {
              var n = createElementID(),
                r = createNS(`mask`);
              (r.setAttribute(`id`, t.layerId),
                r.setAttribute(`mask-type`, `alpha`),
                _svgMatteSymbols.push(t));
              var i = e.globalData.defs;
              i.appendChild(r);
              var a = createNS(`symbol`);
              (a.setAttribute(`id`, n),
                this.replaceInParent(t, n),
                a.appendChild(t.layerElement),
                i.appendChild(a));
              var o = createNS(`use`);
              (o.setAttribute(`href`, `#` + n),
                r.appendChild(o),
                (t.data.hd = !1),
                t.show());
            }
            e.setMatte(t.layerId);
          }),
          (SVGMatte3Effect.prototype.initialize = function () {
            for (
              var e = this.filterManager.effectElements[0].p.v,
                t = this.elem.comp.elements,
                n = 0,
                r = t.length;
              n < r;
            )
              (t[n] &&
                t[n].data.ind === e &&
                this.setElementAsMask(this.elem, t[n]),
                (n += 1));
            this.initialized = !0;
          }),
          (SVGMatte3Effect.prototype.renderFrame = function () {
            this.initialized || this.initialize();
          }));
        function SVGGaussianBlurEffect(e, t, n, r) {
          (e.setAttribute(`x`, `-100%`),
            e.setAttribute(`y`, `-100%`),
            e.setAttribute(`width`, `300%`),
            e.setAttribute(`height`, `300%`),
            (this.filterManager = t));
          var i = createNS(`feGaussianBlur`);
          (i.setAttribute(`result`, r),
            e.appendChild(i),
            (this.feGaussianBlur = i));
        }
        SVGGaussianBlurEffect.prototype.renderFrame = function (e) {
          if (e || this.filterManager._mdf) {
            var t = this.filterManager.effectElements[0].p.v * 0.3,
              n = this.filterManager.effectElements[1].p.v,
              r = n == 3 ? 0 : t,
              i = n == 2 ? 0 : t;
            this.feGaussianBlur.setAttribute(`stdDeviation`, r + ` ` + i);
            var a =
              this.filterManager.effectElements[2].p.v == 1
                ? `wrap`
                : `duplicate`;
            this.feGaussianBlur.setAttribute(`edgeMode`, a);
          }
        };
        function TransformEffect() {}
        ((TransformEffect.prototype.init = function (e) {
          ((this.effectsManager = e),
            (this.type = effectTypes.TRANSFORM_EFFECT),
            (this.matrix = new Matrix()),
            (this.opacity = -1),
            (this._mdf = !1),
            (this._opMdf = !1));
        }),
          (TransformEffect.prototype.renderFrame = function (e) {
            if (
              ((this._opMdf = !1),
              (this._mdf = !1),
              e || this.effectsManager._mdf)
            ) {
              var t = this.effectsManager.effectElements,
                n = t[0].p.v,
                r = t[1].p.v,
                i = t[2].p.v === 1,
                a = t[3].p.v,
                o = i ? a : t[4].p.v,
                s = t[5].p.v,
                c = t[6].p.v,
                l = t[7].p.v;
              (this.matrix.reset(),
                this.matrix.translate(-n[0], -n[1], n[2]),
                this.matrix.scale(o * 0.01, a * 0.01, 1),
                this.matrix.rotate(-l * degToRads),
                this.matrix.skewFromAxis(-s * degToRads, (c + 90) * degToRads),
                this.matrix.translate(r[0], r[1], 0),
                (this._mdf = !0),
                this.opacity !== t[8].p.v &&
                  ((this.opacity = t[8].p.v), (this._opMdf = !0)));
            }
          }));
        function SVGTransformEffect(e, t) {
          this.init(t);
        }
        extendPrototype([TransformEffect], SVGTransformEffect);
        function CVTransformEffect(e) {
          this.init(e);
        }
        return (
          extendPrototype([TransformEffect], CVTransformEffect),
          registerRenderer(`canvas`, CanvasRenderer),
          registerRenderer(`html`, HybridRenderer),
          registerRenderer(`svg`, SVGRenderer),
          ShapeModifiers.registerModifier(`tm`, TrimModifier),
          ShapeModifiers.registerModifier(`pb`, PuckerAndBloatModifier),
          ShapeModifiers.registerModifier(`rp`, RepeaterModifier),
          ShapeModifiers.registerModifier(`rd`, RoundCornersModifier),
          ShapeModifiers.registerModifier(`zz`, ZigZagModifier),
          ShapeModifiers.registerModifier(`op`, OffsetPathModifier),
          setExpressionsPlugin(Expressions),
          setExpressionInterfaces(getInterface),
          initialize$1(),
          initialize(),
          registerEffect$1(20, SVGTintFilter, !0),
          registerEffect$1(21, SVGFillFilter, !0),
          registerEffect$1(22, SVGStrokeEffect, !1),
          registerEffect$1(23, SVGTritoneFilter, !0),
          registerEffect$1(24, SVGProLevelsFilter, !0),
          registerEffect$1(25, SVGDropShadowEffect, !0),
          registerEffect$1(28, SVGMatte3Effect, !1),
          registerEffect$1(29, SVGGaussianBlurEffect, !0),
          registerEffect$1(35, SVGTransformEffect, !1),
          registerEffect(35, CVTransformEffect),
          lottie
        );
      });
  }),
  require_dist = __commonJSMin((e) => {
    Object.defineProperty(e, "__esModule", { value: !0 });
    var t = u(require_extends()),
      n = u(require_get_prototype_of()),
      r = u(require_classCallCheck()),
      i = u(require_createClass()),
      a = u(require_possibleConstructorReturn()),
      o = u(require_inherits()),
      s = u(require_react()),
      c = u(require_prop_types()),
      l = u(require_lottie());
    function u(e) {
      return e && e.__esModule ? e : { default: e };
    }
    var d = (function (e) {
      (0, o.default)(c, e);
      function c() {
        var e, t, i, o;
        (0, r.default)(this, c);
        var s = [...arguments];
        return (
          (o =
            ((t =
              ((i = (0, a.default)(
                this,
                (e = c.__proto__ || (0, n.default)(c)).call.apply(
                  e,
                  [this].concat(s),
                ),
              )),
              i)),
            (i.handleClickToPause = function () {
              i.anim.isPaused ? i.anim.play() : i.anim.pause();
            }),
            t)),
          (0, a.default)(i, o)
        );
      }
      return (
        (0, i.default)(c, [
          {
            key: `componentDidMount`,
            value: function () {
              var e = this.props,
                n = e.options,
                r = e.eventListeners,
                i = n.loop,
                a = n.autoplay,
                o = n.animationData,
                s = n.rendererSettings,
                c = n.segments;
              ((this.options = {
                container: this.el,
                renderer: `svg`,
                loop: i !== !1,
                autoplay: a !== !1,
                segments: c !== !1,
                animationData: o,
                rendererSettings: s,
              }),
                (this.options = (0, t.default)({}, this.options, n)),
                (this.anim = l.default.loadAnimation(this.options)),
                this.registerEvents(r),
                this.setSpeed());
            },
          },
          {
            key: `componentWillUpdate`,
            value: function (e) {
              this.options.animationData !== e.options.animationData &&
                (this.deRegisterEvents(this.props.eventListeners),
                this.destroy(),
                (this.options = (0, t.default)({}, this.options, e.options)),
                (this.anim = l.default.loadAnimation(this.options)),
                this.registerEvents(e.eventListeners));
            },
          },
          {
            key: `componentDidUpdate`,
            value: function () {
              (this.props.isStopped
                ? this.stop()
                : this.props.segments
                  ? this.playSegments()
                  : this.play(),
                this.pause(),
                this.setSpeed(),
                this.setDirection());
            },
          },
          {
            key: `componentWillUnmount`,
            value: function () {
              (this.deRegisterEvents(this.props.eventListeners),
                this.destroy(),
                (this.options.animationData = null),
                (this.anim = null));
            },
          },
          {
            key: `setSpeed`,
            value: function () {
              this.anim.setSpeed(this.props.speed);
            },
          },
          {
            key: `setDirection`,
            value: function () {
              this.anim.setDirection(this.props.direction);
            },
          },
          {
            key: `play`,
            value: function () {
              this.anim.play();
            },
          },
          {
            key: `playSegments`,
            value: function () {
              this.anim.playSegments(this.props.segments);
            },
          },
          {
            key: `stop`,
            value: function () {
              this.anim.stop();
            },
          },
          {
            key: `pause`,
            value: function () {
              ((this.props.isPaused && !this.anim.isPaused) ||
                (!this.props.isPaused && this.anim.isPaused)) &&
                this.anim.pause();
            },
          },
          {
            key: `destroy`,
            value: function () {
              this.anim.destroy();
            },
          },
          {
            key: `registerEvents`,
            value: function (e) {
              var t = this;
              e.forEach(function (e) {
                t.anim.addEventListener(e.eventName, e.callback);
              });
            },
          },
          {
            key: `deRegisterEvents`,
            value: function (e) {
              var t = this;
              e.forEach(function (e) {
                t.anim.removeEventListener(e.eventName, e.callback);
              });
            },
          },
          {
            key: `render`,
            value: function () {
              var e = this,
                n = this.props,
                r = n.width,
                i = n.height,
                a = n.ariaRole,
                o = n.ariaLabel,
                c = n.isClickToPauseDisabled,
                l = n.title,
                u = function (e) {
                  var t = void 0;
                  return (
                    (t = typeof e == `number` ? e + `px` : e || `100%`),
                    t
                  );
                },
                d = (0, t.default)(
                  {
                    width: u(r),
                    height: u(i),
                    overflow: `hidden`,
                    margin: `0 auto`,
                    outline: `none`,
                  },
                  this.props.style,
                ),
                f = c
                  ? function () {
                      return null;
                    }
                  : this.handleClickToPause;
              return s.default.createElement(`div`, {
                ref: function (t) {
                  e.el = t;
                },
                style: d,
                onClick: f,
                title: l,
                role: a,
                "aria-label": o,
                tabIndex: `0`,
              });
            },
          },
        ]),
        c
      );
    })(s.default.Component);
    ((e.default = d),
      (d.propTypes = {
        eventListeners: c.default.arrayOf(c.default.object),
        options: c.default.object.isRequired,
        height: c.default.oneOfType([c.default.string, c.default.number]),
        width: c.default.oneOfType([c.default.string, c.default.number]),
        isStopped: c.default.bool,
        isPaused: c.default.bool,
        speed: c.default.number,
        segments: c.default.arrayOf(c.default.number),
        direction: c.default.number,
        ariaRole: c.default.string,
        ariaLabel: c.default.string,
        isClickToPauseDisabled: c.default.bool,
        title: c.default.string,
        style: c.default.object,
      }),
      (d.defaultProps = {
        eventListeners: [],
        isStopped: !1,
        isPaused: !1,
        speed: 1,
        ariaRole: `button`,
        ariaLabel: `animation`,
        isClickToPauseDisabled: !1,
        title: ``,
      }));
  }),
  import_dist = __toESM(require_dist(), 1),
  copy_default = `data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20width='12px'%20height='11.2px'%20viewBox='0%200%2012%2011.2'%20version='1.1'%20xmlns='http://www.w3.org/2000/svg'%20xmlns:xlink='http://www.w3.org/1999/xlink'%3e%3ctitle%3e删除%3c/title%3e%3cdefs%3e%3crect%20id='path-1'%20x='0'%20y='8.8817842e-16'%20width='14'%20height='13.0666667'%3e%3c/rect%3e%3c/defs%3e%3cg%20id='v1.3'%20stroke='none'%20stroke-width='1'%20fill='none'%20fill-rule='evenodd'%3e%3cg%20id='智能体对话-文生图'%20transform='translate(-1367,%20-257.9333)'%3e%3cg%20id='编辑'%20transform='translate(1361,%20252)'%3e%3cg%20id='删除'%20transform='translate(5,%205)'%3e%3cmask%20id='mask-2'%20fill='white'%3e%3cuse%20xlink:href='%23path-1'%3e%3c/use%3e%3c/mask%3e%3cg%20id='蒙版'%3e%3c/g%3e%3cg%20id='编组-57'%20mask='url(%23mask-2)'%20stroke='%23606478'%3e%3cg%20transform='translate(1,%200.9333)'%3e%3crect%20id='矩形备份'%20fill='none'%20x='2.5'%20y='0.5'%20width='9'%20height='8.33333333'%20rx='2'%3e%3c/rect%3e%3crect%20id='矩形'%20fill='%23FFFFFF'%20fill-rule='evenodd'%20x='0.5'%20y='2.36666667'%20width='9'%20height='8.33333333'%20rx='2'%3e%3c/rect%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/svg%3e`,
  v = `5.6.10`,
  fr = 30,
  ip = 0,
  op = 50,
  w = 16,
  h = 16,
  nm = `A 2`,
  ddd = 0,
  assets = [
    {
      id: `imgSeq_0`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAWlBMVEVHcExxauVwaeRxauRxauVxauVxauVxauVxauVxaeX4tQBwauVyauVxa+b4tQBxauUAAP9xa+VxauVxauT3tQCAgP9wauT2tQD4tgBya+VxauVyauVxauX3tQAmmYyaAAAAHHRSTlMAt4+jz9GyzM6zzKimqs6TAaWRkKUCfbOPlJWAIrQAKgAAAGlJREFUGNN1zrkSgDAIRdGXuABGjfuK//+bxsLCSbwFxZmBAYhyzCN65h4jswvAqgJSJZSqeQoGkQVWxGIRGZBoqqoNGVEGS1QHaK9r/dyIIFqJ2o05u8MY/8Lz2Jw/N/6gKQrfheGQ7gY7Vwd0TnWAZQAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_1`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAeFBMVEVHcExxauT4tQBxauVxauVwaeRxauVxauVxauVxaeVxauVyauVyauVxauVxauZxa+VxauX4tQB1aur3tQD4tgD2tQBya+ZyaeVyauRxa+ZwauVxauVxa+ZzZuZyauVya+VwauRxauVxauRxauZyauV4aeFxauX3tQBQiwAUAAAAJnRSTlMAo8zP0Y+3zM6zk4mmsvql/M4YpY+zcHdnyahjqhSvlH2RkLWAEfX6k38AAABySURBVBjTdc7ZEoJADETRBmYmCS6g4r6gqM3//6FQFE8z3sdTla4AURfVDpVqhbPqcQAlDUIK1mSZgpfZE97M42F2QqJdnjfIRDJ4keUAm77fTxsrskhBdBLVhvD5vkO4zjA+tq3JxV+4OVfeC+cOSPcDZpoJhtD64XMAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_2`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAclBMVEVHcEz4tQBxauWAVdVwaeRxauRxauVxauVxaeVxauVya+VxceNyauVxauVmZsxxauVxa+VxauX4tQD3tQBwauRxauX4tgD2tQBtbdtwauVxauVxauRxauVxaeZwauVxaeVxa+ZxaeRxauVyauVxauX3tQDR85P6AAAAJHRSTlMAzLcGj6PRzLPOlAmmzwXppbLOpX2uj7MHqJGQzb92p6pok4AWhNBWAAAAcUlEQVQY03XO2xKCMAyE4aWUJkFFRBDPeFje/xUBZ7hq/S+/mewEiLqY3VCb1c+72XkGIxVCSklyk4Kraguv6t+qmiPRMctOKEQKeJHtDM049r8NHMhdCqKTqNK5b+vcUK2wPNaR+/wvvEL4+BAeFdJNgdIJftMFcecAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_3`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAb1BMVEVHcExxauRwaeReff9xauVxauX4tQBxauVxauVxaeVwauRyauVxauVyaeX4tQD3tQBxauX2tQD4tgBggP9ffP9vaeVxaedwauVxa+Zxa+VxauRxauVxauV1beJya+VwauRva+NyauRyaeVxauX3tQCPFOqEAAAAI3RSTlMAo48x0bfMzM6zMKbPTs6lsrOPKCMnP6iqpZCRzSOUfTfKuKBo8PAAAABqSURBVBjTbc7JEoNACEXR54DQiUkcM6iJGvz/b9TGZffdcaqgAIJeIgM+IrJO8vQgqg6s1i0Ko3MzUmctiPUoigYJc4KU+XrAfdtqf4NRqZYxCFaCfkR/Ivra0J2P+S4GWQzeudUbtOHJHYjpCYZ4s+ZXAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_4`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAe1BMVEVHcExwaeRxauVeff9xauVxauT4tQBxauVxauVxaeVmZv9xaeZyauVxauVyauVxauX3tQD4tQD2tQD4tgBAgP9eff9eff9VVf9wauRyauRwauVxa+ZxauVxa+VxauVyauRxauRwaedya+VwauVwauRwauVyaeVxauX3tQCDGW+0AAAAJ3RSTlMAj7fm0aPMzM6zBWamz4Cypc6zjwS8pQNUZ6iqzaWRypBJlFl9urgRVMbbAAAAbUlEQVQY023OyQ6DMAxF0Uco2GkLZe4IlNH8/xdCwjK5K+tItgw4fZj/aJm5/70tsIgGiSn1Q6f1jECbJnjL4rhERBQhILofkG9bYW4QHiKJD5wVp1Gti1KDnZ/N+djRzcI19MH3YnpZqGr35A7A8goU7yhBhgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_5`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAe1BMVEVHcExwaeReff9efP9xauX4tQBxauRxauVxauVxaeVxauVyauVxauVwa+X3tQBxauX4tQD2tQD4tgBeff9eff9fff9eff9yaeZxa+ZxauZwauVxa+VyauRxauRxauVya+Vya+RyaeVwauRxauVxauVxa+RwauVxauX3tQBGaTmPAAAAJ3RSTlMAj+bT0cyjzM6zk6bPsaWyzrOPvK6XpXmqjqilypCRlGm4fby3fLruwmt2AAAAbklEQVQY03XO2Q6CQAyF4QMK7SAqyKIsiixS3v8JHdLLGf6r5kvaFHBqmd/omLlvFFjEgMR2PYCPMRMCY/vB3y2KHoiJYgREFwvZtuX7DcJdJPWBs+I0jPO6fHWuan1MJFE4hT54nW1PhbJwT/4BSfMJVssfpAMAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_6`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAeFBMVEVHcExwaeReff9fff9xauT4tQBxauVxauVxauVxaeVyauVxauVyauRxauVxauVxa+VxauX3tQD4tQD4tgD2tQBeff9fff9efP9xauVxa+Zdff9eff9efP9wauVxauVxauRya+VxauVxauZwauRwauVxauX3tQBeff+B+L6JAAAAJXRSTlMAj+aXo8zRzM6zps/Tu+ylsqXOj7O8fNGuqrelbaiRkJS8l326NHNI1AAAAG5JREFUGNN1zscOg0AMBNCBwNqmk0ASSgrF8P9/GKLltjAn60kzMuDkxfxBzszpDqwqIFXNzuAtMsETkRwnKcPwhoAogEcUbXBdluq/QShU4yNwKk6+6TCP9uzbzj6miYXL6h9BY4x5Wrg/anfyB6QUCJ3u5nyHAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_7`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAe1BMVEVHcExwaeRefP9eff9xauT4tQBxauVxauVxauVxaeVxa+dgfP9dff9yauVxauVza+VxauVxauX3tQD4tQD4tgD2tQBxauNeff9gff9xa+Zva+Neff9egP9wauVxa+VwaeZza+ZxauRxauVwauRwauVwauRxauVeff/3tQCNGMoPAAAAJnRSTlMAj9Hmo8zRzM6zK0C3ps9FvLKlzo+zJLw1qjelLqillh+QkTC6fa/kLX8AAABxSURBVBjTdc5LEoJADATQ5jdJBAFFEVBRQAP3PyE4shvoVepVdVcAJ0/mDi0zNyuwqoBUNduDXuQLT0QG7OQcRReERCE8ouMCxTRdfxuEk2q6BU7FySvPP297PZLk/n9MDxbicQy2oDbGlBYq37+5kzP+KglFPzEHpgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_8`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAeFBMVEVHcExVVf9waeRxauVxauVxauT4tQBxauVxauVxaeVefP9xa+Zeff9yauVxauVeff9dff9xauZxauX4tQD3tQD4tgD2tQBxauVeff9fff9fff9wauVefP9wauZxa+VxauWAgP9xaeVxauRxauVwauRxauVeff/3tQCtf+mWAAAAJXRSTlMAA4/RvKPMzM6z0arSps+ut9KyzqWPs5qrj5eofZilkwKKkJF9GX/1kQAAAG5JREFUGNN1zt0SQ1AMBOAthySov5a2KFrC+78hndO7w15lvpndCeCkZf6iZ44vf2BVAakWpzCJzPBEhhEnuYdhhYAogEd03eG2rvVvg1CqpkfgVJy8jfnYq8vzxj5mLGTLkhxB7PsPC68oerqTG5anCHldAvp1AAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_9`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAbFBMVEVHcExefP9xauVefP9waeRxauT4tQBxauVxauVxaeVyauVxauVxa+Vfff9eff9xauX4tQBxauX3tQD4tgD2tQBxauVfff9eff9xa+Zdff9wauVefP9wauZxaeZwauRxauRxauVxauVeff/3tQDMTLhGAAAAIXRSTlMA0dHPj6PMzM6zps+lsrOyzrylj7OTqpOqkah9mIN9kJEhHdIXAAAAZUlEQVQY03XOSQ6AMAhAUdQq4FznWdH731Fj46r1r8hLIABYTUQ7pETpByTCgCL4CwfzBopZwV9VFNUQIoagEOMHyutqzI1CJHGBtWK1aL2aac7z8XvsLTvPwAWD77cGes/r7JM38iYHcRwvLukAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_10`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAbFBMVEVHcExefP9xauVefP9waeRxauT4tQBxauVxauVxaeVyauVxauVxa+Vfff9eff9xauX4tQBxauX3tQD4tgD2tQBxauVfff9eff9xa+Zdff9wauVefP9wauZxaeZwauRxauRxauVxauVeff/3tQDMTLhGAAAAIXRSTlMA0dHPj6PMzM6zps+lsrOyzrylj7OTqpOqkah9mIN9kJEhHdIXAAAAZUlEQVQY03XOSQ6AMAhAUdQq4FznWdH731Fj46r1r8hLIABYTUQ7pETpByTCgCL4CwfzBopZwV9VFNUQIoagEOMHyutqzI1CJHGBtWK1aL2aac7z8XvsLTvPwAWD77cGes/r7JM38iYHcRwvLukAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_11`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAbFBMVEVHcExefP9xauVefP9waeRxauT4tQBxauVxauVxaeVyauVxauVxa+Vfff9eff9xauX4tQBxauX3tQD4tgD2tQBxauVfff9eff9xa+Zdff9wauVefP9wauZxaeZwauRxauRxauVxauVeff/3tQDMTLhGAAAAIXRSTlMA0dHPj6PMzM6zps+lsrOyzrylj7OTqpOqkah9mIN9kJEhHdIXAAAAZUlEQVQY03XOSQ6AMAhAUdQq4FznWdH731Fj46r1r8hLIABYTUQ7pETpByTCgCL4CwfzBopZwV9VFNUQIoagEOMHyutqzI1CJHGBtWK1aL2aac7z8XvsLTvPwAWD77cGes/r7JM38iYHcRwvLukAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_12`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAbFBMVEVHcExefP9xauVefP9waeRxauT4tQBxauVxauVxaeVyauVxauVxa+Vfff9eff9xauX4tQBxauX3tQD4tgD2tQBxauVfff9eff9xa+Zdff9wauVefP9wauZxaeZwauRxauRxauVxauVeff/3tQDMTLhGAAAAIXRSTlMA0dHPj6PMzM6zps+lsrOyzrylj7OTqpOqkah9mIN9kJEhHdIXAAAAZUlEQVQY03XOSQ6AMAhAUdQq4FznWdH731Fj46r1r8hLIABYTUQ7pETpByTCgCL4CwfzBopZwV9VFNUQIoagEOMHyutqzI1CJHGBtWK1aL2aac7z8XvsLTvPwAWD77cGes/r7JM38iYHcRwvLukAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_13`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAgVBMVEVHcEyAYN/4tQBxauVxauWAVdVwaeZxaeVxauVxauVefv9efP9xauVfff9efv9xa+VxauVya+X4tQBxauX3tQBxauX4tgBwaeT2tQBxauVdfv9xa+ZffP9dfP9wauVxauZyauZxauVdfv9wauZxaeZxauRxauVwauRxauVeff/3tQCTVISjAAAAKHRSTlMACMzRuQbcs87Mwc/PssulspTOvKWwj4+zk4aqnKSol4KajpiDkJF9q6Y9yQAAAHpJREFUGNN1jtsOgkAMBQ+wbAsqVxEUFAWUwv9/oIYND4R1Hppmkk4K7HgwvxEzx6tgEUIgEvwVH6IRJVG5CfmO45sBnF33gkLrAi+t6Seyea5MIxE52sRykiqV4qlUCwt9ng9m66Lovj62cJqmg03Unnc14haGzT75BfPGCWDgTDC/AAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_14`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAe1BMVEVHcEz4tQBfff9ffv9yauT//wBwa+ZxauVxauVxaeVxauVefP9xauVxauVffv9xa+VxauVxbOb4tQD3tQBwaeRya+P4tgD2tQBxauVce/9xa+ZwauZxaeZwaeRwauVcff9vaeNvaudee/9xauVwauRxauRxauVeff/3tQDtG+tuAAAAJnRSTlMAzLJDQQFdzM6zss/P0VOlvDTOpY9Kj7OTOqqYg0uoLy41NpF9kPqqWnIAAAB4SURBVBjTfY7ZDoJADEWLU4cW2TcVUZSl8P9fyITJPBAi96U3J7knBTjkQzRBQpQ4QCIMvoj/FwzMI5TM5U5UaV0Bav02vfC82k4CkdCAfFnu52CbZIgZfBF/O3OnVG/OK01bCy7zfHOPnYImih4WPONYOd/VxLYVN0UJ1rAiY48AAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_15`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAjVBMVEVHcEz4tQBxauVxauX/qgBya+VxauVxauVxauVxaeX/zAD/vwBeff9efP9fff9xauVeff9VgP9mZuZyaeX4tQBxa+X3tQD4tgBwaeb2tQBeff9dfv+AYN9xauVeff9xa+ZmZv9eff9yaeZxaeRAgP9xaeZwauZtbdtwauVwauRxauVxauRxauVeff/3tQBBF1pjAAAALHRSTlMAzM+yA5S8zM6zBQSuz7LR6QYKd86lpY+Ws3qOCJO9qgWjeWgEg5gHqH2RkBc9ZRYAAACASURBVBjTdY7HDoMwEESXgM2a3pyQAimQULLw/5+HBfLBIpnLjJ5mVwOwU4/4BYkoNUAiAS6R+xeMQgxQcl5Cl2U3TdeGTXRQ+WhZJwMU83zeg5yxHBrGXvpkVZumD2PiM0lqZR/O3xuIpinUw36DSxBcld3juAJHyfjne56/pQUougs124iq3wAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_16`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAjVBMVEVHcEz/zAD/qgBVgP9xauX4tQD2tgBxauVxauVxaeVggP9eff9efP9xauVfff9xauVxauVyauReff9xauVxauVxa+VxaeT4tQD3tQD4tgD2tQD2tQD2tABefP9eff///wBxauZxa+Zfff9xaeZefv9xauZyauVwauZwauVxauRwauRxauVxauVeff/3tQBalkiLAAAALHRSTlMABQYGy8ySzM6zCNzP0bKTz9O5srylos6lj7N1d5qzAauql4OCjqSYqJB9kZAIYfgAAACASURBVBjTdc7ZDoJADAXQAgN0QBxBFndUcC/8/+cxKZnExnhf2pymTQF+8kR8QYVYOUAiDTFR/Bc+Wr9nMHl+dsqwJlrZfhOGWwHNOO6gVqqGm1J3B9/hFU5fFFcxWg7DwpZHWXYC+DHOMU1PAoIkCWy5ZJlpD1G0F/c83/fmbgIYYgrk1d7ABAAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_17`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAolBMVEVHcEx2Yutxa+X/qgBwcN9xauX4tQBxauVxauVxaeX/zAD3tQD4tQBggP9eff9fff9efP9efv9xauVxaeZwauZxauVxauVxauVxa+X3tQD4tQD4tgD2tQD2tAD3tQBdgP9dff9igP9efv/3tQBfff9xaeZxauX//wD/gAD2tQBxa+Z0dOhefv9xauRwauZwauVxauRxauVwauRxauVeff/3tQAX2rwYAAAAM3RSTlMADaUGEOzMzsyzBeluIPWyz4jPg6HRsry9pc6Ps1i6Fqwax71uv5MBAlmqC19xmKiQkX3E9eCTAAAAjElEQVQY02XO1w6DMAwFUBMIJqyWAoVOuvc2/P+vlWZIRdwHyzqyLQP08kR8AUNkBpBIgEfk9eGeZWkLbyE+CsZEIzP2DxPXnUHJeQmM830L06aZg+U4Flx/RYPMLUl2ZkVmUNfDzosaHkWRKljF8cY8JlNF0VrD8RyGC7N5yfPDaRsEy84937Z91X0B7/kM0Z/Kq5MAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_18`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAkFBMVEVHcExxauVefP9waub4tQBzaeZfff9xauVxauVxaeVxauX/qgD/zAD5tQD3tQD2tgBefP//gABxauVxauVwaeVxa+Vefv/3tQD4tQD4tgD2tQD3tQBee/9fe//3tQD4tQBxa+ZxauVyauVxaeZwauZwaeReff9xauNdfP9wauVxauRxauVwauRxauVeff/3tQCKy3lYAAAALXRSTlMAss8pzDOyzsyzzwYFLek4TALRvGulUaXOj7O6Nj69z6qTV4OYSzkkQqiQkX2XkW6kAAAAgUlEQVQY02XO1w7CMAwF0AtNcUP3ZFNGy3bz/3/HCBGJuA+WdWRbBv5yJbqhJqoNELNEwBygr6qDAyPm6QvuUj4c+MSGmRALeL7v4fwuwFyppR47Nc3FgckwjM2KDb98oSvLo4Z1lm3MY3GaxvbreauUMLArin2+TZKVcy8Kw0h3T6R1C/Qfe1esAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_19`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAqFBMVEVHcExxauX/qgBdff/4tQBxauZxauVxauVxauVxaeX/vwD3tQD/swD3tQD/sQBfff9efP9xaen/gABxauVeff9igP9xa+VxauVyauT4tQD2tQD3tQD4tgD3tgD3tQBfff9dff9tbeT4tQD3tQB1aupxa+ZxauX3tQBfff9efv9wauRjgP9hef9xaeX//wBwauZxaeZwauVxauRwauRxauVxauX3tQBeff/x6r0qAAAANXRSTlMAzwORzHiyzsyzBOkK5g2yzyIC0fIapbxgzrOlj7i6ZnYcz70YqpO7qsVUEhVhAZiDqJB9kcD/mEoAAACLSURBVBjTbc7XDsIwDAVQ0ya46YLusvfew+n//xmBUEEE9+VaR7JlgJ9cEK+QI+Ywj6KJAiQS4BA50CRq/IO7EDcDXik5L2HL+UHNPcb6WndZtlfVkbKrYZ2mGwNaVdU2Vt7wyci2x6pORXEGPwz92p+PHVdBMPiGeColq2GRJMt45nlD457lupaeHs6LDcjpEDRIAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_20`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAmVBMVEVHcEz/gABxauVjgP///wBxauVxauVxauX4tQBxaeVeff/3tQBefP/3tQBfff9xauVffP9xauT4tQBxauVxa+VxauX2tQBxauX4tQD3tQD4tgD4tgBVgP/3tABbgP9fff9fff9efP9xaeT3tgBefP9xaeRyaeRxauVxa+ZwauX4tABxauRxaeZwauZxauVwauRxauX3tQBeff8JTNt8AAAAMHRSTlMAArwSAefMzsyz7+LPg7LPnKPPsqXRs7nOpY9pDLUOp8J/hbhtonKTqqhqkIOYkX0KlWpyAAAAg0lEQVQY03WOaQ+CMBBEh0LZFkRBQbzv+9zy/3+cNY0xxPq+zOQlO1nghzPRFSVRiUNRbKwgZo2YOcaAuecTD62fqKWssZdSwMNYqYlruzxf2xgZM3Si2zQdn/ieLJNk1VqbheHCxl2IW3TJsunHvx8L+saov+JUVcdgm6bz1l5kce0FkRMLqyH16XsAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_21`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAclBMVEVHcEz4tgD2tQBefP9eff/2tQBxauVxauVxaeX4tQBefP9fff9fff9wauVxauX4tQBxauX//wD4tQBxa+X3tQD/gABxauVxauVxauVxauRwaeRwauT3tQBxa+b4tgBxauVwauZxaeb2tQBxauX3tQBeff9f1JaiAAAAI3RSTlMAj9HPzLPMzrPMpo+yqNHOzwHPpaUCsryRkI99qKqqk5iDkTunG98AAABxSURBVBjTdc7JDoMwDEXRxxDsQIECLWNbBof//8UGIVYJd2PrSJYMOOVEAxqiBgNRboFEGIlIglbk6YOeecLIPGJi7uHppXVwblkcp3aUxqgTHvse+cA5cVq6bq02pYILjsfetTH6Fr5FMVe/MPzA3x+zgQhtUVPAXgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_22`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAclBMVEVHcEz4tgD2tQBefP9eff/2tQBxauVxauVxaeX4tQBefP9fff9fff9wauVxauX4tQBxauX//wD4tQBxa+X3tQD/gABxauVxauVxauVxauRwaeRwauT3tQBxa+b4tgBxauVwauZxaeb2tQBxauX3tQBeff9f1JaiAAAAI3RSTlMAj9HPzLPMzrPMpo+yqNHOzwHPpaUCsryRkI99qKqqk5iDkTunG98AAABxSURBVBjTdc7JDoMwDEXRxxDsQIECLWNbBof//8UGIVYJd2PrSJYMOOVEAxqiBgNRboFEGIlIglbk6YOeecLIPGJi7uHppXVwblkcp3aUxqgTHvse+cA5cVq6bq02pYILjsfetTH6Fr5FMVe/MPzA3x+zgQhtUVPAXgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_23`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAclBMVEVHcEz4tgD2tQBefP9eff/2tQBxauVxauVxaeX4tQBefP9fff9fff9wauVxauX4tQBxauX//wD4tQBxa+X3tQD/gABxauVxauVxauVxauRwaeRwauT3tQBxa+b4tgBxauVwauZxaeb2tQBxauX3tQBeff9f1JaiAAAAI3RSTlMAj9HPzLPMzrPMpo+yqNHOzwHPpaUCsryRkI99qKqqk5iDkTunG98AAABxSURBVBjTdc7JDoMwDEXRxxDsQIECLWNbBof//8UGIVYJd2PrSJYMOOVEAxqiBgNRboFEGIlIglbk6YOeecLIPGJi7uHppXVwblkcp3aUxqgTHvse+cA5cVq6bq02pYILjsfetTH6Fr5FMVe/MPzA3x+zgQhtUVPAXgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_24`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAclBMVEVHcEz4tgD2tQBefP9eff/2tQBxauVxauVxaeX4tQBefP9fff9fff9wauVxauX4tQBxauX//wD4tQBxa+X3tQD/gABxauVxauVxauVxauRwaeRwauT3tQBxa+b4tgBxauVwauZxaeb2tQBxauX3tQBeff9f1JaiAAAAI3RSTlMAj9HPzLPMzrPMpo+yqNHOzwHPpaUCsryRkI99qKqqk5iDkTunG98AAABxSURBVBjTdc7JDoMwDEXRxxDsQIECLWNbBof//8UGIVYJd2PrSJYMOOVEAxqiBgNRboFEGIlIglbk6YOeecLIPGJi7uHppXVwblkcp3aUxqgTHvse+cA5cVq6bq02pYILjsfetTH6Fr5FMVe/MPzA3x+zgQhtUVPAXgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_25`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAclBMVEVHcEz4tgD2tQBefP9eff/2tQBxauVxauVxaeX4tQBefP9fff9fff9wauVxauX4tQBxauX//wD4tQBxa+X3tQD/gABxauVxauVxauVxauRwaeRwauT3tQBxa+b4tgBxauVwauZxaeb2tQBxauX3tQBeff9f1JaiAAAAI3RSTlMAj9HPzLPMzrPMpo+yqNHOzwHPpaUCsryRkI99qKqqk5iDkTunG98AAABxSURBVBjTdc7JDoMwDEXRxxDsQIECLWNbBof//8UGIVYJd2PrSJYMOOVEAxqiBgNRboFEGIlIglbk6YOeecLIPGJi7uHppXVwblkcp3aUxqgTHvse+cA5cVq6bq02pYILjsfetTH6Fr5FMVe/MPzA3x+zgQhtUVPAXgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_26`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAmVBMVEVHcExggP9eff9efP9xauX2tQD4tgBxauX4tQBxaeVfff9xauVfff9ya+X2tQBxauVxauZxauVxa+VxauZxauX4tQD4tQD//wD3tQD/gABxauVaeP9ZgP9eff9ffP9yaeVefP/3tQBdff9xauVxaeZyauVxa+b4tgBwauVxauRwauRxauVxaeZwaub2tQBxauVxauX3tQBeff/ph0p2AAAAMHRSTlMAGPzPzLOPzsyzss+JktGy+vulyNHOzwGlArwRFLDNd2+oYMtmr6qqqJB9kYOYkZMoPJjXAAAAgUlEQVQY02NgwAAa7OyaDELs7EIMKry88kABdgMDTgYWAwMWBn4DA25sAtqcnFoMwoICwgyqAoLKDFiABAcHG4SlxMOjAKREDQ1ZIQJcRkbM2AQQWmSZmORQTJNmZJQBUrpSUjrieqysbDBxkMMkxQwNOXAKqImI6Iur8/EpMmAHAGetC57kukweAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_27`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAllBMVEVHcExxauVxauX4tgBxaeVya+X2tQBxauX4tQBxauVeff9efP9xceP2tQBfff9eff9VgP9xauVxa+X4tQD//wD/gABxauVyaeX4tQD3tQBdfv9eff9tbdv3tQBeff9mZv+AVdVeff9yaeZAgP9xaeRxa+b4tgBxaeZxauX2tQBwauZwauVxauRwauRxauVxauX3tQBeff8TCz9bAAAAL3RSTlMAz7KPs5SzzszMrs8J0bLpBtGlzwECvHfOpY56B6i9BQajeQRoqqqDk5GYqJB9kcxP1xcAAACDSURBVBjTdc5pD4IwDIDhKts6EOQQwQtRDhU8Ov7/n3OKxizg+6XNkzQpwKAr4g0ixAgOrrvTgEQMbCIbpkSTMXgwdjfgXcp5ChXnhd7XUlq9lkGQ67FSSvRw9P29AfOumxknH/i1dZyNHm2SnONGCOvrr8eWC6XkX6jD8BKfPC+D8Z67zwwJt03QDAAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_28`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAjVBMVEVHcExfff9xauX4tgBxaeVwaeb2tQBxauVxauX4tQBefP9xauX2tQBffP9xauX//wD4tQD/gABxauVyaeVxa+Vgff9wbOP4tQD3tQBdfP/3tQBfff9xa+b4tgBxaedxauX2tQBva+NwauZxaeZgfP9fff9yaeRyauRwauVxauRxauVwauRxauX3tQBeff9Xhr0KAAAALHRSTlMAsrKPs1CzzszMz8/RadEBzwK8TqU1QM6lSqhWqqo/k5E3mIMlKzhBqJCRfW8Vgj0AAAB9SURBVBjTbc7ZDoIwEIXho7QdqizK5i7uskx5/8eTKMQ2+l9+mUkO8FNFVCMjykYgZgGf2cc5TY8OTJnnPTRCtA68s2GttYdCygIPKZ89rIxRn7Nbnt8dmHTdbHyx4dsAlyS5xielPGzCcDcMWy6M0fZ0B/ZRVMaHINjify+YRAvi7xplgwAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_29`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAjVBMVEVHcExfff9efP9xauVxaeVvZub2tQBxauVxauX4tQBxauV1aur4tgBge//2tQBxauVfff/4tQD//wD/gABxauVxa+X4tQD3tQBxaeRgff/3tQBcfP9wauVxa+ZyauX4tgBwauVdfv9tbedffv9xauX2tQBxaeZwauZwauVxauVxauRwauRxauX3tQBeff9e9dKUAAAALHRSTlMAss/Psx6zzM7MshiPONHRZs8BArylzqVoLagnf6qAqllHFVOTkYOYqJGQffZVMM0AAAB+SURBVBjTbc7bDoIwDIDhImN0nEXwrIAKCHa8/+NxcEtc8L/oxZc2KcCqN2IPOWKuAYkYuETuGsr79ThBx9jnCx6Rrdd+4SBEYMBeSg6+4/jwmIeCpSpJnvpkyRqGjfGigjbLmrTmPNAwP7bbSingEoYnA1S3OH6lRRSd4X8jhmAMPGibWygAAAAASUVORK5CYII=`,
      e: 1,
    },
    {
      id: `imgSeq_30`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAk1BMVEVHcExxa+X4tgBeef9xaeVxauX2tQBxauVxauX4tQBxauVefP9eff9wa+Vfff/2tQBxauVfff9xauX4tQD/gAD//wBxa+VxauX4tQD3tQBmd/9efv9waeRdfP9idv9fff9xa+T3tQBeff9xaeZxa+b4tgBxauX2tQBwauZxaeZwauVxauRwauRxauVxauX3tQBeff+jJMqyAAAALnRSTlMApY8Ts+yzzM7Mz8/ysZfRsrLRzwIBvbzOpQ/Fj3sNqnyoar+qqpORmIOokH2R7uOlyQAAAINJREFUGNN1zmkPwiAMgOGyASu6Q+cO73lu6rTs//86EUMiUd8vJU/TBICvbog9METmAIk4RETRX3hwfn/DLknWTi1MiEbmvVAq8GCutYRKiAqYEEcHn9kT2yFNN95qOgxjMy51fS07KQMHr48VM60VNHG88mAbhksDpzxvy3OW7eF3TyU1DDJmj4ePAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_31`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAjVBMVEVHcEz2tQBxa+VwaeT4tQBwa+VxauVxauVxauVxaeX4tgBxauVefP9efv9xauX2tQBefP9fff9xauX4tQD//wD/gABxauX4tQBxaub3tQBxa+VdfP9xaeZxa+Zeff/4tgBdfv9wauZxauX3tQBwauVeff/2tQBxa+RxaeZxauRwauRxauVxauX3tQBeff+i4t+AAAAALHRSTlMAs6WPzLHszsyzj8/Py9HR07KyzwECvM6Opb2kv6qrqo6Yk6iok5F8g5B9kSyCDCIAAACASURBVBjTdc7ZDoJADAXQzlqKsqiIiCu4Q4f//zwnUR7MyH1pc5LbFCDIFfEFElGOgMwEEXM0CT1RB4pI/Ryqra1BWrv3+1br+FNZMs88bJwTIVTGVPAwRo2V/7nl+dGPpiyfxV2IGBbDMP8+tl45p0M4J8nOwyFN2+KUZZeJy2+JCQtp2UfsGwAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_32`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAkFBMVEVHcEz2tQBefP9xauX4tQBwauVza+VxauVxauVxaeVfff9xauVxaub4tgBffP9xauX2tQBxa+X4tQD//wD/gAD4tQBxauVfff/3tQBwaeRva+NefP9xa+Zefv9yaeT4tgBwauVxauVwaub3tQBwauRffP9xaeb2tQBxaedegP9wauRxauRxauVxauX3tQBeff8D1ZtnAAAALXRSTlMAs8/PzFlFzM6zsrJIj2nR0aXPAQLOvCuljzdUqkk4qqiTmKgwI4ORPx59kJGATzeqAAAAgUlEQVQY032P6Q6CQAyEZ3VZWuUUBcED77vL+7+d65VoCM6PtvmSmUyBllZEV6RE6QeQCMMX8TvBjfmCkrn8CaqMqbAzZunuqdbhyzIU6TswsVb9B09L4HkBTo/xrXNR7N3a5PkhOyoVYtA0vXex8cha3QnmcbzO6iTZYhFFs/bzd0BbDPluzlzpAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_33`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAkFBMVEVHcExxauX2tQBwauVVVf/4tQBxauZxauVxauVxaeX4tgBxa+ZxauVefP9xa+Veff9xauX2tQBxauX4tQD4tQBeff9fff///wBwaeT3tQBxauVxa+b/gABxauVefP9efv9fff9xaeT4tgCAgP/3tQBwauZxauZffv9xaeb2tQBwauRxauVxauRxauX3tQBeff98cw4ZAAAALXRSTlMAx7OoA8zSzsyzj6rPz6XO0dGTzs+8sgGPpbKgArymmI+iqgKomIyEg5F9kZBEiE15AAAAhElEQVQY03WOyRKCMBAFXxKTIaBsiqCI+64T/v/vxO1gEfswh656XQP0UER3xETxVxCzRcAc/BU3a6+orK1+QoMO7J4HmGkdQhmjkBsTdWLsnHw35sxDn3hNaiFqHIXYwMOhac7lRcoQp6JYfR5bTJzTmLbtyCeiNM3LbZbtsU6SZT/5AJelDBkuC8G9AAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_34`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAgVBMVEVHcEz2tQD4tgByauX4tQBwaeRxauRxauVxauVxaeVxa+VefP9efP9xauX2tQBxauX4tQBeff9fff/4tQD//wD3tQBxauX/gABxauVfff9xa+ZwauX4tgBdff9eff/3tQBwauZxauVefP9xaeZxauVxauT2tQBwauRxauX3tQBeff+UJb6KAAAAKHRSTlMAs4+mzI+jzM6zpdHPz9HRzrOyzwGlsgK8qqqoqpGTqJiTfYORkJF9//As1gAAAHVJREFUGNN1ztsSgjAMRdFTbEkCykVQ8YoCSsr/f6DOqE+F/bhmciZA0Jn5iYQ5+QOrCkiVFmEQGeFEHJbaWRshJorhiFYfKLw334296mYOgpOge9P09cuYCF1ZXn+PHSrvLbbTtJ6DU54/6kuWtbil6TGcfAOvBgo7HlYiewAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_35`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAgVBMVEVHcEz2tQD4tgByauX4tQBwaeRxauRxauVxauVxaeVxa+VefP9efP9xauX2tQBxauX4tQBeff9fff/4tQD//wD3tQBxauX/gABxauVfff9xa+ZwauX4tgBdff9eff/3tQBwauZxauVefP9xaeZxauVxauT2tQBwauRxauX3tQBeff+UJb6KAAAAKHRSTlMAs4+mzI+jzM6zpdHPz9HRzrOyzwGlsgK8qqqoqpGTqJiTfYORkJF9//As1gAAAHVJREFUGNN1ztsSgjAMRdFTbEkCykVQ8YoCSsr/f6DOqE+F/bhmciZA0Jn5iYQ5+QOrCkiVFmEQGeFEHJbaWRshJorhiFYfKLw334296mYOgpOge9P09cuYCF1ZXn+PHSrvLbbTtJ6DU54/6kuWtbil6TGcfAOvBgo7HlYiewAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_36`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAgVBMVEVHcEz2tQD4tgByauX4tQBwaeRxauRxauVxauVxaeVxa+VefP9efP9xauX2tQBxauX4tQBeff9fff/4tQD//wD3tQBxauX/gABxauVfff9xa+ZwauX4tgBdff9eff/3tQBwauZxauVefP9xaeZxauVxauT2tQBwauRxauX3tQBeff+UJb6KAAAAKHRSTlMAs4+mzI+jzM6zpdHPz9HRzrOyzwGlsgK8qqqoqpGTqJiTfYORkJF9//As1gAAAHVJREFUGNN1ztsSgjAMRdFTbEkCykVQ8YoCSsr/f6DOqE+F/bhmciZA0Jn5iYQ5+QOrCkiVFmEQGeFEHJbaWRshJorhiFYfKLw334296mYOgpOge9P09cuYCF1ZXn+PHSrvLbbTtJ6DU54/6kuWtbil6TGcfAOvBgo7HlYiewAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_37`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAgVBMVEVHcEz2tQD4tgByauX4tQBwaeRxauRxauVxauVxaeVxa+VefP9efP9xauX2tQBxauX4tQBeff9fff/4tQD//wD3tQBxauX/gABxauVfff9xa+ZwauX4tgBdff9eff/3tQBwauZxauVefP9xaeZxauVxauT2tQBwauRxauX3tQBeff+UJb6KAAAAKHRSTlMAs4+mzI+jzM6zpdHPz9HRzrOyzwGlsgK8qqqoqpGTqJiTfYORkJF9//As1gAAAHVJREFUGNN1ztsSgjAMRdFTbEkCykVQ8YoCSsr/f6DOqE+F/bhmciZA0Jn5iYQ5+QOrCkiVFmEQGeFEHJbaWRshJorhiFYfKLw334296mYOgpOge9P09cuYCF1ZXn+PHSrvLbbTtJ6DU54/6kuWtbil6TGcfAOvBgo7HlYiewAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_38`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAjVBMVEVHcExyauVxauVwaeRxaeVxauT2tQBxauVxauX4tQD4tgCAVdVefP+AYN9eff9xauX2tQBxauVwaeb4tQBefP9dff/4tQD//wD3tQBxauVxauX/gABfff9xa+Zffv9wauVefP/4tgBxa+X3tQBxauVwauZdfP9xauRxauVxauX2tQBwauRxauX3tQBeff/5Vf5xAAAALHRSTlMAprKPs6OzzM7MjwbRCNfP0dHczqC3zwGly7wCr6qEqJqqpaiamHOQkZWRfU1RyDQAAAB6SURBVBjTdc7ZEoJADETRBsIkA6igAooL7muG//88tPRt4D6eqnQF8GpF7jiJhOkfRJXAqvPJGDyI3oiILilGWlmbIGaOETEHH1g4Z74bjFB1NgTeide1aZ71y5gEt7I8/B5bbyrnLJZdNx2CXVEE9THPz9hn2daf7AFnIAub/93oJQAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_39`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAilBMVEVHcExwaeRxauX4tgD4tQBxauT2tQBxauVxauVxaeVefP9eff9xauVyauVdff9ggP9wa+b4tQBxauX3tQD2tQBxauX4tQBza+Feff9waedeff9dfP9wauVxa+VxauVxauRxa+b3tQBhe/9waeZyauRwauT4tgB0a+BwauX2tQBybeBxauX3tQBeff98qE5lAAAAK3RSTlMAj9GPzKOzzM6z0ebPprcoXc6ypdG8z0W8SaUhqKWRkKqoHZZBfao5upEx6Z4gvQAAAHhJREFUGNN1ztkSgjAMheFDKU2Cgqjgihvuprz/66kDd4X/8pvJmQBBNfMJB2be9sCqAlLVYgyOIndEInLDSEtrYyRECSKi7Adz791/g7BQnQ5BcBJ0rarX5+1cjCbPd91jul55bzFr28kQnI0xz0dZXrBP0004+QWJSAudSbl1HwAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_40`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAjVBMVEVHcExwaeRxauX4tgD4tQBxauT2tQBxauVxauVxaeVeff9dfP9yauVxauVmZuZxauX4tQD3tQD2tQDztAdwauVyauReff9efP9dfv+AYN9dff9eff9dff9yauRwauVxa+VxauRxauVtbdtwauRxa+b3tQBya+XzswdyauVxauVyauTztAdxauX3tQBeff8kk/cIAAAALHRSTlMAj9GPzKOzzM6z5numzwqyzqXR1brqvNFlCLelWMqopZCRB32qqJSvwbyolZISSGMAAAB3SURBVBjTdc7ZEoIwDIXhQylN6i4iiqDgvqW8/+NZh8uW//KbyZkAQSfmDi0zH6sBWMSCxLcYgbO1VyTWd0G8tdYpMqIMCdHMw8o5898gLEXmMQhOgh7Fu/h8jUmB5lAPj8l245wGpv0kBjel1OuZ53dgvyvDyR/tlAvE7ebw5AAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_41`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAe1BMVEVHcEz2tQBwaeT4tgD4tQBxauVxauRxauVxauVxaeVeff9eff9yauVxauVxa+ZyauT4tQD3tQD2tQBxauVxauVeff9dff9eff9efP9wauVxa+VyauRxauRxauX3tQBwauRya+VxauWWf6ZxauWVfqdwauVxauX3tQCWf6YvGP7lAAAAJnRSTlMAs4+PzNGjzM6z5rGmz6rTzqXRsre8kaV/qKXKkJGofZST0bu2ujnkYD0AAABzSURBVBjTdY7bEoIwDAVPoZJUBQEBr6CipPz/FxqGx5Z92tmZnAkQcGN+4s7Mj2INLOJAopw2Qu/cC4lTPohTWZsiI8qQEB01lN6bZYNwFsljITgJeDffqfkZk6pfL+tjIrP3Vv2wj4Vip4x1Pah3bTj5B0IPCjEIC929AAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_42`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAeFBMVEVHcExwaeT4tgD2tQD4tQBxauVxauRxauVxauVxaeVxauVeff9yauVxauVwaub4tQD3tQBxauVfff9eff9yauZwauX3tQBxa+VxauVxauVxauT2tQBxa+awjnpyauRya+VwauRxauSvjXtyaeVwauVxauX3tQCwjXqrh+9aAAAAJXRSTlMAj4+zzNGjzM6zt8ymz6HOpbKnk4KoqKXNkZDRqtHKlH1xtbi68Pmm8AAAAG5JREFUGNNtzscSgzAMRdEHOEg2KdSEVEKR8/9/GARL++50ZqQRENQxP3Bj5k/fbsAiFiTaOQ53a79IrDYiWmlMipwoR0J0XOHifaY3CJXIKQbBStDg5sW5KUt1aPbH1n7eKBQxeB209/OqUIcn/268CgzaCTOZAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_43`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAb1BMVEVHcExxauT4tgBwaeRxauX4tQBxauVxauVxauVxaeVZev9yauVxauVwaeX4tQBxauX3tQD2tQBeef9ggP9xa+RwauX3tQBxa+Zxa+VxauVxauRxauXMnUlya+XMnUpwaeRyauRwauRxauX3tQDMnUl80aT7AAAAInRSTlMAo4+P0cy3zM6zF6bPa86ypbMTEFaoqKqlkZDN0ZS0S8p9mRo4mwAAAGlJREFUGNNtztkSgzAIheGjNoVUrWtb9wX7/s+oxMvku+OfgQHwfJgHdMy8jdxqYBELEicPht7aHYl1VoSUxsSIiCIkROkV3sdR6Q1CIZKFgrfimZ/OEuvQ3I+pv9HwCoXfw5m+Gmr/5AljNgmGVXPlHgAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_44`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAe1BMVEVHcEz4tQBxauVxauVwaeRxauVxauRxauVxaeVxauVxauZyauVxauVxaenmqx34tQBxauX3tQBxa+X2tQD4tgBwauVtbeTnrB3mqx1xauR1aup4btpwauRxauV4btlxaeRxa+Zya+VxauVwauRyauVxaeRxauX3tQB4btoDyhFeAAAAJnRSTlMAzLeRj9GjzLPOeKbPIszOsqWls4+oHKiPkBjRfc23X6qUk1SAaLNvzw0AAABzSURBVBjTdc7bEoIwDIThpbQkwROiAp4VdfH9n1B0hqvW//KbyU6AqJ3ZHrVZfT2bNSMYqRBSSpKLFOSqJ3hV/1DVAxKts2yLQqSAF5mNsBqGzW8DFTlPQXQSdXfu+XLu0k3wfSwn38u/cAuhL0M4tkj3AbwCChX7jEFcAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_45`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAflBMVEVHcExxauT4tQByauVxauVwaeRxauVxauVxauVxaeWQfK9xauVyauVxauX4tQBya+Rxa+VxauVxceP3tQD4tgD2tQCQfK9xaeRwauVwauVxauRxa+Zya+SPerB3Zt1xauVya+VxaeRwauRxauVxauRxbOR2dthyauVxauX3tQDy6QwNAAAAKHRSTlMAo8ym0Y+3zM6zzM+kss7wpecSpY+zqIWounOqxZIPk5SifZGQrQ2AFq2JTAAAAHJJREFUGNN1ztkOgzAMRNEBktjuCqX7RjfK8P8/CFXVp6T38UgeGYjaq75QqpY4qO5GUNIgpKAiZyl4mj3gzTzuZkckqvN8jUwkgxcpRlj0/ea7MSenKYhOom4hdO82hMsPPo+tluTkL5yca65n57ZINwCfPgoGfaTlHAAAAABJRU5ErkJggg==`,
      e: 1,
    },
    {
      id: `imgSeq_46`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAYFBMVEVHcExxauVwaeRxauRxauVxauVxauVxauVxauVxaeX4tQBwauWqqlVyauX4tQBxauV1bOJxa+VxauVxauT3tQBwauT4tgD2tQBxa+Z0bOJya+V1bOJyauWAgIBxauX3tQC7Ji7gAAAAHnRSTlMAt4+jz9GyzM6zzKgDps6T0qWRkKV9j7OqrZSXgAJpONB2AAAAbElEQVQY03XOwRKDIAxF0QcWk4hKRW2rrfH//7K4cOGAd3lm8iZAlmceMTAPGJl9AlYVkCqhVn2UIIrMsCIWs0hEoalpXqiIKliiLkG/7+/LRgbZSdZqzG/7GhNOOB5rn8fGHXycC+3inEe5P2XGB9nWNd/iAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_47`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAYFBMVEVHcExxauVwaeRxauRxauVxauVxauVxauVxauVxaeX4tQBwauWqqlVyauX4tQBxauV1bOJxa+VxauVxauT3tQBwauT4tgD2tQBxa+Z0bOJya+V1bOJyauWAgIBxauX3tQC7Ji7gAAAAHnRSTlMAt4+jz9GyzM6zzKgDps6T0qWRkKV9j7OqrZSXgAJpONB2AAAAbElEQVQY03XOwRKDIAxF0QcWk4hKRW2rrfH//7K4cOGAd3lm8iZAlmceMTAPGJl9AlYVkCqhVn2UIIrMsCIWs0hEoalpXqiIKliiLkG/7+/LRgbZSdZqzG/7GhNOOB5rn8fGHXycC+3inEe5P2XGB9nWNd/iAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_48`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAYFBMVEVHcExxauVwaeRxauRxauVxauVxauVxauVxauVxaeX4tQBwauWqqlVyauX4tQBxauV1bOJxa+VxauVxauT3tQBwauT4tgD2tQBxa+Z0bOJya+V1bOJyauWAgIBxauX3tQC7Ji7gAAAAHnRSTlMAt4+jz9GyzM6zzKgDps6T0qWRkKV9j7OqrZSXgAJpONB2AAAAbElEQVQY03XOwRKDIAxF0QcWk4hKRW2rrfH//7K4cOGAd3lm8iZAlmceMTAPGJl9AlYVkCqhVn2UIIrMsCIWs0hEoalpXqiIKliiLkG/7+/LRgbZSdZqzG/7GhNOOB5rn8fGHXycC+3inEe5P2XGB9nWNd/iAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `imgSeq_49`,
      w: 16,
      h: 16,
      t: `seq`,
      u: ``,
      p: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAJHpUWHRDcmVhdG9yAAAImXNMyU9KVXBMK0ktUnBNS0tNLikGAEF6Bs5qehXFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAYFBMVEVHcExxauVwaeRxauRxauVxauVxauVxauVxauVxaeX4tQBwauWqqlVyauX4tQBxauV1bOJxa+VxauVxauT3tQBwauT4tgD2tQBxa+Z0bOJya+V1bOJyauWAgIBxauX3tQC7Ji7gAAAAHnRSTlMAt4+jz9GyzM6zzKgDps6T0qWRkKV9j7OqrZSXgAJpONB2AAAAbElEQVQY03XOwRKDIAxF0QcWk4hKRW2rrfH//7K4cOGAd3lm8iZAlmceMTAPGJl9AlYVkCqhVn2UIIrMsCIWs0hEoalpXqiIKliiLkG/7+/LRgbZSdZqzG/7GhNOOB5rn8fGHXycC+3inEe5P2XGB9nWNd/iAAAAAElFTkSuQmCC`,
      e: 1,
    },
    {
      id: `sequence_0`,
      layers: [
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_0`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 0,
          st: 0,
          op: 1,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_1`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 1,
          st: 1,
          op: 2,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_2`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 2,
          st: 2,
          op: 3,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_3`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 3,
          st: 3,
          op: 4,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_4`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 4,
          st: 4,
          op: 5,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_5`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 5,
          st: 5,
          op: 6,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_6`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 6,
          st: 6,
          op: 7,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_7`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 7,
          st: 7,
          op: 8,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_8`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 8,
          st: 8,
          op: 9,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_9`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 9,
          st: 9,
          op: 10,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_10`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 10,
          st: 10,
          op: 11,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_11`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 11,
          st: 11,
          op: 12,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_12`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 12,
          st: 12,
          op: 13,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_13`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 13,
          st: 13,
          op: 14,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_14`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 14,
          st: 14,
          op: 15,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_15`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 15,
          st: 15,
          op: 16,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_16`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 16,
          st: 16,
          op: 17,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_17`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 17,
          st: 17,
          op: 18,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_18`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 18,
          st: 18,
          op: 19,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_19`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 19,
          st: 19,
          op: 20,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_20`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 20,
          st: 20,
          op: 21,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_21`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 21,
          st: 21,
          op: 22,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_22`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 22,
          st: 22,
          op: 23,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_23`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 23,
          st: 23,
          op: 24,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_24`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 24,
          st: 24,
          op: 25,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_25`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 25,
          st: 25,
          op: 26,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_26`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 26,
          st: 26,
          op: 27,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_27`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 27,
          st: 27,
          op: 28,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_28`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 28,
          st: 28,
          op: 29,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_29`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 29,
          st: 29,
          op: 30,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_30`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 30,
          st: 30,
          op: 31,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_31`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 31,
          st: 31,
          op: 32,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_32`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 32,
          st: 32,
          op: 33,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_33`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 33,
          st: 33,
          op: 34,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_34`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 34,
          st: 34,
          op: 35,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_35`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 35,
          st: 35,
          op: 36,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_36`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 36,
          st: 36,
          op: 37,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_37`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 37,
          st: 37,
          op: 38,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_38`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 38,
          st: 38,
          op: 39,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_39`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 39,
          st: 39,
          op: 40,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_40`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 40,
          st: 40,
          op: 41,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_41`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 41,
          st: 41,
          op: 42,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_42`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 42,
          st: 42,
          op: 43,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_43`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 43,
          st: 43,
          op: 44,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_44`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 44,
          st: 44,
          op: 45,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_45`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 45,
          st: 45,
          op: 46,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_46`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 46,
          st: 46,
          op: 47,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_47`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 47,
          st: 47,
          op: 48,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_48`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 48,
          st: 48,
          op: 49,
          sr: 1,
          bm: 0,
        },
        {
          ty: 2,
          sc: `#00ffff`,
          refId: `imgSeq_49`,
          ks: {
            p: { a: 0, k: [0, 0] },
            a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: [0] },
            o: { a: 0, k: [100] },
          },
          ip: 49,
          st: 49,
          op: 51,
          sr: 1,
          bm: 0,
        },
      ],
    },
  ],
  layers = [
    {
      ddd: 0,
      ind: 1,
      ty: 0,
      nm: `A_[00000-00049].png`,
      cl: `png`,
      refId: `sequence_0`,
      sr: 1,
      ks: {
        o: { a: 0, k: 100, ix: 11 },
        r: { a: 0, k: 0, ix: 10 },
        p: { a: 0, k: [8, 8, 0], ix: 2 },
        a: { a: 0, k: [8, 8, 0], ix: 1 },
        s: { a: 0, k: [100, 100, 100], ix: 6 },
      },
      ao: 0,
      w: 16,
      h: 16,
      ip: 0,
      op: 50,
      st: 0,
      bm: 0,
    },
  ],
  markers = [],
  data_default = {
    v,
    fr: 30,
    ip: 0,
    op: 50,
    w: 16,
    h: 16,
    nm: `A 2`,
    ddd: 0,
    assets,
    layers,
    markers,
  },
  disabledSend_default = `data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20width='28px'%20height='28px'%20viewBox='0%200%2028%2028'%20version='1.1'%20xmlns='http://www.w3.org/2000/svg'%20xmlns:xlink='http://www.w3.org/1999/xlink'%3e%3ctitle%3e发送%3c/title%3e%3cdefs%3e%3clinearGradient%20x1='50%25'%20y1='0%25'%20x2='50%25'%20y2='100%25'%20id='linearGradient-1'%3e%3cstop%20stop-color='%23AC9DF9'%20offset='0%25'%3e%3c/stop%3e%3cstop%20stop-color='%239280FB'%20offset='100%25'%3e%3c/stop%3e%3c/linearGradient%3e%3c/defs%3e%3cg%20id='1.3'%20stroke='none'%20stroke-width='1'%20fill='none'%20fill-rule='evenodd'%3e%3cg%20id='智能体对话-文生图'%20transform='translate(-1343,%20-920)'%3e%3cg%20id='编组-30'%20transform='translate(713,%20909)'%3e%3cg%20id='编组-55'%20transform='translate(630,%2011)'%3e%3crect%20id='矩形'%20fill-opacity='0.5'%20fill='url(%23linearGradient-1)'%20x='0'%20y='0'%20width='28'%20height='28'%20rx='8'%3e%3c/rect%3e%3cpath%20d='M6.87301168,13.4233444%20L10.2330117,15.7989694%20C10.5873867,16.0483444%2011.0730117,16.0089694%2011.3748867,15.7070944%20L16.2048867,10.8770944%20C16.4542617,10.6277194%2016.8742617,10.6277194%2017.1236367,10.8770944%20C17.3730117,11.1264694%2017.3730117,11.5464694%2017.1236367,11.7958444%20L12.2936367,16.6258444%20C11.9917617,16.9277194%2011.9392617,17.4133444%2012.2017617,17.7677194%20L14.5773867,21.1277194%20C15.4173867,22.3220944%2017.2548867,22.0464694%2017.7142617,20.6552194%20L21.7698867,8.47521941%20C22.2292617,7.08396941%2020.9036367,5.75834441%2019.5123867,6.21771941%20L7.34551168,10.2864694%20C5.95426168,10.7458444%205.69176168,12.5833444%206.87301168,13.4233444%20Z'%20id='路径'%20fill='%23FBFCFF'%20fill-rule='nonzero'%3e%3c/path%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/svg%3e`,
  send_default = `data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20width='28px'%20height='28px'%20viewBox='0%200%2028%2028'%20version='1.1'%20xmlns='http://www.w3.org/2000/svg'%20xmlns:xlink='http://www.w3.org/1999/xlink'%3e%3ctitle%3e发送%3c/title%3e%3cdefs%3e%3clinearGradient%20x1='50%25'%20y1='0%25'%20x2='50%25'%20y2='100%25'%20id='linearGradient-1'%3e%3cstop%20stop-color='%23AC9DF9'%20offset='0%25'%3e%3c/stop%3e%3cstop%20stop-color='%239280FB'%20offset='100%25'%3e%3c/stop%3e%3c/linearGradient%3e%3c/defs%3e%3cg%20id='1.3'%20stroke='none'%20stroke-width='1'%20fill='none'%20fill-rule='evenodd'%3e%3cg%20id='智能体对话-回答完成'%20transform='translate(-1343,%20-920)'%3e%3cg%20id='编组-30'%20transform='translate(713,%20869)'%3e%3cg%20id='编组-55'%20transform='translate(630,%2051)'%3e%3cg%20id='输入框/发送按钮/默认'%20fill='url(%23linearGradient-1)'%3e%3crect%20id='矩形'%20x='0'%20y='0'%20width='28'%20height='28'%20rx='8'%3e%3c/rect%3e%3c/g%3e%3cpath%20d='M6.87301168,13.4233444%20L10.2330117,15.7989694%20C10.5873867,16.0483444%2011.0730117,16.0089694%2011.3748867,15.7070944%20L16.2048867,10.8770944%20C16.4542617,10.6277194%2016.8742617,10.6277194%2017.1236367,10.8770944%20C17.3730117,11.1264694%2017.3730117,11.5464694%2017.1236367,11.7958444%20L12.2936367,16.6258444%20C11.9917617,16.9277194%2011.9392617,17.4133444%2012.2017617,17.7677194%20L14.5773867,21.1277194%20C15.4173867,22.3220944%2017.2548867,22.0464694%2017.7142617,20.6552194%20L21.7698867,8.47521941%20C22.2292617,7.08396941%2020.9036367,5.75834441%2019.5123867,6.21771941%20L7.34551168,10.2864694%20C5.95426168,10.7458444%205.69176168,12.5833444%206.87301168,13.4233444%20Z'%20id='路径'%20fill='%23FBFCFF'%20fill-rule='nonzero'%3e%3c/path%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/g%3e%3c/svg%3e`;
init_es();
var Lottie = import_dist.default?.default || import_dist.default,
  { TextArea } = Input,
  AlldebugParams,
  LoadingComp = () =>
    (0, import_jsx_runtime.jsx)(`div`, {
      children: (0, import_jsx_runtime.jsx)(Lottie, {
        options: {
          loop: !0,
          autoplay: !0,
          animationData: data_default,
          rendererSettings: { preserveAspectRatio: `xMidYMid slice` },
        },
        height: 16,
        width: 16,
      }),
    }),
  currentStop = { stop: !1 },
  AgentTest = (e) => {
    let {
        microAppId: t,
        microAppName: n,
        microAppVersionId: r,
        testCount: i,
      } = e || {},
      [a, o] = (0, import_react.useState)(``),
      [s, c] = (0, import_react.useState)([]),
      [l, u] = (0, import_react.useState)(!1),
      [d, f] = (0, import_react.useState)({}),
      [p, m] = (0, import_react.useState)(),
      [g, _] = (0, import_react.useState)(0),
      [y, b] = (0, import_react.useState)(``),
      [x, S] = (0, import_react.useState)(!1),
      [C, T] = (0, import_react.useState)(!0),
      E = (0, import_react.useRef)(),
      D = (0, import_react.useRef)(!0),
      O = (0, import_react.useRef)(0),
      k = (0, import_react.useRef)(!1);
    ((0, import_react.useEffect)(
      () => () => {
        (P(), (AlldebugParams = null));
      },
      [],
    ),
      (0, import_react.useEffect)(() => {
        i && A();
      }, [i]));
    let A = async () => {
        (c([]),
          o(``),
          b(``),
          _(0),
          u(!1),
          AlldebugParams && (L(), await P(), (currentStop = { stop: !1 })),
          j());
      },
      j = () => {
        u(!0);
        let e = {
            sopId: t,
            sopVersionId: r,
            userId: Date.now(),
            bizType: 321,
            bizId: 222,
            content: ``,
            userParam: {},
          },
          i = [];
        (f(e),
          (AlldebugParams = e),
          startDebugSOP(e).then((t) => {
            if (t.success && t.data) {
              if ((u(!1), t.data)) {
                let r = { ...e, sessionId: t.data.sessionId };
                (f(r), (AlldebugParams = r));
                let a = t.data.sopcallVO?.imageList,
                  o =
                    a &&
                    typeof a == `string` &&
                    JSON.parse(a) &&
                    typeof JSON.parse(a) == `object`
                      ? JSON.parse(a)
                      : [],
                  s = t.data.sopcallVO?.labelList,
                  l =
                    s &&
                    typeof s == `string` &&
                    JSON.parse(s) &&
                    typeof JSON.parse(s) == `object`
                      ? JSON.parse(s)
                      : [];
                if (t.data.sopcallVO?.content) {
                  let e = `<div class="chat-text-weight">Hi，你好呀！</div><div>${t.data.sopcallVO?.content}</div>`;
                  i.push({
                    type: 2,
                    ...(t.data.sopcallVO || {}),
                    imageList: o,
                    response: e,
                    labelList: l,
                  });
                } else {
                  let e = `<div class="chat-text-weight">Hi，你好呀！</div><div>欢迎体验【${n}】，我将竭诚为您服务，有任何问题都可以咨询我哦！</div>`;
                  i.push({ type: 2, imageList: o, response: e, labelList: l });
                }
                c([...i]);
              }
            } else u(!1);
          }));
      },
      M = (e, t, n) => {
        let r = -1;
        ((D.current = !0),
          (k.current = !1),
          chatStreaming(
            `/decision/agent-microapp/aiagent/runSOPStream`,
            { ...e, dataId: getUUId() },
            (e, n, i) => {
              r === -1 && (r = s.length);
              let a = i && i.split(`data:`)[1] ? i.split(`data:`)[1] : i;
              if (e === `continue` && a) {
                ((a &&= JSON.parse(a)), console.log(88888, a));
                let e = a?.data?.imageList ? JSON.parse(a?.data.imageList) : [];
                if (a?.finish === !1)
                  if ((u(!1), a.first))
                    (s.push({
                      type: 2,
                      ...(a?.data || {}),
                      imageList: e,
                      response: a?.content || ``,
                    }),
                      c([...s]));
                  else {
                    let t = s[r];
                    ((s[r] = {
                      ...t,
                      imageList: e,
                      response: (t?.response || ``) + (a?.content || ``),
                    }),
                      c([...s]));
                  }
                if (
                  (a?.errCode > 0 && staticMethods.error(`网络或系统错误！`),
                  a?.data && a?.finish)
                ) {
                  let n =
                    e && e.length
                      ? ``
                      : `不好意思，超出了我的理解范围，换个问题试试吧~`;
                  if (a?.errCode === 0 && !a?.data?.componentInParam?.length) {
                    if (a?.data?.dataId === s[r]?.dataId) {
                      let t = s[r].response + (a.data?.response || ``);
                      s[r] = {
                        ...s[r],
                        ...a.data,
                        imageList: e,
                        response: t || n,
                      };
                    } else
                      s.push({
                        type: 2,
                        ...(a?.data || {}),
                        imageList: e,
                        response: a.content || n,
                      });
                    (u(!1), (currentStop = { stop: !0 }), T(!0), c([...s]));
                    return;
                  }
                  if (a?.errCode === 0 && a?.data?.componentInParam?.length) {
                    t && t(a);
                    return;
                  }
                  if (a?.errCode !== 0) {
                    ((currentStop = { stop: !0 }),
                      u(!1),
                      T(!0),
                      s[r].response ||
                        ((s[r] = {
                          ...s[r],
                          ...a.data,
                          imageList: e,
                          response: n,
                        }),
                        c([...s])));
                    return;
                  }
                }
              }
              (e === `error` &&
                ((currentStop = { stop: !0 }),
                u(!1),
                T(!0),
                n === `已停止回答，有其他问题可以随时问我～` &&
                  staticMethods.error(n)),
                e === `finish` && u(!1));
            },
            n,
            currentStop,
          ));
      },
      N = (e, t, n, r) => {
        if (((currentStop.stop = !1), T(!1), (e ||= a), e)) {
          if (y && g !== 100) return;
          (t ||
            (s.push({ response: e, type: 1, imageList: y ? [y] : [] }),
            c([...s])),
            b(``),
            o(``),
            u(!0));
          let i = {
              ...d,
              content: y ? e + `:'${y}'` : t ? s[s.length - 1]?.response : e,
              param: t,
              inParamFlag: t ? 1 : void 0,
              bubbleComponent: n || null,
              dealMode: r || null,
            },
            a = new AbortController();
          (S(a), _(0), M(i, (e) => {}, a), m(!1));
        }
      };
    ((0, import_react.useEffect)(() => {
      if (s && E.current) {
        let e = E.current;
        setTimeout(() => {
          D.current &&
            !k.current &&
            ((e.scrollTop = e.scrollHeight), (O.current = e.scrollTop));
        }, 0);
      }
    }, [s, p]),
      (0, import_react.useEffect)(() => {
        let e = E.current;
        if (!e) return;
        let t = (e) => {
            e.deltaY < 0 && ((D.current = !1), (k.current = !0));
          },
          n = () => {
            let { scrollTop: t, scrollHeight: n, clientHeight: r } = e,
              i = n - t - r;
            (t < O.current && ((D.current = !1), (k.current = !0)),
              (O.current = t),
              i <= 10 && ((D.current = !0), (k.current = !1)));
          };
        return (
          e.addEventListener(`wheel`, t, { passive: !0 }),
          e.addEventListener(`scroll`, n, { passive: !0 }),
          () => {
            (e.removeEventListener(`wheel`, t),
              e.removeEventListener(`scroll`, n));
          }
        );
      }, [s]));
    let P = async () => {
        if (!AlldebugParams?.sessionId) return;
        let { success: e } = await endDebugSOP(AlldebugParams);
        (e && c([]), b(``));
      },
      F = {
        name: `avatar`,
        accept: `image/*`,
        maxCount: 1,
        action: `/decision/agent-microapp/file/upload`,
        listType: `picture-card`,
        showUploadList: !1,
        headers: { Authorization: appStore.token },
        onProgress(e) {
          _(e.percent === 100 ? 99 : parseInt(e.percent));
        },
        beforeUpload(e) {
          let t = new FormData();
          (t.append(`avatar`, e),
            (F.headers.sign = getHeaderSign({
              url: `/decision/agent-microapp/file/upload`,
              fileParam: t,
              ...homingRequestHeaders,
            })));
          let n = e.size / 1024 / 1024 <= 10;
          return (n || staticMethods.warning(`图片尺寸不能大于10MB!`), n);
        },
        onChange(e) {
          if (e.file.status === `done`)
            e.file.response?.errCode === 0
              ? (b(e.file.response?.data), _(100))
              : staticMethods.error(e.file.response?.msg || `上传失败`);
          else if (e.file.status === `uploading`) {
            let t = new FileReader();
            ((t.onloadend = () => {
              g < 100 && b(t.result);
            }),
              t.readAsDataURL(e.file.originFileObj));
          } else
            e.file.status === `error` &&
              staticMethods.error(`${e.file.name} 上传失败`);
        },
      },
      I = () => {
        N(s[s.length - 2].response, null, null, 2);
      },
      L = async () => {
        !currentStop.stop &&
          !C &&
          ((currentStop.stop = !0),
          T(!0),
          x && x.abort(),
          await interruptSOP(AlldebugParams));
      },
      R = (e) => {
        fetch(e)
          .then((e) => e.blob())
          .then((e) => {
            let t = URL.createObjectURL(new Blob([e])),
              n = document.createElement(`a`);
            ((n.href = t),
              (n.download = `image.png`),
              document.body.appendChild(n),
              n.click(),
              URL.revokeObjectURL(t),
              n.remove());
          });
      },
      z = (e) => {
        window.navigator.clipboard.writeText(e).then(
          () => {
            staticMethods.success(`复制成功`);
          },
          () => {
            staticMethods.error(`复制失败`);
          },
        );
      };
    return (0, import_jsx_runtime.jsxs)(`div`, {
      className: `agent-nocode-test-page`,
      children: [
        (0, import_jsx_runtime.jsxs)(`div`, {
          className: `agent-test-header`,
          children: [
            (0, import_jsx_runtime.jsx)(`img`, {
              src: logo_default,
              className: `agent-test-logo`,
            }),
            (0, import_jsx_runtime.jsx)(`span`, {
              className: `agent-test-title`,
              children: `调试`,
            }),
          ],
        }),
        (0, import_jsx_runtime.jsxs)(`div`, {
          className: `agent-test-top`,
          ref: E,
          children: [
            s.map((e, t) => {
              let n = e.labelList?.length || 1;
              return (0, import_jsx_runtime.jsx)(
                `div`,
                {
                  className: `agent-text-base ${e.type === 1 ? `agent-text-right` : ``}`,
                  children: (0, import_jsx_runtime.jsxs)(`div`, {
                    className: `agent-text-content`,
                    children: [
                      (0, import_jsx_runtime.jsx)(`div`, {
                        children: (e.imageList || []).map((e, t) =>
                          (0, import_jsx_runtime.jsx)(
                            Image$1,
                            {
                              src: e,
                              onClick: (e) => {
                                e.stopPropagation();
                              },
                              preview: {
                                toolbarRender: (
                                  t,
                                  {
                                    transform: { scale: n },
                                    actions: {
                                      onFlipY: r,
                                      onFlipX: i,
                                      onRotateLeft: a,
                                      onRotateRight: o,
                                      onZoomOut: s,
                                      onZoomIn: c,
                                    },
                                  },
                                ) =>
                                  (0, import_jsx_runtime.jsxs)(Space, {
                                    size: 12,
                                    className: `toolbar-wrapper`,
                                    children: [
                                      (0, import_jsx_runtime.jsx)(`a`, {
                                        href: e,
                                        children: (0, import_jsx_runtime.jsx)(
                                          RefIcon$1,
                                          {},
                                        ),
                                      }),
                                      (0, import_jsx_runtime.jsx)(RefIcon$2, {
                                        rotate: 90,
                                        onClick: r,
                                      }),
                                      (0, import_jsx_runtime.jsx)(RefIcon$2, {
                                        onClick: i,
                                      }),
                                      (0, import_jsx_runtime.jsx)(RefIcon$3, {
                                        onClick: a,
                                      }),
                                      (0, import_jsx_runtime.jsx)(RefIcon$4, {
                                        onClick: o,
                                      }),
                                      (0, import_jsx_runtime.jsx)(RefIcon$5, {
                                        disabled: n === 1,
                                        onClick: s,
                                      }),
                                      (0, import_jsx_runtime.jsx)(RefIcon$6, {
                                        disabled: n === 50,
                                        onClick: c,
                                      }),
                                    ],
                                  }),
                              },
                            },
                            t,
                          ),
                        ),
                      }),
                      (0, import_jsx_runtime.jsx)(`span`, {
                        style: { wordBreak: `break-all` },
                        dangerouslySetInnerHTML: { __html: e.response },
                      }),
                      (0, import_jsx_runtime.jsx)(`br`, {}),
                      (0, import_jsx_runtime.jsx)(`div`, {
                        className: `chat-label-box`,
                        style: {
                          gridTemplateColumns: `repeat(${n < 3 ? n : n === 4 ? 2 : 3}, 1fr)`,
                        },
                        children: (e?.labelList &&
                        typeof e?.labelList == `string`
                          ? JSON.parse(e.labelList)
                          : e?.labelList
                            ? e?.labelList
                            : []
                        ).map((e, t) =>
                          (0, import_jsx_runtime.jsx)(
                            `div`,
                            {
                              className: `chat-label`,
                              style: { cursor: l ? `not-allowed` : `pointer` },
                              onClick: () => {
                                l || N(e);
                              },
                              children: e,
                            },
                            t,
                          ),
                        ),
                      }),
                      t && e.response
                        ? (0, import_jsx_runtime.jsx)(`div`, {
                            className: `chat-text-copy`,
                            onClick: () => z(e.response),
                            children: (0, import_jsx_runtime.jsx)(`img`, {
                              src: copy_default,
                            }),
                          })
                        : null,
                    ],
                  }),
                },
                t,
              );
            }),
            l
              ? (0, import_jsx_runtime.jsx)(`div`, {
                  className: `agent-test-spin`,
                  children: (0, import_jsx_runtime.jsxs)(`div`, {
                    className: `agent-test-loading`,
                    children: [
                      (0, import_jsx_runtime.jsx)(LoadingComp, {}),
                      (0, import_jsx_runtime.jsx)(`span`, {
                        children: `我正在思考中，请稍等一下…`,
                      }),
                    ],
                  }),
                })
              : null,
            !l && C && s.length - 1 && s[s.length - 1]?.type === 2
              ? (0, import_jsx_runtime.jsx)(`div`, {
                  className: `agent-test-spin`,
                  children: (0, import_jsx_runtime.jsxs)(`div`, {
                    className: `agent-test-reloading`,
                    onClick: () => I(),
                    children: [
                      (0, import_jsx_runtime.jsx)(RefIcon$7, {}),
                      (0, import_jsx_runtime.jsx)(`span`, {
                        children: `重新回答`,
                      }),
                    ],
                  }),
                })
              : null,
          ],
        }),
        (0, import_jsx_runtime.jsx)(`div`, {
          className: `agent-test-bottom`,
          children: (0, import_jsx_runtime.jsxs)(`div`, {
            className: `agent-test-tool`,
            children: [
              C
                ? null
                : (0, import_jsx_runtime.jsxs)(`div`, {
                    className: `stop-btn`,
                    onClick: () => L(),
                    children: [
                      (0, import_jsx_runtime.jsx)(`div`, {
                        className: `stop-dot`,
                      }),
                      (0, import_jsx_runtime.jsx)(`span`, {
                        children: `停止回答`,
                      }),
                    ],
                  }),
              (0, import_jsx_runtime.jsxs)(`div`, {
                className: `agent-test-box`,
                children: [
                  (0, import_jsx_runtime.jsxs)(`div`, {
                    className: `agent-test-message`,
                    children: [
                      (0, import_jsx_runtime.jsx)(TextArea, {
                        className: !a && y ? `text-warning-focus` : ``,
                        id: `dom-guidance-input-propmt`,
                        value: a,
                        disabled: l || !C,
                        placeholder: `输入您的问题`,
                        autoSize: { minRows: 1, maxRows: 3 },
                        onPressEnter: () => {
                          a && (!y || (y && g === 100)) && N();
                        },
                        onChange: (e) => {
                          let t = e.target.value.trim();
                          (o(t),
                            t &&
                              t.length >= 8e3 &&
                              staticMethods.warning(`输入限制8000字符`));
                        },
                        maxLength: 8e3,
                        style: { background: a ? `#ECEBFB` : `` },
                      }),
                      a && (!y || (y && g === 100))
                        ? (0, import_jsx_runtime.jsx)(`img`, {
                            src: send_default,
                            className: `agent-test-send`,
                            onClick: () => {
                              N();
                            },
                          })
                        : (0, import_jsx_runtime.jsx)(`img`, {
                            src: disabledSend_default,
                            className: `agent-test-send agent-test-disabled-send`,
                          }),
                    ],
                  }),
                  (0, import_jsx_runtime.jsx)(Tooltip, {
                    placement: `topLeft`,
                    overlayClassName: `upload-image-tip`,
                    open: !!y,
                    onClick: (e) => {
                      e.stopPropagation();
                    },
                    title: (0, import_jsx_runtime.jsxs)(
                      import_jsx_runtime.Fragment,
                      {
                        children: [
                          (0, import_jsx_runtime.jsxs)(`div`, {
                            className: `imageBox`,
                            children: [
                              (0, import_jsx_runtime.jsx)(Image$1, {
                                width: 81,
                                src: y,
                                onClick: (e) => {
                                  e.stopPropagation();
                                },
                                preview: {
                                  toolbarRender: (
                                    e,
                                    {
                                      transform: { scale: t },
                                      actions: {
                                        onFlipY: n,
                                        onFlipX: r,
                                        onRotateLeft: i,
                                        onRotateRight: a,
                                        onZoomOut: o,
                                        onZoomIn: s,
                                      },
                                    },
                                  ) =>
                                    (0, import_jsx_runtime.jsxs)(Space, {
                                      size: 12,
                                      className: `toolbar-wrapper`,
                                      children: [
                                        (0, import_jsx_runtime.jsx)(RefIcon$1, {
                                          onClick: () => R(y),
                                        }),
                                        (0, import_jsx_runtime.jsx)(RefIcon$2, {
                                          rotate: 90,
                                          onClick: n,
                                        }),
                                        (0, import_jsx_runtime.jsx)(RefIcon$2, {
                                          onClick: r,
                                        }),
                                        (0, import_jsx_runtime.jsx)(RefIcon$3, {
                                          onClick: i,
                                        }),
                                        (0, import_jsx_runtime.jsx)(RefIcon$4, {
                                          onClick: a,
                                        }),
                                        (0, import_jsx_runtime.jsx)(RefIcon$5, {
                                          disabled: t === 1,
                                          onClick: o,
                                        }),
                                        (0, import_jsx_runtime.jsx)(RefIcon$6, {
                                          disabled: t === 50,
                                          onClick: s,
                                        }),
                                      ],
                                    }),
                                },
                              }),
                              g < 100
                                ? (0, import_jsx_runtime.jsxs)(`div`, {
                                    className: `image-loading-box`,
                                    children: [`已加载`, g, `%`],
                                  })
                                : null,
                            ],
                          }),
                          g === 100
                            ? (0, import_jsx_runtime.jsx)(`svg`, {
                                className: `icon svg-icon icon-image-delete`,
                                "aria-hidden": `true`,
                                onClick: () => b(``),
                                children: (0, import_jsx_runtime.jsx)(`use`, {
                                  xlinkHref: `#icon-shanchulianjie`,
                                }),
                              })
                            : null,
                        ],
                      },
                    ),
                    overlayInnerStyle: { color: ` #606478`, fontSize: `14px` },
                    color: `#FFFFFF`,
                    children: (0, import_jsx_runtime.jsx)(Upload, {
                      ...F,
                      className: `agent-test-upload`,
                      disabled: !(!y || (y && g === 100)),
                      children: (0, import_jsx_runtime.jsx)(Tooltip, {
                        placement: `topLeft`,
                        title: `仅支持图片格式`,
                        children: (0, import_jsx_runtime.jsx)(RefIcon, {
                          className: `agent-test-icon ${!y || (y && g === 100) ? `` : `agent-disabled-test-icon`}`,
                        }),
                      }),
                    }),
                  }),
                ],
              }),
            ],
          }),
        }),
      ],
    });
  };
init_es();
var noCodeTimer,
  NocodeAgent = () => {
    let [e, t] = (0, import_react.useState)(),
      [n, r] = (0, import_react.useState)(),
      [i, a] = (0, import_react.useState)(),
      [o, s] = (0, import_react.useState)(0),
      [c, l] = (0, import_react.useState)(!1),
      { state: u } = useLocation(),
      d = useNavigate(),
      {
        microAppName: f,
        microAppVersionId: p,
        microAppId: m,
        runMode: g,
      } = u || {},
      { status: _, upLineStatus: y } = i || {},
      [b, x] = (0, import_react.useState)(!1),
      [S, C] = (0, import_react.useState)([]),
      T = (0, import_react.useRef)();
    ((0, import_react.useEffect)(() => {
      t(f);
    }, [f]),
      (0, import_react.useEffect)(
        () => (
          D(),
          () => {
            (noCodeTimer && clearTimeout(noCodeTimer), (noCodeTimer = null));
          }
        ),
        [],
      ));
    let E = () => {
        let e = document.getElementsByClassName(`dom-guidance-instruct`)[0],
          t = document.getElementById(`dom-guidance-input-propmt`),
          n = document.getElementById(`dom-guidance-up-btn`);
        (C([
          {
            title: `创建零代码智能体（1/3）`,
            description: `您可以将要创建的智能体的需求、约束等信息填写在指令中；`,
            target: () => e,
          },
          {
            title: `创建零代码智能体（2/3）`,
            description: `您可以通过对话形式调试智能体应用；`,
            target: () => t,
          },
          {
            title: `创建零代码智能体（3/3）`,
            description: `完成智能体调试后，您将该智能体进行发布`,
            target: () => n,
            nextButtonProps: {
              style: { padding: `0 12px` },
              children: (0, import_jsx_runtime.jsx)(`span`, {
                children: `完成`,
              }),
            },
          },
        ]),
          x(!0));
      },
      D = async () => {
        let { errCode: e, data: t } = await getMicroAppVersionDetail({ id: p });
        e === 0 &&
          t &&
          (a(t),
          r(t.updateDate),
          findIsFistQuy({ runMode: g }).then((e) => {
            e?.errCode === 0 && e?.data === 1 && E();
          }));
      },
      O = async (e) => {
        let t = T?.current?.getFieldsValue(),
          { errCode: n } = await updataMicroAppVersion({
            microAppVersionId: p,
            microAppId: m,
            data: JSON.stringify(t),
            runMode: g,
          });
        n === 0 &&
          (e && staticMethods.success(`保存成功`),
          r(hooks(new Date().getTime()).format(`YYYY-MM-DD HH:mm:ss`)));
      },
      k = (e) => {
        let { time: t, removeSaveFlag: n, showmsg: r } = e || {};
        (noCodeTimer && clearTimeout(noCodeTimer),
          (noCodeTimer = setTimeout(
            async () => {
              (!n && (await O(r)), s(o + 1));
            },
            t === 0 ? t : 5e3,
          )));
      },
      A = (0, import_react.useCallback)(async () => {
        (await O(),
          enableMicroAppVersion({ id: p }).then((e) => {
            e.errCode === 0 && (staticMethods.success(`上架成功！`), D());
          }));
      }, []),
      j = (0, import_react.useCallback)(() => {
        d(ERoutes.AGENT_APP_VERSION, {
          state: { microAppId: m, microAppVersionId: p, runMode: g },
        });
      }, [g, m, p, d]);
    return (0, import_jsx_runtime.jsxs)(`div`, {
      className: `create-agent-with-noCode`,
      children: [
        (0, import_jsx_runtime.jsxs)(`div`, {
          className: `create-agent-tool`,
          children: [
            (0, import_jsx_runtime.jsx)(Space, {
              direction: `vertical`,
              children: (0, import_jsx_runtime.jsxs)(Space, {
                children: [
                  (0, import_jsx_runtime.jsx)(RefIcon$8, {
                    style: { marginLeft: `24px`, cursor: `pointer` },
                    onClick: () => d(-1),
                  }),
                  (0, import_jsx_runtime.jsx)(`div`, {
                    className: `create-agent-name`,
                    children: e,
                  }),
                  (0, import_jsx_runtime.jsx)(CreateAgent, {
                    type: `Edit`,
                    record: u,
                    callback: (e) => {
                      t(e);
                    },
                    disabled: _ === 1 || _ === 2 || !y,
                    children: (0, import_jsx_runtime.jsx)(`svg`, {
                      className: `icon svg-icon agent-edit-icon`,
                      "aria-hidden": `true`,
                      children: (0, import_jsx_runtime.jsx)(`use`, {
                        xlinkHref: `#icon-edit-square`,
                      }),
                    }),
                  }),
                  (0, import_jsx_runtime.jsxs)(`span`, {
                    className: `create-agent-time`,
                    children: [` `, n],
                  }),
                ],
              }),
            }),
            (0, import_jsx_runtime.jsxs)(Space, {
              children: [
                (0, import_jsx_runtime.jsx)(Tooltip, {
                  title: `历史版本`,
                  placement: `bottom`,
                  children: (0, import_jsx_runtime.jsx)(
                    button_default,
                    {
                      style: { marginLeft: 10 },
                      onClick: j,
                      children: `版本管理`,
                    },
                    `version`,
                  ),
                }),
                (0, import_jsx_runtime.jsx)(button_default, {
                  onClick: () => k({ showmsg: !0, time: 0 }),
                  disabled: _ === 1 || _ === 2,
                  children: `保存`,
                }),
                (0, import_jsx_runtime.jsx)(OnLineButton, {
                  onLineMethod: A,
                  disabled: _ === 1 || _ === 2 || !y,
                }),
              ],
            }),
          ],
        }),
        (0, import_jsx_runtime.jsxs)(`div`, {
          className: `agent-content`,
          children: [
            (0, import_jsx_runtime.jsx)(`div`, {
              className: `agent-content-config`,
              children: (0, import_jsx_runtime.jsx)(ApiBase, {
                initData: i,
                ref: T,
                updateTest: k,
                status: _,
              }),
            }),
            (0, import_jsx_runtime.jsx)(`div`, {
              className: `agent-content-test`,
              children: (0, import_jsx_runtime.jsx)(AgentTest, {
                microAppId: m,
                microAppName: e,
                microAppVersionId: p,
                testCount: o,
              }),
            }),
          ],
        }),
        (0, import_jsx_runtime.jsx)(Tour, {
          open: b,
          indicatorsRender: () => null,
          onClose: () => x(!1),
          steps: S,
          type: `primary`,
        }),
      ],
    });
  };
export { NocodeAgent as default };
