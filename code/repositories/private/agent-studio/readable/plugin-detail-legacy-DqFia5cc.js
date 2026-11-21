var e = document.createElement(`style`);
((e.textContent = `.agent-chart-container{height:100%;width:100%;box-sizing:border-box;background-color:#eff2f5;position:relative;font-size:14px!important}.agent-chart-container .ant-spin-nested-loading,.agent-chart-container .ant-spin-container{height:100%;width:100%}.agent-chart-container .agent-chart-top{width:100%;height:58px;border-bottom:1px solid #ecf0f5;background:#f7f9fb;display:flex;align-items:center;justify-content:space-between}.agent-chart-container .agent-name-box{display:flex;height:100%;align-items:center}.agent-chart-container .agent-name-box .header-name-title{margin:0 6px 0 12px;font-family:PingFangSC-SNaNpxibold;font-weight:600;font-size:18px;color:var(--text-color-primary)}.agent-chart-container .agent-name-box .agent-name-edit{width:24px;height:24px;background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAA/FJREFUaEPdmslPFEEUxr/XOIMJw8wIymjcEvXgEo0xKgZwwRViHDQm7geNf4An9aKJBy/qyavilohGL+6KgOgYNSYCCW5RUdyDzQzLgAcEpp7pjhAclu7pZaSta9V79X7f63pdXdUEjfY1Gs1wd9B0AZFHoFyWxFQIBACM1rJNsD8CCTIJ6QODH0uQHnWO5DcTfb7mofzQYJ3MLDU2ty9CTBxg5jkMjE8wIFPDCfhORM+RIh3Oykh/SkRiIIf9AJiZGhujU5j4ODNWA3CZisS8cRcRyohpT1aWr56IuK/LfgANkegCdItjICw1P7eFHhghjJD2jhvtezYggKL8j6a2+YiJcgA+C6e20lUUKdKqsZneqp5M9GZAllunCuZTw075eHxGSCLaHQj4PyhdKoCyYOVw63VmrLVSLrt8EeFWYIw/qCxsFUBuassR3bEHw2DB6mXukkakLAtkep+QWud/8XnBXKjXejiMk4judKbSDpLlthxG7HKy67xZEdT3BFI2UYPcug/gI2Yd/ht72k8/5Og1hggmK4COjg68fVePObNngGjQjYCucAjSdWqQW14BmKnLwuQgJfiSC1dQVV2LvNyFKAqugceTZsbrawUgbMPGrF9QSvC371SivOKhUrbhdrmQnT0P27ZuMJOJiALw197CjByD2fZVXgm+b1uyOBvBdcYzYTtAvPLxkG63C4uy52HrFmOZsBVgKOXjQVbk5yIYLEBqqjuhh8A2AC3l46PMX5aD9UWFwwMgEeVdymJeOBfbt200tJgtz0CiyuflLkBRsADp6Z6EHp2ewZYCqMpfvIKqqlq1VA7VzCpvOYCqfOl9lJeHNINXJjervKUAvcpX14JFcpS3DKBX+YqQZvBWKm8JQEwInD13Sd3bJFt5SwAikWYcPHRUM3g7lLcEoLrmOU4WlySl2gw2iakyeuv2Pdy4WTYkgFXVxnKAWEzg9JkLqK55MaBvq+q81tvNcAba23/iRHEJ6urqB5zDbuVNr4GmphYUnyrBx09foajt9XrUryu/z4uJk8ZjbeEKQ3sbLcXj+w1noLs7hjdv6xAONyNjlB9+vxdpnjT4vB4VKFnNMECyAtSa578A0P1R//nLN5w5ewldnV1awhjqd7ld2LVzMyZPmqDXPkIN4ZaXEJilx6L07n1cvVaqZ6jhMeuLClCwJl+fvYRXCR1sVVY+QllFSJ9zg6NWr1yK5cvzdFn/OdjSf7TYGm2DUj7tbJmZo9RSrK/Rfucf7jr+eF1JlaMvOBQAx18xqVlw8iXfnyw4+5q1p2w59qK7B8Dxvxr0AXHmzx7xb8B+v9tATAOQZcOtTgRAI0F6n8jvNr8BKHNeoAuJUhcAAAAASUVORK5CYII=);background-size:contain;background-position:center;cursor:pointer}.agent-chart-container .agent-name-box .agent-name-edit:hover{background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAA8xJREFUaEPdms9vE0cUx79vvA40kDiCEPNDvTQVqkJlIX5GaRoQiFRVKiQunLjxB3CiuXDkgnpCHBE3ThDUJjSqlKpqIWlIC1wQgSAVaBSlzjpOYif9ge3deWhMEgXH8a49u062c52dN+/zffPe7s4MwaFNpNPbat7QJxKynUCfsZDNkIgCaHQaW2Z/EgImSfGSwb8KiKHsZh77MBKZLWWH1upkZpGYXWiFLS8xc4yBPWU6pPU4AZNE9AQhcblpW90IEcliBlcBMDMlEumPmPgqMzoBhLU80R+cI8IAMV1oaoq8IiJeaXIVQDyZPgxLfgPCMf25PbTAuAdDXNzVGHlYFEApPzUzfwi2/BFAxMOpvTSVRkic2rm9/tFSJJYjYJqpZsl8Y8MpX4jPuCeIzkejDS9VVx5AJaw5nepjRpeXcvlliwj90R0Np1Vi5wHMmfk2adm/bICEdcucE0boeHR7/TDl63yGb0rmL92O3gjPCaIfspvoHJnmfBvDvlXtOq8rQv49gdBZipuprwG+omtwfcZTN02Z6V6GPF0tBzIZxsSfEs17Q6A1vwPceUMQfRQ350YBtLgbovdUNgMMfJ/F81ELsQMGPj8RRm2tFsUzBTDtw4fZKlLl/IPBHH4fzoEZMMLAvpiBzq4anUgkFcB73xZ6GhcfvVJ55fzKtv+ggXaNSPgOUKh8IaKKxKcxA6cqjISvAKWULwQ5dFTlRA3CNeWtAd8AnJQvdPPAEQPHTm4QgHKUNwygJWbgi68qS2bPI6Dq/MigtVxtnBaEKqcdKom3VFZOPQVQzg/05zD21MqXylJNV/kl254BKOcfDFp4uFjn/VbeU4D1UN4zgPVS3hMAKYH+77JVXfOFS1MrB1JzjOvX/nNMWDWpbrVZK6e0AF6M2ujtyVSl2vgCMHw/h6GfcyUB/FJeOwfU+r97J4sXz6yiAF7VeadyXPES+vcfRu/tLCbG7aJz+K28dgTSKUZfTwbxSQml9pathA9qCVvrCNFdAm0dYZ0fFSfhl/srjoBtA+OvbczNMuojhLq6dwAKRAFVq1UMUC0Hneb5XwC4/qmf+kui/9sMrNKV00m0NfvV72XXmU3YuVu4tZGk+PTcU0jsczNiZCiH+z/55P2iAx0nw2htd3mmIjBa1sbW4xELvw37C3C0LYyDre6qwOLGlvutxb8XGKp8+tkiDe9KsbtG3cHf3A389roKVaAPOBRA4I+Y8lEI8iHfYhSCfcy6VLYCe9C9BBD4qwYrQIJ52aPwDbjqug3kxwCafDjVSQJIEMQf5Vy3eQtfy0agWENc3QAAAABJRU5ErkJggg==)}.agent-chart-container .agent-graph-box{width:100%;height:calc(100vh - 119px)}.agent-chart-container .ant-tabs-tab-btn{display:flex}.agent-chart-container .version-status-box{width:55px}.agent-chart-container .ant-tabs-content-holder{width:10px}.agent-chart-container .save-footer{position:absolute;top:10px;right:10px}.agent-chart-container .tab-position{width:360px;height:calc(100% - 34px);position:absolute;top:20px;left:20px;background:#fff;border-radius:8px;z-index:6}.agent-chart-container .tabs-er-box{height:calc(100% - 91px);width:130px}.agent-chart-container foreignObject{overflow:visible;outline:none}
/*$vite$:1*/`),
  document.head.appendChild(e));
import { o as t } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as n, t as r } from "./vendor-react.CV1S_bb1.js";
import {
  Ii as i,
  N as a,
  Or as o,
  Vt as s,
  Yi as c,
  an as l,
  dr as u,
  j as d,
  or as f,
  yr as p,
} from "./vendor-antd.QfSgOu5e.js";
import { S as m } from "./singleton-rEY9lZZ3-YXHRT4AG.js";
import { t as h } from "./Dependency-D0rklwaK.js";
import { t as g } from "./ProForm-DbXaWFwb.js";
import { C as _ } from "./config-KnGHEPxL.js";
import { t as v } from "./Select-BVLhUCvL.js";
import { t as y } from "./Text-uTTksjIP.js";
import { t as b } from "./AgentGraphDrawer-Bu5JvJ67.js";
import { J as x, R as S, Y as C, j as w } from "./index.B_LPe2F7.js";
import {
  A as T,
  E,
  M as ee,
  at as te,
  ft as D,
  ht as O,
  j as k,
  u as A,
  w as ne,
} from "./intelligentEngine-BhRFRjx8.js";
import {
  D as j,
  E as M,
  O as N,
  T as P,
  c as F,
} from "./ParamSetting-CquF8dGB.js";
import { n as I } from "./operator-D03Sn4KY.js";
import { n as L, t as R } from "./graph-Co13WHYI.js";
import { t as z } from "./ImportExportJson-FqUU1dJJ.js";
import { n as B, t as V } from "./PluginForm-icNwBkLH.js";
var H = t(_(), 1);
s();
var U = t(n(), 1),
  W = r(),
  G = ({
    name: e,
    form: t,
    TableStyle: n,
    dataSource: r,
    setDataSource: a,
    onRef: o,
    title: s,
  }) => {
    e ||= `inParamList`;
    let [c, d] = (0, U.useState)([S()]),
      [f, m] = (0, U.useState)(!1);
    (0, U.useImperativeHandle)(o, () => ({ updateDataSource: C }));
    let g = [];
    (0, U.useEffect)(() => {
      let n = {};
      ((g = []), _(r, n), d(g), t.current?.setFieldValue(e, n), m(!1));
    }, [r, t]);
    let _ = (e, t) => {
        e.forEach((e) => {
          ((t[e.paramId] = e),
            g.push(e.paramId),
            e.children && e.children.length > 0 && _(e.children, t));
        });
      },
      b = (e, t, n) => {
        for (let r = 0; r < e.length; r++) {
          if (t.paramId === e[r].paramId) {
            n ? e.push(n) : (e[r] = t);
            break;
          }
          e[r].children && b(e[r].children, t, n);
        }
      },
      x = ({ list: e, row: t, val: n }) => {
        for (let r = 0; r < e.length; r++) {
          if (t.paramId === e[r].paramId) {
            if (
              ((e[r] = { ...t }),
              (e[r].children = null),
              (e[r].paramType = n),
              n === 4)
            ) {
              let t = {
                paramId: S(),
                paramType: 2,
                required: 1,
                disabled: !0,
                paramName: `items`,
                paramCode: `items`,
              };
              e[r].children = [t];
            }
            break;
          }
          e[r].children && x({ list: e[r].children, row: t, val: n });
        }
      },
      C = () => {
        let n = t.current?.getFieldValue(e),
          i = r;
        for (let e in n) b(i, n[e]);
        a([...i]);
      };
    return (0, W.jsx)(`div`, {
      className: `edit-table-box`,
      children: (0, W.jsx)(u, {
        spinning: f,
        children: (0, W.jsx)(l, {
          style: n,
          dataSource: r,
          columns: [
            {
              title: (0, W.jsxs)(`span`, {
                children: [
                  (0, W.jsx)(`i`, {
                    className: `table-form-required-icon`,
                    children: `*`,
                  }),
                  `参数编码`,
                ],
              }),
              dataIndex: `paramCode`,
              width: 120,
              render: (t, n) =>
                (0, W.jsx)(y, {
                  disabled: !0,
                  rules: [{ required: !0, message: `请输入参数编码` }],
                  name: [e, n.paramId, `paramCode`],
                }),
            },
            {
              title: (0, W.jsxs)(`span`, {
                children: [
                  (0, W.jsx)(`i`, {
                    className: `table-form-required-icon`,
                    children: `*`,
                  }),
                  `参数名称`,
                ],
              }),
              dataIndex: `paramName`,
              ellipsis: !0,
              width: 120,
              render: (t, n) =>
                (0, W.jsx)(y, {
                  disabled: !0,
                  rules: [{ required: !0, message: `请输入参数名称` }],
                  name: [e, n.paramId, `paramName`],
                }),
            },
            {
              title: (0, W.jsxs)(`span`, {
                children: [
                  (0, W.jsx)(`i`, {
                    className: `table-form-required-icon`,
                    children: `*`,
                  }),
                  `是否必填`,
                ],
              }),
              dataIndex: `required`,
              width: 90,
              render: (t, n) =>
                (0, W.jsx)(v, {
                  name: [e, n.paramId, `required`],
                  fieldProps: { style: { width: 80 } },
                  disabled: !0,
                  placeholder: `请选择`,
                  options: [
                    { label: `是`, value: 1 },
                    { label: `否`, value: 0 },
                  ],
                }),
            },
            {
              title: (0, W.jsxs)(`span`, {
                children: [
                  (0, W.jsx)(`i`, {
                    className: `table-form-required-icon`,
                    children: `*`,
                  }),
                  `字段类型`,
                ],
              }),
              dataIndex: `paramType`,
              width: 110,
              render: (n, o) =>
                (0, W.jsx)(p.Item, {
                  name: [e, o.paramId, `paramType`],
                  children: (0, W.jsx)(i, {
                    style: { width: `100px` },
                    placeholder: `请选择`,
                    disabled: !0,
                    options: [
                      { label: `数字`, value: 1 },
                      { label: `字符串`, value: 2 },
                      { label: `布尔`, value: 3 },
                      { label: `数组`, value: 4 },
                      { label: `对象`, value: 5 },
                    ],
                    onChange: (n) => {
                      setTimeout(() => {
                        let i = t.current?.getFieldValue(e),
                          s = r;
                        for (let e in i) b(s, i[e]);
                        let c = t.current?.getFieldValue(e)?.[o.paramId];
                        (x({ list: s, row: c, val: n }), a([...s]));
                      }, 100);
                    },
                  }),
                }),
            },
            {
              title: `初始值`,
              dataIndex: `defaultValue`,
              render: (t, n) =>
                (0, W.jsx)(h, {
                  name: [[e, n.paramId, `required`]],
                  children: () => {
                    let r = n.required;
                    return (0, W.jsx)(y, {
                      formItemProps: { wrapperCol: { span: 12 } },
                      value: t,
                      rules: r
                        ? [{ required: !0, message: `请输入初始值` }]
                        : [],
                      name: [e, n.paramId, `defaultValue`],
                    });
                  },
                }),
            },
          ],
          pagination: !1,
          rowKey: `paramId`,
          title: () => s,
          scroll: { x: 600 },
          expandable: {
            rowExpandable: () => !0,
            expandedRowKeys: c,
            onExpand: (e, t) => {
              e
                ? c.push(t.paramId)
                : c.splice(
                    c.findIndex((e) => e === t.paramId),
                    1,
                  );
            },
          },
        }),
      }),
    });
  };
s();
var K = H.default?.default || H.default,
  q,
  J;
function Y(e) {
  let [t, n] = (0, U.useState)([]),
    [r, i] = (0, U.useState)(!1),
    [a, o] = (0, U.useState)(0),
    [s, l] = (0, U.useState)(null),
    {
      open: p,
      setOpen: h,
      disabled: _,
      compId: v,
      reactFlowInstance: y,
    } = e || {},
    { getNodes: x, getEdges: S, setNodes: C } = y,
    w = (0, U.useRef)(null);
  ((0, U.useEffect)(
    () => () => {
      ((q = null), (J = null));
    },
    [],
  ),
    (0, U.useEffect)(() => {
      if (p) {
        let { inParams: e } =
            x().find((e) => e.type === `StartNode`)?.data.formData || {},
          t = [];
        (e &&
          e.forEach((e) => {
            t.push({ ...e, children: null });
          }),
          n(t),
          w.current?.setFieldValue(`inParamList`, t));
      } else (o(0), n([]), w.current?.setFieldsValue({ inParamList: [] }));
    }, [p]));
  let T = () => {
      h(!1);
    },
    E = () => {
      w.current?.validateFields().then(async (e) => {
        let { inParamList: t } = e,
          n = {};
        try {
          for (let e in t) {
            let { defaultValue: r, paramType: i, paramCode: a } = t[e];
            n[a] = i == 2 ? r : r == null ? null : I[i](r);
          }
        } catch {
          f.error(`调试参数格式错误，请检查！`);
          return;
        }
        (i(!0), o(0), l());
        let r = x(),
          a = S();
        C((e) =>
          e.map(
            (e) => (
              (e.data = {
                ...e.data,
                updateTestRecord: { loading: !0, id: e.id },
              }),
              e
            ),
          ),
        );
        let s = new Date().getTime();
        ((q = m.CancelToken.source()), (J = L.makeString()));
        let c = await A(
            {
              input: n,
              compId: v,
              data: JSON.stringify({ nodes: r, edges: a }),
              sessionId: J,
            },
            { hideMsg: !0, source: q },
          ),
          { data: u, stop: d } = c || {},
          p = !0;
        (u && u.executeLogList && u.executeLogList.length > 0
          ? ((p = !u.executeLogList.find((e) => e.status === 0)),
            C((e) =>
              e.map((e) => {
                let t = u.executeLogList.find((t) => t.id === e.id);
                return (
                  t
                    ? (e.data = {
                        ...e.data,
                        updateTestRecord: t.status
                          ? t
                          : { ...t, id: e.id, error: !0 },
                      })
                    : (e.data = { ...e.data, updateTestRecord: null }),
                  e
                );
              }),
            ))
          : ((p = !1),
            C((e) =>
              e.map(
                (e) => (
                  (e.data = {
                    ...e.data,
                    updateTestRecord: d
                      ? {
                          stop: !0,
                          id: e.id,
                          startTime: s,
                          endTime: new Date().getTime(),
                        }
                      : { id: e.id, error: !0 },
                  }),
                  e
                ),
              ),
            )),
          l(c ? { ...c, successResult: p } : null),
          o((new Date().getTime() - s) / 1e3),
          i(!1));
      });
    };
  return (0, W.jsx)(b, {
    onClose: T,
    open: p,
    width: 900,
    title: `调试`,
    className: `test-modal`,
    footer: (0, W.jsx)(`div`, {
      className: `agent-graph-form-btn`,
      children: r
        ? (0, W.jsx)(c, {
            onClick: () => {
              (console.log(q, `各发达国家打开`),
                q.cancel(),
                D({ sessionId: J }));
            },
            style: { width: `100%` },
            icon: (0, W.jsx)(`span`, {
              className: `agent-graph-form-btn-stop`,
              children: (0, W.jsx)(`i`, {}),
            }),
            children: `停止运行`,
          })
        : (0, W.jsx)(c, {
            onClick: () => {
              E();
            },
            style: { width: `100%` },
            type: `primary`,
            children: `开始运行`,
          }),
    }),
    children: (0, W.jsxs)(g, {
      submitter: !1,
      formRef: w,
      disabled: _,
      children: [
        (0, W.jsx)(G, {
          title: (0, W.jsx)(`span`, {
            style: { marginRight: `5px` },
            children: `请求参数`,
          }),
          name: `inParamList`,
          form: w,
          dataSource: t,
          setDataSource: n,
        }),
        (0, W.jsx)(`div`, {
          className: `test-modal-title`,
          children: `输出结果`,
        }),
        !s &&
          !r &&
          (0, W.jsx)(`div`, {
            style: { color: `#9296A6` },
            children: `请运行后查看输出结果`,
          }),
        r
          ? (0, W.jsxs)(`div`, {
              className: `loading-test`,
              children: [
                (0, W.jsx)(u, {
                  indicator: (0, W.jsx)(d, {
                    style: { fontSize: 16 },
                    spin: !0,
                  }),
                  loading: r,
                }),
                (0, W.jsx)(`span`, {
                  className: `test-res-status`,
                  children: `执行中`,
                }),
              ],
            })
          : null,
        a
          ? (0, W.jsxs)(`div`, {
              className: `end-test`,
              children: [
                (0, W.jsxs)(`div`, {
                  className: `end-test-tip`,
                  children: [
                    (0, W.jsx)(`img`, {
                      src: s?.successResult ? P : s?.stop ? M : j,
                    }),
                    (0, W.jsx)(`span`, {
                      className: `test-res-status`,
                      children: s?.successResult
                        ? `成功`
                        : s?.stop
                          ? `已中止`
                          : `失败`,
                    }),
                    s?.successResult
                      ? (0, W.jsxs)(`div`, {
                          className: `end-test-time`,
                          children: [a, `s`],
                        })
                      : null,
                  ],
                }),
                s && !s.stop
                  ? (0, W.jsx)(K, { src: s || {}, name: null, theme: N })
                  : null,
              ],
            })
          : null,
      ],
    }),
  });
}
var re = (0, U.memo)(Y);
s();
var X, Z, Q, $;
function ie() {
  let [e, t] = (0, U.useState)([]),
    [n, r] = (0, U.useState)(),
    [i, s] = (0, U.useState)(),
    [l, d] = (0, U.useState)(),
    [p, m] = (0, U.useState)(!1),
    [h, g] = (0, U.useState)(null),
    [_, v] = (0, U.useState)(!1),
    [y, b] = (0, U.useState)(!1),
    [S, D] = (0, U.useState)(!1),
    A = C(),
    { state: j } = x(),
    { id: M } =
      j ||
      (localStorage.getItem(`compItem_state`)
        ? JSON.parse(localStorage.getItem(`compItem_state`))
        : {}),
    { compStatus: N } = i || {},
    {
      graphDisabled: P,
      updateBigModelList: I,
      updateBigPrivateModelList: L,
    } = w();
  ((Q = P),
    (Z = h),
    (X &&= (clearInterval(X), null)),
    (X = setInterval(() => {
      Y();
    }, 180 * 1e3)),
    (0, U.useEffect)(
      () => () => {
        localStorage.removeItem(`compItem_state`);
      },
      [],
    ),
    (0, U.useEffect)(
      () => (
        J({ updateGraph: !0 }),
        H(),
        G(),
        K(),
        q(),
        (window.onbeforeunload = () => {
          Y();
        }),
        () => {
          (Y(),
            clearInterval(X),
            (X = null),
            sessionStorage.removeItem(`bigModels`),
            ($ = null),
            (Q = null),
            (Z = null),
            (window.onbeforeunload = null));
        }
      ),
      [],
    ));
  let H = async () => {
      let e = await ee({ type: `system_param` });
      e.errCode === 0 &&
        e.data &&
        sessionStorage.setItem(`systemPromptParams`, JSON.stringify(e.data));
    },
    G = async () => {
      let { data: e, errCode: n } = await ne();
      n === 0 && e && t(e);
      let r = await T({ type: `default_Knowledge` });
      r.errCode === 0 &&
        r.data &&
        ((r.data.compType = 11),
        (r.data.iconTitle = `通过知识库组件引用知识库，建议关联大模型组件使用，优化内容输出。`),
        sessionStorage.setItem(`sys_knowledge_base`, JSON.stringify(r.data)));
    },
    K = async () => {
      let { data: e, success: t } = await k({ type: `default_bigModel` });
      t &&
        e &&
        (I(e), sessionStorage.setItem(`default_bigModel`, JSON.stringify(e)));
    },
    q = async () => {
      let { data: e, success: t } = await k({ type: `private_bigModel` });
      t &&
        e &&
        (L(e), sessionStorage.setItem(`private_bigModel`, JSON.stringify(e)));
    },
    J = async (e) => {
      let { updateGraph: t } = e || {};
      t && v(!0);
      let { success: n, data: i } = await E({ id: M });
      v(!1);
      let a;
      if (
        (n &&
          i &&
          (i.interfaceDependency && (a = JSON.parse(i.interfaceDependency)),
          ($ = i),
          s(i),
          d(i.compName),
          m(i?.beautifyFlag)),
        t)
      ) {
        if (!a) {
          let e = F.makeString(),
            t = F.makeString();
          a = {
            nodes: [
              {
                id: e,
                type: `StartNode`,
                position: { x: 180, y: 300 },
                width: 306,
                height: 136,
                data: {
                  nodeType: `StartNode`,
                  nodeId: e,
                  icon: `CompStart`,
                  graphType: `comp`,
                },
              },
              {
                id: t,
                type: `EndNode`,
                position: { x: 660, y: 300 },
                width: 306,
                height: 153,
                data: {
                  nodeType: `EndNode`,
                  nodeId: t,
                  icon: `end`,
                  graphType: `comp`,
                },
              },
            ],
            edges: [],
          };
        }
        r(a);
      }
    },
    Y = (0, U.useCallback)(async (e) => {
      let {
        compType: t,
        compName: n,
        type: r,
        description: i,
        compStatus: a,
      } = $ || {};
      if (a === 1 || a === 2 || Q || !Z) return;
      let { getEdges: o, getNodes: s } = Z,
        c = s(),
        l = o();
      (c.forEach((e) => {
        ((e.selected = !1), (e.data.updateTestRecord = null));
      }),
        l.forEach((e) => {
          e.selected = !1;
        }));
      let { success: u } = await O({
        compId: M,
        compType: t,
        compName: n,
        type: r,
        description: i,
        interfaceDependency: JSON.stringify({ nodes: c, edges: l }),
      });
      u && (e && f.success(`保存成功`), J());
    }, []);
  return (0, W.jsxs)(`div`, {
    className: `agent-chart-container`,
    children: [
      (0, W.jsxs)(u, {
        spinning: _,
        tip: `Loading...`,
        children: [
          (0, W.jsxs)(`div`, {
            className: `agent-chart-top`,
            children: [
              (0, W.jsxs)(`div`, {
                className: `agent-name-box`,
                children: [
                  (0, W.jsx)(a, {
                    style: { marginLeft: `24px`, cursor: `pointer` },
                    onClick: () => A(-1),
                  }),
                  (0, W.jsx)(`span`, {
                    className: `header-name-title`,
                    title: l,
                    children: l,
                  }),
                  (0, W.jsx)(V, {
                    callback: (e) => {
                      (d(e.compName), s(e), ($ = e));
                    },
                    record: i,
                    type: `Edit`,
                    disabled: P,
                    children: (0, W.jsx)(`div`, {
                      className: `agent-name-edit`,
                    }),
                  }),
                ],
              }),
              (0, W.jsx)(`div`, {
                className: `save-footer`,
                children: [
                  (0, W.jsxs)(
                    o,
                    {
                      className: `comp-pro-op`,
                      children: [
                        (0, W.jsx)(z, {
                          id: M,
                          exportUrl: `/agent-microapp/component/export`,
                          name: `插件`,
                          importFn: te,
                          importCb: () => {
                            (f.success(`导入成功`), J({ updateGraph: !0 }));
                          },
                          saveData: Y,
                          status: N,
                          upLineStatus: !0,
                        }),
                        (0, W.jsx)(c, {
                          onClick: () => {
                            let { getEdges: e, getNodes: t } = Z,
                              { inParams: n } =
                                t().find((e) => e.type === `StartNode`)?.data
                                  .formData || {};
                            if (n && n.length) {
                              let e = !1;
                              for (let t of n)
                                if (!t.paramName || !t.paramCode) {
                                  e = !0;
                                  break;
                                }
                              (e && f.warning(`请填写开始节点完整参数信息`),
                                !e && b(!0));
                            } else f.warning(`请先配置开始入参！`);
                          },
                          children: `调试`,
                        }),
                        (0, W.jsx)(c, {
                          onClick: () => Y(`showMsg`),
                          disabled: !(N !== 1 && N !== 2),
                          children: `保存`,
                        }),
                        (0, W.jsx)(c, {
                          type: `primary`,
                          onClick: () => D(!0),
                          disabled: !(N !== 1 && N !== 2),
                          children: `上架`,
                        }),
                      ],
                    },
                    `tool`,
                  ),
                ],
              }),
            ],
          }),
          (0, W.jsx)(`div`, {
            className: `agent-graph-box`,
            children: (0, W.jsx)(R, {
              compList: e,
              disabled: !(N !== 1 && N !== 2),
              reactFlowInstance: h,
              setReactFlowInstance: g,
              interfaceDependency: n,
              beautifyFlag: p,
            }),
          }),
          h
            ? (0, W.jsx)(re, {
                open: y,
                setOpen: b,
                reactFlowInstance: h,
                compId: M,
              })
            : null,
        ],
      }),
      S
        ? (0, W.jsx)(B, {
            open: S,
            save: Y,
            setOpen: D,
            id: M,
            callBack: () => J(),
            reactFlowInstance: h,
            pluginInfo: i,
          })
        : null,
    ],
  });
}
export { ie as default };
