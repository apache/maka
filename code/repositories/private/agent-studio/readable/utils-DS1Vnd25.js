import { o as e } from "./rolldown-runtime-CMxvf4Kt.js";
import { i as t, r as n, t as r } from "./vendor-react.CV1S_bb1.js";
import {
  Kt as i,
  Pi as a,
  Vt as o,
  nn as s,
  or as c,
  po as l,
} from "./vendor-antd.QfSgOu5e.js";
import { n as u } from "./agent-C0JAlTor.js";
import { i as d } from "./status-dict-D3T8Xf4E.js";
import { t as f } from "./react-D9MLkLvv.js";
import { F as p } from "./index.B_LPe2F7.js";
import {
  a as m,
  c as h,
  d as g,
  f as _,
  g as v,
  h as y,
  i as b,
  l as x,
  m as S,
  n as C,
  o as w,
  p as T,
  r as E,
  s as D,
  t as O,
  u as k,
} from "./src--QpPaBte.js";
var A = (function (e) {
    return (
      (e.StartNode = `StartNode`),
      (e.EndNode = `EndNode`),
      (e.LLMNode = `LLMNode`),
      (e.KnowlEdgeNode = `KnowlEdgeNode`),
      (e.ApiNode = `ApiNode`),
      (e.CodeNode = `CodeNode`),
      (e.TextNode = `TextNode`),
      (e.PluginNode = `PluginNode`),
      (e.RuleNode = `RuleNode`),
      (e.MCPNode = `MCPNode`),
      (e.WorkflowNode = `WorkflowNode`),
      (e.SubWorkflowNode = `SubWorkflowNode`),
      (e.IntentNode = `IntentNode`),
      (e.VariableProcessNode = `VariableProcessNode`),
      (e.VariableAssignNode = `VariableAssignNode`),
      (e.AgentNode = `AgentNode`),
      (e.MultiAgentNode = `MultiAgentNode`),
      (e.IteratorNode = `IteratorNode`),
      (e.ParameterExtractorNode = `ParameterExtractorNode`),
      (e.ParallelNode = `ParallelNode`),
      (e.ContainerNode = `ContainerNode`),
      (e.ExecuteConfirmNode = `ExecuteConfirmNode`),
      (e.ImageGenerationNode = `ImageGenerationNode`),
      e
    );
  })({}),
  j = f((e) => ({
    sysParams: [],
    setSysParams: (t) => e({ sysParams: t }),
    knowledgeParams: {},
    setKnowledgeParams: (t) => {
      e({ knowledgeParams: t });
    },
    workflowGraphDisabled: !1,
    setWorkflowGraphDisabled: (t) => e({ workflowGraphDisabled: t }),
    hasModalOpen: !1,
    setHasModalOpen: (t) => e({ hasModalOpen: t }),
    microAppInfo: {},
    setMicroAppInfo: (t) => e({ microAppInfo: t }),
    autoOpenDebugNodeId: null,
    setAutoOpenDebugNodeId: (t) => e({ autoOpenDebugNodeId: t }),
    pluginList: [],
    setPluginList: (t) => e({ pluginList: t }),
    modelList: [],
    setModelList: (t) => e({ modelList: t }),
    imageModelList: [],
    setImageModelList: (t) => e({ imageModelList: t }),
    sessionVariables: [],
    setSessionVariables: (t) => e({ sessionVariables: t }),
    lastSaveTime: null,
    setLastSaveTime: (t) => e({ lastSaveTime: t }),
    workflowDebugModalOpen: !1,
    setWorkflowDebugModalOpen: (t) => e({ workflowDebugModalOpen: t }),
    hoveredNodeId: null,
    setHoveredNodeId: (t) => e({ hoveredNodeId: t }),
    memoryConfig: {},
    setMemoryConfig: (t) => e({ memoryConfig: t }),
    nodeConfigList: [],
    setNodeConfigList: (t) => {
      let n = {},
        r = {};
      (t.forEach((e) => {
        (e.code && e.name && (n[e.code] = e.name),
          e.code && e.desc && (r[e.code] = e.desc));
      }),
        e({ nodeConfigList: t, nodesNameMap: n, nodesDescMap: r }));
    },
    nodesNameMap: {},
    nodesDescMap: {},
    mainCanvasNodes: [],
    setMainCanvasNodes: (t) => e({ mainCanvasNodes: t }),
    mainCanvasEdges: [],
    setMainCanvasEdges: (t) => e({ mainCanvasEdges: t }),
    currentOpenNodeId: null,
    openNodeModal: (t) => {
      e(() => ({ currentOpenNodeId: t, subCanvasOpenNodeIdMap: {} }));
    },
    closeNodeModal: () => {
      e({ currentOpenNodeId: null });
    },
    subCanvasOpenNodeIdMap: {},
    openSubCanvasNodeModal: (t, n) => {
      e((e) => ({
        currentOpenNodeId: null,
        subCanvasOpenNodeIdMap: { ...e.subCanvasOpenNodeIdMap, [t]: n },
      }));
    },
    closeSubCanvasNodeModal: (t) => {
      e((e) => ({
        subCanvasOpenNodeIdMap: { ...e.subCanvasOpenNodeIdMap, [t]: null },
      }));
    },
  })),
  M = e(t()),
  N = e(l()),
  P = {
    "stream-container": `_stream-container_1g5g4_1`,
    "stream-display": `_stream-display_1g5g4_4`,
    "fade-in": `_fade-in_1g5g4_8`,
    fadeIn: `_fadeIn_1g5g4_1`,
    "stream-typewriter": `_stream-typewriter_1g5g4_11`,
    blink: `_blink_1g5g4_1`,
  };
function F(e) {
  return !e || e.length === 0
    ? ``
    : e.reduce((e, t) => {
        let n = 0;
        for (; n < e.length && n < t.length && e[n] === t[n];) n++;
        return e.slice(0, n);
      });
}
var I = () => Math.random().toString().slice(2),
  L = ({
    streaming: e,
    content: t,
    animation: n,
    onProgress: r,
    onComplete: i,
  }) => {
    let [a, o] = (0, M.useState)([]),
      s = (0, M.useRef)(!1),
      c = (0, M.useRef)(``),
      l = (0, M.useRef)(1),
      u = (0, M.useRef)(-1),
      d = (0, M.useRef)(e);
    d.current = e;
    let f = (0, M.useMemo)(() => {
        let e = { effect: `fade-in`, interval: 50, step: 3, keepPrefix: !0 };
        if (n === !1 || n === !0) return e;
        let { step: t = 6, interval: r = 100 } = n,
          i = (e) => typeof e == `number`;
        return (
          (!i(r) || r <= 0) &&
            console.error(
              `[StreamText] 无效的 animation.interval 属性，期望值为正数`,
            ),
          !i(t) &&
            !Array.isArray(t) &&
            console.error(
              `[StreamText] 无效的 animation.step 属性，期望值为正数或 [min, max] 区间`,
            ),
          i(t) &&
            t <= 0 &&
            console.error(
              `[StreamText] 无效的 animation.step 属性，期望值为正数`,
            ),
          Array.isArray(t) &&
            ((!i(t[0]) || t[0] <= 0) &&
              console.error(
                `[StreamText] 无效的 animation.step[0] 属性，期望值为正数`,
              ),
            (!i(t[1]) || t[1] <= 0) &&
              console.error(
                `[StreamText] 无效的 animation.step[1] 属性，期望值为正数`,
              ),
            t[0] > t[1] &&
              console.error(
                `[StreamText] 无效的 animation.step 属性，step[0] 应小于等于 step[1]`,
              )),
          { ...e, ...n }
        );
      }, [n]),
      p = (0, M.useRef)({ content: t, interval: f.interval, step: f.step });
    p.current = { content: t, interval: f.interval, step: f.step };
    let m = (0, M.useCallback)(
        (e) => {
          let t = 0;
          ((c.current = f.keepPrefix ? F([p.current.content, c.current]) : ``),
            o(
              c.current
                ? [{ text: c.current, id: I(), taskId: e, done: !0 }]
                : [],
            ));
          let n = () => {
            if (e !== l.current) return;
            let a = performance.now(),
              { content: f, interval: m, step: h } = p.current;
            if (a - t < m) {
              u.current = requestAnimationFrame(n);
              return;
            }
            let g = c.current.length,
              _ =
                typeof h == `number`
                  ? h
                  : Math.floor(Math.random() * (h[1] - h[0])) + h[0],
              v = f.slice(g, g + _);
            if (!v) {
              if (d.current) {
                u.current = requestAnimationFrame(n);
                return;
              }
              (o((t) => [
                {
                  text: t.map(({ text: e }) => e).join(``),
                  id: I(),
                  taskId: e,
                  done: !0,
                },
              ]),
                i?.(f),
                (s.current = !1),
                l.current++);
              return;
            }
            c.current += v;
            let y = { id: I(), text: v, taskId: e, done: !1 };
            (o((e) => e.concat(y)),
              (s.current ||= !0),
              r?.(c.current, f),
              (t = a),
              (u.current = requestAnimationFrame(n)));
          };
          n();
        },
        [f.keepPrefix, r, i],
      ),
      h = (0, M.useCallback)(() => {
        (cancelAnimationFrame(u.current),
          o([]),
          (c.current = ``),
          (s.current = !1));
      }, []);
    return (
      (0, M.useLayoutEffect)(() => {
        if (!t) return h();
        t !== c.current &&
          ((s.current && t.startsWith(c.current)) ||
            (s.current && !t.startsWith(c.current)
              ? (cancelAnimationFrame(u.current),
                (s.current = !1),
                requestAnimationFrame(() => m(++l.current)))
              : s.current || m(l.current)));
      }, [t, h, m]),
      { renderedData: a, animating: s.current, memoedAnimationCfg: f }
    );
  },
  R = r(),
  z = (0, M.memo)(
    ({
      content: e,
      streaming: t = !0,
      animation: n = !0,
      onProgress: r,
      onComplete: i,
      className: a,
      style: o,
      contentClassName: s,
      contentStyle: c,
    }) => {
      let {
          renderedData: l,
          animating: u,
          memoedAnimationCfg: d,
        } = L({
          streaming: t && n !== !1,
          content: e,
          animation: n,
          onProgress: r,
          onComplete: i,
        }),
        { effect: f } = d,
        p = l.map((e) =>
          f === `fade-in` && !e.done
            ? (0, R.jsx)(
                `span`,
                { className: P[`fade-in`], children: e.text },
                e.id,
              )
            : e.text,
        ),
        m = n !== !1 && f === `typewriter`;
      return (0, R.jsx)(`div`, {
        className: (0, N.default)(P[`stream-container`], a),
        style: o,
        children: (0, R.jsx)(`div`, {
          className: (0, N.default)(
            P[`stream-display`],
            { [P[`stream-typewriter`]]: m && u },
            s,
          ),
          style: c,
          children: p,
        }),
      });
    },
  );
function B(e, t) {
  t ||= [];
  var n = e ? Math.min(t.length, e.length) : 0,
    r = t.slice(),
    i;
  return function (a) {
    for (i = 0; i < n; ++i) r[i] = e[i] * (1 - a) + t[i] * a;
    return r;
  };
}
function V(e) {
  return ArrayBuffer.isView(e) && !(e instanceof DataView);
}
function H(e, t) {
  var n = t ? t.length : 0,
    r = e ? Math.min(n, e.length) : 0,
    i = Array(r),
    a = Array(n),
    o;
  for (o = 0; o < r; ++o) i[o] = G(e[o], t[o]);
  for (; o < n; ++o) a[o] = t[o];
  return function (e) {
    for (o = 0; o < r; ++o) a[o] = i[o](e);
    return a;
  };
}
function U(e, t) {
  var n = new Date();
  return (
    (e = +e),
    (t = +t),
    function (r) {
      return (n.setTime(e * (1 - r) + t * r), n);
    }
  );
}
function W(e, t) {
  var n = {},
    r = {},
    i;
  for (i in ((typeof e != `object` || !e) && (e = {}),
  (typeof t != `object` || !t) && (t = {}),
  t))
    i in e ? (n[i] = G(e[i], t[i])) : (r[i] = t[i]);
  return function (e) {
    for (i in n) r[i] = n[i](e);
    return r;
  };
}
function G(e, t) {
  var n = typeof t,
    r;
  return t == null || n === `boolean`
    ? h(t)
    : (n === `number`
        ? w
        : n === `string`
          ? (r = x(t))
            ? ((t = r), D)
            : m
          : t instanceof x
            ? D
            : t instanceof Date
              ? U
              : V(t)
                ? B
                : Array.isArray(t)
                  ? H
                  : (typeof t.valueOf != `function` &&
                        typeof t.toString != `function`) ||
                      isNaN(t)
                    ? W
                    : w)(e, t);
}
var ee = [
    `temperature`,
    `max_tokens`,
    `top_p`,
    `seed`,
    `enable_search`,
    `enable_thinking`,
    `stream`,
  ],
  te = new Set(ee),
  ne = [`size`, `watermark`, `max_images`],
  K = (e) => te.has(e),
  re = new Set(ne),
  ie = (e) => re.has(e),
  ae = `data:image/png;base64,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`,
  oe = `data:image/png;base64,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`,
  se = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAAXNSR0IArs4c6QAABHVJREFUWEftmW1oW2UUx//nuWnaxdHZ+kLF6WC09cMGVqiVSZKmbTpBEDc/DDZXweIHt9FsdRSr9kOE4cu0tk2tDkEqsxvagQNhvixJ0/VFsVLUTnHTKk4YiM7WTdial/scudlasqTm3luzdBd8vt7/Oc/vPm/nPOchWKyRxXjxP/C1njHTI+yJtKyWMaUSAhuIZZWqYD0xbgGjmAgJADMM/EaMSUn0jQJ8qRbGpsdcb87m4mcMA3sibWVqItYEyM0AVQK4yQAAg3AGTKcVogNRB336+f1dlwzY/atEF7g+vHdNQsa3MvAMgOL/0hnA01BEe6FaFAo1vnx+Kb6yAruP+yqYqB/gagCFS+kgw4YwK4Bjjhjv+vjB3gtmfS4K7Ge/GArNbmeS+8B0h1mnxvT0lSDee8IbiBjTX1ZlAGuww8HZbSpxt8F1aqa/NC1NS0VsGq/v+s6okwzg2rCvSUp0XXvYeUQ6TYKbRxoCnxmBvgrYGWpdS1AjYNxpxDhHGibCmFBKNw7X+ef0fC4A14dbb4+zHACzR88ox98vCcaxhKOoedy5/2893wvArrDvCUgEAKzQM0r9zgLfCokpAp3VdgQz1jL4XsDQLDFI7INd7R119/5hpN8ksCey50Y1Lk+CsNqIEYBzRHSYgbdHvT1TGTbM5Ak/9YCE2syMTQAK0jWkncmk+Ee83YfSv7HfL1D+YQ1YrQbRKjCdAtmDtP2LC0lgd8i3ixmvG4Il+gngjrKZ0g+ObPHHstl4g0+viiLaAcgdAG5I0f5MAk1ClE4M1/m1cL7Q+KPyQvy5sgnMHVdmSWOcg8A7iNufJ9fIntsQlYMAnPrAPK3YlMbhuu5f9LWXFdoxGRk6/7CUqjaSK4hwxEYFbUMNnWcyRrZ/XRlsBa+CecsisyJB4hVyHW+pBYlBgG/NDkG/E7hlpDGg/ZyplgxEwdk3QFxjE8pDQw1dZzNg37u7EjG8AOCRxeJDUk/8PbmCu9sA3q9LoOC1i8Vz7ZPVb8V1tYsINnzSWmpzFCmj7hev2lw8uM6OaEEtmA8CKNPxzRrwYYC36kEwqXeNeft+0NOZ/c4DVTshuR2AoRSAnGHfSZJYn60jYkyMbAzcZxYmm54D5YUoWfkkOJkCGG7kCvq0KbpZZ/0eGG3s0XZ6zhofqqqCivcB1nJrw43cQV+UAXs2C0H03Alvj7Yhctb43XseA8t+AMKM02UErnoUzANmYJMHxbIuiQQPglBhBnr5Nl3yOLO1gvGSKWDLHWv5ChzO0R0ltoRDGa7rPJc6ouYDR75Cc2imj4lrJNPm8cbAr+nLgA2FZvpxOZKfozYqaF1C8sMg6kyml7Wh3Tslc5+hxZ+/9PJZAGuunNMXIXAQQvVfvwl8xdFqMGn1kBKwPIWECNPjX/9lzSuSthQsdwnVoC11zZ/fcJYqpGjQlitVzUNbphiYehZbptyaCq0VtOMc3waGdu+6vgvaqeCWeTJID9eGH2WASUBMEXhiWR5lDOUZeRDpPsrkgcFUF/8Az2d8PB//Xu4AAAAASUVORK5CYII=`,
  ce = `data:image/png;base64,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`,
  le = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/api-icon-BtRA6oDA.png`,
  ue = `data:image/png;base64,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`,
  de = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/container-icon-AJLKZR9N.png`,
  fe = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/execute-confirm-icon-CAAZHIaX.png`,
  pe = `data:image/png;base64,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`,
  me = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/intent-icon-DM0fWKOx.png`,
  he = `data:image/png;base64,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`,
  ge = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIQAAACECAYAAABRRIOnAAAMxUlEQVR4Aeyde4wdZRnGn5ndrXQv3QXZtruABWJMNChBooHShkIAAfGCQkUxQCL/2GJKC23KRVqJYGmlF5AajAgIqFRFNBASy6UKpagJkZvKTS6mu9ButwtLt9vd7Y7f75ydBc5mds6cM+c2853w43S++b73e9/nfc6c09lNj6sSP5Yv7zsQllzS9e0MC7ruXGJYvLDrMViycPuLYP7cn2HBdm9xmljYlakbDcBokNXFaIROGc2MdmgIJW6XSm6IUhdg48erQOyGMA4/G4y7H4Wh/oEd4I16d2WQd4FnkOfNA8/TJ8D8uTlDvPVVfzTPy9SNBmA0yOpiNEInb0w3NAQ0BTSGuAuM3RBxJ2jjlVeBog2x9JLtJ8CSBdu3gnH4fWDcfVIGz6v3DOUtK3m7oWEGeRld0RjQHOgBFFt50YYoNgG7vroUiGyITZu8Oli8oGs9jIzqCfCk2VBd5SU/GzQHegD0BOgRRFUgsiGibmDn56dAtczK2xArL93dBk/9pfshkLxFWaqlFJtHVoFsX+gR0DPIngv/f96GCA9lZyRBgVBD4C54Z2jvk2A+6Z4KSSg+yTXQI6BnQA8hrOZQQ4QFsOeTpUCgIfiECu8O790E5vPCJ7MkS4DkV+Nl+kYPgZ5CUN2BhghaYMeTrUCgIbZt6b4ReB+CZMuQ/OroIdBTCKo40BBBC5I2buv5sAITDMH9cDCfF+x9hg9rlZCj7H0Kegy5RU0wRO4Ee5wuBSYYYv+oVkO6ZEhftfQYciufYIjcCfY4XQqMG4LfvgF+cgbpkiF91dJjoOfgKzBuCH/APqdbgXFDOJ6+B+mWI33V03PwKx83hD9Qrme7T3Uq4PK7/iBHczNUZ542q1IpMNZ3PAD2ClEqoWs0rjvcP3AWmPvc9reja7SJxaTt9x0PgL1CFKNmAte6o9KpkMDabEkRFMADYK8QEURLw1QMcZgpFMxT5f5rbnEFx89pFJx/YZtg2dXtgmtXzRCsualDsOK6GYJFSw8WXHjxgYLZcxsFTc2uIO6KiAnsAewJ5ADkBOQI5AzUANQEx53QKKBmiDvPvOO9PxEPHIYh3h+yf0q9Aq4jrxPKrcTB7XWC8y8yVwLDNT+cITj3m22CYz/fKJjZ0SBobqkzV5A61dU5GVrb6gSzDp8iOPqYqYJzzmsTrLx+huDi7x4kmNlRb+LUK+rDX0cMICawB7AnkAOQE/h5+nnPHKuDmmD+t9oE1Ay+DmgCUfMsdj4eALfYQHZ9shRwPTmdUK6yTjqlSbD0qumCYz9nrgSG+npHEFce/iv0U0cdILjsinbB6V9sEdTVyVxpJu7mjzMHWAPEgLqxK9TElYWNUDP4OqAJoBEUFjX6KjwA9goRXbtEr3A19i+YlKpKx5HgnPNazXt7q750dpaGBkegMj38V/ZpZ7YILvyO+VuJgdw+yAVmDJgD/roypZnRBF18nXzd/BxLlseYD+wVomQK12bgkhvilNObBbPnNpn7A015q7RvcFTwxutDgqf/MSB45M/9gicf3yP41/ODgsG9o4J8Nzjq6KkC/xX49W+0Cj5txiHfOOwJ5ADkBOQI5AzUANQEynMDXzc0hDyXFTyt5IYoODO7sCIKlMwQHZ31gtPOaBGEVbd7937B/b9/R7DiyrcFG9b0CO6+o0/w4B/7Bb/7zTuCn/+0V/D95W8JfnFrr+Dtt4YFYfseP6fJ3BnNXr14NYbNJyawB7AnkAOQE5AjkDNQA1ATUCNQM4Tti4aAphA2v9DzJTNEoQnZdZVVoGSGmDuvSRD2Kf2F5wYFN1y7Q/DXR/cIhvZ5gnzl2T8iwfPPDgrWXLdT8PdtA4J84wTNIwYQE9gD2BOC1uWOUxNQI1AzoAHkzvePfR3RFPzxuJ9LZoi4E7XxyqNAyQxx9GfNzxYMQWXseHtE8MvbegVDQ+aKYAiaH3V81PxwH+69p0/w7D/3CqLGee6ZvQJiADEhapyg+X7daABoAkHz+bkJBJ0vdrxkhig2Mbu+MgrEboimJlcwdaorCCrrqa17BMPDEgTNK3bc82Ruxkr33LE7w4v/GdSLhrC4L5k5cPft5m83Bj9O2LpCz6MBoAkExZnaaHQ1oDEEzSt0PHZDFJqIXVcdCsRuCH6bCMLK6zP3HSBsXlznefXBww+9JwiLu9nMg+Fhz1zBzGUmbEFM59EEwsKhMYTNi3o+dkNETcDOry4FrCGqqx8Vz8YaouItqK4ErCGqqx8Vz8YaouItqK4EymeI6qrbZhOggDVEgDBpHbaGSGvnA+q2hggQJq3D1hBp7XxA3dYQAcKkddgaIq2dD6jbGiJAmOQOT16ZNcTk+qTurDVE6lo+ecHWEJPrk7qz1hCpa/nkBVtDTK5P6s5aQ6Su5ZMXbA0xuT6pO2sNUbaW18ZG1hC10aeyZWkNUTapa2Mja4ja6FPZsrSGKJvUtbGRNURt9KlsWVpDlE3q2tjIGqI2+lS2LFNgiLJpmYiNrCES0cb4irCGiE/LRESyhkhEG+MrwhoiPi0TEanqDVFXp8z3WrS1uYLOQ+sF01pdQbV1gZyAHKHV5AmuURqqLd/cfEyauUP2OM0KVI0hZh3eIDjrq9MEl1/ZLlhzU6fgmutmCi6/Yrpg5fUzBas3dAiuWDFdcPa50wSHHtYgiLu5xAT2APYEcgByAnKEFSZP4Bwsu6pdcOaXWwQfm9UgiDvPQuOV0BCFpmTXVVKBihniyI9/RHDJ4o8KFi1tF5x8arOg85AGQZg4fF8VtE+vF8yd1yxYsrxdwKsRPnPMAYKweLnnWQPLrjavbAMxgT2APYEcIHe9f+y6jmBmZ4PglC+0CC5d1i5AA5h1xBSBKvSomCEqVK/dNkSBihlizolNAq4SEJJnwad5NcJFFx8kOPMr5r3bEBbQn8ca8L93M2xdoefRAE48uVlQaJxi11XMEMUmbteXRoHUGeKIIz8iCJOTORA2L2nnU2eIpDUw7nqq1hB8ZwRseeQ9wb139wluu7VX8Ntf9wke3dwv6O4aFsQtUFg89gS+gQ/ICfg+Ltj0qz4BNcDOHSOCsLgxno8UqmoNEakKOzk2BWI3xMiIJ4ia4asv7xNsXN8jWHXtDsGf7ntX8LdtA4IXnh0UbHtiQPDA/f0CvgcL1q/eKeD7sCBqHmHziQnsAewJfAMfkBMwB57aOiCgBvjRD3YIblnXI3jtv0OCsH1zz5fqX+mP3RC5idvj2lLA3D9z+h05/XGlvbt3v2BXz4ggKO6+wVEB77dwy/pdgldeHhIErQsbf/ONYQHv33Dnbb2C/v79grD1uedZA8QAYgJ7QO78fI9ffWVIcPONPQI+Z4D/HVxBcXp2jgjQGILmRR3HA2CvEFGVS/h8V47XnSGmQv3vpuJVBP97Y0jA5wp45aV9gnWrewS830JM208I88zTg4J1q3YKeneNCCZMzBlgDrAGiAE502I75HMG8LkEXh37TIVm8KbREW7/Wa8gto39QGM+cP1j+2wVQAHXk9MFHMRJd9eIuS8wkrkKcCVYtqhbsHHDLgH3GCDOPSeL1dc3Klh7w07B668NCXLXMAZrzRUFWAO58/I4LmjKW90jAj5PAZrBenNFBV/XgoJPsggPgL1CTCJSGk+5jqc3IS3FD+zxBDf9uEewZGGXPghjMDBg5hnSogseAHuFSEvH86zTdRw9DHnOt9OSqoCrzTLYK0RSG1xgXW5DS+MD4DjOCBQYxy6rUQXoOUxpbnwQ7BWiRhtZqrTdVavadoM8PZ6hVDuVL67dKYoCY33HA2CvEFHES8HccUN4jm6GFNRsS/yAAvQc/KFxQ/gD9jndCowbYt0tnX8AR3oS0i1L8qunx0DPwa943BD+gH1OtwITDFHnahmkW5bkV0+PIbfSCYbInWCP06XABEOs+ckhW0FyNmRRvg87ryYUyPaVHkNuyhMMkTvBHqdLgUBDHD+v4zJwHGczpEuW5FVLD4GeQlCFgYYIWmDHk61AoCHmz3f2w7SGqfNBcv6dRfZRUwpk+0YPgZ5CUAmBhghaYMeTrUCoIVauP7APWqdMnQ28D0GyZan96ugR0DOghxBWWaghwgLY89WnQDEZ5W0I3AXHndhxBsjep1B1PpzM/SN6BPQM8s01b0PkG9DOq20FIhuCT6iwbmPnpVDvag7wkzOobTlqL3s0B3oA9AToEUStKLIhom5g59eWAkUbgvvhsHbjISeAHOdr4Mh5LIP9be5YHOGM6ZjR1GiLxoDmQA+g2M2KNkSxCdj11aVA7Ibgt29g7cbOk2FKS+N0cB3nAjCuvmuMLeZ5i+PoJTB/fi9DdelT+mwcJ1M3GoDRIKOLec7ohGaAhoCmgMYQd4KxGyLuBGspXhJy/T8AAAD//wBoU5kAAAAGSURBVAMAmqk9Ul27dCcAAAAASUVORK5CYII=`,
  _e = `data:image/png;base64,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`,
  ve = `data:image/png;base64,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`,
  ye = `data:image/png;base64,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`,
  be = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/parameter-extractor-icon-l9LxNWcG.png`,
  xe = `data:image/png;base64,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`,
  Se = `data:image/png;base64,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`,
  Ce = `data:image/png;base64,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`,
  we = `data:image/png;base64,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`,
  Te = `https://ai-copilot.cos.clife.cn/web-agent-paas/assets/images/workflow-icon-CXgiFgat.png`,
  Ee = {
    [A.StartNode]: ce,
    [A.EndNode]: se,
    [A.AgentNode]: ae,
    [A.LLMNode]: ve,
    [A.KnowlEdgeNode]: ge,
    [A.ApiNode]: le,
    [A.CodeNode]: Se,
    [A.TextNode]: pe,
    [A.PluginNode]: xe,
    [A.RuleNode]: ue,
    [A.MCPNode]: _e,
    [A.MultiAgentNode]: ae,
    [A.ParameterExtractorNode]: be,
    [A.WorkflowNode]: Te,
    [A.IntentNode]: me,
    [A.VariableProcessNode]: we,
    [A.VariableAssignNode]: Ce,
    [A.IteratorNode]: he,
    [A.ParallelNode]: ye,
    [A.ContainerNode]: de,
    [A.ExecuteConfirmNode]: fe,
    [A.ImageGenerationNode]: ve,
  };
function De(e) {
  return e ? Ee[e] : oe;
}
var Oe = {
    [A.StartNode]: `开始`,
    [A.EndNode]: `结束`,
    [A.AgentNode]: `智能体`,
    [A.LLMNode]: `大模型`,
    [A.KnowlEdgeNode]: `知识库`,
    [A.ApiNode]: `API`,
    [A.CodeNode]: `脚本`,
    [A.TextNode]: `流程输出`,
    [A.PluginNode]: `常规插件`,
    [A.RuleNode]: `条件判断`,
    [A.MCPNode]: `MCP`,
    [A.MultiAgentNode]: `多智能体`,
    [A.WorkflowNode]: `工作流`,
    [A.IntentNode]: `意图识别`,
    [A.VariableProcessNode]: `变量处理`,
    [A.VariableAssignNode]: `变量赋值`,
    [A.ParameterExtractorNode]: `参数提取`,
    [A.IteratorNode]: `循环`,
    [A.ParallelNode]: `批处理`,
    [A.ContainerNode]: `并行`,
    [A.ExecuteConfirmNode]: `执行确认`,
    [A.ImageGenerationNode]: `图片生成`,
  },
  ke = {
    [A.StartNode]: `组件运行的起点，定义此组件所需的输入参数`,
    [A.EndNode]: `输出参数配置`,
    [A.AgentNode]: `对话场景中回复用户问题的智能体`,
    [A.LLMNode]: `调用大语言模型，使用变量和提示词生成回复`,
    [A.KnowlEdgeNode]: `支持专业知识的检索，建议关联大模型使用`,
    [A.ApiNode]: `配置并调用外部API服务`,
    [A.CodeNode]: `编写代码，处理输入变量来生成返回值`,
    [A.TextNode]: `将流程的中间信息输出`,
    [A.PluginNode]: `用于拓展应用能力，执行外部操作`,
    [A.RuleNode]: `通过逻辑规则的设定，实现规则的调度`,
    [A.MCPNode]: `用于调用MCP协议服务`,
    [A.MultiAgentNode]: `编排多个智能体协同工作，实现复杂的任务流程`,
    [A.WorkflowNode]: `引用其他工作流，实现更复杂的业务逻辑`,
    [A.IntentNode]: `大模型调度，根据设定进行判断执行`,
    [A.VariableProcessNode]: `对变量采用多种方法处理`,
    [A.VariableAssignNode]: `对变量进行赋值`,
    [A.ParameterExtractorNode]: `通过模型提取结构化参数`,
    [A.IteratorNode]: `通过在画布中设定逻辑并配置规则，重复执行一系列任务`,
    [A.ParallelNode]: `并行批量处理特定任务`,
    [A.ContainerNode]: `并行执行多个任务分支`,
    [A.ExecuteConfirmNode]: `需前端用户确认执行分支后，才可继续后续流程`,
    [A.ImageGenerationNode]: `通过文字描述/添加参考图生成图片`,
  };
function Ae() {
  let { nodesNameMap: e } = j.getState();
  return e && Object.keys(e).length > 0 ? { ...Oe, ...e } : Oe;
}
function je() {
  let { nodesDescMap: e } = j.getState();
  return e && Object.keys(e).length > 0 ? { ...ke, ...e } : ke;
}
function Me(e) {
  return Ae()[e] || ``;
}
var Ne = {
    [A.StartNode]: `Start`,
    [A.EndNode]: `End`,
    [A.AgentNode]: `Agent`,
    [A.LLMNode]: `Llm`,
    [A.KnowlEdgeNode]: `Knowledge`,
    [A.ApiNode]: `Api`,
    [A.CodeNode]: `Code`,
    [A.TextNode]: `Text`,
    [A.PluginNode]: `Plugin`,
    [A.RuleNode]: `Rule`,
    [A.MCPNode]: `MCP`,
    [A.MultiAgentNode]: `Multiagent`,
    [A.WorkflowNode]: `Workflow`,
    [A.IntentNode]: `Intent`,
    [A.VariableProcessNode]: `Variableprocess`,
    [A.VariableAssignNode]: `Variableassign`,
    [A.ParameterExtractorNode]: `Parameterextractor`,
    [A.IteratorNode]: `Iterator`,
    [A.ParallelNode]: `Parallel`,
    [A.ContainerNode]: `Container`,
    [A.ExecuteConfirmNode]: `Executeconfirm`,
    [A.ImageGenerationNode]: `Imagegeneration`,
  },
  Pe = {
    base: `基础`,
    interaction: `交互`,
    tool: `工具`,
    logic: `逻辑`,
    variable: `变量`,
    system: `系统`,
    image: `图像处理`,
  },
  Fe = () => {
    let { nodeConfigList: e } = j.getState(),
      t = Ae(),
      n = je();
    if (!e || e.length === 0) return [];
    let r = {};
    return (
      e.forEach((e) => {
        let i = e.group || `base`,
          a = e.code;
        [A.StartNode, A.EndNode].includes(a) ||
          (r[i] || (r[i] = []),
          r[i].push({
            compName: e.name || t[a] || ``,
            description: e.desc || n[a] || ``,
            nodeType: a,
            icon: De(a),
          }));
      }),
      [`base`, `interaction`, `tool`, `logic`, `variable`, `system`, `image`]
        .filter((e) => r[e] && r[e].length > 0)
        .map((e) => ({ key: e, title: Pe[e] || e, nodes: r[e] }))
    );
  },
  Ie = [
    {
      paramCode: `content`,
      paramType: `String`,
      paramName: `文本输出`,
      paramId: `AFAD6221-7D83-4E1D-890A-5FF347AC7E44`,
    },
    {
      paramCode: `reasoningContent`,
      paramType: `String`,
      paramName: `深度思考`,
      paramId: `989F2542-76A6-4E1D-837D-8EEE5A421724`,
    },
  ],
  Le = [
    {
      paramCode: `thought`,
      paramType: `String`,
      paramName: `思考过程`,
      paramId: `C9F43F21-044B-4763-98AC-270C75686E3A`,
    },
    {
      paramCode: `subject`,
      paramType: `String`,
      paramName: `命中主题`,
      paramId: `543338BD-955F-4680-9AB7-3157F74E016A`,
    },
  ],
  Re = [
    {
      paramCode: `code`,
      paramType: `String`,
      paramName: `状态码`,
      paramId: `D70A1A8E-8160-4F0C-B9C5-E0DE9240BF52`,
    },
    {
      paramCode: `data`,
      paramType: `Object`,
      paramName: `数据`,
      paramId: `5938CCDF-9A5F-44E3-92BD-EC29B6FEBF76`,
      children: [
        {
          paramCode: `docs_count`,
          paramType: `Number`,
          paramName: `文档数量`,
          paramId: `B1CB5282-6C4A-4157-9192-8BD95808B7C1`,
        },
        {
          paramCode: `docs_list`,
          paramType: `Array`,
          paramName: `文档列表`,
          paramId: `913A4D93-88CA-40C8-BDC6-4001867BEE9B`,
        },
        {
          paramCode: `doc_score`,
          paramType: `Number`,
          paramName: `文档评分`,
          paramId: `913A4D93-88CA-40C8-BDC6-4001867BEE3C`,
        },
        {
          paramCode: `doc_attribute`,
          paramType: `Object`,
          paramName: `文档属性`,
          paramId: `68745A2F-5EF5-4D95-829A-D1E3EBE7DFCB`,
        },
      ],
    },
    {
      paramCode: `msg`,
      paramType: `String`,
      paramName: `消息`,
      paramId: `5E73DE49-2AE2-4A9B-AA2C-065D04EDBF5F`,
    },
  ],
  ze = [
    {
      paramCode: `urls`,
      paramType: `Array<String>`,
      paramName: `生成文件的URL`,
      paramId: `A1B2C3D4-5E6F-7890-ABCD-EF1234567890`,
    },
    {
      paramCode: `id`,
      paramType: `String`,
      paramName: `ID`,
      paramId: `C3D4E5F6-7A8B-9012-CDEF-123456789012`,
    },
  ],
  Be = `# 定义一个 main 函数，传入 params 参数。params 中包含了节点配置的输入变量。
# 需要定义一个字典作为输出变量
# 运行环境 Python3；预置 Package：NumPy

def main(params):

    # 创建一个字典作为输出变量
    output_object ={
    
        # 引用节点定义的 city 变量
        "key0": params['city'],
        
        # 引用节点定义的 weather，city 和 days 变量
        # 拼接为字符串赋值到 ”key1“ 
        "key1": "it will " + params['weather'] + " in " + params['city'] + " in the next " + str(params['days']) + " days",
        
        # 为 “key2” 赋值一个浮点列表
        "key2": [1.1, 2.1, 3.0],

        # 为 “key3" 赋值一个字典，包含多种类型数据
        "key3": {
            "key3_1": "text",
            "key3_2": 12.88,
            "key3_3": ["word1","word2"],
            "key3_4": {
                "key3_4_1": "text"
            }
        }
    }
    
    # 返回输出字典类型变量 output_object，包含代码节点所需的输出数据
    return output_object`,
  Ve = Object.fromEntries(d.map(({ value: e, label: t }) => [e, t])),
  He = {
    [u.RELEASED]: { backgroundColor: `#E6FFFB`, color: `#08979C` },
    [u.UNDER_REVIEW]: { backgroundColor: `#FFF7E6`, color: `#D46B08` },
    [u.REJECTED]: { backgroundColor: `#FFF1F0`, color: `#D32029` },
    [u.NOT_RELEASED]: { backgroundColor: `#E9EBF2`, color: `#9296A6` },
  },
  Ue = { backgroundColor: `#E6F4FF`, color: `#0958D9` },
  We = {
    1: `Number`,
    2: `String`,
    3: `Boolean`,
    4: `Array<Object>`,
    5: `Object`,
  };
o();
var Ge = { 1: `Number`, 2: `String`, 3: `Boolean`, 4: `Array`, 5: `Object` },
  Ke = {
    文本: `String`,
    数字: `Number`,
    布尔: `Boolean`,
    对象: `Object`,
    数组: `Array`,
  },
  qe = (e) => {
    if (typeof e == `string` && e) return e.startsWith(`Array`) ? `Array` : e;
    if (typeof e == `number`) return Ge[e] || `String`;
  },
  Je = (e) => {
    if (typeof e == `string` && e) return e;
    if (typeof e == `number`) return Ge[e] || `String`;
  },
  Ye = (e, t) => {
    if (!e || !t || t.length === 0) return !0;
    for (let n of t) if (e === n || e.startsWith(n + `<`)) return !0;
    return !1;
  },
  Xe = (e) => {
    if (e.valueFrom === `refer`) return `String`;
    if (e.valueFrom === `input` && e.type) {
      let t = String(e.type),
        n = t.match(/^Array<(\w+)>$/);
      if (n && n[1]) return n[1];
      if ([`String`, `Number`, `Boolean`, `Object`, `Array`].includes(t))
        return t;
    }
    return `String`;
  },
  Ze = (e) => Ke[e] || `String`,
  Qe = (e, t) =>
    (0, R.jsxs)(`span`, {
      style: {
        display: `flex`,
        justifyContent: `space-between`,
        alignItems: `center`,
        minWidth: 160,
      },
      children: [
        (0, R.jsx)(`span`, {
          style: { flex: 1, minWidth: 0 },
          children: e || `未命名变量`,
        }),
        t
          ? (0, R.jsx)(s, {
              style: {
                marginLeft: 12,
                padding: `0 8px`,
                borderRadius: 6,
                height: 20,
                lineHeight: `20px`,
              },
              children: (0, R.jsx)(`span`, {
                style: { color: `rgba(0, 0, 0, 0.65)`, fontSize: 12 },
                children: t,
              }),
            })
          : null,
      ],
    }),
  $e = (e) => {
    if (typeof e == `string` || typeof e == `number`) return String(e);
    if (M.isValidElement(e)) {
      let { children: t } = e.props;
      if (typeof t == `string` || typeof t == `number`) return String(t);
      if (Array.isArray(t)) {
        let e = t.find((e) => typeof e == `string` || typeof e == `number`);
        if (e !== void 0) return String(e);
        let n = t.find((e) => M.isValidElement(e));
        if (n) return $e(n.props?.children);
      }
    }
    return ``;
  },
  et = (e) => e?.key ?? e?.value ?? e?.paramCode,
  tt = (e) => {
    if (!e) return [];
    let t = e?.properties || e?.children,
      n = Array.isArray(t) ? t : [];
    return n.length > 0 && n.some((e) => e?.paramCode && !e?.key) ? it(n) : n;
  },
  nt = new Set([`root`, `result`]),
  rt = (e) => {
    if (!e) return [];
    if (Array.isArray(e)) {
      if (e.length === 1 && nt.has(String(et(e[0]) || ``))) {
        let t = e[0];
        console.log(
          `%c [ rootParam ]-127`,
          `font-size:13px; background:pink; color:#bf2c9f;`,
          t,
        );
        let n = tt(t);
        return t?.type || t?.paramType ? e : n;
      }
      return e;
    }
    if (nt.has(String(et(e) || ``))) {
      let t = tt(e);
      return e?.type || e?.paramType ? [e] : t;
    }
    return Array.isArray(e) ? e : [e];
  },
  it = (e) =>
    Array.isArray(e)
      ? e.map((e) => {
          let t = {
            key: e.paramCode || e.key,
            type: Ze(e.paramType || e.type || `文本`),
          };
          return (
            e.paramName && (t.paramName = e.paramName),
            e.children &&
              Array.isArray(e.children) &&
              e.children.length > 0 &&
              (t.properties = it(e.children)),
            t
          );
        })
      : [],
  at = (e, t) => (!e || !t.length ? `` : `\${${e}.result.${t.join(`.`)}}`),
  ot = (e) => (e ? `\${sys.${e}}` : ``),
  st = (e) => (e ? `\${session.${e}}` : ``),
  ct = (e) => {
    if (!e || typeof e != `string`) return null;
    let t = e.match(/^\$\{session\.([^{}]+)\}$/);
    if (t) return { type: `session`, variableName: t[1] };
    let n = e.match(/^\$\{sys\.([^{}]+)\}$/);
    if (n) return { type: `builtin`, code: n[1] };
    let r = e.match(/^\$\{([^.\s{}]+)\.index\}$/);
    if (r)
      return {
        type: `node`,
        nodeId: r[1],
        pathSegments: [`index`],
        isSpecialVariable: !0,
        specialType: `index`,
      };
    let i = e.match(/^\$\{([^.\s{}]+)\.([^.\s{}]+)\}$/);
    if (i) {
      let [, e, t] = i;
      if (t !== `result` && t !== `index`)
        return {
          type: `node`,
          nodeId: e,
          pathSegments: [t],
          isSpecialVariable: !0,
          specialType: `intermediateOrItem`,
        };
    }
    let a = e.match(/^\$\{([^.\s{}]+)\.result\}$/);
    if (a) {
      let [, e] = a;
      return { type: `node`, nodeId: e, pathSegments: [] };
    }
    let o = e.match(/^\$\{([^.\s{}]+)\.result\.(.+)\}$/);
    if (!o) return null;
    let [, s, c] = o;
    return !s || !c
      ? null
      : { type: `node`, nodeId: s, pathSegments: c.split(`.`).filter(Boolean) };
  },
  lt = (e, t, n = []) =>
    Array.isArray(e)
      ? e.reduce((e, r) => {
          if (!r) return e;
          let i = r?.value,
            a = r.key || i;
          if (!a) return e;
          let o = r.type,
            s = qe(o),
            c = Je(o),
            l = [...n, a],
            u = r.properties || r?.children;
          return (
            e.push({
              label: Qe(r.key || r?.paramName || `未命名变量`, s),
              value: a,
              children: lt(u, t, l),
              nodeId: t,
              path: l,
              isLeaf: !u || u.length === 0,
              type: `node`,
              typeLabel: s,
              fullType: c,
            }),
            e
          );
        }, [])
      : [],
  ut = [
    { key: `isSuccess`, type: `Boolean`, desc: `执行是否成功`, properties: [] },
    {
      key: `errorBody`,
      type: `Object`,
      desc: `运行时的报错信息`,
      properties: [
        {
          key: `errorMessage`,
          type: `String`,
          desc: `运行时报错描述`,
          properties: [],
        },
        {
          key: `errorCode`,
          type: `String`,
          desc: `运行时报错Code`,
          properties: [],
        },
      ],
    },
  ],
  dt = [
    {
      paramCode: `isSuccess`,
      paramType: `Boolean`,
      paramName: `执行是否成功`,
      paramId: `EXCEPTION-IS-SUCCESS`,
    },
    {
      paramCode: `errorBody`,
      paramType: `Object`,
      paramName: `运行时的报错信息`,
      paramId: `EXCEPTION-ERROR-BODY`,
      children: [
        {
          paramCode: `errorMessage`,
          paramType: `String`,
          paramName: `运行时报错描述`,
          paramId: `EXCEPTION-ERROR-MESSAGE`,
        },
        {
          paramCode: `errorCode`,
          paramType: `String`,
          paramName: `运行时报错Code`,
          paramId: `EXCEPTION-ERROR-CODE`,
        },
      ],
    },
  ],
  ft = [
    { key: `isSuccess`, type: `Boolean`, desc: `执行是否成功` },
    {
      key: `errorBody`,
      type: `Object`,
      desc: `运行时的报错信息`,
      children: [
        { key: `errorMessage`, type: `String`, desc: `运行时报错描述` },
        { key: `errorCode`, type: `String`, desc: `运行时报错Code` },
      ],
    },
  ],
  pt = (e, t) =>
    !!(e && t && (t === `SKIP` || t === `EXECUTE_EXCEPTION_BRANCH`)),
  mt = (e, t, n) => {
    if (!pt(t, n?.strategy)) return e;
    let r = [...e],
      i = r.some((e) => e.key === `isSuccess`),
      a = r.some((e) => e.key === `errorBody`);
    return (
      i || r.push({ ...ut[0], _isExceptionField: !0 }),
      a || r.push({ ...ut[1], _isExceptionField: !0 }),
      r
    );
  },
  ht = (e, t, n, r = `paramCode`) => {
    if (!pt(t, n?.strategy)) return e;
    let i = [...(e || [])],
      a = r === `key` ? ft : dt,
      o = r === `key` ? `key` : `paramCode`,
      s = i.some((e) => e[o] === `isSuccess` || e.key === `isSuccess`),
      c = i.some((e) => e[o] === `errorBody` || e.key === `errorBody`);
    return (s || i.push(a[0]), c || i.push(a[1]), i);
  },
  gt = (e) =>
    e
      .map((e) =>
        e.key === `isSuccess` || e.key === `errorBody`
          ? { ...e, _isExceptionField: !0 }
          : e,
      )
      .filter((e) => !e._isExceptionField),
  _t = [`isSuccess`, `errorBody`],
  vt = (e, t, n) => {
    let r = ht(e, t?.exceptionEnable, t?.exceptionConfig),
      i = (e, t = []) => {
        let r = e.paramType || e.type,
          a = [...t, e.paramCode],
          o = e.children?.length ? e.children.map((e) => i(e, a)) : void 0;
        return {
          label: Qe(e.paramName || e.paramCode, qe(r)),
          value: e.paramCode,
          nodeId: n,
          path: a,
          isLeaf: !o?.length,
          type: `node`,
          typeLabel: qe(r),
          fullType: Je(r),
          children: o,
        };
      };
    return r.map((e) => i(e));
  },
  yt = (e, t) => {
    let n = e?.outParams;
    if (
      ((!n || !Array.isArray(n) || n.length === 0) && (n = []),
      e?.exceptionEnable &&
        e?.exceptionConfig?.strategy &&
        (e.exceptionConfig.strategy === `SKIP` ||
          e.exceptionConfig.strategy === `EXECUTE_EXCEPTION_BRANCH`))
    ) {
      n = [...n];
      let e = n.some((e) => e.key === `isSuccess`),
        t = n.some((e) => e.key === `errorBody`);
      (e || n.push({ key: `isSuccess`, type: `Boolean`, desc: `执行是否成功` }),
        t ||
          n.push({
            key: `errorBody`,
            type: `Object`,
            desc: `运行时的报错信息`,
            properties: [
              { key: `errorMessage`, type: `String`, desc: `运行时报错描述` },
              { key: `errorCode`, type: `String`, desc: `运行时报错Code` },
            ],
          }));
    }
    if (!n || n.length === 0) return [];
    n.some((e) => e?.paramCode && !e?.key) && (n = it(n));
    let r = rt(n);
    return r?.length ? lt(r, t) : [];
  },
  bt = (e, t) => {
    let n = e?.outputParams;
    if (
      ((!n || !Array.isArray(n) || n.length === 0) && (n = []),
      (n = mt(n, e?.exceptionEnable, e?.exceptionConfig)),
      !n || n.length === 0)
    )
      return [];
    n.some((e) => e?.paramCode && !e?.key) && (n = it(n));
    let r = rt(n);
    return r?.length ? lt(r, t) : [];
  },
  xt = {
    1: `Number`,
    2: `String`,
    3: `Boolean`,
    4: `Array<Object>`,
    5: `Object`,
  },
  St = (e) => (e && xt[e]) || `String`,
  Ct = (e) =>
    e
      ? Array.isArray(e)
        ? e
        : Array.isArray(e?.list)
          ? e.list
          : Array.isArray(e?.inParams)
            ? e.inParams
            : Array.isArray(e?.outParams)
              ? e.outParams
              : Array.isArray(e?.children)
                ? e.children
                : Array.isArray(e?.data)
                  ? e.data
                  : []
      : [],
  wt = (e) => {
    if (!Array.isArray(e)) return ``;
    let t = e.find((e) => e?.type === 1 || e?.value === 1);
    return !t || t.defaultValue === void 0 || t.defaultValue === null
      ? ``
      : String(t.defaultValue);
  },
  Tt = (e) => {
    let t = Ct(e);
    return t.length
      ? t
          .map((e, t) => {
            if (!e) return null;
            let n = e.paramCode || e.paramName || `param_${t + 1}`;
            return n
              ? {
                  desc: e.paramName,
                  key: n,
                  value: wt(e.typeList),
                  valueFrom: `input`,
                  type: St(e.paramType),
                }
              : null;
          })
          .filter(Boolean)
      : [];
  },
  Et = (e) => {
    let t = Dt(e);
    return t.length ? t : void 0;
  },
  Dt = (e) => {
    let t = Ct(e);
    return t.length
      ? t
          .map((e, t) => {
            if (!e) return null;
            let n = e.paramCode || e.paramName || `result_${t + 1}`;
            return n
              ? {
                  key: n,
                  type: St(e.paramType),
                  desc: e.paramName || e.paramDesc,
                  properties: Et(e.children),
                }
              : null;
          })
          .filter(Boolean)
      : [];
  },
  Ot = (e, t) => {
    let n = e?.outputParams;
    n ||= [];
    let r = Dt(n);
    if (
      (r?.length || (r = []),
      (r = mt(r, e?.exceptionEnable, e?.exceptionConfig)),
      !r?.length)
    )
      return [];
    let i = rt(r);
    return i?.length ? lt(i, t) : [];
  },
  kt = (e, t) => {
    let n = e?.outputType || `aggregator`;
    if (n === `text`) return lt([{ key: `text`, type: `String` }], t);
    if (n === `json`) {
      let n = e?.variables;
      if (n?.length) return lt(n, t);
    } else if (n === `aggregator`) {
      let n = e?.advancedSettings || [];
      if (n.length > 0)
        return n.map((e) => {
          let n = e.groupName || e.groupId;
          return {
            label: e.groupName || `分组${e.groupId}`,
            value: n,
            nodeId: t,
            path: [n],
            isLeaf: !0,
            type: `node`,
          };
        });
    }
    return [];
  },
  At = (e, t, n) => {
    switch (e) {
      case A.TextNode:
        return lt([{ key: `text`, type: `String` }], n);
      case A.VariableProcessNode:
        return kt(t, n);
      case A.LLMNode:
        return vt(Ie, t, n);
      case A.IntentNode:
        return vt(Le, t, n);
      case A.PluginNode:
        return Ot(t, n);
      case A.StartNode:
      case A.KnowlEdgeNode:
      case A.ApiNode:
      case A.CodeNode:
      case A.ParameterExtractorNode:
      case A.MCPNode:
      case A.ParallelNode:
      case A.ContainerNode:
      case A.ExecuteConfirmNode:
      case A.IteratorNode:
        return bt(t, n);
      case A.ImageGenerationNode:
        return vt(ze, t, n);
      case A.WorkflowNode:
        return yt(t, n);
      case A.EndNode:
      case A.VariableAssignNode:
      case A.RuleNode:
      default:
        return [];
    }
  },
  q = {
    error001: () =>
      `[React Flow]: Seems like you have not used zustand provider as an ancestor. Help: https://reactflow.dev/error#001`,
    error002: () =>
      `It looks like you've created a new nodeTypes or edgeTypes object. If this wasn't on purpose please define the nodeTypes/edgeTypes outside of the component or memoize them.`,
    error003: (e) =>
      `Node type "${e}" not found. Using fallback type "default".`,
    error004: () =>
      `The React Flow parent container needs a width and a height to render the graph.`,
    error005: () => `Only child nodes can use a parent extent.`,
    error006: () => `Can't create edge. An edge needs a source and a target.`,
    error007: (e) => `The old edge with id=${e} does not exist.`,
    error009: (e) => `Marker type "${e}" doesn't exist.`,
    error008: (e, { id: t, sourceHandle: n, targetHandle: r }) =>
      `Couldn't create edge for ${e} handle id: "${e === `source` ? n : r}", edge id: ${t}.`,
    error010: () =>
      `Handle: No node id found. Make sure to only use a Handle inside a custom Node.`,
    error011: (e) =>
      `Edge type "${e}" not found. Using fallback type "default".`,
    error012: (e) =>
      `Node with id "${e}" does not exist, it may have been removed. This can happen when a node is deleted before the "onNodeClick" handler is called.`,
    error013: (e = `react`) =>
      `It seems that you haven't loaded the styles. Please import '@xyflow/${e}/dist/style.css' or base.css to make sure everything is working properly.`,
    error014: () =>
      `useNodeConnections: No node ID found. Call useNodeConnections inside a custom Node or provide a node ID.`,
    error015: () =>
      `It seems that you are trying to drag a node that is not initialized. Please use onNodesChange as explained in the docs.`,
  },
  jt = [
    [-1 / 0, -1 / 0],
    [1 / 0, 1 / 0],
  ],
  Mt = [`Enter`, ` `, `Escape`],
  Nt = {
    "node.a11yDescription.default": `Press enter or space to select a node. Press delete to remove it and escape to cancel.`,
    "node.a11yDescription.keyboardDisabled": `Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel.`,
    "node.a11yDescription.ariaLiveMessage": ({ direction: e, x: t, y: n }) =>
      `Moved selected node ${e}. New position, x: ${t}, y: ${n}`,
    "edge.a11yDescription.default": `Press enter or space to select an edge. You can then press delete to remove it or escape to cancel.`,
    "controls.ariaLabel": `Control Panel`,
    "controls.zoomIn.ariaLabel": `Zoom In`,
    "controls.zoomOut.ariaLabel": `Zoom Out`,
    "controls.fitView.ariaLabel": `Fit View`,
    "controls.interactive.ariaLabel": `Toggle Interactivity`,
    "minimap.ariaLabel": `Mini Map`,
    "handle.ariaLabel": `Handle`,
  },
  Pt;
(function (e) {
  ((e.Strict = `strict`), (e.Loose = `loose`));
})((Pt ||= {}));
var Ft;
(function (e) {
  ((e.Free = `free`), (e.Vertical = `vertical`), (e.Horizontal = `horizontal`));
})((Ft ||= {}));
var It;
(function (e) {
  ((e.Partial = `partial`), (e.Full = `full`));
})((It ||= {}));
var Lt = {
    inProgress: !1,
    isValid: null,
    from: null,
    fromHandle: null,
    fromPosition: null,
    fromNode: null,
    to: null,
    toHandle: null,
    toPosition: null,
    toNode: null,
    pointer: null,
  },
  Rt;
(function (e) {
  ((e.Bezier = `default`),
    (e.Straight = `straight`),
    (e.Step = `step`),
    (e.SmoothStep = `smoothstep`),
    (e.SimpleBezier = `simplebezier`));
})((Rt ||= {}));
var zt;
(function (e) {
  ((e.Arrow = `arrow`), (e.ArrowClosed = `arrowclosed`));
})((zt ||= {}));
var J;
(function (e) {
  ((e.Left = `left`),
    (e.Top = `top`),
    (e.Right = `right`),
    (e.Bottom = `bottom`));
})((J ||= {}));
var Bt = {
  [J.Left]: J.Right,
  [J.Right]: J.Left,
  [J.Top]: J.Bottom,
  [J.Bottom]: J.Top,
};
function Vt(e) {
  return e === null ? null : e ? `valid` : `invalid`;
}
var Ht = (e) => `id` in e && `source` in e && `target` in e,
  Ut = (e) =>
    `id` in e && `position` in e && !(`source` in e) && !(`target` in e),
  Wt = (e) =>
    `id` in e && `internals` in e && !(`source` in e) && !(`target` in e),
  Gt = (e, t = [0, 0]) => {
    let { width: n, height: r } = X(e),
      i = e.origin ?? t,
      a = n * i[0],
      o = r * i[1];
    return { x: e.position.x - a, y: e.position.y - o };
  },
  Kt = (e, t = { nodeOrigin: [0, 0] }) =>
    e.length === 0
      ? { x: 0, y: 0, width: 0, height: 0 }
      : cn(
          e.reduce(
            (e, n) => {
              let r = typeof n == `string`,
                i = !t.nodeLookup && !r ? n : void 0;
              return (
                t.nodeLookup &&
                  (i = r
                    ? t.nodeLookup.get(n)
                    : Wt(n)
                      ? n
                      : t.nodeLookup.get(n.id)),
                on(e, i ? un(i, t.nodeOrigin) : { x: 0, y: 0, x2: 0, y2: 0 })
              );
            },
            { x: 1 / 0, y: 1 / 0, x2: -1 / 0, y2: -1 / 0 },
          ),
        ),
  qt = (e, t = {}) => {
    let n = { x: 1 / 0, y: 1 / 0, x2: -1 / 0, y2: -1 / 0 },
      r = !1;
    return (
      e.forEach((e) => {
        (t.filter === void 0 || t.filter(e)) && ((n = on(n, un(e))), (r = !0));
      }),
      r ? cn(n) : { x: 0, y: 0, width: 0, height: 0 }
    );
  },
  Jt = (e, t, [n, r, i] = [0, 0, 1], a = !1, o = !1) => {
    let s = { ...gn(t, [n, r, i]), width: t.width / i, height: t.height / i },
      c = [];
    for (let t of e.values()) {
      let { measured: e, selectable: n = !0, hidden: r = !1 } = t;
      if ((o && !n) || r) continue;
      let i = e.width ?? t.width ?? t.initialWidth ?? null,
        l = e.height ?? t.height ?? t.initialHeight ?? null,
        u = fn(s, ln(t)),
        d = (i ?? 0) * (l ?? 0),
        f = a && u > 0;
      (!t.internals.handleBounds || f || u >= d || t.dragging) && c.push(t);
    }
    return c;
  },
  Yt = (e, t) => {
    let n = new Set();
    return (
      e.forEach((e) => {
        n.add(e.id);
      }),
      t.filter((e) => n.has(e.source) || n.has(e.target))
    );
  };
function Xt(e, t) {
  let n = new Map(),
    r = t?.nodes ? new Set(t.nodes.map((e) => e.id)) : null;
  return (
    e.forEach((e) => {
      e.measured.width &&
        e.measured.height &&
        (t?.includeHiddenNodes || !e.hidden) &&
        (!r || r.has(e.id)) &&
        n.set(e.id, e);
    }),
    n
  );
}
async function Zt(
  { nodes: e, width: t, height: n, panZoom: r, minZoom: i, maxZoom: a },
  o,
) {
  if (e.size === 0) return Promise.resolve(!0);
  let s = xn(
    qt(Xt(e, o)),
    t,
    n,
    o?.minZoom ?? i,
    o?.maxZoom ?? a,
    o?.padding ?? 0.1,
  );
  return (
    await r.setViewport(s, {
      duration: o?.duration,
      ease: o?.ease,
      interpolate: o?.interpolate,
    }),
    Promise.resolve(!0)
  );
}
function Qt({
  nodeId: e,
  nextPosition: t,
  nodeLookup: n,
  nodeOrigin: r = [0, 0],
  nodeExtent: i,
  onError: a,
}) {
  let o = n.get(e),
    s = o.parentId ? n.get(o.parentId) : void 0,
    { x: c, y: l } = s ? s.internals.positionAbsolute : { x: 0, y: 0 },
    u = o.origin ?? r,
    d = o.extent || i;
  if (o.extent === `parent` && !o.expandParent)
    if (!s) a?.(`005`, q.error005());
    else {
      let e = s.measured.width,
        t = s.measured.height;
      e &&
        t &&
        (d = [
          [c, l],
          [c + e, l + t],
        ]);
    }
  else
    s &&
      Cn(o.extent) &&
      (d = [
        [o.extent[0][0] + c, o.extent[0][1] + l],
        [o.extent[1][0] + c, o.extent[1][1] + l],
      ]);
  let f = Cn(d) ? tn(t, d, o.measured) : t;
  return (
    (o.measured.width === void 0 || o.measured.height === void 0) &&
      a?.(`015`, q.error015()),
    {
      position: {
        x: f.x - c + (o.measured.width ?? 0) * u[0],
        y: f.y - l + (o.measured.height ?? 0) * u[1],
      },
      positionAbsolute: f,
    }
  );
}
async function $t({
  nodesToRemove: e = [],
  edgesToRemove: t = [],
  nodes: n,
  edges: r,
  onBeforeDelete: i,
}) {
  let a = new Set(e.map((e) => e.id)),
    o = [];
  for (let e of n) {
    if (e.deletable === !1) continue;
    let t = a.has(e.id),
      n = !t && e.parentId && o.find((t) => t.id === e.parentId);
    (t || n) && o.push(e);
  }
  let s = new Set(t.map((e) => e.id)),
    c = r.filter((e) => e.deletable !== !1),
    l = Yt(o, c);
  for (let e of c) s.has(e.id) && !l.find((t) => t.id === e.id) && l.push(e);
  if (!i) return { edges: l, nodes: o };
  let u = await i({ nodes: o, edges: l });
  return typeof u == `boolean`
    ? u
      ? { edges: l, nodes: o }
      : { edges: [], nodes: [] }
    : u;
}
var en = (e, t = 0, n = 1) => Math.min(Math.max(e, t), n),
  tn = (e = { x: 0, y: 0 }, t, n) => ({
    x: en(e.x, t[0][0], t[1][0] - (n?.width ?? 0)),
    y: en(e.y, t[0][1], t[1][1] - (n?.height ?? 0)),
  });
function nn(e, t, n) {
  let { width: r, height: i } = X(n),
    { x: a, y: o } = n.internals.positionAbsolute;
  return tn(
    e,
    [
      [a, o],
      [a + r, o + i],
    ],
    t,
  );
}
var rn = (e, t, n) =>
    e < t
      ? en(Math.abs(e - t), 1, t) / t
      : e > n
        ? -en(Math.abs(e - n), 1, t) / t
        : 0,
  an = (e, t, n = 15, r = 40) => [
    rn(e.x, r, t.width - r) * n,
    rn(e.y, r, t.height - r) * n,
  ],
  on = (e, t) => ({
    x: Math.min(e.x, t.x),
    y: Math.min(e.y, t.y),
    x2: Math.max(e.x2, t.x2),
    y2: Math.max(e.y2, t.y2),
  }),
  sn = ({ x: e, y: t, width: n, height: r }) => ({
    x: e,
    y: t,
    x2: e + n,
    y2: t + r,
  }),
  cn = ({ x: e, y: t, x2: n, y2: r }) => ({
    x: e,
    y: t,
    width: n - e,
    height: r - t,
  }),
  ln = (e, t = [0, 0]) => {
    let { x: n, y: r } = Wt(e) ? e.internals.positionAbsolute : Gt(e, t);
    return {
      x: n,
      y: r,
      width: e.measured?.width ?? e.width ?? e.initialWidth ?? 0,
      height: e.measured?.height ?? e.height ?? e.initialHeight ?? 0,
    };
  },
  un = (e, t = [0, 0]) => {
    let { x: n, y: r } = Wt(e) ? e.internals.positionAbsolute : Gt(e, t);
    return {
      x: n,
      y: r,
      x2: n + (e.measured?.width ?? e.width ?? e.initialWidth ?? 0),
      y2: r + (e.measured?.height ?? e.height ?? e.initialHeight ?? 0),
    };
  },
  dn = (e, t) => cn(on(sn(e), sn(t))),
  fn = (e, t) => {
    let n = Math.max(
        0,
        Math.min(e.x + e.width, t.x + t.width) - Math.max(e.x, t.x),
      ),
      r = Math.max(
        0,
        Math.min(e.y + e.height, t.y + t.height) - Math.max(e.y, t.y),
      );
    return Math.ceil(n * r);
  },
  pn = (e) => Y(e.width) && Y(e.height) && Y(e.x) && Y(e.y),
  Y = (e) => !isNaN(e) && isFinite(e),
  mn = (e, t) => {},
  hn = (e, t = [1, 1]) => ({
    x: t[0] * Math.round(e.x / t[0]),
    y: t[1] * Math.round(e.y / t[1]),
  }),
  gn = ({ x: e, y: t }, [n, r, i], a = !1, o = [1, 1]) => {
    let s = { x: (e - n) / i, y: (t - r) / i };
    return a ? hn(s, o) : s;
  },
  _n = ({ x: e, y: t }, [n, r, i]) => ({ x: e * i + n, y: t * i + r });
function vn(e, t) {
  if (typeof e == `number`) return Math.floor((t - t / (1 + e)) * 0.5);
  if (typeof e == `string` && e.endsWith(`px`)) {
    let t = parseFloat(e);
    if (!Number.isNaN(t)) return Math.floor(t);
  }
  if (typeof e == `string` && e.endsWith(`%`)) {
    let n = parseFloat(e);
    if (!Number.isNaN(n)) return Math.floor(t * n * 0.01);
  }
  return (
    console.error(
      `[React Flow] The padding value "${e}" is invalid. Please provide a number or a string with a valid unit (px or %).`,
    ),
    0
  );
}
function yn(e, t, n) {
  if (typeof e == `string` || typeof e == `number`) {
    let r = vn(e, n),
      i = vn(e, t);
    return { top: r, right: i, bottom: r, left: i, x: i * 2, y: r * 2 };
  }
  if (typeof e == `object`) {
    let r = vn(e.top ?? e.y ?? 0, n),
      i = vn(e.bottom ?? e.y ?? 0, n),
      a = vn(e.left ?? e.x ?? 0, t),
      o = vn(e.right ?? e.x ?? 0, t);
    return { top: r, right: o, bottom: i, left: a, x: a + o, y: r + i };
  }
  return { top: 0, right: 0, bottom: 0, left: 0, x: 0, y: 0 };
}
function bn(e, t, n, r, i, a) {
  let { x: o, y: s } = _n(e, [t, n, r]),
    { x: c, y: l } = _n({ x: e.x + e.width, y: e.y + e.height }, [t, n, r]),
    u = i - c,
    d = a - l;
  return {
    left: Math.floor(o),
    top: Math.floor(s),
    right: Math.floor(u),
    bottom: Math.floor(d),
  };
}
var xn = (e, t, n, r, i, a) => {
    let o = yn(a, t, n),
      s = (t - o.x) / e.width,
      c = (n - o.y) / e.height,
      l = en(Math.min(s, c), r, i),
      u = e.x + e.width / 2,
      d = e.y + e.height / 2,
      f = t / 2 - u * l,
      p = n / 2 - d * l,
      m = bn(e, f, p, l, t, n),
      h = {
        left: Math.min(m.left - o.left, 0),
        top: Math.min(m.top - o.top, 0),
        right: Math.min(m.right - o.right, 0),
        bottom: Math.min(m.bottom - o.bottom, 0),
      };
    return { x: f - h.left + h.right, y: p - h.top + h.bottom, zoom: l };
  },
  Sn = () =>
    typeof navigator < `u` && navigator?.userAgent?.indexOf(`Mac`) >= 0;
function Cn(e) {
  return e != null && e !== `parent`;
}
function X(e) {
  return {
    width: e.measured?.width ?? e.width ?? e.initialWidth ?? 0,
    height: e.measured?.height ?? e.height ?? e.initialHeight ?? 0,
  };
}
function wn(e) {
  return (
    (e.measured?.width ?? e.width ?? e.initialWidth) !== void 0 &&
    (e.measured?.height ?? e.height ?? e.initialHeight) !== void 0
  );
}
function Tn(e, t = { width: 0, height: 0 }, n, r, i) {
  let a = { ...e },
    o = r.get(n);
  if (o) {
    let e = o.origin || i;
    ((a.x += o.internals.positionAbsolute.x - (t.width ?? 0) * e[0]),
      (a.y += o.internals.positionAbsolute.y - (t.height ?? 0) * e[1]));
  }
  return a;
}
function En(e, t) {
  if (e.size !== t.size) return !1;
  for (let n of e) if (!t.has(n)) return !1;
  return !0;
}
function Dn() {
  let e, t;
  return {
    promise: new Promise((n, r) => {
      ((e = n), (t = r));
    }),
    resolve: e,
    reject: t,
  };
}
function On(e) {
  return { ...Nt, ...(e || {}) };
}
function kn(
  e,
  {
    snapGrid: t = [0, 0],
    snapToGrid: n = !1,
    transform: r,
    containerBounds: i,
  },
) {
  let { x: a, y: o } = Z(e),
    s = gn({ x: a - (i?.left ?? 0), y: o - (i?.top ?? 0) }, r),
    { x: c, y: l } = n ? hn(s, t) : s;
  return { xSnapped: c, ySnapped: l, ...s };
}
var An = (e) => ({ width: e.offsetWidth, height: e.offsetHeight }),
  jn = (e) => e?.getRootNode?.() || window?.document,
  Mn = [`INPUT`, `SELECT`, `TEXTAREA`];
function Nn(e) {
  let t = e.composedPath?.()?.[0] || e.target;
  return t?.nodeType === 1
    ? Mn.includes(t.nodeName) ||
        t.hasAttribute(`contenteditable`) ||
        !!t.closest(`.nokey`)
    : !1;
}
var Pn = (e) => `clientX` in e,
  Z = (e, t) => {
    let n = Pn(e),
      r = n ? e.clientX : e.touches?.[0].clientX,
      i = n ? e.clientY : e.touches?.[0].clientY;
    return { x: r - (t?.left ?? 0), y: i - (t?.top ?? 0) };
  },
  Fn = (e, t, n, r, i) => {
    let a = t.querySelectorAll(`.${e}`);
    return !a || !a.length
      ? null
      : Array.from(a).map((t) => {
          let a = t.getBoundingClientRect();
          return {
            id: t.getAttribute(`data-handleid`),
            type: e,
            nodeId: i,
            position: t.getAttribute(`data-handlepos`),
            x: (a.left - n.left) / r,
            y: (a.top - n.top) / r,
            ...An(t),
          };
        });
  };
function In({
  sourceX: e,
  sourceY: t,
  targetX: n,
  targetY: r,
  sourceControlX: i,
  sourceControlY: a,
  targetControlX: o,
  targetControlY: s,
}) {
  let c = e * 0.125 + i * 0.375 + o * 0.375 + n * 0.125,
    l = t * 0.125 + a * 0.375 + s * 0.375 + r * 0.125;
  return [c, l, Math.abs(c - e), Math.abs(l - t)];
}
function Ln(e, t) {
  return e >= 0 ? 0.5 * e : t * 25 * Math.sqrt(-e);
}
function Rn({ pos: e, x1: t, y1: n, x2: r, y2: i, c: a }) {
  switch (e) {
    case J.Left:
      return [t - Ln(t - r, a), n];
    case J.Right:
      return [t + Ln(r - t, a), n];
    case J.Top:
      return [t, n - Ln(n - i, a)];
    case J.Bottom:
      return [t, n + Ln(i - n, a)];
  }
}
function zn({
  sourceX: e,
  sourceY: t,
  sourcePosition: n = J.Bottom,
  targetX: r,
  targetY: i,
  targetPosition: a = J.Top,
  curvature: o = 0.25,
}) {
  let [s, c] = Rn({ pos: n, x1: e, y1: t, x2: r, y2: i, c: o }),
    [l, u] = Rn({ pos: a, x1: r, y1: i, x2: e, y2: t, c: o }),
    [d, f, p, m] = In({
      sourceX: e,
      sourceY: t,
      targetX: r,
      targetY: i,
      sourceControlX: s,
      sourceControlY: c,
      targetControlX: l,
      targetControlY: u,
    });
  return [`M${e},${t} C${s},${c} ${l},${u} ${r},${i}`, d, f, p, m];
}
function Bn({ sourceX: e, sourceY: t, targetX: n, targetY: r }) {
  let i = Math.abs(n - e) / 2,
    a = n < e ? n + i : n - i,
    o = Math.abs(r - t) / 2;
  return [a, r < t ? r + o : r - o, i, o];
}
function Vn({
  sourceNode: e,
  targetNode: t,
  selected: n = !1,
  zIndex: r = 0,
  elevateOnSelect: i = !1,
  zIndexMode: a = `basic`,
}) {
  return a === `manual`
    ? r
    : (i && n ? r + 1e3 : r) +
        Math.max(
          e.parentId || (i && e.selected) ? e.internals.z : 0,
          t.parentId || (i && t.selected) ? t.internals.z : 0,
        );
}
function Hn({
  sourceNode: e,
  targetNode: t,
  width: n,
  height: r,
  transform: i,
}) {
  let a = on(un(e), un(t));
  return (
    a.x === a.x2 && (a.x2 += 1),
    a.y === a.y2 && (a.y2 += 1),
    fn(
      { x: -i[0] / i[2], y: -i[1] / i[2], width: n / i[2], height: r / i[2] },
      cn(a),
    ) > 0
  );
}
var Un = ({ source: e, sourceHandle: t, target: n, targetHandle: r }) =>
    `xy-edge__${e}${t || ``}-${n}${r || ``}`,
  Wn = (e, t) =>
    t.some(
      (t) =>
        t.source === e.source &&
        t.target === e.target &&
        (t.sourceHandle === e.sourceHandle ||
          (!t.sourceHandle && !e.sourceHandle)) &&
        (t.targetHandle === e.targetHandle ||
          (!t.targetHandle && !e.targetHandle)),
    ),
  Gn = (e, t, n = {}) => {
    if (!e.source || !e.target) return (q.error006(), t);
    let r = n.getEdgeId || Un,
      i;
    return (
      (i = Ht(e) ? { ...e } : { ...e, id: r(e) }),
      Wn(i, t)
        ? t
        : (i.sourceHandle === null && delete i.sourceHandle,
          i.targetHandle === null && delete i.targetHandle,
          t.concat(i))
    );
  };
function Kn({ sourceX: e, sourceY: t, targetX: n, targetY: r }) {
  let [i, a, o, s] = Bn({ sourceX: e, sourceY: t, targetX: n, targetY: r });
  return [`M ${e},${t}L ${n},${r}`, i, a, o, s];
}
var qn = {
    [J.Left]: { x: -1, y: 0 },
    [J.Right]: { x: 1, y: 0 },
    [J.Top]: { x: 0, y: -1 },
    [J.Bottom]: { x: 0, y: 1 },
  },
  Jn = ({ source: e, sourcePosition: t = J.Bottom, target: n }) =>
    t === J.Left || t === J.Right
      ? e.x < n.x
        ? { x: 1, y: 0 }
        : { x: -1, y: 0 }
      : e.y < n.y
        ? { x: 0, y: 1 }
        : { x: 0, y: -1 },
  Yn = (e, t) => Math.sqrt((t.x - e.x) ** 2 + (t.y - e.y) ** 2);
function Xn({
  source: e,
  sourcePosition: t = J.Bottom,
  target: n,
  targetPosition: r = J.Top,
  center: i,
  offset: a,
  stepPosition: o,
}) {
  let s = qn[t],
    c = qn[r],
    l = { x: e.x + s.x * a, y: e.y + s.y * a },
    u = { x: n.x + c.x * a, y: n.y + c.y * a },
    d = Jn({ source: l, sourcePosition: t, target: u }),
    f = d.x === 0 ? `y` : `x`,
    p = d[f],
    m = [],
    h,
    g,
    _ = { x: 0, y: 0 },
    v = { x: 0, y: 0 },
    [, , y, b] = Bn({ sourceX: e.x, sourceY: e.y, targetX: n.x, targetY: n.y });
  if (s[f] * c[f] === -1) {
    f === `x`
      ? ((h = i.x ?? l.x + (u.x - l.x) * o), (g = i.y ?? (l.y + u.y) / 2))
      : ((h = i.x ?? (l.x + u.x) / 2), (g = i.y ?? l.y + (u.y - l.y) * o));
    let e = [
        { x: h, y: l.y },
        { x: h, y: u.y },
      ],
      t = [
        { x: l.x, y: g },
        { x: u.x, y: g },
      ];
    m = s[f] === p ? (f === `x` ? e : t) : f === `x` ? t : e;
  } else {
    let i = [{ x: l.x, y: u.y }],
      o = [{ x: u.x, y: l.y }];
    if (((m = f === `x` ? (s.x === p ? o : i) : s.y === p ? i : o), t === r)) {
      let t = Math.abs(e[f] - n[f]);
      if (t <= a) {
        let r = Math.min(a - 1, a - t);
        s[f] === p
          ? (_[f] = (l[f] > e[f] ? -1 : 1) * r)
          : (v[f] = (u[f] > n[f] ? -1 : 1) * r);
      }
    }
    if (t !== r) {
      let e = f === `x` ? `y` : `x`,
        t = s[f] === c[e],
        n = l[e] > u[e],
        r = l[e] < u[e];
      ((s[f] === 1 && ((!t && n) || (t && r))) ||
        (s[f] !== 1 && ((!t && r) || (t && n)))) &&
        (m = f === `x` ? i : o);
    }
    let d = { x: l.x + _.x, y: l.y + _.y },
      y = { x: u.x + v.x, y: u.y + v.y };
    Math.max(Math.abs(d.x - m[0].x), Math.abs(y.x - m[0].x)) >=
    Math.max(Math.abs(d.y - m[0].y), Math.abs(y.y - m[0].y))
      ? ((h = (d.x + y.x) / 2), (g = m[0].y))
      : ((h = m[0].x), (g = (d.y + y.y) / 2));
  }
  return [
    [
      e,
      { x: l.x + _.x, y: l.y + _.y },
      ...m,
      { x: u.x + v.x, y: u.y + v.y },
      n,
    ],
    h,
    g,
    y,
    b,
  ];
}
function Zn(e, t, n, r) {
  let i = Math.min(Yn(e, t) / 2, Yn(t, n) / 2, r),
    { x: a, y: o } = t;
  if ((e.x === a && a === n.x) || (e.y === o && o === n.y)) return `L${a} ${o}`;
  if (e.y === o) {
    let t = e.x < n.x ? -1 : 1,
      r = e.y < n.y ? 1 : -1;
    return `L ${a + i * t},${o}Q ${a},${o} ${a},${o + i * r}`;
  }
  let s = e.x < n.x ? 1 : -1;
  return `L ${a},${o + i * (e.y < n.y ? -1 : 1)}Q ${a},${o} ${a + i * s},${o}`;
}
function Qn({
  sourceX: e,
  sourceY: t,
  sourcePosition: n = J.Bottom,
  targetX: r,
  targetY: i,
  targetPosition: a = J.Top,
  borderRadius: o = 5,
  centerX: s,
  centerY: c,
  offset: l = 20,
  stepPosition: u = 0.5,
}) {
  let [d, f, p, m, h] = Xn({
    source: { x: e, y: t },
    sourcePosition: n,
    target: { x: r, y: i },
    targetPosition: a,
    center: { x: s, y: c },
    offset: l,
    stepPosition: u,
  });
  return [
    d.reduce((e, t, n) => {
      let r = ``;
      return (
        (r =
          n > 0 && n < d.length - 1
            ? Zn(d[n - 1], t, d[n + 1], o)
            : `${n === 0 ? `M` : `L`}${t.x} ${t.y}`),
        (e += r),
        e
      );
    }, ``),
    f,
    p,
    m,
    h,
  ];
}
function $n(e) {
  return (
    e &&
    !!(e.internals.handleBounds || e.handles?.length) &&
    !!(e.measured.width || e.width || e.initialWidth)
  );
}
function er(e) {
  let { sourceNode: t, targetNode: n } = e;
  if (!$n(t) || !$n(n)) return null;
  let r = t.internals.handleBounds || tr(t.handles),
    i = n.internals.handleBounds || tr(n.handles),
    a = rr(r?.source ?? [], e.sourceHandle),
    o = rr(
      e.connectionMode === Pt.Strict
        ? (i?.target ?? [])
        : (i?.target ?? []).concat(i?.source ?? []),
      e.targetHandle,
    );
  if (!a || !o)
    return (
      e.onError?.(
        `008`,
        q.error008(a ? `target` : `source`, {
          id: e.id,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        }),
      ),
      null
    );
  let s = a?.position || J.Bottom,
    c = o?.position || J.Top,
    l = nr(t, a, s),
    u = nr(n, o, c);
  return {
    sourceX: l.x,
    sourceY: l.y,
    targetX: u.x,
    targetY: u.y,
    sourcePosition: s,
    targetPosition: c,
  };
}
function tr(e) {
  if (!e) return null;
  let t = [],
    n = [];
  for (let r of e)
    ((r.width = r.width ?? 1),
      (r.height = r.height ?? 1),
      r.type === `source` ? t.push(r) : r.type === `target` && n.push(r));
  return { source: t, target: n };
}
function nr(e, t, n = J.Left, r = !1) {
  let i = (t?.x ?? 0) + e.internals.positionAbsolute.x,
    a = (t?.y ?? 0) + e.internals.positionAbsolute.y,
    { width: o, height: s } = t ?? X(e);
  if (r) return { x: i + o / 2, y: a + s / 2 };
  switch (t?.position ?? n) {
    case J.Top:
      return { x: i + o / 2, y: a };
    case J.Right:
      return { x: i + o, y: a + s / 2 };
    case J.Bottom:
      return { x: i + o / 2, y: a + s };
    case J.Left:
      return { x: i, y: a + s / 2 };
  }
}
function rr(e, t) {
  return (e && (t ? e.find((e) => e.id === t) : e[0])) || null;
}
function ir(e, t) {
  return e
    ? typeof e == `string`
      ? e
      : `${t ? `${t}__` : ``}${Object.keys(e)
          .sort()
          .map((t) => `${t}=${e[t]}`)
          .join(`&`)}`
    : ``;
}
function ar(
  e,
  { id: t, defaultColor: n, defaultMarkerStart: r, defaultMarkerEnd: i },
) {
  let a = new Set();
  return e
    .reduce(
      (e, o) => (
        [o.markerStart || r, o.markerEnd || i].forEach((r) => {
          if (r && typeof r == `object`) {
            let i = ir(r, t);
            a.has(i) ||
              (e.push({ id: i, color: r.color || n, ...r }), a.add(i));
          }
        }),
        e
      ),
      [],
    )
    .sort((e, t) => e.id.localeCompare(t.id));
}
var or = 1e3,
  sr = 10,
  cr = {
    nodeOrigin: [0, 0],
    nodeExtent: jt,
    elevateNodesOnSelect: !0,
    zIndexMode: `basic`,
    defaults: {},
  },
  lr = { ...cr, checkEquality: !0 };
function ur(e, t) {
  let n = { ...e };
  for (let e in t) t[e] !== void 0 && (n[e] = t[e]);
  return n;
}
function dr(e, t, n) {
  let r = ur(cr, n);
  for (let n of e.values())
    if (n.parentId) gr(n, e, t, r);
    else {
      let e = tn(
        Gt(n, r.nodeOrigin),
        Cn(n.extent) ? n.extent : r.nodeExtent,
        X(n),
      );
      n.internals.positionAbsolute = e;
    }
}
function fr(e, t) {
  if (!e.handles) return e.measured ? t?.internals.handleBounds : void 0;
  let n = [],
    r = [];
  for (let t of e.handles) {
    let i = {
      id: t.id,
      width: t.width ?? 1,
      height: t.height ?? 1,
      nodeId: e.id,
      x: t.x,
      y: t.y,
      position: t.position,
      type: t.type,
    };
    t.type === `source` ? n.push(i) : t.type === `target` && r.push(i);
  }
  return { source: n, target: r };
}
function pr(e) {
  return e === `manual`;
}
function mr(e, t, n, r = {}) {
  let i = ur(lr, r),
    a = { i: 0 },
    o = new Map(t),
    s = i?.elevateNodesOnSelect && !pr(i.zIndexMode) ? or : 0,
    c = e.length > 0;
  (t.clear(), n.clear());
  for (let l of e) {
    let e = o.get(l.id);
    if (i.checkEquality && l === e?.internals.userNode) t.set(l.id, e);
    else {
      let n = tn(
        Gt(l, i.nodeOrigin),
        Cn(l.extent) ? l.extent : i.nodeExtent,
        X(l),
      );
      ((e = {
        ...i.defaults,
        ...l,
        measured: { width: l.measured?.width, height: l.measured?.height },
        internals: {
          positionAbsolute: n,
          handleBounds: fr(l, e),
          z: _r(l, s, i.zIndexMode),
          userNode: l,
        },
      }),
        t.set(l.id, e));
    }
    ((e.measured === void 0 ||
      e.measured.width === void 0 ||
      e.measured.height === void 0) &&
      !e.hidden &&
      (c = !1),
      l.parentId && gr(e, t, n, r, a));
  }
  return c;
}
function hr(e, t) {
  if (!e.parentId) return;
  let n = t.get(e.parentId);
  n ? n.set(e.id, e) : t.set(e.parentId, new Map([[e.id, e]]));
}
function gr(e, t, n, r, i) {
  let {
      elevateNodesOnSelect: a,
      nodeOrigin: o,
      nodeExtent: s,
      zIndexMode: c,
    } = ur(cr, r),
    l = e.parentId,
    u = t.get(l);
  if (!u) {
    console.warn(
      `Parent node ${l} not found. Please make sure that parent nodes are in front of their child nodes in the nodes array.`,
    );
    return;
  }
  (hr(e, n),
    i &&
      !u.parentId &&
      u.internals.rootParentIndex === void 0 &&
      c === `auto` &&
      ((u.internals.rootParentIndex = ++i.i),
      (u.internals.z = u.internals.z + i.i * sr)),
    i &&
      u.internals.rootParentIndex !== void 0 &&
      (i.i = u.internals.rootParentIndex));
  let { x: d, y: f, z: p } = vr(e, u, o, s, a && !pr(c) ? or : 0, c),
    { positionAbsolute: m } = e.internals,
    h = d !== m.x || f !== m.y;
  (h || p !== e.internals.z) &&
    t.set(e.id, {
      ...e,
      internals: {
        ...e.internals,
        positionAbsolute: h ? { x: d, y: f } : m,
        z: p,
      },
    });
}
function _r(e, t, n) {
  let r = Y(e.zIndex) ? e.zIndex : 0;
  return pr(n) ? r : r + (e.selected ? t : 0);
}
function vr(e, t, n, r, i, a) {
  let { x: o, y: s } = t.internals.positionAbsolute,
    c = X(e),
    l = Gt(e, n),
    u = Cn(e.extent) ? tn(l, e.extent, c) : l,
    d = tn({ x: o + u.x, y: s + u.y }, r, c);
  e.extent === `parent` && (d = nn(d, c, t));
  let f = _r(e, i, a),
    p = t.internals.z ?? 0;
  return { x: d.x, y: d.y, z: p >= f ? p + 1 : f };
}
function yr(e, t, n, r = [0, 0]) {
  let i = [],
    a = new Map();
  for (let n of e) {
    let e = t.get(n.parentId);
    if (!e) continue;
    let r = dn(a.get(n.parentId)?.expandedRect ?? ln(e), n.rect);
    a.set(n.parentId, { expandedRect: r, parent: e });
  }
  return (
    a.size > 0 &&
      a.forEach(({ expandedRect: t, parent: a }, o) => {
        let s = a.internals.positionAbsolute,
          c = X(a),
          l = a.origin ?? r,
          u = t.x < s.x ? Math.round(Math.abs(s.x - t.x)) : 0,
          d = t.y < s.y ? Math.round(Math.abs(s.y - t.y)) : 0,
          f = Math.max(c.width, Math.round(t.width)),
          p = Math.max(c.height, Math.round(t.height)),
          m = (f - c.width) * l[0],
          h = (p - c.height) * l[1];
        ((u > 0 || d > 0 || m || h) &&
          (i.push({
            id: o,
            type: `position`,
            position: { x: a.position.x - u + m, y: a.position.y - d + h },
          }),
          n.get(o)?.forEach((t) => {
            e.some((e) => e.id === t.id) ||
              i.push({
                id: t.id,
                type: `position`,
                position: { x: t.position.x + u, y: t.position.y + d },
              });
          })),
          (c.width < t.width || c.height < t.height || u || d) &&
            i.push({
              id: o,
              type: `dimensions`,
              setAttributes: !0,
              dimensions: {
                width: f + (u ? l[0] * u - m : 0),
                height: p + (d ? l[1] * d - h : 0),
              },
            }));
      }),
    i
  );
}
function br(e, t, n, r, i, a, o) {
  let s = r?.querySelector(`.xyflow__viewport`),
    c = !1;
  if (!s) return { changes: [], updatedInternals: c };
  let l = [],
    u = window.getComputedStyle(s),
    { m22: d } = new window.DOMMatrixReadOnly(u.transform),
    f = [];
  for (let r of e.values()) {
    let e = t.get(r.id);
    if (!e) continue;
    if (e.hidden) {
      (t.set(e.id, {
        ...e,
        internals: { ...e.internals, handleBounds: void 0 },
      }),
        (c = !0));
      continue;
    }
    let s = An(r.nodeElement),
      u = e.measured.width !== s.width || e.measured.height !== s.height;
    if (s.width && s.height && (u || !e.internals.handleBounds || r.force)) {
      let p = r.nodeElement.getBoundingClientRect(),
        m = Cn(e.extent) ? e.extent : a,
        { positionAbsolute: h } = e.internals;
      e.parentId && e.extent === `parent`
        ? (h = nn(h, s, t.get(e.parentId)))
        : m && (h = tn(h, m, s));
      let g = {
        ...e,
        measured: s,
        internals: {
          ...e.internals,
          positionAbsolute: h,
          handleBounds: {
            source: Fn(`source`, r.nodeElement, p, d, e.id),
            target: Fn(`target`, r.nodeElement, p, d, e.id),
          },
        },
      };
      (t.set(e.id, g),
        e.parentId && gr(g, t, n, { nodeOrigin: i, zIndexMode: o }),
        (c = !0),
        u &&
          (l.push({ id: e.id, type: `dimensions`, dimensions: s }),
          e.expandParent &&
            e.parentId &&
            f.push({ id: e.id, parentId: e.parentId, rect: ln(g, i) })));
    }
  }
  if (f.length > 0) {
    let e = yr(f, t, n, i);
    l.push(...e);
  }
  return { changes: l, updatedInternals: c };
}
async function xr({
  delta: e,
  panZoom: t,
  transform: n,
  translateExtent: r,
  width: i,
  height: a,
}) {
  if (!t || (!e.x && !e.y)) return Promise.resolve(!1);
  let o = await t.setViewportConstrained(
      { x: n[0] + e.x, y: n[1] + e.y, zoom: n[2] },
      [
        [0, 0],
        [i, a],
      ],
      r,
    ),
    s = !!o && (o.x !== n[0] || o.y !== n[1] || o.k !== n[2]);
  return Promise.resolve(s);
}
function Sr(e, t, n, r, i, a) {
  let o = i,
    s = r.get(o) || new Map();
  (r.set(o, s.set(n, t)), (o = `${i}-${e}`));
  let c = r.get(o) || new Map();
  if ((r.set(o, c.set(n, t)), a)) {
    o = `${i}-${e}-${a}`;
    let s = r.get(o) || new Map();
    r.set(o, s.set(n, t));
  }
}
function Cr(e, t, n) {
  (e.clear(), t.clear());
  for (let r of n) {
    let {
        source: n,
        target: i,
        sourceHandle: a = null,
        targetHandle: o = null,
      } = r,
      s = {
        edgeId: r.id,
        source: n,
        target: i,
        sourceHandle: a,
        targetHandle: o,
      },
      c = `${n}-${a}--${i}-${o}`;
    (Sr(`source`, s, `${i}-${o}--${n}-${a}`, e, n, a),
      Sr(`target`, s, c, e, i, o),
      t.set(r.id, r));
  }
}
function wr(e, t) {
  if (!e.parentId) return !1;
  let n = t.get(e.parentId);
  return n ? (n.selected ? !0 : wr(n, t)) : !1;
}
function Tr(e, t, n) {
  let r = e;
  do {
    if (r?.matches?.(t)) return !0;
    if (r === n) return !1;
    r = r?.parentElement;
  } while (r);
  return !1;
}
function Er(e, t, n, r) {
  let i = new Map();
  for (let [a, o] of e)
    if (
      (o.selected || o.id === r) &&
      (!o.parentId || !wr(o, e)) &&
      (o.draggable || (t && o.draggable === void 0))
    ) {
      let t = e.get(a);
      t &&
        i.set(a, {
          id: a,
          position: t.position || { x: 0, y: 0 },
          distance: {
            x: n.x - t.internals.positionAbsolute.x,
            y: n.y - t.internals.positionAbsolute.y,
          },
          extent: t.extent,
          parentId: t.parentId,
          origin: t.origin,
          expandParent: t.expandParent,
          internals: {
            positionAbsolute: t.internals.positionAbsolute || { x: 0, y: 0 },
          },
          measured: {
            width: t.measured.width ?? 0,
            height: t.measured.height ?? 0,
          },
        });
    }
  return i;
}
function Dr({ nodeId: e, dragItems: t, nodeLookup: n, dragging: r = !0 }) {
  let i = [];
  for (let [e, a] of t) {
    let t = n.get(e)?.internals.userNode;
    t && i.push({ ...t, position: a.position, dragging: r });
  }
  if (!e) return [i[0], i];
  let a = n.get(e)?.internals.userNode;
  return [
    a
      ? { ...a, position: t.get(e)?.position || a.position, dragging: r }
      : i[0],
    i,
  ];
}
function Or({ dragItems: e, snapGrid: t, x: n, y: r }) {
  let i = e.values().next().value;
  if (!i) return null;
  let a = { x: n - i.distance.x, y: r - i.distance.y },
    o = hn(a, t);
  return { x: o.x - a.x, y: o.y - a.y };
}
function kr({
  onNodeMouseDown: e,
  getStoreItems: t,
  onDragStart: n,
  onDrag: r,
  onDragStop: i,
}) {
  let a = { x: null, y: null },
    o = 0,
    s = new Map(),
    c = !1,
    l = { x: 0, y: 0 },
    u = null,
    d = !1,
    f = null,
    p = !1,
    m = !1,
    h = null;
  function g({
    noDragClassName: g,
    handleSelector: v,
    domNode: y,
    isSelectable: b,
    nodeId: x,
    nodeClickDistance: S = 0,
  }) {
    f = _(y);
    function C({ x: e, y: n }) {
      let {
        nodeLookup: i,
        nodeExtent: o,
        snapGrid: c,
        snapToGrid: l,
        nodeOrigin: u,
        onNodeDrag: d,
        onSelectionDrag: f,
        onError: p,
        updateNodePositions: g,
      } = t();
      a = { x: e, y: n };
      let _ = !1,
        v = s.size > 1,
        y = v && o ? sn(qt(s)) : null,
        b = v && l ? Or({ dragItems: s, snapGrid: c, x: e, y: n }) : null;
      for (let [t, r] of s) {
        if (!i.has(t)) continue;
        let a = { x: e - r.distance.x, y: n - r.distance.y };
        l &&
          (a = b
            ? { x: Math.round(a.x + b.x), y: Math.round(a.y + b.y) }
            : hn(a, c));
        let s = null;
        if (v && o && !r.extent && y) {
          let { positionAbsolute: e } = r.internals,
            t = e.x - y.x + o[0][0],
            n = e.x + r.measured.width - y.x2 + o[1][0],
            i = e.y - y.y + o[0][1],
            a = e.y + r.measured.height - y.y2 + o[1][1];
          s = [
            [t, i],
            [n, a],
          ];
        }
        let { position: d, positionAbsolute: f } = Qt({
          nodeId: t,
          nextPosition: a,
          nodeLookup: i,
          nodeExtent: s || o,
          nodeOrigin: u,
          onError: p,
        });
        ((_ = _ || r.position.x !== d.x || r.position.y !== d.y),
          (r.position = d),
          (r.internals.positionAbsolute = f));
      }
      if (((m ||= _), _ && (g(s, !0), h && (r || d || (!x && f))))) {
        let [e, t] = Dr({ nodeId: x, dragItems: s, nodeLookup: i });
        (r?.(h, s, e, t), d?.(h, e, t), x || f?.(h, t));
      }
    }
    async function w() {
      if (!u) return;
      let {
        transform: e,
        panBy: n,
        autoPanSpeed: r,
        autoPanOnNodeDrag: i,
      } = t();
      if (!i) {
        ((c = !1), cancelAnimationFrame(o));
        return;
      }
      let [s, d] = an(l, u, r);
      ((s !== 0 || d !== 0) &&
        ((a.x = (a.x ?? 0) - s / e[2]),
        (a.y = (a.y ?? 0) - d / e[2]),
        (await n({ x: s, y: d })) && C(a)),
        (o = requestAnimationFrame(w)));
    }
    function T(r) {
      let {
        nodeLookup: i,
        multiSelectionActive: o,
        nodesDraggable: c,
        transform: l,
        snapGrid: f,
        snapToGrid: p,
        selectNodesOnDrag: m,
        onNodeDragStart: h,
        onSelectionDragStart: g,
        unselectNodesAndEdges: _,
      } = t();
      ((d = !0),
        (!m || !b) && !o && x && (i.get(x)?.selected || _()),
        b && m && x && e?.(x));
      let v = kn(r.sourceEvent, {
        transform: l,
        snapGrid: f,
        snapToGrid: p,
        containerBounds: u,
      });
      if (
        ((a = v), (s = Er(i, c, v, x)), s.size > 0 && (n || h || (!x && g)))
      ) {
        let [e, t] = Dr({ nodeId: x, dragItems: s, nodeLookup: i });
        (n?.(r.sourceEvent, s, e, t),
          h?.(r.sourceEvent, e, t),
          x || g?.(r.sourceEvent, t));
      }
    }
    let E = k()
      .clickDistance(S)
      .on(`start`, (e) => {
        let {
          domNode: n,
          nodeDragThreshold: r,
          transform: i,
          snapGrid: o,
          snapToGrid: s,
        } = t();
        ((u = n?.getBoundingClientRect() || null),
          (p = !1),
          (m = !1),
          (h = e.sourceEvent),
          r === 0 && T(e),
          (a = kn(e.sourceEvent, {
            transform: i,
            snapGrid: o,
            snapToGrid: s,
            containerBounds: u,
          })),
          (l = Z(e.sourceEvent, u)));
      })
      .on(`drag`, (e) => {
        let {
            autoPanOnNodeDrag: n,
            transform: r,
            snapGrid: i,
            snapToGrid: o,
            nodeDragThreshold: f,
            nodeLookup: m,
          } = t(),
          g = kn(e.sourceEvent, {
            transform: r,
            snapGrid: i,
            snapToGrid: o,
            containerBounds: u,
          });
        if (
          ((h = e.sourceEvent),
          ((e.sourceEvent.type === `touchmove` &&
            e.sourceEvent.touches.length > 1) ||
            (x && !m.has(x))) &&
            (p = !0),
          !p)
        ) {
          if ((!c && n && d && ((c = !0), w()), !d)) {
            let t = Z(e.sourceEvent, u),
              n = t.x - l.x,
              r = t.y - l.y;
            Math.sqrt(n * n + r * r) > f && T(e);
          }
          (a.x !== g.xSnapped || a.y !== g.ySnapped) &&
            s &&
            d &&
            ((l = Z(e.sourceEvent, u)), C(g));
        }
      })
      .on(`end`, (e) => {
        if (
          !(!d || p) &&
          ((c = !1), (d = !1), cancelAnimationFrame(o), s.size > 0)
        ) {
          let {
            nodeLookup: n,
            updateNodePositions: r,
            onNodeDragStop: a,
            onSelectionDragStop: o,
          } = t();
          if (((m &&= (r(s, !1), !1)), i || a || (!x && o))) {
            let [t, r] = Dr({
              nodeId: x,
              dragItems: s,
              nodeLookup: n,
              dragging: !1,
            });
            (i?.(e.sourceEvent, s, t, r),
              a?.(e.sourceEvent, t, r),
              x || o?.(e.sourceEvent, r));
          }
        }
      })
      .filter((e) => {
        let t = e.target;
        return !e.button && (!g || !Tr(t, `.${g}`, y)) && (!v || Tr(t, v, y));
      });
    f.call(E);
  }
  function v() {
    f?.on(`.drag`, null);
  }
  return { update: g, destroy: v };
}
function Ar(e, t, n) {
  let r = [],
    i = { x: e.x - n, y: e.y - n, width: n * 2, height: n * 2 };
  for (let e of t.values()) fn(i, ln(e)) > 0 && r.push(e);
  return r;
}
var jr = 250;
function Mr(e, t, n, r) {
  let i = [],
    a = 1 / 0,
    o = Ar(e, n, t + jr);
  for (let n of o) {
    let o = [
      ...(n.internals.handleBounds?.source ?? []),
      ...(n.internals.handleBounds?.target ?? []),
    ];
    for (let s of o) {
      if (r.nodeId === s.nodeId && r.type === s.type && r.id === s.id) continue;
      let { x: o, y: c } = nr(n, s, s.position, !0),
        l = Math.sqrt((o - e.x) ** 2 + (c - e.y) ** 2);
      l > t ||
        (l < a
          ? ((i = [{ ...s, x: o, y: c }]), (a = l))
          : l === a && i.push({ ...s, x: o, y: c }));
    }
  }
  if (!i.length) return null;
  if (i.length > 1) {
    let e = r.type === `source` ? `target` : `source`;
    return i.find((t) => t.type === e) ?? i[0];
  }
  return i[0];
}
function Nr(e, t, n, r, i, a = !1) {
  let o = r.get(e);
  if (!o) return null;
  let s =
      i === `strict`
        ? o.internals.handleBounds?.[t]
        : [
            ...(o.internals.handleBounds?.source ?? []),
            ...(o.internals.handleBounds?.target ?? []),
          ],
    c = (n ? s?.find((e) => e.id === n) : s?.[0]) ?? null;
  return c && a ? { ...c, ...nr(o, c, c.position, !0) } : c;
}
function Pr(e, t) {
  return (
    e ||
    (t?.classList.contains(`target`)
      ? `target`
      : t?.classList.contains(`source`)
        ? `source`
        : null)
  );
}
function Fr(e, t) {
  let n = null;
  return (t ? (n = !0) : e && !t && (n = !1), n);
}
var Ir = () => !0;
function Lr(
  e,
  {
    connectionMode: t,
    connectionRadius: n,
    handleId: r,
    nodeId: i,
    edgeUpdaterType: a,
    isTarget: o,
    domNode: s,
    nodeLookup: c,
    lib: l,
    autoPanOnConnect: u,
    flowId: d,
    panBy: f,
    cancelConnection: p,
    onConnectStart: m,
    onConnect: h,
    onConnectEnd: g,
    isValidConnection: _ = Ir,
    onReconnectEnd: v,
    updateConnection: y,
    getTransform: b,
    getFromHandle: x,
    autoPanSpeed: S,
    dragThreshold: C = 1,
    handleDomNode: w,
  },
) {
  let T = jn(e.target),
    E = 0,
    D,
    { x: O, y: k } = Z(e),
    A = Pr(a, w),
    j = s?.getBoundingClientRect(),
    M = !1;
  if (!j || !A) return;
  let N = Nr(i, A, r, c, t);
  if (!N) return;
  let P = Z(e, j),
    F = !1,
    I = null,
    L = !1,
    R = null;
  function z() {
    if (!u || !j) return;
    let [e, t] = an(P, j, S);
    (f({ x: e, y: t }), (E = requestAnimationFrame(z)));
  }
  let B = { ...N, nodeId: i, type: A, position: N.position },
    V = c.get(i),
    H = {
      inProgress: !0,
      isValid: null,
      from: nr(V, B, J.Left, !0),
      fromHandle: B,
      fromPosition: B.position,
      fromNode: V,
      to: P,
      toHandle: null,
      toPosition: Bt[B.position],
      toNode: null,
      pointer: P,
    };
  function U() {
    ((M = !0), y(H), m?.(e, { nodeId: i, handleId: r, handleType: A }));
  }
  C === 0 && U();
  function W(e) {
    if (!M) {
      let { x: t, y: n } = Z(e),
        r = t - O,
        i = n - k;
      if (!(r * r + i * i > C * C)) return;
      U();
    }
    if (!x() || !B) {
      G(e);
      return;
    }
    let a = b();
    ((P = Z(e, j)), (D = Mr(gn(P, a, !1, [1, 1]), n, c, B)), (F ||= (z(), !0)));
    let s = Rr(e, {
      handle: D,
      connectionMode: t,
      fromNodeId: i,
      fromHandleId: r,
      fromType: o ? `target` : `source`,
      isValidConnection: _,
      doc: T,
      lib: l,
      flowId: d,
      nodeLookup: c,
    });
    ((R = s.handleDomNode), (I = s.connection), (L = Fr(!!D, s.isValid)));
    let u = c.get(i),
      f = u ? nr(u, B, J.Left, !0) : H.from,
      p = {
        ...H,
        from: f,
        isValid: L,
        to: s.toHandle && L ? _n({ x: s.toHandle.x, y: s.toHandle.y }, a) : P,
        toHandle: s.toHandle,
        toPosition: L && s.toHandle ? s.toHandle.position : Bt[B.position],
        toNode: s.toHandle ? c.get(s.toHandle.nodeId) : null,
        pointer: P,
      };
    (y(p), (H = p));
  }
  function G(e) {
    if (!(`touches` in e && e.touches.length > 0)) {
      if (M) {
        (D || R) && I && L && h?.(I);
        let { inProgress: t, ...n } = H,
          r = { ...n, toPosition: H.toHandle ? H.toPosition : null };
        (g?.(e, r), a && v?.(e, r));
      }
      (p(),
        cancelAnimationFrame(E),
        (F = !1),
        (L = !1),
        (I = null),
        (R = null),
        T.removeEventListener(`mousemove`, W),
        T.removeEventListener(`mouseup`, G),
        T.removeEventListener(`touchmove`, W),
        T.removeEventListener(`touchend`, G));
    }
  }
  (T.addEventListener(`mousemove`, W),
    T.addEventListener(`mouseup`, G),
    T.addEventListener(`touchmove`, W),
    T.addEventListener(`touchend`, G));
}
function Rr(
  e,
  {
    handle: t,
    connectionMode: n,
    fromNodeId: r,
    fromHandleId: i,
    fromType: a,
    doc: o,
    lib: s,
    flowId: c,
    isValidConnection: l = Ir,
    nodeLookup: u,
  },
) {
  let d = a === `target`,
    f = t
      ? o.querySelector(
          `.${s}-flow__handle[data-id="${c}-${t?.nodeId}-${t?.id}-${t?.type}"]`,
        )
      : null,
    { x: p, y: m } = Z(e),
    h = o.elementFromPoint(p, m),
    g = h?.classList.contains(`${s}-flow__handle`) ? h : f,
    _ = { handleDomNode: g, isValid: !1, connection: null, toHandle: null };
  if (g) {
    let e = Pr(void 0, g),
      t = g.getAttribute(`data-nodeid`),
      a = g.getAttribute(`data-handleid`),
      o = g.classList.contains(`connectable`),
      s = g.classList.contains(`connectableend`);
    if (!t || !e) return _;
    let c = {
      source: d ? t : r,
      sourceHandle: d ? a : i,
      target: d ? r : t,
      targetHandle: d ? i : a,
    };
    ((_.connection = c),
      (_.isValid =
        o &&
        s &&
        (n === Pt.Strict
          ? (d && e === `source`) || (!d && e === `target`)
          : t !== r || a !== i) &&
        l(c)),
      (_.toHandle = Nr(t, e, a, u, n, !0)));
  }
  return _;
}
var zr = { onPointerDown: Lr, isValid: Rr };
function Br({ domNode: e, panZoom: t, getTransform: n, getViewScale: r }) {
  let i = _(e);
  function a({
    translateExtent: e,
    width: a,
    height: o,
    zoomStep: s = 1,
    pannable: c = !0,
    zoomable: l = !0,
    inversePan: u = !1,
  }) {
    let d = (e) => {
        if (e.sourceEvent.type !== `wheel` || !t) return;
        let r = n(),
          i = e.sourceEvent.ctrlKey && Sn() ? 10 : 1,
          a =
            -e.sourceEvent.deltaY *
            (e.sourceEvent.deltaMode === 1
              ? 0.05
              : e.sourceEvent.deltaMode
                ? 1
                : 0.002) *
            s,
          o = r[2] * 2 ** (a * i);
        t.scaleTo(o);
      },
      f = [0, 0],
      p = O()
        .on(`start`, (e) => {
          (e.sourceEvent.type === `mousedown` ||
            e.sourceEvent.type === `touchstart`) &&
            (f = [
              e.sourceEvent.clientX ?? e.sourceEvent.touches[0].clientX,
              e.sourceEvent.clientY ?? e.sourceEvent.touches[0].clientY,
            ]);
        })
        .on(
          `zoom`,
          c
            ? (i) => {
                let s = n();
                if (
                  (i.sourceEvent.type !== `mousemove` &&
                    i.sourceEvent.type !== `touchmove`) ||
                  !t
                )
                  return;
                let c = [
                    i.sourceEvent.clientX ?? i.sourceEvent.touches[0].clientX,
                    i.sourceEvent.clientY ?? i.sourceEvent.touches[0].clientY,
                  ],
                  l = [c[0] - f[0], c[1] - f[1]];
                f = c;
                let d = r() * Math.max(s[2], Math.log(s[2])) * (u ? -1 : 1),
                  p = { x: s[0] - l[0] * d, y: s[1] - l[1] * d },
                  m = [
                    [0, 0],
                    [a, o],
                  ];
                t.setViewportConstrained({ x: p.x, y: p.y, zoom: s[2] }, m, e);
              }
            : null,
        )
        .on(`zoom.wheel`, l ? d : null);
    i.call(p, {});
  }
  function o() {
    i.on(`zoom`, null);
  }
  return { update: a, destroy: o, pointer: g };
}
var Vr = (e) => ({ x: e.x, y: e.y, zoom: e.k }),
  Hr = ({ x: e, y: t, zoom: n }) => C.translate(e, t).scale(n),
  Ur = (e, t) => e.target.closest(`.${t}`),
  Wr = (e, t) => t === 2 && Array.isArray(e) && e.includes(2),
  Gr = (e) => ((e *= 2) <= 1 ? e * e * e : (e -= 2) * e * e + 2) / 2,
  Kr = (e, t = 0, n = Gr, r = () => {}) => {
    let i = typeof t == `number` && t > 0;
    return (i || r(), i ? e.transition().duration(t).ease(n).on(`end`, r) : e);
  },
  qr = (e) => {
    let t = e.ctrlKey && Sn() ? 10 : 1;
    return -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * t;
  };
function Jr({
  zoomPanValues: e,
  noWheelClassName: t,
  d3Selection: n,
  d3Zoom: r,
  panOnScrollMode: i,
  panOnScrollSpeed: a,
  zoomOnPinch: o,
  onPanZoomStart: s,
  onPanZoom: c,
  onPanZoomEnd: l,
}) {
  return (u) => {
    if (Ur(u, t)) return (u.ctrlKey && u.preventDefault(), !1);
    (u.preventDefault(), u.stopImmediatePropagation());
    let d = n.property(`__zoom`).k || 1;
    if (u.ctrlKey && o) {
      let e = g(u),
        t = d * 2 ** qr(u);
      r.scaleTo(n, t, e, u);
      return;
    }
    let f = u.deltaMode === 1 ? 20 : 1,
      p = i === Ft.Vertical ? 0 : u.deltaX * f,
      m = i === Ft.Horizontal ? 0 : u.deltaY * f;
    (!Sn() && u.shiftKey && i !== Ft.Vertical && ((p = u.deltaY * f), (m = 0)),
      r.translateBy(n, -(p / d) * a, -(m / d) * a, { internal: !0 }));
    let h = Vr(n.property(`__zoom`));
    (clearTimeout(e.panScrollTimeout),
      e.isPanScrolling
        ? (c?.(u, h),
          (e.panScrollTimeout = setTimeout(() => {
            (l?.(u, h), (e.isPanScrolling = !1));
          }, 150)))
        : ((e.isPanScrolling = !0), s?.(u, h)));
  };
}
function Yr({ noWheelClassName: e, preventScrolling: t, d3ZoomHandler: n }) {
  return function (r, i) {
    let a = r.type === `wheel`,
      o = !t && a && !r.ctrlKey,
      s = Ur(r, e);
    if ((r.ctrlKey && a && s && r.preventDefault(), o || s)) return null;
    (r.preventDefault(), n.call(this, r, i));
  };
}
function Xr({ zoomPanValues: e, onDraggingChange: t, onPanZoomStart: n }) {
  return (r) => {
    if (r.sourceEvent?.internal) return;
    let i = Vr(r.transform);
    ((e.mouseButton = r.sourceEvent?.button || 0),
      (e.isZoomingOrPanning = !0),
      (e.prevViewport = i),
      r.sourceEvent?.type === `mousedown` && t(!0),
      n && n?.(r.sourceEvent, i));
  };
}
function Zr({
  zoomPanValues: e,
  panOnDrag: t,
  onPaneContextMenu: n,
  onTransformChange: r,
  onPanZoom: i,
}) {
  return (a) => {
    ((e.usedRightMouseButton = !!(n && Wr(t, e.mouseButton ?? 0))),
      a.sourceEvent?.sync || r([a.transform.x, a.transform.y, a.transform.k]),
      i && !a.sourceEvent?.internal && i?.(a.sourceEvent, Vr(a.transform)));
  };
}
function Qr({
  zoomPanValues: e,
  panOnDrag: t,
  panOnScroll: n,
  onDraggingChange: r,
  onPanZoomEnd: i,
  onPaneContextMenu: a,
}) {
  return (o) => {
    if (
      !o.sourceEvent?.internal &&
      ((e.isZoomingOrPanning = !1),
      a &&
        Wr(t, e.mouseButton ?? 0) &&
        !e.usedRightMouseButton &&
        o.sourceEvent &&
        a(o.sourceEvent),
      (e.usedRightMouseButton = !1),
      r(!1),
      i)
    ) {
      let t = Vr(o.transform);
      ((e.prevViewport = t),
        clearTimeout(e.timerId),
        (e.timerId = setTimeout(
          () => {
            i?.(o.sourceEvent, t);
          },
          n ? 150 : 0,
        )));
    }
  };
}
function $r({
  zoomActivationKeyPressed: e,
  zoomOnScroll: t,
  zoomOnPinch: n,
  panOnDrag: r,
  panOnScroll: i,
  zoomOnDoubleClick: a,
  userSelectionActive: o,
  noWheelClassName: s,
  noPanClassName: c,
  lib: l,
  connectionInProgress: u,
}) {
  return (d) => {
    let f = e || t,
      p = n && d.ctrlKey,
      m = d.type === `wheel`;
    if (
      d.button === 1 &&
      d.type === `mousedown` &&
      (Ur(d, `${l}-flow__node`) || Ur(d, `${l}-flow__edge`))
    )
      return !0;
    if (
      (!r && !f && !i && !a && !n) ||
      o ||
      (u && !m) ||
      (Ur(d, s) && m) ||
      (Ur(d, c) && (!m || (i && m && !e))) ||
      (!n && d.ctrlKey && m)
    )
      return !1;
    if (!n && d.type === `touchstart` && d.touches?.length > 1)
      return (d.preventDefault(), !1);
    if (
      (!f && !i && !p && m) ||
      (!r && (d.type === `mousedown` || d.type === `touchstart`)) ||
      (Array.isArray(r) && !r.includes(d.button) && d.type === `mousedown`)
    )
      return !1;
    let h =
      (Array.isArray(r) && r.includes(d.button)) || !d.button || d.button <= 1;
    return (!d.ctrlKey || m) && h;
  };
}
function ei({
  domNode: e,
  minZoom: t,
  maxZoom: n,
  translateExtent: r,
  viewport: i,
  onPanZoom: a,
  onPanZoomStart: o,
  onPanZoomEnd: s,
  onDraggingChange: c,
}) {
  let l = {
      isZoomingOrPanning: !1,
      usedRightMouseButton: !1,
      prevViewport: { x: 0, y: 0, zoom: 0 },
      mouseButton: 0,
      timerId: void 0,
      panScrollTimeout: void 0,
      isPanScrolling: !1,
    },
    u = e.getBoundingClientRect(),
    d = O().scaleExtent([t, n]).translateExtent(r),
    f = _(e).call(d);
  y(
    { x: i.x, y: i.y, zoom: en(i.zoom, t, n) },
    [
      [0, 0],
      [u.width, u.height],
    ],
    r,
  );
  let p = f.on(`wheel.zoom`),
    m = f.on(`dblclick.zoom`);
  d.wheelDelta(qr);
  function h(e, t) {
    return f
      ? new Promise((n) => {
          d?.interpolate(t?.interpolate === `linear` ? G : b).transform(
            Kr(f, t?.duration, t?.ease, () => n(!0)),
            e,
          );
        })
      : Promise.resolve(!1);
  }
  function g({
    noWheelClassName: e,
    noPanClassName: t,
    onPaneContextMenu: n,
    userSelectionActive: r,
    panOnScroll: i,
    panOnDrag: u,
    panOnScrollMode: h,
    panOnScrollSpeed: g,
    preventScrolling: _,
    zoomOnPinch: y,
    zoomOnScroll: b,
    zoomOnDoubleClick: x,
    zoomActivationKeyPressed: S,
    lib: C,
    onTransformChange: w,
    connectionInProgress: T,
    paneClickDistance: E,
    selectionOnDrag: D,
  }) {
    r && !l.isZoomingOrPanning && v();
    let O = i && !S && !r;
    d.clickDistance(D ? 1 / 0 : !Y(E) || E < 0 ? 0 : E);
    let k = O
      ? Jr({
          zoomPanValues: l,
          noWheelClassName: e,
          d3Selection: f,
          d3Zoom: d,
          panOnScrollMode: h,
          panOnScrollSpeed: g,
          zoomOnPinch: y,
          onPanZoomStart: o,
          onPanZoom: a,
          onPanZoomEnd: s,
        })
      : Yr({ noWheelClassName: e, preventScrolling: _, d3ZoomHandler: p });
    if ((f.on(`wheel.zoom`, k, { passive: !1 }), !r)) {
      let e = Xr({ zoomPanValues: l, onDraggingChange: c, onPanZoomStart: o });
      d.on(`start`, e);
      let t = Zr({
        zoomPanValues: l,
        panOnDrag: u,
        onPaneContextMenu: !!n,
        onPanZoom: a,
        onTransformChange: w,
      });
      d.on(`zoom`, t);
      let r = Qr({
        zoomPanValues: l,
        panOnDrag: u,
        panOnScroll: i,
        onPaneContextMenu: n,
        onPanZoomEnd: s,
        onDraggingChange: c,
      });
      d.on(`end`, r);
    }
    let A = $r({
      zoomActivationKeyPressed: S,
      panOnDrag: u,
      zoomOnScroll: b,
      panOnScroll: i,
      zoomOnDoubleClick: x,
      zoomOnPinch: y,
      userSelectionActive: r,
      noPanClassName: t,
      noWheelClassName: e,
      lib: C,
      connectionInProgress: T,
    });
    (d.filter(A), x ? f.on(`dblclick.zoom`, m) : f.on(`dblclick.zoom`, null));
  }
  function v() {
    d.on(`zoom`, null);
  }
  async function y(e, t, n) {
    let r = Hr(e),
      i = d?.constrain()(r, t, n);
    return (i && (await h(i)), new Promise((e) => e(i)));
  }
  async function x(e, t) {
    let n = Hr(e);
    return (await h(n, t), new Promise((e) => e(n)));
  }
  function S(e) {
    if (f) {
      let t = Hr(e),
        n = f.property(`__zoom`);
      (n.k !== e.zoom || n.x !== e.x || n.y !== e.y) &&
        d?.transform(f, t, null, { sync: !0 });
    }
  }
  function C() {
    let e = f ? E(f.node()) : { x: 0, y: 0, k: 1 };
    return { x: e.x, y: e.y, zoom: e.k };
  }
  function w(e, t) {
    return f
      ? new Promise((n) => {
          d?.interpolate(t?.interpolate === `linear` ? G : b).scaleTo(
            Kr(f, t?.duration, t?.ease, () => n(!0)),
            e,
          );
        })
      : Promise.resolve(!1);
  }
  function T(e, t) {
    return f
      ? new Promise((n) => {
          d?.interpolate(t?.interpolate === `linear` ? G : b).scaleBy(
            Kr(f, t?.duration, t?.ease, () => n(!0)),
            e,
          );
        })
      : Promise.resolve(!1);
  }
  function D(e) {
    d?.scaleExtent(e);
  }
  function k(e) {
    d?.translateExtent(e);
  }
  function A(e) {
    let t = !Y(e) || e < 0 ? 0 : e;
    d?.clickDistance(t);
  }
  return {
    update: g,
    destroy: v,
    setViewport: x,
    setViewportConstrained: y,
    getViewport: C,
    scaleTo: w,
    scaleBy: T,
    setScaleExtent: D,
    setTranslateExtent: k,
    syncViewport: S,
    setClickDistance: A,
  };
}
var ti;
(function (e) {
  ((e.Line = `line`), (e.Handle = `handle`));
})((ti ||= {}));
var ni = [`top-left`, `top-right`, `bottom-left`, `bottom-right`],
  ri = [`top`, `right`, `bottom`, `left`];
function ii({
  width: e,
  prevWidth: t,
  height: n,
  prevHeight: r,
  affectsX: i,
  affectsY: a,
}) {
  let o = e - t,
    s = n - r,
    c = [o > 0 ? 1 : o < 0 ? -1 : 0, s > 0 ? 1 : s < 0 ? -1 : 0];
  return (o && i && (c[0] *= -1), s && a && (c[1] *= -1), c);
}
function ai(e) {
  return {
    isHorizontal: e.includes(`right`) || e.includes(`left`),
    isVertical: e.includes(`bottom`) || e.includes(`top`),
    affectsX: e.includes(`left`),
    affectsY: e.includes(`top`),
  };
}
function oi(e, t) {
  return Math.max(0, t - e);
}
function si(e, t) {
  return Math.max(0, e - t);
}
function ci(e, t, n) {
  return Math.max(0, t - e, e - n);
}
function li(e, t) {
  return e ? !t : t;
}
function ui(e, t, n, r, i, a, o, s) {
  let { affectsX: c, affectsY: l } = t,
    { isHorizontal: u, isVertical: d } = t,
    f = u && d,
    { xSnapped: p, ySnapped: m } = n,
    { minWidth: h, maxWidth: g, minHeight: _, maxHeight: v } = r,
    { x: y, y: b, width: x, height: S, aspectRatio: C } = e,
    w = Math.floor(u ? p - e.pointerX : 0),
    T = Math.floor(d ? m - e.pointerY : 0),
    E = x + (c ? -w : w),
    D = S + (l ? -T : T),
    O = -a[0] * x,
    k = -a[1] * S,
    A = ci(E, h, g),
    j = ci(D, _, v);
  if (o) {
    let e = 0,
      t = 0;
    (c && w < 0
      ? (e = oi(y + w + O, o[0][0]))
      : !c && w > 0 && (e = si(y + E + O, o[1][0])),
      l && T < 0
        ? (t = oi(b + T + k, o[0][1]))
        : !l && T > 0 && (t = si(b + D + k, o[1][1])),
      (A = Math.max(A, e)),
      (j = Math.max(j, t)));
  }
  if (s) {
    let e = 0,
      t = 0;
    (c && w > 0
      ? (e = si(y + w, s[0][0]))
      : !c && w < 0 && (e = oi(y + E, s[1][0])),
      l && T > 0
        ? (t = si(b + T, s[0][1]))
        : !l && T < 0 && (t = oi(b + D, s[1][1])),
      (A = Math.max(A, e)),
      (j = Math.max(j, t)));
  }
  if (i) {
    if (u) {
      let e = ci(E / C, _, v) * C;
      if (((A = Math.max(A, e)), o)) {
        let e = 0;
        ((e =
          (!c && !l) || (c && !l && f)
            ? si(b + k + E / C, o[1][1]) * C
            : oi(b + k + (c ? w : -w) / C, o[0][1]) * C),
          (A = Math.max(A, e)));
      }
      if (s) {
        let e = 0;
        ((e =
          (!c && !l) || (c && !l && f)
            ? oi(b + E / C, s[1][1]) * C
            : si(b + (c ? w : -w) / C, s[0][1]) * C),
          (A = Math.max(A, e)));
      }
    }
    if (d) {
      let e = ci(D * C, h, g) / C;
      if (((j = Math.max(j, e)), o)) {
        let e = 0;
        ((e =
          (!c && !l) || (l && !c && f)
            ? si(y + D * C + O, o[1][0]) / C
            : oi(y + (l ? T : -T) * C + O, o[0][0]) / C),
          (j = Math.max(j, e)));
      }
      if (s) {
        let e = 0;
        ((e =
          (!c && !l) || (l && !c && f)
            ? oi(y + D * C, s[1][0]) / C
            : si(y + (l ? T : -T) * C, s[0][0]) / C),
          (j = Math.max(j, e)));
      }
    }
  }
  ((T += T < 0 ? j : -j),
    (w += w < 0 ? A : -A),
    i &&
      (f
        ? E > D * C
          ? (T = (li(c, l) ? -w : w) / C)
          : (w = (li(c, l) ? -T : T) * C)
        : u
          ? ((T = w / C), (l = c))
          : ((w = T * C), (c = l))));
  let M = c ? y + w : y,
    N = l ? b + T : b;
  return {
    width: x + (c ? -w : w),
    height: S + (l ? -T : T),
    x: a[0] * w * (c ? -1 : 1) + M,
    y: a[1] * T * (l ? -1 : 1) + N,
  };
}
var di = { width: 0, height: 0, x: 0, y: 0 },
  fi = { ...di, pointerX: 0, pointerY: 0, aspectRatio: 1 };
function pi(e) {
  return [
    [0, 0],
    [e.measured.width, e.measured.height],
  ];
}
function mi(e, t, n) {
  let r = t.position.x + e.position.x,
    i = t.position.y + e.position.y,
    a = e.measured.width ?? 0,
    o = e.measured.height ?? 0,
    s = n[0] * a,
    c = n[1] * o;
  return [
    [r - s, i - c],
    [r + a - s, i + o - c],
  ];
}
function hi({
  domNode: e,
  nodeId: t,
  getStoreItems: n,
  onChange: r,
  onEnd: i,
}) {
  let a = _(e),
    o = {
      controlDirection: ai(`bottom-right`),
      boundaries: {
        minWidth: 0,
        minHeight: 0,
        maxWidth: Number.MAX_VALUE,
        maxHeight: Number.MAX_VALUE,
      },
      resizeDirection: void 0,
      keepAspectRatio: !1,
    };
  function s({
    controlPosition: e,
    boundaries: s,
    keepAspectRatio: c,
    resizeDirection: l,
    onResizeStart: u,
    onResize: d,
    onResizeEnd: f,
    shouldResize: p,
  }) {
    let m = { ...di },
      h = { ...fi };
    o = {
      boundaries: s,
      resizeDirection: l,
      keepAspectRatio: c,
      controlDirection: ai(e),
    };
    let g,
      _ = null,
      v = [],
      y,
      b,
      x,
      S = !1,
      C = k()
        .on(`start`, (e) => {
          let {
            nodeLookup: r,
            transform: i,
            snapGrid: a,
            snapToGrid: o,
            nodeOrigin: s,
            paneDomNode: c,
          } = n();
          if (((g = r.get(t)), !g)) return;
          _ = c?.getBoundingClientRect() ?? null;
          let { xSnapped: l, ySnapped: d } = kn(e.sourceEvent, {
            transform: i,
            snapGrid: a,
            snapToGrid: o,
            containerBounds: _,
          });
          ((m = {
            width: g.measured.width ?? 0,
            height: g.measured.height ?? 0,
            x: g.position.x ?? 0,
            y: g.position.y ?? 0,
          }),
            (h = {
              ...m,
              pointerX: l,
              pointerY: d,
              aspectRatio: m.width / m.height,
            }),
            (y = void 0),
            g.parentId &&
              (g.extent === `parent` || g.expandParent) &&
              ((y = r.get(g.parentId)),
              (b = y && g.extent === `parent` ? pi(y) : void 0)),
            (v = []),
            (x = void 0));
          for (let [e, n] of r)
            if (
              n.parentId === t &&
              (v.push({ id: e, position: { ...n.position }, extent: n.extent }),
              n.extent === `parent` || n.expandParent)
            ) {
              let e = mi(n, g, n.origin ?? s);
              x = x
                ? [
                    [Math.min(e[0][0], x[0][0]), Math.min(e[0][1], x[0][1])],
                    [Math.max(e[1][0], x[1][0]), Math.max(e[1][1], x[1][1])],
                  ]
                : e;
            }
          u?.(e, { ...m });
        })
        .on(`drag`, (e) => {
          let { transform: t, snapGrid: i, snapToGrid: a, nodeOrigin: s } = n(),
            c = kn(e.sourceEvent, {
              transform: t,
              snapGrid: i,
              snapToGrid: a,
              containerBounds: _,
            }),
            l = [];
          if (!g) return;
          let { x: u, y: f, width: C, height: w } = m,
            T = {},
            E = g.origin ?? s,
            {
              width: D,
              height: O,
              x: k,
              y: A,
            } = ui(
              h,
              o.controlDirection,
              c,
              o.boundaries,
              o.keepAspectRatio,
              E,
              b,
              x,
            ),
            j = D !== C,
            M = O !== w,
            N = k !== u && j,
            P = A !== f && M;
          if (!N && !P && !j && !M) return;
          if (
            (N || P || E[0] === 1 || E[1] === 1) &&
            ((T.x = N ? k : m.x),
            (T.y = P ? A : m.y),
            (m.x = T.x),
            (m.y = T.y),
            v.length > 0)
          ) {
            let e = k - u,
              t = A - f;
            for (let n of v)
              ((n.position = {
                x: n.position.x - e + E[0] * (D - C),
                y: n.position.y - t + E[1] * (O - w),
              }),
                l.push(n));
          }
          if (
            ((j || M) &&
              ((T.width =
                j && (!o.resizeDirection || o.resizeDirection === `horizontal`)
                  ? D
                  : m.width),
              (T.height =
                M && (!o.resizeDirection || o.resizeDirection === `vertical`)
                  ? O
                  : m.height),
              (m.width = T.width),
              (m.height = T.height)),
            y && g.expandParent)
          ) {
            let e = E[0] * (T.width ?? 0);
            T.x && T.x < e && ((m.x = e), (h.x -= T.x - e));
            let t = E[1] * (T.height ?? 0);
            T.y && T.y < t && ((m.y = t), (h.y -= T.y - t));
          }
          let F = ii({
              width: m.width,
              prevWidth: C,
              height: m.height,
              prevHeight: w,
              affectsX: o.controlDirection.affectsX,
              affectsY: o.controlDirection.affectsY,
            }),
            I = { ...m, direction: F };
          p?.(e, I) !== !1 && ((S = !0), d?.(e, I), r(T, l));
        })
        .on(`end`, (e) => {
          S &&= (f?.(e, { ...m }), i?.({ ...m }), !1);
        });
    a.call(C);
  }
  function c() {
    a.on(`.drag`, null);
  }
  return { update: s, destroy: c };
}
var gi = e(n()),
  _i = (0, M.createContext)(null),
  vi = _i.Provider,
  yi = q.error001();
function Q(e, t) {
  let n = (0, M.useContext)(_i);
  if (n === null) throw Error(yi);
  return y(n, e, t);
}
function $() {
  let e = (0, M.useContext)(_i);
  if (e === null) throw Error(yi);
  return (0, M.useMemo)(
    () => ({
      getState: e.getState,
      setState: e.setState,
      subscribe: e.subscribe,
    }),
    [e],
  );
}
var bi = { display: `none` },
  xi = {
    position: `absolute`,
    width: 1,
    height: 1,
    margin: -1,
    border: 0,
    padding: 0,
    overflow: `hidden`,
    clip: `rect(0px, 0px, 0px, 0px)`,
    clipPath: `inset(100%)`,
  },
  Si = `react-flow__node-desc`,
  Ci = `react-flow__edge-desc`,
  wi = `react-flow__aria-live`,
  Ti = (e) => e.ariaLiveMessage,
  Ei = (e) => e.ariaLabelConfig;
function Di({ rfId: e }) {
  let t = Q(Ti);
  return (0, R.jsx)(`div`, {
    id: `${wi}-${e}`,
    "aria-live": `assertive`,
    "aria-atomic": `true`,
    style: xi,
    children: t,
  });
}
function Oi({ rfId: e, disableKeyboardA11y: t }) {
  let n = Q(Ei);
  return (0, R.jsxs)(R.Fragment, {
    children: [
      (0, R.jsx)(`div`, {
        id: `${Si}-${e}`,
        style: bi,
        children: t
          ? n[`node.a11yDescription.default`]
          : n[`node.a11yDescription.keyboardDisabled`],
      }),
      (0, R.jsx)(`div`, {
        id: `${Ci}-${e}`,
        style: bi,
        children: n[`edge.a11yDescription.default`],
      }),
      !t && (0, R.jsx)(Di, { rfId: e }),
    ],
  });
}
var ki = (0, M.forwardRef)(
  (
    { position: e = `top-left`, children: t, className: n, style: r, ...i },
    a,
  ) =>
    (0, R.jsx)(`div`, {
      className: v([`react-flow__panel`, n, ...`${e}`.split(`-`)]),
      style: r,
      ref: a,
      ...i,
      children: t,
    }),
);
ki.displayName = `Panel`;
function Ai({ proOptions: e, position: t = `bottom-right` }) {
  return e?.hideAttribution
    ? null
    : (0, R.jsx)(ki, {
        position: t,
        className: `react-flow__attribution`,
        "data-message": `Please only hide this attribution when you are subscribed to React Flow Pro: https://pro.reactflow.dev`,
        children: (0, R.jsx)(`a`, {
          href: `https://reactflow.dev`,
          target: `_blank`,
          rel: `noopener noreferrer`,
          "aria-label": `React Flow attribution`,
          children: `React Flow`,
        }),
      });
}
var ji = (e) => {
    let t = [],
      n = [];
    for (let [, n] of e.nodeLookup) n.selected && t.push(n.internals.userNode);
    for (let [, t] of e.edgeLookup) t.selected && n.push(t);
    return { selectedNodes: t, selectedEdges: n };
  },
  Mi = (e) => e.id;
function Ni(e, t) {
  return (
    T(e.selectedNodes.map(Mi), t.selectedNodes.map(Mi)) &&
    T(e.selectedEdges.map(Mi), t.selectedEdges.map(Mi))
  );
}
function Pi({ onSelectionChange: e }) {
  let t = $(),
    { selectedNodes: n, selectedEdges: r } = Q(ji, Ni);
  return (
    (0, M.useEffect)(() => {
      let i = { nodes: n, edges: r };
      (e?.(i), t.getState().onSelectionChangeHandlers.forEach((e) => e(i)));
    }, [n, r, e]),
    null
  );
}
var Fi = (e) => !!e.onSelectionChangeHandlers;
function Ii({ onSelectionChange: e }) {
  let t = Q(Fi);
  return e || t ? (0, R.jsx)(Pi, { onSelectionChange: e }) : null;
}
var Li = [0, 0],
  Ri = { x: 0, y: 0, zoom: 1 },
  zi = [
    ...`nodes.edges.defaultNodes.defaultEdges.onConnect.onConnectStart.onConnectEnd.onClickConnectStart.onClickConnectEnd.nodesDraggable.autoPanOnNodeFocus.nodesConnectable.nodesFocusable.edgesFocusable.edgesReconnectable.elevateNodesOnSelect.elevateEdgesOnSelect.minZoom.maxZoom.nodeExtent.onNodesChange.onEdgesChange.elementsSelectable.connectionMode.snapGrid.snapToGrid.translateExtent.connectOnClick.defaultEdgeOptions.fitView.fitViewOptions.onNodesDelete.onEdgesDelete.onDelete.onNodeDrag.onNodeDragStart.onNodeDragStop.onSelectionDrag.onSelectionDragStart.onSelectionDragStop.onMoveStart.onMove.onMoveEnd.noPanClassName.nodeOrigin.autoPanOnConnect.autoPanOnNodeDrag.onError.connectionRadius.isValidConnection.selectNodesOnDrag.nodeDragThreshold.connectionDragThreshold.onBeforeDelete.debug.autoPanSpeed.ariaLabelConfig.zIndexMode`.split(
      `.`,
    ),
    `rfId`,
  ],
  Bi = (e) => ({
    setNodes: e.setNodes,
    setEdges: e.setEdges,
    setMinZoom: e.setMinZoom,
    setMaxZoom: e.setMaxZoom,
    setTranslateExtent: e.setTranslateExtent,
    setNodeExtent: e.setNodeExtent,
    reset: e.reset,
    setDefaultNodesAndEdges: e.setDefaultNodesAndEdges,
  }),
  Vi = {
    translateExtent: jt,
    nodeOrigin: Li,
    minZoom: 0.5,
    maxZoom: 2,
    elementsSelectable: !0,
    noPanClassName: `nopan`,
    rfId: `1`,
  };
function Hi(e) {
  let {
      setNodes: t,
      setEdges: n,
      setMinZoom: r,
      setMaxZoom: i,
      setTranslateExtent: a,
      setNodeExtent: o,
      reset: s,
      setDefaultNodesAndEdges: c,
    } = Q(Bi, T),
    l = $();
  (0, M.useEffect)(
    () => (
      c(e.defaultNodes, e.defaultEdges),
      () => {
        ((u.current = Vi), s());
      }
    ),
    [],
  );
  let u = (0, M.useRef)(Vi);
  return (
    (0, M.useEffect)(
      () => {
        for (let s of zi) {
          let c = e[s];
          c !== u.current[s] &&
            e[s] !== void 0 &&
            (s === `nodes`
              ? t(c)
              : s === `edges`
                ? n(c)
                : s === `minZoom`
                  ? r(c)
                  : s === `maxZoom`
                    ? i(c)
                    : s === `translateExtent`
                      ? a(c)
                      : s === `nodeExtent`
                        ? o(c)
                        : s === `ariaLabelConfig`
                          ? l.setState({ ariaLabelConfig: On(c) })
                          : s === `fitView`
                            ? l.setState({ fitViewQueued: c })
                            : s === `fitViewOptions`
                              ? l.setState({ fitViewOptions: c })
                              : l.setState({ [s]: c }));
        }
        u.current = e;
      },
      zi.map((t) => e[t]),
    ),
    null
  );
}
function Ui() {
  return typeof window > `u` || !window.matchMedia
    ? null
    : window.matchMedia(`(prefers-color-scheme: dark)`);
}
function Wi(e) {
  let [t, n] = (0, M.useState)(e === `system` ? null : e);
  return (
    (0, M.useEffect)(() => {
      if (e !== `system`) {
        n(e);
        return;
      }
      let t = Ui(),
        r = () => n(t?.matches ? `dark` : `light`);
      return (
        r(),
        t?.addEventListener(`change`, r),
        () => {
          t?.removeEventListener(`change`, r);
        }
      );
    }, [e]),
    t === null ? (Ui()?.matches ? `dark` : `light`) : t
  );
}
var Gi = typeof document < `u` ? document : null;
function Ki(e = null, t = { target: Gi, actInsideInputWithModifier: !0 }) {
  let [n, r] = (0, M.useState)(!1),
    i = (0, M.useRef)(!1),
    a = (0, M.useRef)(new Set([])),
    [o, s] = (0, M.useMemo)(() => {
      if (e !== null) {
        let t = (Array.isArray(e) ? e : [e])
          .filter((e) => typeof e == `string`)
          .map((e) =>
            e
              .replace(
                `+`,
                `
`,
              )
              .replace(
                `

`,
                `
+`,
              ).split(`
`),
          );
        return [t, t.reduce((e, t) => e.concat(...t), [])];
      }
      return [[], []];
    }, [e]);
  return (
    (0, M.useEffect)(() => {
      let n = t?.target ?? Gi,
        c = t?.actInsideInputWithModifier ?? !0;
      if (e !== null) {
        let e = (e) => {
            if (
              ((i.current = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey),
              (!i.current || (i.current && !c)) && Nn(e))
            )
              return !1;
            let n = Ji(e.code, s);
            if ((a.current.add(e[n]), qi(o, a.current, !1))) {
              let n = e.composedPath?.()?.[0] || e.target,
                a = n?.nodeName === `BUTTON` || n?.nodeName === `A`;
              (t.preventDefault !== !1 &&
                (i.current || !a) &&
                e.preventDefault(),
                r(!0));
            }
          },
          l = (e) => {
            let t = Ji(e.code, s);
            (qi(o, a.current, !0)
              ? (r(!1), a.current.clear())
              : a.current.delete(e[t]),
              e.key === `Meta` && a.current.clear(),
              (i.current = !1));
          },
          u = () => {
            (a.current.clear(), r(!1));
          };
        return (
          n?.addEventListener(`keydown`, e),
          n?.addEventListener(`keyup`, l),
          window.addEventListener(`blur`, u),
          window.addEventListener(`contextmenu`, u),
          () => {
            (n?.removeEventListener(`keydown`, e),
              n?.removeEventListener(`keyup`, l),
              window.removeEventListener(`blur`, u),
              window.removeEventListener(`contextmenu`, u));
          }
        );
      }
    }, [e, r]),
    n
  );
}
function qi(e, t, n) {
  return e
    .filter((e) => n || e.length === t.size)
    .some((e) => e.every((e) => t.has(e)));
}
function Ji(e, t) {
  return t.includes(e) ? `code` : `key`;
}
var Yi = () => {
  let e = $();
  return (0, M.useMemo)(
    () => ({
      zoomIn: (t) => {
        let { panZoom: n } = e.getState();
        return n
          ? n.scaleBy(1.2, { duration: t?.duration })
          : Promise.resolve(!1);
      },
      zoomOut: (t) => {
        let { panZoom: n } = e.getState();
        return n
          ? n.scaleBy(1 / 1.2, { duration: t?.duration })
          : Promise.resolve(!1);
      },
      zoomTo: (t, n) => {
        let { panZoom: r } = e.getState();
        return r
          ? r.scaleTo(t, { duration: n?.duration })
          : Promise.resolve(!1);
      },
      getZoom: () => e.getState().transform[2],
      setViewport: async (t, n) => {
        let {
          transform: [r, i, a],
          panZoom: o,
        } = e.getState();
        return o
          ? (await o.setViewport(
              { x: t.x ?? r, y: t.y ?? i, zoom: t.zoom ?? a },
              n,
            ),
            Promise.resolve(!0))
          : Promise.resolve(!1);
      },
      getViewport: () => {
        let [t, n, r] = e.getState().transform;
        return { x: t, y: n, zoom: r };
      },
      setCenter: async (t, n, r) => e.getState().setCenter(t, n, r),
      fitBounds: async (t, n) => {
        let {
            width: r,
            height: i,
            minZoom: a,
            maxZoom: o,
            panZoom: s,
          } = e.getState(),
          c = xn(t, r, i, a, o, n?.padding ?? 0.1);
        return s
          ? (await s.setViewport(c, {
              duration: n?.duration,
              ease: n?.ease,
              interpolate: n?.interpolate,
            }),
            Promise.resolve(!0))
          : Promise.resolve(!1);
      },
      screenToFlowPosition: (t, n = {}) => {
        let {
          transform: r,
          snapGrid: i,
          snapToGrid: a,
          domNode: o,
        } = e.getState();
        if (!o) return t;
        let { x: s, y: c } = o.getBoundingClientRect(),
          l = { x: t.x - s, y: t.y - c },
          u = n.snapGrid ?? i;
        return gn(l, r, n.snapToGrid ?? a, u);
      },
      flowToScreenPosition: (t) => {
        let { transform: n, domNode: r } = e.getState();
        if (!r) return t;
        let { x: i, y: a } = r.getBoundingClientRect(),
          o = _n(t, n);
        return { x: o.x + i, y: o.y + a };
      },
    }),
    [],
  );
};
function Xi(e, t) {
  let n = [],
    r = new Map(),
    i = [];
  for (let t of e)
    if (t.type === `add`) {
      i.push(t);
      continue;
    } else if (t.type === `remove` || t.type === `replace`) r.set(t.id, [t]);
    else {
      let e = r.get(t.id);
      e ? e.push(t) : r.set(t.id, [t]);
    }
  for (let e of t) {
    let t = r.get(e.id);
    if (!t) {
      n.push(e);
      continue;
    }
    if (t[0].type === `remove`) continue;
    if (t[0].type === `replace`) {
      n.push({ ...t[0].item });
      continue;
    }
    let i = { ...e };
    for (let e of t) Zi(e, i);
    n.push(i);
  }
  return (
    i.length &&
      i.forEach((e) => {
        e.index === void 0
          ? n.push({ ...e.item })
          : n.splice(e.index, 0, { ...e.item });
      }),
    n
  );
}
function Zi(e, t) {
  switch (e.type) {
    case `select`:
      t.selected = e.selected;
      break;
    case `position`:
      (e.position !== void 0 && (t.position = e.position),
        e.dragging !== void 0 && (t.dragging = e.dragging));
      break;
    case `dimensions`:
      (e.dimensions !== void 0 &&
        ((t.measured = { ...e.dimensions }),
        e.setAttributes &&
          ((e.setAttributes === !0 || e.setAttributes === `width`) &&
            (t.width = e.dimensions.width),
          (e.setAttributes === !0 || e.setAttributes === `height`) &&
            (t.height = e.dimensions.height))),
        typeof e.resizing == `boolean` && (t.resizing = e.resizing));
      break;
  }
}
function Qi(e, t) {
  return Xi(e, t);
}
function $i(e, t) {
  return Xi(e, t);
}
function ea(e, t) {
  return { id: e, type: `select`, selected: t };
}
function ta(e, t = new Set(), n = !1) {
  let r = [];
  for (let [i, a] of e) {
    let e = t.has(i);
    !(a.selected === void 0 && !e) &&
      a.selected !== e &&
      (n && (a.selected = e), r.push(ea(a.id, e)));
  }
  return r;
}
function na({ items: e = [], lookup: t }) {
  let n = [],
    r = new Map(e.map((e) => [e.id, e]));
  for (let [r, i] of e.entries()) {
    let e = t.get(i.id),
      a = e?.internals?.userNode ?? e;
    (a !== void 0 && a !== i && n.push({ id: i.id, item: i, type: `replace` }),
      a === void 0 && n.push({ item: i, type: `add`, index: r }));
  }
  for (let [e] of t) r.get(e) === void 0 && n.push({ id: e, type: `remove` });
  return n;
}
function ra(e) {
  return { id: e.id, type: `remove` };
}
var ia = (e) => Ut(e),
  aa = (e) => Ht(e);
function oa(e) {
  return (0, M.forwardRef)(e);
}
var sa = typeof window < `u` ? M.useLayoutEffect : M.useEffect;
function ca(e) {
  let [t, n] = (0, M.useState)(BigInt(0)),
    [r] = (0, M.useState)(() => la(() => n((e) => e + BigInt(1))));
  return (
    sa(() => {
      let t = r.get();
      t.length && (e(t), r.reset());
    }, [t]),
    r
  );
}
function la(e) {
  let t = [];
  return {
    get: () => t,
    reset: () => {
      t = [];
    },
    push: (n) => {
      (t.push(n), e());
    },
  };
}
var ua = (0, M.createContext)(null);
function da({ children: e }) {
  let t = $(),
    n = ca(
      (0, M.useCallback)((e) => {
        let {
            nodes: n = [],
            setNodes: r,
            hasDefaultNodes: i,
            onNodesChange: a,
            nodeLookup: o,
            fitViewQueued: s,
            onNodesChangeMiddlewareMap: c,
          } = t.getState(),
          l = n;
        for (let t of e) l = typeof t == `function` ? t(l) : t;
        let u = na({ items: l, lookup: o });
        for (let e of c.values()) u = e(u);
        (i && r(l),
          u.length > 0
            ? a?.(u)
            : s &&
              window.requestAnimationFrame(() => {
                let { fitViewQueued: e, nodes: n, setNodes: r } = t.getState();
                e && r(n);
              }));
      }, []),
    ),
    r = ca(
      (0, M.useCallback)((e) => {
        let {
            edges: n = [],
            setEdges: r,
            hasDefaultEdges: i,
            onEdgesChange: a,
            edgeLookup: o,
          } = t.getState(),
          s = n;
        for (let t of e) s = typeof t == `function` ? t(s) : t;
        i ? r(s) : a && a(na({ items: s, lookup: o }));
      }, []),
    ),
    i = (0, M.useMemo)(() => ({ nodeQueue: n, edgeQueue: r }), []);
  return (0, R.jsx)(ua.Provider, { value: i, children: e });
}
function fa() {
  let e = (0, M.useContext)(ua);
  if (!e) throw Error(`useBatchContext must be used within a BatchProvider`);
  return e;
}
var pa = (e) => !!e.panZoom;
function ma() {
  let e = Yi(),
    t = $(),
    n = fa(),
    r = Q(pa),
    i = (0, M.useMemo)(() => {
      let e = (e) => t.getState().nodeLookup.get(e),
        r = (e) => {
          n.nodeQueue.push(e);
        },
        i = (e) => {
          n.edgeQueue.push(e);
        },
        a = (e) => {
          let { nodeLookup: n, nodeOrigin: r } = t.getState(),
            i = ia(e) ? e : n.get(e.id),
            a = i.parentId
              ? Tn(i.position, i.measured, i.parentId, n, r)
              : i.position;
          return ln({
            ...i,
            position: a,
            width: i.measured?.width ?? i.width,
            height: i.measured?.height ?? i.height,
          });
        },
        o = (e, t, n = { replace: !1 }) => {
          r((r) =>
            r.map((r) => {
              if (r.id === e) {
                let e = typeof t == `function` ? t(r) : t;
                return n.replace && ia(e) ? e : { ...r, ...e };
              }
              return r;
            }),
          );
        },
        s = (e, t, n = { replace: !1 }) => {
          i((r) =>
            r.map((r) => {
              if (r.id === e) {
                let e = typeof t == `function` ? t(r) : t;
                return n.replace && aa(e) ? e : { ...r, ...e };
              }
              return r;
            }),
          );
        };
      return {
        getNodes: () => t.getState().nodes.map((e) => ({ ...e })),
        getNode: (t) => e(t)?.internals.userNode,
        getInternalNode: e,
        getEdges: () => {
          let { edges: e = [] } = t.getState();
          return e.map((e) => ({ ...e }));
        },
        getEdge: (e) => t.getState().edgeLookup.get(e),
        setNodes: r,
        setEdges: i,
        addNodes: (e) => {
          let t = Array.isArray(e) ? e : [e];
          n.nodeQueue.push((e) => [...e, ...t]);
        },
        addEdges: (e) => {
          let t = Array.isArray(e) ? e : [e];
          n.edgeQueue.push((e) => [...e, ...t]);
        },
        toObject: () => {
          let { nodes: e = [], edges: n = [], transform: r } = t.getState(),
            [i, a, o] = r;
          return {
            nodes: e.map((e) => ({ ...e })),
            edges: n.map((e) => ({ ...e })),
            viewport: { x: i, y: a, zoom: o },
          };
        },
        deleteElements: async ({ nodes: e = [], edges: n = [] }) => {
          let {
              nodes: r,
              edges: i,
              onNodesDelete: a,
              onEdgesDelete: o,
              triggerNodeChanges: s,
              triggerEdgeChanges: c,
              onDelete: l,
              onBeforeDelete: u,
            } = t.getState(),
            { nodes: d, edges: f } = await $t({
              nodesToRemove: e,
              edgesToRemove: n,
              nodes: r,
              edges: i,
              onBeforeDelete: u,
            }),
            p = f.length > 0,
            m = d.length > 0;
          if (p) {
            let e = f.map(ra);
            (o?.(f), c(e));
          }
          if (m) {
            let e = d.map(ra);
            (a?.(d), s(e));
          }
          return (
            (m || p) && l?.({ nodes: d, edges: f }),
            { deletedNodes: d, deletedEdges: f }
          );
        },
        getIntersectingNodes: (e, n = !0, r) => {
          let i = pn(e),
            o = i ? e : a(e),
            s = r !== void 0;
          return o
            ? (r || t.getState().nodes).filter((r) => {
                let a = t.getState().nodeLookup.get(r.id);
                if (a && !i && (r.id === e.id || !a.internals.positionAbsolute))
                  return !1;
                let c = ln(s ? r : a),
                  l = fn(c, o);
                return (
                  (n && l > 0) ||
                  l >= c.width * c.height ||
                  l >= o.width * o.height
                );
              })
            : [];
        },
        isNodeIntersecting: (e, t, n = !0) => {
          let r = pn(e) ? e : a(e);
          if (!r) return !1;
          let i = fn(r, t);
          return (
            (n && i > 0) || i >= t.width * t.height || i >= r.width * r.height
          );
        },
        updateNode: o,
        updateNodeData: (e, t, n = { replace: !1 }) => {
          o(
            e,
            (e) => {
              let r = typeof t == `function` ? t(e) : t;
              return n.replace
                ? { ...e, data: r }
                : { ...e, data: { ...e.data, ...r } };
            },
            n,
          );
        },
        updateEdge: s,
        updateEdgeData: (e, t, n = { replace: !1 }) => {
          s(
            e,
            (e) => {
              let r = typeof t == `function` ? t(e) : t;
              return n.replace
                ? { ...e, data: r }
                : { ...e, data: { ...e.data, ...r } };
            },
            n,
          );
        },
        getNodesBounds: (e) => {
          let { nodeLookup: n, nodeOrigin: r } = t.getState();
          return Kt(e, { nodeLookup: n, nodeOrigin: r });
        },
        getHandleConnections: ({ type: e, id: n, nodeId: r }) =>
          Array.from(
            t
              .getState()
              .connectionLookup.get(`${r}-${e}${n ? `-${n}` : ``}`)
              ?.values() ?? [],
          ),
        getNodeConnections: ({ type: e, handleId: n, nodeId: r }) =>
          Array.from(
            t
              .getState()
              .connectionLookup.get(
                `${r}${e ? (n ? `-${e}-${n}` : `-${e}`) : ``}`,
              )
              ?.values() ?? [],
          ),
        fitView: async (e) => {
          let r = t.getState().fitViewResolver ?? Dn();
          return (
            t.setState({
              fitViewQueued: !0,
              fitViewOptions: e,
              fitViewResolver: r,
            }),
            n.nodeQueue.push((e) => [...e]),
            r.promise
          );
        },
      };
    }, []);
  return (0, M.useMemo)(() => ({ ...i, ...e, viewportInitialized: r }), [r]);
}
var ha = (e) => e.selected,
  ga = typeof window < `u` ? window : void 0;
function _a({ deleteKeyCode: e, multiSelectionKeyCode: t }) {
  let n = $(),
    { deleteElements: r } = ma(),
    i = Ki(e, { actInsideInputWithModifier: !1 }),
    a = Ki(t, { target: ga });
  ((0, M.useEffect)(() => {
    if (i) {
      let { edges: e, nodes: t } = n.getState();
      (r({ nodes: t.filter(ha), edges: e.filter(ha) }),
        n.setState({ nodesSelectionActive: !1 }));
    }
  }, [i]),
    (0, M.useEffect)(() => {
      n.setState({ multiSelectionActive: a });
    }, [a]));
}
function va(e) {
  let t = $();
  (0, M.useEffect)(() => {
    let n = () => {
      if (!e.current || !(e.current.checkVisibility?.() ?? !0)) return !1;
      let n = An(e.current);
      ((n.height === 0 || n.width === 0) &&
        t.getState().onError?.(`004`, q.error004()),
        t.setState({ width: n.width || 500, height: n.height || 500 }));
    };
    if (e.current) {
      (n(), window.addEventListener(`resize`, n));
      let t = new ResizeObserver(() => n());
      return (
        t.observe(e.current),
        () => {
          (window.removeEventListener(`resize`, n),
            t && e.current && t.unobserve(e.current));
        }
      );
    }
  }, []);
}
var ya = {
    position: `absolute`,
    width: `100%`,
    height: `100%`,
    top: 0,
    left: 0,
  },
  ba = (e) => ({
    userSelectionActive: e.userSelectionActive,
    lib: e.lib,
    connectionInProgress: e.connection.inProgress,
  });
function xa({
  onPaneContextMenu: e,
  zoomOnScroll: t = !0,
  zoomOnPinch: n = !0,
  panOnScroll: r = !1,
  panOnScrollSpeed: i = 0.5,
  panOnScrollMode: a = Ft.Free,
  zoomOnDoubleClick: o = !0,
  panOnDrag: s = !0,
  defaultViewport: c,
  translateExtent: l,
  minZoom: u,
  maxZoom: d,
  zoomActivationKeyCode: f,
  preventScrolling: p = !0,
  children: m,
  noWheelClassName: h,
  noPanClassName: g,
  onViewportChange: _,
  isControlledViewport: v,
  paneClickDistance: y,
  selectionOnDrag: b,
}) {
  let x = $(),
    S = (0, M.useRef)(null),
    { userSelectionActive: C, lib: w, connectionInProgress: E } = Q(ba, T),
    D = Ki(f),
    O = (0, M.useRef)();
  va(S);
  let k = (0, M.useCallback)(
    (e) => {
      (_?.({ x: e[0], y: e[1], zoom: e[2] }),
        v || x.setState({ transform: e }));
    },
    [_, v],
  );
  return (
    (0, M.useEffect)(() => {
      if (S.current) {
        O.current = ei({
          domNode: S.current,
          minZoom: u,
          maxZoom: d,
          translateExtent: l,
          viewport: c,
          onDraggingChange: (e) =>
            x.setState((t) => (t.paneDragging === e ? t : { paneDragging: e })),
          onPanZoomStart: (e, t) => {
            let { onViewportChangeStart: n, onMoveStart: r } = x.getState();
            (r?.(e, t), n?.(t));
          },
          onPanZoom: (e, t) => {
            let { onViewportChange: n, onMove: r } = x.getState();
            (r?.(e, t), n?.(t));
          },
          onPanZoomEnd: (e, t) => {
            let { onViewportChangeEnd: n, onMoveEnd: r } = x.getState();
            (r?.(e, t), n?.(t));
          },
        });
        let { x: e, y: t, zoom: n } = O.current.getViewport();
        return (
          x.setState({
            panZoom: O.current,
            transform: [e, t, n],
            domNode: S.current.closest(`.react-flow`),
          }),
          () => {
            O.current?.destroy();
          }
        );
      }
    }, []),
    (0, M.useEffect)(() => {
      O.current?.update({
        onPaneContextMenu: e,
        zoomOnScroll: t,
        zoomOnPinch: n,
        panOnScroll: r,
        panOnScrollSpeed: i,
        panOnScrollMode: a,
        zoomOnDoubleClick: o,
        panOnDrag: s,
        zoomActivationKeyPressed: D,
        preventScrolling: p,
        noPanClassName: g,
        userSelectionActive: C,
        noWheelClassName: h,
        lib: w,
        onTransformChange: k,
        connectionInProgress: E,
        selectionOnDrag: b,
        paneClickDistance: y,
      });
    }, [e, t, n, r, i, a, o, s, D, p, g, C, h, w, k, E, b, y]),
    (0, R.jsx)(`div`, {
      className: `react-flow__renderer`,
      ref: S,
      style: ya,
      children: m,
    })
  );
}
var Sa = (e) => ({
  userSelectionActive: e.userSelectionActive,
  userSelectionRect: e.userSelectionRect,
});
function Ca() {
  let { userSelectionActive: e, userSelectionRect: t } = Q(Sa, T);
  return e && t
    ? (0, R.jsx)(`div`, {
        className: `react-flow__selection react-flow__container`,
        style: {
          width: t.width,
          height: t.height,
          transform: `translate(${t.x}px, ${t.y}px)`,
        },
      })
    : null;
}
var wa = (e, t) => (n) => {
    n.target === t.current && e?.(n);
  },
  Ta = (e) => ({
    userSelectionActive: e.userSelectionActive,
    elementsSelectable: e.elementsSelectable,
    connectionInProgress: e.connection.inProgress,
    dragging: e.paneDragging,
  });
function Ea({
  isSelecting: e,
  selectionKeyPressed: t,
  selectionMode: n = It.Full,
  panOnDrag: r,
  paneClickDistance: i,
  selectionOnDrag: a,
  onSelectionStart: o,
  onSelectionEnd: s,
  onPaneClick: c,
  onPaneContextMenu: l,
  onPaneScroll: u,
  onPaneMouseEnter: d,
  onPaneMouseMove: f,
  onPaneMouseLeave: p,
  children: m,
}) {
  let h = $(),
    {
      userSelectionActive: g,
      elementsSelectable: _,
      dragging: y,
      connectionInProgress: b,
    } = Q(Ta, T),
    x = _ && (e || g),
    S = (0, M.useRef)(null),
    C = (0, M.useRef)(),
    w = (0, M.useRef)(new Set()),
    E = (0, M.useRef)(new Set()),
    D = (0, M.useRef)(!1),
    O = (e) => {
      if (D.current || b) {
        D.current = !1;
        return;
      }
      (c?.(e),
        h.getState().resetSelectedElements(),
        h.setState({ nodesSelectionActive: !1 }));
    },
    k = (e) => {
      if (Array.isArray(r) && r?.includes(2)) {
        e.preventDefault();
        return;
      }
      l?.(e);
    },
    A = u ? (e) => u(e) : void 0;
  return (0, R.jsxs)(`div`, {
    className: v([
      `react-flow__pane`,
      {
        draggable: r === !0 || (Array.isArray(r) && r.includes(0)),
        dragging: y,
        selection: e,
      },
    ]),
    onClick: x ? void 0 : wa(O, S),
    onContextMenu: wa(k, S),
    onWheel: wa(A, S),
    onPointerEnter: x ? void 0 : d,
    onPointerMove: x
      ? (e) => {
          let {
            userSelectionRect: r,
            transform: a,
            nodeLookup: s,
            edgeLookup: c,
            connectionLookup: l,
            triggerNodeChanges: u,
            triggerEdgeChanges: d,
            defaultEdgeOptions: f,
            resetSelectedElements: p,
          } = h.getState();
          if (!C.current || !r) return;
          let { x: m, y: g } = Z(e.nativeEvent, C.current),
            { startX: _, startY: v } = r;
          if (!D.current) {
            let n = t ? 0 : i;
            if (Math.hypot(m - _, g - v) <= n) return;
            (p(), o?.(e));
          }
          D.current = !0;
          let y = {
              startX: _,
              startY: v,
              x: m < _ ? m : _,
              y: g < v ? g : v,
              width: Math.abs(m - _),
              height: Math.abs(g - v),
            },
            b = w.current,
            x = E.current;
          ((w.current = new Set(
            Jt(s, y, a, n === It.Partial, !0).map((e) => e.id),
          )),
            (E.current = new Set()));
          let S = f?.selectable ?? !0;
          for (let e of w.current) {
            let t = l.get(e);
            if (t)
              for (let { edgeId: e } of t.values()) {
                let t = c.get(e);
                t && (t.selectable ?? S) && E.current.add(e);
              }
          }
          (En(b, w.current) || u(ta(s, w.current, !0)),
            En(x, E.current) || d(ta(c, E.current)),
            h.setState({
              userSelectionRect: y,
              userSelectionActive: !0,
              nodesSelectionActive: !1,
            }));
        }
      : f,
    onPointerUp: x
      ? (e) => {
          e.button === 0 &&
            (e.target?.releasePointerCapture?.(e.pointerId),
            !g &&
              e.target === S.current &&
              h.getState().userSelectionRect &&
              O?.(e),
            h.setState({ userSelectionActive: !1, userSelectionRect: null }),
            D.current &&
              (s?.(e),
              h.setState({ nodesSelectionActive: w.current.size > 0 })));
        }
      : void 0,
    onPointerDownCapture: x
      ? (n) => {
          let { domNode: r } = h.getState();
          if (((C.current = r?.getBoundingClientRect()), !C.current)) return;
          let i = n.target === S.current;
          if (
            (!i && n.target.closest(`.nokey`)) ||
            !e ||
            !((a && i) || t) ||
            n.button !== 0 ||
            !n.isPrimary
          )
            return;
          (n.target?.setPointerCapture?.(n.pointerId), (D.current = !1));
          let { x: o, y: s } = Z(n.nativeEvent, C.current);
          (h.setState({
            userSelectionRect: {
              width: 0,
              height: 0,
              startX: o,
              startY: s,
              x: o,
              y: s,
            },
          }),
            i || (n.stopPropagation(), n.preventDefault()));
        }
      : void 0,
    onClickCapture: x
      ? (e) => {
          D.current &&= (e.stopPropagation(), !1);
        }
      : void 0,
    onPointerLeave: p,
    ref: S,
    style: ya,
    children: [m, (0, R.jsx)(Ca, {})],
  });
}
function Da({ id: e, store: t, unselect: n = !1, nodeRef: r }) {
  let {
      addSelectedNodes: i,
      unselectNodesAndEdges: a,
      multiSelectionActive: o,
      nodeLookup: s,
      onError: c,
    } = t.getState(),
    l = s.get(e);
  if (!l) {
    c?.(`012`, q.error012(e));
    return;
  }
  (t.setState({ nodesSelectionActive: !1 }),
    l.selected
      ? (n || (l.selected && o)) &&
        (a({ nodes: [l], edges: [] }),
        requestAnimationFrame(() => r?.current?.blur()))
      : i([e]));
}
function Oa({
  nodeRef: e,
  disabled: t = !1,
  noDragClassName: n,
  handleSelector: r,
  nodeId: i,
  isSelectable: a,
  nodeClickDistance: o,
}) {
  let s = $(),
    [c, l] = (0, M.useState)(!1),
    u = (0, M.useRef)();
  return (
    (0, M.useEffect)(() => {
      u.current = kr({
        getStoreItems: () => s.getState(),
        onNodeMouseDown: (t) => {
          Da({ id: t, store: s, nodeRef: e });
        },
        onDragStart: () => {
          l(!0);
        },
        onDragStop: () => {
          l(!1);
        },
      });
    }, []),
    (0, M.useEffect)(() => {
      if (!(t || !e.current || !u.current))
        return (
          u.current.update({
            noDragClassName: n,
            handleSelector: r,
            domNode: e.current,
            isSelectable: a,
            nodeId: i,
            nodeClickDistance: o,
          }),
          () => {
            u.current?.destroy();
          }
        );
    }, [n, r, t, a, e, i, o]),
    c
  );
}
var ka = (e) => (t) =>
  t.selected && (t.draggable || (e && t.draggable === void 0));
function Aa() {
  let e = $();
  return (0, M.useCallback)((t) => {
    let {
        nodeExtent: n,
        snapToGrid: r,
        snapGrid: i,
        nodesDraggable: a,
        onError: o,
        updateNodePositions: s,
        nodeLookup: c,
        nodeOrigin: l,
      } = e.getState(),
      u = new Map(),
      d = ka(a),
      f = r ? i[0] : 5,
      p = r ? i[1] : 5,
      m = t.direction.x * f * t.factor,
      h = t.direction.y * p * t.factor;
    for (let [, e] of c) {
      if (!d(e)) continue;
      let t = {
        x: e.internals.positionAbsolute.x + m,
        y: e.internals.positionAbsolute.y + h,
      };
      r && (t = hn(t, i));
      let { position: a, positionAbsolute: s } = Qt({
        nodeId: e.id,
        nextPosition: t,
        nodeLookup: c,
        nodeExtent: n,
        nodeOrigin: l,
        onError: o,
      });
      ((e.position = a), (e.internals.positionAbsolute = s), u.set(e.id, e));
    }
    s(u);
  }, []);
}
var ja = (0, M.createContext)(null),
  Ma = ja.Provider;
ja.Consumer;
var Na = () => (0, M.useContext)(ja),
  Pa = (e) => ({
    connectOnClick: e.connectOnClick,
    noPanClassName: e.noPanClassName,
    rfId: e.rfId,
  }),
  Fa = (e, t, n) => (r) => {
    let { connectionClickStartHandle: i, connectionMode: a, connection: o } = r,
      { fromHandle: s, toHandle: c, isValid: l } = o,
      u = c?.nodeId === e && c?.id === t && c?.type === n;
    return {
      connectingFrom: s?.nodeId === e && s?.id === t && s?.type === n,
      connectingTo: u,
      clickConnecting: i?.nodeId === e && i?.id === t && i?.type === n,
      isPossibleEndHandle:
        a === Pt.Strict ? s?.type !== n : e !== s?.nodeId || t !== s?.id,
      connectionInProcess: !!s,
      clickConnectionInProcess: !!i,
      valid: u && l,
    };
  };
function Ia(
  {
    type: e = `source`,
    position: t = J.Top,
    isValidConnection: n,
    isConnectable: r = !0,
    isConnectableStart: i = !0,
    isConnectableEnd: a = !0,
    id: o,
    onConnect: s,
    children: c,
    className: l,
    onMouseDown: u,
    onTouchStart: d,
    ...f
  },
  p,
) {
  let m = o || null,
    h = e === `target`,
    g = $(),
    _ = Na(),
    { connectOnClick: y, noPanClassName: b, rfId: x } = Q(Pa, T),
    {
      connectingFrom: S,
      connectingTo: C,
      clickConnecting: w,
      isPossibleEndHandle: E,
      connectionInProcess: D,
      clickConnectionInProcess: O,
      valid: k,
    } = Q(Fa(_, m, e), T);
  _ || g.getState().onError?.(`010`, q.error010());
  let A = (e) => {
      let {
          defaultEdgeOptions: t,
          onConnect: n,
          hasDefaultEdges: r,
        } = g.getState(),
        i = { ...t, ...e };
      if (r) {
        let { edges: e, setEdges: t } = g.getState();
        t(Gn(i, e));
      }
      (n?.(i), s?.(i));
    },
    j = (e) => {
      if (!_) return;
      let t = Pn(e.nativeEvent);
      if (i && ((t && e.button === 0) || !t)) {
        let t = g.getState();
        zr.onPointerDown(e.nativeEvent, {
          handleDomNode: e.currentTarget,
          autoPanOnConnect: t.autoPanOnConnect,
          connectionMode: t.connectionMode,
          connectionRadius: t.connectionRadius,
          domNode: t.domNode,
          nodeLookup: t.nodeLookup,
          lib: t.lib,
          isTarget: h,
          handleId: m,
          nodeId: _,
          flowId: t.rfId,
          panBy: t.panBy,
          cancelConnection: t.cancelConnection,
          onConnectStart: t.onConnectStart,
          onConnectEnd: (...e) => g.getState().onConnectEnd?.(...e),
          updateConnection: t.updateConnection,
          onConnect: A,
          isValidConnection:
            n || ((...e) => g.getState().isValidConnection?.(...e) ?? !0),
          getTransform: () => g.getState().transform,
          getFromHandle: () => g.getState().connection.fromHandle,
          autoPanSpeed: t.autoPanSpeed,
          dragThreshold: t.connectionDragThreshold,
        });
      }
      t ? u?.(e) : d?.(e);
    };
  return (0, R.jsx)(`div`, {
    "data-handleid": m,
    "data-nodeid": _,
    "data-handlepos": t,
    "data-id": `${x}-${_}-${m}-${e}`,
    className: v([
      `react-flow__handle`,
      `react-flow__handle-${t}`,
      `nodrag`,
      b,
      l,
      {
        source: !h,
        target: h,
        connectable: r,
        connectablestart: i,
        connectableend: a,
        clickconnecting: w,
        connectingfrom: S,
        connectingto: C,
        valid: k,
        connectionindicator: r && (!D || E) && (D || O ? a : i),
      },
    ]),
    onMouseDown: j,
    onTouchStart: j,
    onClick: y
      ? (t) => {
          let {
            onClickConnectStart: r,
            onClickConnectEnd: a,
            connectionClickStartHandle: o,
            connectionMode: s,
            isValidConnection: c,
            lib: l,
            rfId: u,
            nodeLookup: d,
            connection: f,
          } = g.getState();
          if (!_ || (!o && !i)) return;
          if (!o) {
            (r?.(t.nativeEvent, { nodeId: _, handleId: m, handleType: e }),
              g.setState({
                connectionClickStartHandle: { nodeId: _, type: e, id: m },
              }));
            return;
          }
          let p = jn(t.target),
            h = n || c,
            { connection: v, isValid: y } = zr.isValid(t.nativeEvent, {
              handle: { nodeId: _, id: m, type: e },
              connectionMode: s,
              fromNodeId: o.nodeId,
              fromHandleId: o.id || null,
              fromType: o.type,
              isValidConnection: h,
              flowId: u,
              doc: p,
              lib: l,
              nodeLookup: d,
            });
          y && v && A(v);
          let b = structuredClone(f);
          (delete b.inProgress,
            (b.toPosition = b.toHandle ? b.toHandle.position : null),
            a?.(t, b),
            g.setState({ connectionClickStartHandle: null }));
        }
      : void 0,
    ref: p,
    ...f,
    children: c,
  });
}
var La = (0, M.memo)(oa(Ia));
function Ra({ data: e, isConnectable: t, sourcePosition: n = J.Bottom }) {
  return (0, R.jsxs)(R.Fragment, {
    children: [
      e?.label,
      (0, R.jsx)(La, { type: `source`, position: n, isConnectable: t }),
    ],
  });
}
function za({
  data: e,
  isConnectable: t,
  targetPosition: n = J.Top,
  sourcePosition: r = J.Bottom,
}) {
  return (0, R.jsxs)(R.Fragment, {
    children: [
      (0, R.jsx)(La, { type: `target`, position: n, isConnectable: t }),
      e?.label,
      (0, R.jsx)(La, { type: `source`, position: r, isConnectable: t }),
    ],
  });
}
function Ba() {
  return null;
}
function Va({ data: e, isConnectable: t, targetPosition: n = J.Top }) {
  return (0, R.jsxs)(R.Fragment, {
    children: [
      (0, R.jsx)(La, { type: `target`, position: n, isConnectable: t }),
      e?.label,
    ],
  });
}
var Ha = {
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
  },
  Ua = { input: Ra, default: za, output: Va, group: Ba };
function Wa(e) {
  return e.internals.handleBounds === void 0
    ? {
        width: e.width ?? e.initialWidth ?? e.style?.width,
        height: e.height ?? e.initialHeight ?? e.style?.height,
      }
    : { width: e.width ?? e.style?.width, height: e.height ?? e.style?.height };
}
var Ga = (e) => {
  let {
    width: t,
    height: n,
    x: r,
    y: i,
  } = qt(e.nodeLookup, { filter: (e) => !!e.selected });
  return {
    width: Y(t) ? t : null,
    height: Y(n) ? n : null,
    userSelectionActive: e.userSelectionActive,
    transformString: `translate(${e.transform[0]}px,${e.transform[1]}px) scale(${e.transform[2]}) translate(${r}px,${i}px)`,
  };
};
function Ka({
  onSelectionContextMenu: e,
  noPanClassName: t,
  disableKeyboardA11y: n,
}) {
  let r = $(),
    {
      width: i,
      height: a,
      transformString: o,
      userSelectionActive: s,
    } = Q(Ga, T),
    c = Aa(),
    l = (0, M.useRef)(null);
  (0, M.useEffect)(() => {
    n || l.current?.focus({ preventScroll: !0 });
  }, [n]);
  let u = !s && i !== null && a !== null;
  if ((Oa({ nodeRef: l, disabled: !u }), !u)) return null;
  let d = e
    ? (t) => {
        e(
          t,
          r.getState().nodes.filter((e) => e.selected),
        );
      }
    : void 0;
  return (0, R.jsx)(`div`, {
    className: v([`react-flow__nodesselection`, `react-flow__container`, t]),
    style: { transform: o },
    children: (0, R.jsx)(`div`, {
      ref: l,
      className: `react-flow__nodesselection-rect`,
      onContextMenu: d,
      tabIndex: n ? void 0 : -1,
      onKeyDown: n
        ? void 0
        : (e) => {
            Object.prototype.hasOwnProperty.call(Ha, e.key) &&
              (e.preventDefault(),
              c({ direction: Ha[e.key], factor: e.shiftKey ? 4 : 1 }));
          },
      style: { width: i, height: a },
    }),
  });
}
var qa = typeof window < `u` ? window : void 0,
  Ja = (e) => ({
    nodesSelectionActive: e.nodesSelectionActive,
    userSelectionActive: e.userSelectionActive,
  });
function Ya({
  children: e,
  onPaneClick: t,
  onPaneMouseEnter: n,
  onPaneMouseMove: r,
  onPaneMouseLeave: i,
  onPaneContextMenu: a,
  onPaneScroll: o,
  paneClickDistance: s,
  deleteKeyCode: c,
  selectionKeyCode: l,
  selectionOnDrag: u,
  selectionMode: d,
  onSelectionStart: f,
  onSelectionEnd: p,
  multiSelectionKeyCode: m,
  panActivationKeyCode: h,
  zoomActivationKeyCode: g,
  elementsSelectable: _,
  zoomOnScroll: v,
  zoomOnPinch: y,
  panOnScroll: b,
  panOnScrollSpeed: x,
  panOnScrollMode: S,
  zoomOnDoubleClick: C,
  panOnDrag: w,
  defaultViewport: E,
  translateExtent: D,
  minZoom: O,
  maxZoom: k,
  preventScrolling: A,
  onSelectionContextMenu: j,
  noWheelClassName: M,
  noPanClassName: N,
  disableKeyboardA11y: P,
  onViewportChange: F,
  isControlledViewport: I,
}) {
  let { nodesSelectionActive: L, userSelectionActive: z } = Q(Ja, T),
    B = Ki(l, { target: qa }),
    V = Ki(h, { target: qa }),
    H = V || w,
    U = V || b,
    W = u && H !== !0,
    G = B || z || W;
  return (
    _a({ deleteKeyCode: c, multiSelectionKeyCode: m }),
    (0, R.jsx)(xa, {
      onPaneContextMenu: a,
      elementsSelectable: _,
      zoomOnScroll: v,
      zoomOnPinch: y,
      panOnScroll: U,
      panOnScrollSpeed: x,
      panOnScrollMode: S,
      zoomOnDoubleClick: C,
      panOnDrag: !B && H,
      defaultViewport: E,
      translateExtent: D,
      minZoom: O,
      maxZoom: k,
      zoomActivationKeyCode: g,
      preventScrolling: A,
      noWheelClassName: M,
      noPanClassName: N,
      onViewportChange: F,
      isControlledViewport: I,
      paneClickDistance: s,
      selectionOnDrag: W,
      children: (0, R.jsxs)(Ea, {
        onSelectionStart: f,
        onSelectionEnd: p,
        onPaneClick: t,
        onPaneMouseEnter: n,
        onPaneMouseMove: r,
        onPaneMouseLeave: i,
        onPaneContextMenu: a,
        onPaneScroll: o,
        panOnDrag: H,
        isSelecting: !!G,
        selectionMode: d,
        selectionKeyPressed: B,
        paneClickDistance: s,
        selectionOnDrag: W,
        children: [
          e,
          L &&
            (0, R.jsx)(Ka, {
              onSelectionContextMenu: j,
              noPanClassName: N,
              disableKeyboardA11y: P,
            }),
        ],
      }),
    })
  );
}
Ya.displayName = `FlowRenderer`;
var Xa = (0, M.memo)(Ya),
  Za = (e) => (t) =>
    e
      ? Jt(
          t.nodeLookup,
          { x: 0, y: 0, width: t.width, height: t.height },
          t.transform,
          !0,
        ).map((e) => e.id)
      : Array.from(t.nodeLookup.keys());
function Qa(e) {
  return Q((0, M.useCallback)(Za(e), [e]), T);
}
var $a = (e) => e.updateNodeInternals;
function eo() {
  let e = Q($a),
    [t] = (0, M.useState)(() =>
      typeof ResizeObserver > `u`
        ? null
        : new ResizeObserver((t) => {
            let n = new Map();
            (t.forEach((e) => {
              let t = e.target.getAttribute(`data-id`);
              n.set(t, { id: t, nodeElement: e.target, force: !0 });
            }),
              e(n));
          }),
    );
  return (
    (0, M.useEffect)(
      () => () => {
        t?.disconnect();
      },
      [t],
    ),
    t
  );
}
function to({ node: e, nodeType: t, hasDimensions: n, resizeObserver: r }) {
  let i = $(),
    a = (0, M.useRef)(null),
    o = (0, M.useRef)(null),
    s = (0, M.useRef)(e.sourcePosition),
    c = (0, M.useRef)(e.targetPosition),
    l = (0, M.useRef)(t),
    u = n && !!e.internals.handleBounds;
  return (
    (0, M.useEffect)(() => {
      a.current &&
        !e.hidden &&
        (!u || o.current !== a.current) &&
        (o.current && r?.unobserve(o.current),
        r?.observe(a.current),
        (o.current = a.current));
    }, [u, e.hidden]),
    (0, M.useEffect)(
      () => () => {
        o.current &&= (r?.unobserve(o.current), null);
      },
      [],
    ),
    (0, M.useEffect)(() => {
      if (a.current) {
        let n = l.current !== t,
          r = s.current !== e.sourcePosition,
          o = c.current !== e.targetPosition;
        (n || r || o) &&
          ((l.current = t),
          (s.current = e.sourcePosition),
          (c.current = e.targetPosition),
          i
            .getState()
            .updateNodeInternals(
              new Map([
                [e.id, { id: e.id, nodeElement: a.current, force: !0 }],
              ]),
            ));
      }
    }, [e.id, t, e.sourcePosition, e.targetPosition]),
    a
  );
}
function no({
  id: e,
  onClick: t,
  onMouseEnter: n,
  onMouseMove: r,
  onMouseLeave: i,
  onContextMenu: a,
  onDoubleClick: o,
  nodesDraggable: s,
  elementsSelectable: c,
  nodesConnectable: l,
  nodesFocusable: u,
  resizeObserver: d,
  noDragClassName: f,
  noPanClassName: p,
  disableKeyboardA11y: m,
  rfId: h,
  nodeTypes: g,
  nodeClickDistance: _,
  onError: y,
}) {
  let {
      node: b,
      internals: x,
      isParent: S,
    } = Q((t) => {
      let n = t.nodeLookup.get(e),
        r = t.parentLookup.has(e);
      return { node: n, internals: n.internals, isParent: r };
    }, T),
    C = b.type || `default`,
    w = g?.[C] || Ua[C];
  w === void 0 &&
    (y?.(`003`, q.error003(C)),
    (C = `default`),
    (w = g?.default || Ua.default));
  let E = !!(b.draggable || (s && b.draggable === void 0)),
    D = !!(b.selectable || (c && b.selectable === void 0)),
    O = !!(b.connectable || (l && b.connectable === void 0)),
    k = !!(b.focusable || (u && b.focusable === void 0)),
    A = $(),
    j = wn(b),
    M = to({ node: b, nodeType: C, hasDimensions: j, resizeObserver: d }),
    N = Oa({
      nodeRef: M,
      disabled: b.hidden || !E,
      noDragClassName: f,
      handleSelector: b.dragHandle,
      nodeId: e,
      isSelectable: D,
      nodeClickDistance: _,
    }),
    P = Aa();
  if (b.hidden) return null;
  let F = X(b),
    I = Wa(b),
    L = D || E || t || n || r || i,
    z = n ? (e) => n(e, { ...x.userNode }) : void 0,
    B = r ? (e) => r(e, { ...x.userNode }) : void 0,
    V = i ? (e) => i(e, { ...x.userNode }) : void 0,
    H = a ? (e) => a(e, { ...x.userNode }) : void 0,
    U = o ? (e) => o(e, { ...x.userNode }) : void 0,
    W = (n) => {
      let { selectNodesOnDrag: r, nodeDragThreshold: i } = A.getState();
      (D && (!r || !E || i > 0) && Da({ id: e, store: A, nodeRef: M }),
        t && t(n, { ...x.userNode }));
    },
    G = (t) => {
      if (!(Nn(t.nativeEvent) || m)) {
        if (Mt.includes(t.key) && D)
          Da({ id: e, store: A, unselect: t.key === `Escape`, nodeRef: M });
        else if (
          E &&
          b.selected &&
          Object.prototype.hasOwnProperty.call(Ha, t.key)
        ) {
          t.preventDefault();
          let { ariaLabelConfig: e } = A.getState();
          (A.setState({
            ariaLiveMessage: e[`node.a11yDescription.ariaLiveMessage`]({
              direction: t.key.replace(`Arrow`, ``).toLowerCase(),
              x: ~~x.positionAbsolute.x,
              y: ~~x.positionAbsolute.y,
            }),
          }),
            P({ direction: Ha[t.key], factor: t.shiftKey ? 4 : 1 }));
        }
      }
    },
    ee = () => {
      if (m || !M.current?.matches(`:focus-visible`)) return;
      let {
        transform: t,
        width: n,
        height: r,
        autoPanOnNodeFocus: i,
        setCenter: a,
      } = A.getState();
      i &&
        (Jt(new Map([[e, b]]), { x: 0, y: 0, width: n, height: r }, t, !0)
          .length > 0 ||
          a(b.position.x + F.width / 2, b.position.y + F.height / 2, {
            zoom: t[2],
          }));
    };
  return (0, R.jsx)(`div`, {
    className: v([
      `react-flow__node`,
      `react-flow__node-${C}`,
      { [p]: E },
      b.className,
      {
        selected: b.selected,
        selectable: D,
        parent: S,
        draggable: E,
        dragging: N,
      },
    ]),
    ref: M,
    style: {
      zIndex: x.z,
      transform: `translate(${x.positionAbsolute.x}px,${x.positionAbsolute.y}px)`,
      pointerEvents: L ? `all` : `none`,
      visibility: j ? `visible` : `hidden`,
      ...b.style,
      ...I,
    },
    "data-id": e,
    "data-testid": `rf__node-${e}`,
    onMouseEnter: z,
    onMouseMove: B,
    onMouseLeave: V,
    onContextMenu: H,
    onClick: W,
    onDoubleClick: U,
    onKeyDown: k ? G : void 0,
    tabIndex: k ? 0 : void 0,
    onFocus: k ? ee : void 0,
    role: b.ariaRole ?? (k ? `group` : void 0),
    "aria-roledescription": `node`,
    "aria-describedby": m ? void 0 : `${Si}-${h}`,
    "aria-label": b.ariaLabel,
    ...b.domAttributes,
    children: (0, R.jsx)(Ma, {
      value: e,
      children: (0, R.jsx)(w, {
        id: e,
        data: b.data,
        type: C,
        positionAbsoluteX: x.positionAbsolute.x,
        positionAbsoluteY: x.positionAbsolute.y,
        selected: b.selected ?? !1,
        selectable: D,
        draggable: E,
        deletable: b.deletable ?? !0,
        isConnectable: O,
        sourcePosition: b.sourcePosition,
        targetPosition: b.targetPosition,
        dragging: N,
        dragHandle: b.dragHandle,
        zIndex: x.z,
        parentId: b.parentId,
        ...F,
      }),
    }),
  });
}
var ro = (0, M.memo)(no),
  io = (e) => ({
    nodesDraggable: e.nodesDraggable,
    nodesConnectable: e.nodesConnectable,
    nodesFocusable: e.nodesFocusable,
    elementsSelectable: e.elementsSelectable,
    onError: e.onError,
  });
function ao(e) {
  let {
      nodesDraggable: t,
      nodesConnectable: n,
      nodesFocusable: r,
      elementsSelectable: i,
      onError: a,
    } = Q(io, T),
    o = Qa(e.onlyRenderVisibleElements),
    s = eo();
  return (0, R.jsx)(`div`, {
    className: `react-flow__nodes`,
    style: ya,
    children: o.map((o) =>
      (0, R.jsx)(
        ro,
        {
          id: o,
          nodeTypes: e.nodeTypes,
          nodeExtent: e.nodeExtent,
          onClick: e.onNodeClick,
          onMouseEnter: e.onNodeMouseEnter,
          onMouseMove: e.onNodeMouseMove,
          onMouseLeave: e.onNodeMouseLeave,
          onContextMenu: e.onNodeContextMenu,
          onDoubleClick: e.onNodeDoubleClick,
          noDragClassName: e.noDragClassName,
          noPanClassName: e.noPanClassName,
          rfId: e.rfId,
          disableKeyboardA11y: e.disableKeyboardA11y,
          resizeObserver: s,
          nodesDraggable: t,
          nodesConnectable: n,
          nodesFocusable: r,
          elementsSelectable: i,
          nodeClickDistance: e.nodeClickDistance,
          onError: a,
        },
        o,
      ),
    ),
  });
}
ao.displayName = `NodeRenderer`;
var oo = (0, M.memo)(ao);
function so(e) {
  return Q(
    (0, M.useCallback)(
      (t) => {
        if (!e) return t.edges.map((e) => e.id);
        let n = [];
        if (t.width && t.height)
          for (let e of t.edges) {
            let r = t.nodeLookup.get(e.source),
              i = t.nodeLookup.get(e.target);
            r &&
              i &&
              Hn({
                sourceNode: r,
                targetNode: i,
                width: t.width,
                height: t.height,
                transform: t.transform,
              }) &&
              n.push(e.id);
          }
        return n;
      },
      [e],
    ),
    T,
  );
}
var co = ({ color: e = `none`, strokeWidth: t = 1 }) =>
    (0, R.jsx)(`polyline`, {
      className: `arrow`,
      style: { strokeWidth: t, ...(e && { stroke: e }) },
      strokeLinecap: `round`,
      fill: `none`,
      strokeLinejoin: `round`,
      points: `-5,-4 0,0 -5,4`,
    }),
  lo = ({ color: e = `none`, strokeWidth: t = 1 }) =>
    (0, R.jsx)(`polyline`, {
      className: `arrowclosed`,
      style: { strokeWidth: t, ...(e && { stroke: e, fill: e }) },
      strokeLinecap: `round`,
      strokeLinejoin: `round`,
      points: `-5,-4 0,0 -5,4 -5,-4`,
    }),
  uo = { [zt.Arrow]: co, [zt.ArrowClosed]: lo };
function fo(e) {
  let t = $();
  return (0, M.useMemo)(
    () =>
      Object.prototype.hasOwnProperty.call(uo, e)
        ? uo[e]
        : (t.getState().onError?.(`009`, q.error009(e)), null),
    [e],
  );
}
var po = ({
    id: e,
    type: t,
    color: n,
    width: r = 12.5,
    height: i = 12.5,
    markerUnits: a = `strokeWidth`,
    strokeWidth: o,
    orient: s = `auto-start-reverse`,
  }) => {
    let c = fo(t);
    return c
      ? (0, R.jsx)(`marker`, {
          className: `react-flow__arrowhead`,
          id: e,
          markerWidth: `${r}`,
          markerHeight: `${i}`,
          viewBox: `-10 -10 20 20`,
          markerUnits: a,
          orient: s,
          refX: `0`,
          refY: `0`,
          children: (0, R.jsx)(c, { color: n, strokeWidth: o }),
        })
      : null;
  },
  mo = ({ defaultColor: e, rfId: t }) => {
    let n = Q((e) => e.edges),
      r = Q((e) => e.defaultEdgeOptions),
      i = (0, M.useMemo)(
        () =>
          ar(n, {
            id: t,
            defaultColor: e,
            defaultMarkerStart: r?.markerStart,
            defaultMarkerEnd: r?.markerEnd,
          }),
        [n, r, t, e],
      );
    return i.length
      ? (0, R.jsx)(`svg`, {
          className: `react-flow__marker`,
          "aria-hidden": `true`,
          children: (0, R.jsx)(`defs`, {
            children: i.map((e) =>
              (0, R.jsx)(
                po,
                {
                  id: e.id,
                  type: e.type,
                  color: e.color,
                  width: e.width,
                  height: e.height,
                  markerUnits: e.markerUnits,
                  strokeWidth: e.strokeWidth,
                  orient: e.orient,
                },
                e.id,
              ),
            ),
          }),
        })
      : null;
  };
mo.displayName = `MarkerDefinitions`;
var ho = (0, M.memo)(mo);
function go({
  x: e,
  y: t,
  label: n,
  labelStyle: r,
  labelShowBg: i = !0,
  labelBgStyle: a,
  labelBgPadding: o = [2, 4],
  labelBgBorderRadius: s = 2,
  children: c,
  className: l,
  ...u
}) {
  let [d, f] = (0, M.useState)({ x: 1, y: 0, width: 0, height: 0 }),
    p = v([`react-flow__edge-textwrapper`, l]),
    m = (0, M.useRef)(null);
  return (
    (0, M.useEffect)(() => {
      if (m.current) {
        let e = m.current.getBBox();
        f({ x: e.x, y: e.y, width: e.width, height: e.height });
      }
    }, [n]),
    n
      ? (0, R.jsxs)(`g`, {
          transform: `translate(${e - d.width / 2} ${t - d.height / 2})`,
          className: p,
          visibility: d.width ? `visible` : `hidden`,
          ...u,
          children: [
            i &&
              (0, R.jsx)(`rect`, {
                width: d.width + 2 * o[0],
                x: -o[0],
                y: -o[1],
                height: d.height + 2 * o[1],
                className: `react-flow__edge-textbg`,
                style: a,
                rx: s,
                ry: s,
              }),
            (0, R.jsx)(`text`, {
              className: `react-flow__edge-text`,
              y: d.height / 2,
              dy: `0.3em`,
              ref: m,
              style: r,
              children: n,
            }),
            c,
          ],
        })
      : null
  );
}
go.displayName = `EdgeText`;
var _o = (0, M.memo)(go);
function vo({
  path: e,
  labelX: t,
  labelY: n,
  label: r,
  labelStyle: i,
  labelShowBg: a,
  labelBgStyle: o,
  labelBgPadding: s,
  labelBgBorderRadius: c,
  interactionWidth: l = 20,
  ...u
}) {
  return (0, R.jsxs)(R.Fragment, {
    children: [
      (0, R.jsx)(`path`, {
        ...u,
        d: e,
        fill: `none`,
        className: v([`react-flow__edge-path`, u.className]),
      }),
      l
        ? (0, R.jsx)(`path`, {
            d: e,
            fill: `none`,
            strokeOpacity: 0,
            strokeWidth: l,
            className: `react-flow__edge-interaction`,
          })
        : null,
      r && Y(t) && Y(n)
        ? (0, R.jsx)(_o, {
            x: t,
            y: n,
            label: r,
            labelStyle: i,
            labelShowBg: a,
            labelBgStyle: o,
            labelBgPadding: s,
            labelBgBorderRadius: c,
          })
        : null,
    ],
  });
}
function yo({ pos: e, x1: t, y1: n, x2: r, y2: i }) {
  return e === J.Left || e === J.Right
    ? [0.5 * (t + r), n]
    : [t, 0.5 * (n + i)];
}
function bo({
  sourceX: e,
  sourceY: t,
  sourcePosition: n = J.Bottom,
  targetX: r,
  targetY: i,
  targetPosition: a = J.Top,
}) {
  let [o, s] = yo({ pos: n, x1: e, y1: t, x2: r, y2: i }),
    [c, l] = yo({ pos: a, x1: r, y1: i, x2: e, y2: t }),
    [u, d, f, p] = In({
      sourceX: e,
      sourceY: t,
      targetX: r,
      targetY: i,
      sourceControlX: o,
      sourceControlY: s,
      targetControlX: c,
      targetControlY: l,
    });
  return [`M${e},${t} C${o},${s} ${c},${l} ${r},${i}`, u, d, f, p];
}
function xo(e) {
  return (0, M.memo)(
    ({
      id: t,
      sourceX: n,
      sourceY: r,
      targetX: i,
      targetY: a,
      sourcePosition: o,
      targetPosition: s,
      label: c,
      labelStyle: l,
      labelShowBg: u,
      labelBgStyle: d,
      labelBgPadding: f,
      labelBgBorderRadius: p,
      style: m,
      markerEnd: h,
      markerStart: g,
      interactionWidth: _,
    }) => {
      let [v, y, b] = bo({
        sourceX: n,
        sourceY: r,
        sourcePosition: o,
        targetX: i,
        targetY: a,
        targetPosition: s,
      });
      return (0, R.jsx)(vo, {
        id: e.isInternal ? void 0 : t,
        path: v,
        labelX: y,
        labelY: b,
        label: c,
        labelStyle: l,
        labelShowBg: u,
        labelBgStyle: d,
        labelBgPadding: f,
        labelBgBorderRadius: p,
        style: m,
        markerEnd: h,
        markerStart: g,
        interactionWidth: _,
      });
    },
  );
}
var So = xo({ isInternal: !1 }),
  Co = xo({ isInternal: !0 });
((So.displayName = `SimpleBezierEdge`),
  (Co.displayName = `SimpleBezierEdgeInternal`));
function wo(e) {
  return (0, M.memo)(
    ({
      id: t,
      sourceX: n,
      sourceY: r,
      targetX: i,
      targetY: a,
      label: o,
      labelStyle: s,
      labelShowBg: c,
      labelBgStyle: l,
      labelBgPadding: u,
      labelBgBorderRadius: d,
      style: f,
      sourcePosition: p = J.Bottom,
      targetPosition: m = J.Top,
      markerEnd: h,
      markerStart: g,
      pathOptions: _,
      interactionWidth: v,
    }) => {
      let [y, b, x] = Qn({
        sourceX: n,
        sourceY: r,
        sourcePosition: p,
        targetX: i,
        targetY: a,
        targetPosition: m,
        borderRadius: _?.borderRadius,
        offset: _?.offset,
        stepPosition: _?.stepPosition,
      });
      return (0, R.jsx)(vo, {
        id: e.isInternal ? void 0 : t,
        path: y,
        labelX: b,
        labelY: x,
        label: o,
        labelStyle: s,
        labelShowBg: c,
        labelBgStyle: l,
        labelBgPadding: u,
        labelBgBorderRadius: d,
        style: f,
        markerEnd: h,
        markerStart: g,
        interactionWidth: v,
      });
    },
  );
}
var To = wo({ isInternal: !1 }),
  Eo = wo({ isInternal: !0 });
((To.displayName = `SmoothStepEdge`),
  (Eo.displayName = `SmoothStepEdgeInternal`));
function Do(e) {
  return (0, M.memo)(({ id: t, ...n }) => {
    let r = e.isInternal ? void 0 : t;
    return (0, R.jsx)(To, {
      ...n,
      id: r,
      pathOptions: (0, M.useMemo)(
        () => ({ borderRadius: 0, offset: n.pathOptions?.offset }),
        [n.pathOptions?.offset],
      ),
    });
  });
}
var Oo = Do({ isInternal: !1 }),
  ko = Do({ isInternal: !0 });
((Oo.displayName = `StepEdge`), (ko.displayName = `StepEdgeInternal`));
function Ao(e) {
  return (0, M.memo)(
    ({
      id: t,
      sourceX: n,
      sourceY: r,
      targetX: i,
      targetY: a,
      label: o,
      labelStyle: s,
      labelShowBg: c,
      labelBgStyle: l,
      labelBgPadding: u,
      labelBgBorderRadius: d,
      style: f,
      markerEnd: p,
      markerStart: m,
      interactionWidth: h,
    }) => {
      let [g, _, v] = Kn({ sourceX: n, sourceY: r, targetX: i, targetY: a });
      return (0, R.jsx)(vo, {
        id: e.isInternal ? void 0 : t,
        path: g,
        labelX: _,
        labelY: v,
        label: o,
        labelStyle: s,
        labelShowBg: c,
        labelBgStyle: l,
        labelBgPadding: u,
        labelBgBorderRadius: d,
        style: f,
        markerEnd: p,
        markerStart: m,
        interactionWidth: h,
      });
    },
  );
}
var jo = Ao({ isInternal: !1 }),
  Mo = Ao({ isInternal: !0 });
((jo.displayName = `StraightEdge`), (Mo.displayName = `StraightEdgeInternal`));
function No(e) {
  return (0, M.memo)(
    ({
      id: t,
      sourceX: n,
      sourceY: r,
      targetX: i,
      targetY: a,
      sourcePosition: o = J.Bottom,
      targetPosition: s = J.Top,
      label: c,
      labelStyle: l,
      labelShowBg: u,
      labelBgStyle: d,
      labelBgPadding: f,
      labelBgBorderRadius: p,
      style: m,
      markerEnd: h,
      markerStart: g,
      pathOptions: _,
      interactionWidth: v,
    }) => {
      let [y, b, x] = zn({
        sourceX: n,
        sourceY: r,
        sourcePosition: o,
        targetX: i,
        targetY: a,
        targetPosition: s,
        curvature: _?.curvature,
      });
      return (0, R.jsx)(vo, {
        id: e.isInternal ? void 0 : t,
        path: y,
        labelX: b,
        labelY: x,
        label: c,
        labelStyle: l,
        labelShowBg: u,
        labelBgStyle: d,
        labelBgPadding: f,
        labelBgBorderRadius: p,
        style: m,
        markerEnd: h,
        markerStart: g,
        interactionWidth: v,
      });
    },
  );
}
var Po = No({ isInternal: !1 }),
  Fo = No({ isInternal: !0 });
((Po.displayName = `BezierEdge`), (Fo.displayName = `BezierEdgeInternal`));
var Io = {
    default: Fo,
    straight: Mo,
    step: ko,
    smoothstep: Eo,
    simplebezier: Co,
  },
  Lo = {
    sourceX: null,
    sourceY: null,
    targetX: null,
    targetY: null,
    sourcePosition: null,
    targetPosition: null,
  },
  Ro = (e, t, n) => (n === J.Left ? e - t : n === J.Right ? e + t : e),
  zo = (e, t, n) => (n === J.Top ? e - t : n === J.Bottom ? e + t : e),
  Bo = `react-flow__edgeupdater`;
function Vo({
  position: e,
  centerX: t,
  centerY: n,
  radius: r = 10,
  onMouseDown: i,
  onMouseEnter: a,
  onMouseOut: o,
  type: s,
}) {
  return (0, R.jsx)(`circle`, {
    onMouseDown: i,
    onMouseEnter: a,
    onMouseOut: o,
    className: v([Bo, `${Bo}-${s}`]),
    cx: Ro(t, r, e),
    cy: zo(n, r, e),
    r,
    stroke: `transparent`,
    fill: `transparent`,
  });
}
function Ho({
  isReconnectable: e,
  reconnectRadius: t,
  edge: n,
  sourceX: r,
  sourceY: i,
  targetX: a,
  targetY: o,
  sourcePosition: s,
  targetPosition: c,
  onReconnect: l,
  onReconnectStart: u,
  onReconnectEnd: d,
  setReconnecting: f,
  setUpdateHover: p,
}) {
  let m = $(),
    h = (e, t) => {
      if (e.button !== 0) return;
      let {
          autoPanOnConnect: r,
          domNode: i,
          connectionMode: a,
          connectionRadius: o,
          lib: s,
          onConnectStart: c,
          cancelConnection: p,
          nodeLookup: h,
          rfId: g,
          panBy: _,
          updateConnection: v,
        } = m.getState(),
        y = t.type === `target`;
      zr.onPointerDown(e.nativeEvent, {
        autoPanOnConnect: r,
        connectionMode: a,
        connectionRadius: o,
        domNode: i,
        handleId: t.id,
        nodeId: t.nodeId,
        nodeLookup: h,
        isTarget: y,
        edgeUpdaterType: t.type,
        lib: s,
        flowId: g,
        cancelConnection: p,
        panBy: _,
        isValidConnection: (...e) =>
          m.getState().isValidConnection?.(...e) ?? !0,
        onConnect: (e) => l?.(n, e),
        onConnectStart: (r, i) => {
          (f(!0), u?.(e, n, t.type), c?.(r, i));
        },
        onConnectEnd: (...e) => m.getState().onConnectEnd?.(...e),
        onReconnectEnd: (e, r) => {
          (f(!1), d?.(e, n, t.type, r));
        },
        updateConnection: v,
        getTransform: () => m.getState().transform,
        getFromHandle: () => m.getState().connection.fromHandle,
        dragThreshold: m.getState().connectionDragThreshold,
        handleDomNode: e.currentTarget,
      });
    },
    g = (e) =>
      h(e, { nodeId: n.target, id: n.targetHandle ?? null, type: `target` }),
    _ = (e) =>
      h(e, { nodeId: n.source, id: n.sourceHandle ?? null, type: `source` }),
    v = () => p(!0),
    y = () => p(!1);
  return (0, R.jsxs)(R.Fragment, {
    children: [
      (e === !0 || e === `source`) &&
        (0, R.jsx)(Vo, {
          position: s,
          centerX: r,
          centerY: i,
          radius: t,
          onMouseDown: g,
          onMouseEnter: v,
          onMouseOut: y,
          type: `source`,
        }),
      (e === !0 || e === `target`) &&
        (0, R.jsx)(Vo, {
          position: c,
          centerX: a,
          centerY: o,
          radius: t,
          onMouseDown: _,
          onMouseEnter: v,
          onMouseOut: y,
          type: `target`,
        }),
    ],
  });
}
function Uo({
  id: e,
  edgesFocusable: t,
  edgesReconnectable: n,
  elementsSelectable: r,
  onClick: i,
  onDoubleClick: a,
  onContextMenu: o,
  onMouseEnter: s,
  onMouseMove: c,
  onMouseLeave: l,
  reconnectRadius: u,
  onReconnect: d,
  onReconnectStart: f,
  onReconnectEnd: p,
  rfId: m,
  edgeTypes: h,
  noPanClassName: g,
  onError: _,
  disableKeyboardA11y: y,
}) {
  let b = Q((t) => t.edgeLookup.get(e)),
    x = Q((e) => e.defaultEdgeOptions);
  b = x ? { ...x, ...b } : b;
  let S = b.type || `default`,
    C = h?.[S] || Io[S];
  C === void 0 &&
    (_?.(`011`, q.error011(S)),
    (S = `default`),
    (C = h?.default || Io.default));
  let w = !!(b.focusable || (t && b.focusable === void 0)),
    E = d !== void 0 && (b.reconnectable || (n && b.reconnectable === void 0)),
    D = !!(b.selectable || (r && b.selectable === void 0)),
    O = (0, M.useRef)(null),
    [k, A] = (0, M.useState)(!1),
    [j, N] = (0, M.useState)(!1),
    P = $(),
    {
      zIndex: F,
      sourceX: I,
      sourceY: L,
      targetX: z,
      targetY: B,
      sourcePosition: V,
      targetPosition: H,
    } = Q(
      (0, M.useCallback)(
        (t) => {
          let n = t.nodeLookup.get(b.source),
            r = t.nodeLookup.get(b.target);
          if (!n || !r) return { zIndex: b.zIndex, ...Lo };
          let i = er({
            id: e,
            sourceNode: n,
            targetNode: r,
            sourceHandle: b.sourceHandle || null,
            targetHandle: b.targetHandle || null,
            connectionMode: t.connectionMode,
            onError: _,
          });
          return {
            zIndex: Vn({
              selected: b.selected,
              zIndex: b.zIndex,
              sourceNode: n,
              targetNode: r,
              elevateOnSelect: t.elevateEdgesOnSelect,
              zIndexMode: t.zIndexMode,
            }),
            ...(i || Lo),
          };
        },
        [
          b.source,
          b.target,
          b.sourceHandle,
          b.targetHandle,
          b.selected,
          b.zIndex,
        ],
      ),
      T,
    ),
    U = (0, M.useMemo)(
      () => (b.markerStart ? `url('#${ir(b.markerStart, m)}')` : void 0),
      [b.markerStart, m],
    ),
    W = (0, M.useMemo)(
      () => (b.markerEnd ? `url('#${ir(b.markerEnd, m)}')` : void 0),
      [b.markerEnd, m],
    );
  if (b.hidden || I === null || L === null || z === null || B === null)
    return null;
  let G = (t) => {
      let {
        addSelectedEdges: n,
        unselectNodesAndEdges: r,
        multiSelectionActive: a,
      } = P.getState();
      (D &&
        (P.setState({ nodesSelectionActive: !1 }),
        b.selected && a
          ? (r({ nodes: [], edges: [b] }), O.current?.blur())
          : n([e])),
        i && i(t, b));
    },
    ee = a
      ? (e) => {
          a(e, { ...b });
        }
      : void 0,
    te = o
      ? (e) => {
          o(e, { ...b });
        }
      : void 0,
    ne = s
      ? (e) => {
          s(e, { ...b });
        }
      : void 0,
    K = c
      ? (e) => {
          c(e, { ...b });
        }
      : void 0,
    re = l
      ? (e) => {
          l(e, { ...b });
        }
      : void 0;
  return (0, R.jsx)(`svg`, {
    style: { zIndex: F },
    children: (0, R.jsxs)(`g`, {
      className: v([
        `react-flow__edge`,
        `react-flow__edge-${S}`,
        b.className,
        g,
        {
          selected: b.selected,
          animated: b.animated,
          inactive: !D && !i,
          updating: k,
          selectable: D,
        },
      ]),
      onClick: G,
      onDoubleClick: ee,
      onContextMenu: te,
      onMouseEnter: ne,
      onMouseMove: K,
      onMouseLeave: re,
      onKeyDown: w
        ? (t) => {
            if (!y && Mt.includes(t.key) && D) {
              let { unselectNodesAndEdges: n, addSelectedEdges: r } =
                P.getState();
              t.key === `Escape`
                ? (O.current?.blur(), n({ edges: [b] }))
                : r([e]);
            }
          }
        : void 0,
      tabIndex: w ? 0 : void 0,
      role: b.ariaRole ?? (w ? `group` : `img`),
      "aria-roledescription": `edge`,
      "data-id": e,
      "data-testid": `rf__edge-${e}`,
      "aria-label":
        b.ariaLabel === null
          ? void 0
          : b.ariaLabel || `Edge from ${b.source} to ${b.target}`,
      "aria-describedby": w ? `${Ci}-${m}` : void 0,
      ref: O,
      ...b.domAttributes,
      children: [
        !j &&
          (0, R.jsx)(C, {
            id: e,
            source: b.source,
            target: b.target,
            type: b.type,
            selected: b.selected,
            animated: b.animated,
            selectable: D,
            deletable: b.deletable ?? !0,
            label: b.label,
            labelStyle: b.labelStyle,
            labelShowBg: b.labelShowBg,
            labelBgStyle: b.labelBgStyle,
            labelBgPadding: b.labelBgPadding,
            labelBgBorderRadius: b.labelBgBorderRadius,
            sourceX: I,
            sourceY: L,
            targetX: z,
            targetY: B,
            sourcePosition: V,
            targetPosition: H,
            data: b.data,
            style: b.style,
            sourceHandleId: b.sourceHandle,
            targetHandleId: b.targetHandle,
            markerStart: U,
            markerEnd: W,
            pathOptions: `pathOptions` in b ? b.pathOptions : void 0,
            interactionWidth: b.interactionWidth,
          }),
        E &&
          (0, R.jsx)(Ho, {
            edge: b,
            isReconnectable: E,
            reconnectRadius: u,
            onReconnect: d,
            onReconnectStart: f,
            onReconnectEnd: p,
            sourceX: I,
            sourceY: L,
            targetX: z,
            targetY: B,
            sourcePosition: V,
            targetPosition: H,
            setUpdateHover: A,
            setReconnecting: N,
          }),
      ],
    }),
  });
}
var Wo = (0, M.memo)(Uo),
  Go = (e) => ({
    edgesFocusable: e.edgesFocusable,
    edgesReconnectable: e.edgesReconnectable,
    elementsSelectable: e.elementsSelectable,
    connectionMode: e.connectionMode,
    onError: e.onError,
  });
function Ko({
  defaultMarkerColor: e,
  onlyRenderVisibleElements: t,
  rfId: n,
  edgeTypes: r,
  noPanClassName: i,
  onReconnect: a,
  onEdgeContextMenu: o,
  onEdgeMouseEnter: s,
  onEdgeMouseMove: c,
  onEdgeMouseLeave: l,
  onEdgeClick: u,
  reconnectRadius: d,
  onEdgeDoubleClick: f,
  onReconnectStart: p,
  onReconnectEnd: m,
  disableKeyboardA11y: h,
}) {
  let {
      edgesFocusable: g,
      edgesReconnectable: _,
      elementsSelectable: v,
      onError: y,
    } = Q(Go, T),
    b = so(t);
  return (0, R.jsxs)(`div`, {
    className: `react-flow__edges`,
    children: [
      (0, R.jsx)(ho, { defaultColor: e, rfId: n }),
      b.map((e) =>
        (0, R.jsx)(
          Wo,
          {
            id: e,
            edgesFocusable: g,
            edgesReconnectable: _,
            elementsSelectable: v,
            noPanClassName: i,
            onReconnect: a,
            onContextMenu: o,
            onMouseEnter: s,
            onMouseMove: c,
            onMouseLeave: l,
            onClick: u,
            reconnectRadius: d,
            onDoubleClick: f,
            onReconnectStart: p,
            onReconnectEnd: m,
            rfId: n,
            onError: y,
            edgeTypes: r,
            disableKeyboardA11y: h,
          },
          e,
        ),
      ),
    ],
  });
}
Ko.displayName = `EdgeRenderer`;
var qo = (0, M.memo)(Ko),
  Jo = (e) =>
    `translate(${e.transform[0]}px,${e.transform[1]}px) scale(${e.transform[2]})`;
function Yo({ children: e }) {
  return (0, R.jsx)(`div`, {
    className: `react-flow__viewport xyflow__viewport react-flow__container`,
    style: { transform: Q(Jo) },
    children: e,
  });
}
function Xo(e) {
  let t = ma(),
    n = (0, M.useRef)(!1);
  (0, M.useEffect)(() => {
    !n.current &&
      t.viewportInitialized &&
      e &&
      (setTimeout(() => e(t), 1), (n.current = !0));
  }, [e, t.viewportInitialized]);
}
var Zo = (e) => e.panZoom?.syncViewport;
function Qo(e) {
  let t = Q(Zo),
    n = $();
  return (
    (0, M.useEffect)(() => {
      e && (t?.(e), n.setState({ transform: [e.x, e.y, e.zoom] }));
    }, [e, t]),
    null
  );
}
function $o(e) {
  return e.connection.inProgress
    ? { ...e.connection, to: gn(e.connection.to, e.transform) }
    : { ...e.connection };
}
function es(e) {
  return e ? (t) => e($o(t)) : $o;
}
function ts(e) {
  return Q(es(e), T);
}
var ns = (e) => ({
  nodesConnectable: e.nodesConnectable,
  isValid: e.connection.isValid,
  inProgress: e.connection.inProgress,
  width: e.width,
  height: e.height,
});
function rs({ containerStyle: e, style: t, type: n, component: r }) {
  let {
    nodesConnectable: i,
    width: a,
    height: o,
    isValid: s,
    inProgress: c,
  } = Q(ns, T);
  return a && i && c
    ? (0, R.jsx)(`svg`, {
        style: e,
        width: a,
        height: o,
        className: `react-flow__connectionline react-flow__container`,
        children: (0, R.jsx)(`g`, {
          className: v([`react-flow__connection`, Vt(s)]),
          children: (0, R.jsx)(is, {
            style: t,
            type: n,
            CustomComponent: r,
            isValid: s,
          }),
        }),
      })
    : null;
}
var is = ({
  style: e,
  type: t = Rt.Bezier,
  CustomComponent: n,
  isValid: r,
}) => {
  let {
    inProgress: i,
    from: a,
    fromNode: o,
    fromHandle: s,
    fromPosition: c,
    to: l,
    toNode: u,
    toHandle: d,
    toPosition: f,
    pointer: p,
  } = ts();
  if (!i) return;
  if (n)
    return (0, R.jsx)(n, {
      connectionLineType: t,
      connectionLineStyle: e,
      fromNode: o,
      fromHandle: s,
      fromX: a.x,
      fromY: a.y,
      toX: l.x,
      toY: l.y,
      fromPosition: c,
      toPosition: f,
      connectionStatus: Vt(r),
      toNode: u,
      toHandle: d,
      pointer: p,
    });
  let m = ``,
    h = {
      sourceX: a.x,
      sourceY: a.y,
      sourcePosition: c,
      targetX: l.x,
      targetY: l.y,
      targetPosition: f,
    };
  switch (t) {
    case Rt.Bezier:
      [m] = zn(h);
      break;
    case Rt.SimpleBezier:
      [m] = bo(h);
      break;
    case Rt.Step:
      [m] = Qn({ ...h, borderRadius: 0 });
      break;
    case Rt.SmoothStep:
      [m] = Qn(h);
      break;
    default:
      [m] = Kn(h);
  }
  return (0, R.jsx)(`path`, {
    d: m,
    fill: `none`,
    className: `react-flow__connection-path`,
    style: e,
  });
};
is.displayName = `ConnectionLine`;
var as = {};
function os(e = as) {
  ((0, M.useRef)(e), $(), (0, M.useEffect)(() => {}, [e]));
}
function ss() {
  ($(), (0, M.useRef)(!1), (0, M.useEffect)(() => {}, []));
}
function cs({
  nodeTypes: e,
  edgeTypes: t,
  onInit: n,
  onNodeClick: r,
  onEdgeClick: i,
  onNodeDoubleClick: a,
  onEdgeDoubleClick: o,
  onNodeMouseEnter: s,
  onNodeMouseMove: c,
  onNodeMouseLeave: l,
  onNodeContextMenu: u,
  onSelectionContextMenu: d,
  onSelectionStart: f,
  onSelectionEnd: p,
  connectionLineType: m,
  connectionLineStyle: h,
  connectionLineComponent: g,
  connectionLineContainerStyle: _,
  selectionKeyCode: v,
  selectionOnDrag: y,
  selectionMode: b,
  multiSelectionKeyCode: x,
  panActivationKeyCode: S,
  zoomActivationKeyCode: C,
  deleteKeyCode: w,
  onlyRenderVisibleElements: T,
  elementsSelectable: E,
  defaultViewport: D,
  translateExtent: O,
  minZoom: k,
  maxZoom: A,
  preventScrolling: j,
  defaultMarkerColor: M,
  zoomOnScroll: N,
  zoomOnPinch: P,
  panOnScroll: F,
  panOnScrollSpeed: I,
  panOnScrollMode: L,
  zoomOnDoubleClick: z,
  panOnDrag: B,
  onPaneClick: V,
  onPaneMouseEnter: H,
  onPaneMouseMove: U,
  onPaneMouseLeave: W,
  onPaneScroll: G,
  onPaneContextMenu: ee,
  paneClickDistance: te,
  nodeClickDistance: ne,
  onEdgeContextMenu: K,
  onEdgeMouseEnter: re,
  onEdgeMouseMove: ie,
  onEdgeMouseLeave: ae,
  reconnectRadius: oe,
  onReconnect: se,
  onReconnectStart: ce,
  onReconnectEnd: le,
  noDragClassName: ue,
  noWheelClassName: de,
  noPanClassName: fe,
  disableKeyboardA11y: pe,
  nodeExtent: me,
  rfId: he,
  viewport: ge,
  onViewportChange: _e,
}) {
  return (
    os(e),
    os(t),
    ss(),
    Xo(n),
    Qo(ge),
    (0, R.jsx)(Xa, {
      onPaneClick: V,
      onPaneMouseEnter: H,
      onPaneMouseMove: U,
      onPaneMouseLeave: W,
      onPaneContextMenu: ee,
      onPaneScroll: G,
      paneClickDistance: te,
      deleteKeyCode: w,
      selectionKeyCode: v,
      selectionOnDrag: y,
      selectionMode: b,
      onSelectionStart: f,
      onSelectionEnd: p,
      multiSelectionKeyCode: x,
      panActivationKeyCode: S,
      zoomActivationKeyCode: C,
      elementsSelectable: E,
      zoomOnScroll: N,
      zoomOnPinch: P,
      zoomOnDoubleClick: z,
      panOnScroll: F,
      panOnScrollSpeed: I,
      panOnScrollMode: L,
      panOnDrag: B,
      defaultViewport: D,
      translateExtent: O,
      minZoom: k,
      maxZoom: A,
      onSelectionContextMenu: d,
      preventScrolling: j,
      noDragClassName: ue,
      noWheelClassName: de,
      noPanClassName: fe,
      disableKeyboardA11y: pe,
      onViewportChange: _e,
      isControlledViewport: !!ge,
      children: (0, R.jsxs)(Yo, {
        children: [
          (0, R.jsx)(qo, {
            edgeTypes: t,
            onEdgeClick: i,
            onEdgeDoubleClick: o,
            onReconnect: se,
            onReconnectStart: ce,
            onReconnectEnd: le,
            onlyRenderVisibleElements: T,
            onEdgeContextMenu: K,
            onEdgeMouseEnter: re,
            onEdgeMouseMove: ie,
            onEdgeMouseLeave: ae,
            reconnectRadius: oe,
            defaultMarkerColor: M,
            noPanClassName: fe,
            disableKeyboardA11y: pe,
            rfId: he,
          }),
          (0, R.jsx)(rs, {
            style: h,
            type: m,
            component: g,
            containerStyle: _,
          }),
          (0, R.jsx)(`div`, { className: `react-flow__edgelabel-renderer` }),
          (0, R.jsx)(oo, {
            nodeTypes: e,
            onNodeClick: r,
            onNodeDoubleClick: a,
            onNodeMouseEnter: s,
            onNodeMouseMove: c,
            onNodeMouseLeave: l,
            onNodeContextMenu: u,
            nodeClickDistance: ne,
            onlyRenderVisibleElements: T,
            noPanClassName: fe,
            noDragClassName: ue,
            disableKeyboardA11y: pe,
            nodeExtent: me,
            rfId: he,
          }),
          (0, R.jsx)(`div`, { className: `react-flow__viewport-portal` }),
        ],
      }),
    })
  );
}
cs.displayName = `GraphView`;
var ls = (0, M.memo)(cs),
  us = ({
    nodes: e,
    edges: t,
    defaultNodes: n,
    defaultEdges: r,
    width: i,
    height: a,
    fitView: o,
    fitViewOptions: s,
    minZoom: c = 0.5,
    maxZoom: l = 2,
    nodeOrigin: u,
    nodeExtent: d,
    zIndexMode: f = `basic`,
  } = {}) => {
    let p = new Map(),
      m = new Map(),
      h = new Map(),
      g = new Map(),
      _ = r ?? t ?? [],
      v = n ?? e ?? [],
      y = u ?? [0, 0],
      b = d ?? jt;
    Cr(h, g, _);
    let x = mr(v, p, m, { nodeOrigin: y, nodeExtent: b, zIndexMode: f }),
      S = [0, 0, 1];
    if (o && i && a) {
      let {
        x: e,
        y: t,
        zoom: n,
      } = xn(
        qt(p, {
          filter: (e) =>
            !!((e.width || e.initialWidth) && (e.height || e.initialHeight)),
        }),
        i,
        a,
        c,
        l,
        s?.padding ?? 0.1,
      );
      S = [e, t, n];
    }
    return {
      rfId: `1`,
      width: i ?? 0,
      height: a ?? 0,
      transform: S,
      nodes: v,
      nodesInitialized: x,
      nodeLookup: p,
      parentLookup: m,
      edges: _,
      edgeLookup: g,
      connectionLookup: h,
      onNodesChange: null,
      onEdgesChange: null,
      hasDefaultNodes: n !== void 0,
      hasDefaultEdges: r !== void 0,
      panZoom: null,
      minZoom: c,
      maxZoom: l,
      translateExtent: jt,
      nodeExtent: b,
      nodesSelectionActive: !1,
      userSelectionActive: !1,
      userSelectionRect: null,
      connectionMode: Pt.Strict,
      domNode: null,
      paneDragging: !1,
      noPanClassName: `nopan`,
      nodeOrigin: y,
      nodeDragThreshold: 1,
      connectionDragThreshold: 1,
      snapGrid: [15, 15],
      snapToGrid: !1,
      nodesDraggable: !0,
      nodesConnectable: !0,
      nodesFocusable: !0,
      edgesFocusable: !0,
      edgesReconnectable: !0,
      elementsSelectable: !0,
      elevateNodesOnSelect: !0,
      elevateEdgesOnSelect: !0,
      selectNodesOnDrag: !0,
      multiSelectionActive: !1,
      fitViewQueued: o ?? !1,
      fitViewOptions: s,
      fitViewResolver: null,
      connection: { ...Lt },
      connectionClickStartHandle: null,
      connectOnClick: !0,
      ariaLiveMessage: ``,
      autoPanOnConnect: !0,
      autoPanOnNodeDrag: !0,
      autoPanOnNodeFocus: !0,
      autoPanSpeed: 15,
      connectionRadius: 20,
      onError: mn,
      isValidConnection: void 0,
      onSelectionChangeHandlers: [],
      lib: `react`,
      debug: !1,
      ariaLabelConfig: Nt,
      zIndexMode: f,
      onNodesChangeMiddlewareMap: new Map(),
      onEdgesChangeMiddlewareMap: new Map(),
    };
  },
  ds = ({
    nodes: e,
    edges: t,
    defaultNodes: n,
    defaultEdges: r,
    width: i,
    height: a,
    fitView: o,
    fitViewOptions: s,
    minZoom: c,
    maxZoom: l,
    nodeOrigin: u,
    nodeExtent: d,
    zIndexMode: f,
  }) =>
    S((p, m) => {
      async function h() {
        let {
          nodeLookup: e,
          panZoom: t,
          fitViewOptions: n,
          fitViewResolver: r,
          width: i,
          height: a,
          minZoom: o,
          maxZoom: s,
        } = m();
        t &&
          (await Zt(
            {
              nodes: e,
              width: i,
              height: a,
              panZoom: t,
              minZoom: o,
              maxZoom: s,
            },
            n,
          ),
          r?.resolve(!0),
          p({ fitViewResolver: null }));
      }
      return {
        ...us({
          nodes: e,
          edges: t,
          width: i,
          height: a,
          fitView: o,
          fitViewOptions: s,
          minZoom: c,
          maxZoom: l,
          nodeOrigin: u,
          nodeExtent: d,
          defaultNodes: n,
          defaultEdges: r,
          zIndexMode: f,
        }),
        setNodes: (e) => {
          let {
              nodeLookup: t,
              parentLookup: n,
              nodeOrigin: r,
              elevateNodesOnSelect: i,
              fitViewQueued: a,
              zIndexMode: o,
            } = m(),
            s = mr(e, t, n, {
              nodeOrigin: r,
              nodeExtent: d,
              elevateNodesOnSelect: i,
              checkEquality: !0,
              zIndexMode: o,
            });
          a && s
            ? (h(),
              p({
                nodes: e,
                nodesInitialized: s,
                fitViewQueued: !1,
                fitViewOptions: void 0,
              }))
            : p({ nodes: e, nodesInitialized: s });
        },
        setEdges: (e) => {
          let { connectionLookup: t, edgeLookup: n } = m();
          (Cr(t, n, e), p({ edges: e }));
        },
        setDefaultNodesAndEdges: (e, t) => {
          if (e) {
            let { setNodes: t } = m();
            (t(e), p({ hasDefaultNodes: !0 }));
          }
          if (t) {
            let { setEdges: e } = m();
            (e(t), p({ hasDefaultEdges: !0 }));
          }
        },
        updateNodeInternals: (e) => {
          let {
              triggerNodeChanges: t,
              nodeLookup: n,
              parentLookup: r,
              domNode: i,
              nodeOrigin: a,
              nodeExtent: o,
              debug: s,
              fitViewQueued: c,
              zIndexMode: l,
            } = m(),
            { changes: u, updatedInternals: d } = br(e, n, r, i, a, o, l);
          d &&
            (dr(n, r, { nodeOrigin: a, nodeExtent: o, zIndexMode: l }),
            c ? (h(), p({ fitViewQueued: !1, fitViewOptions: void 0 })) : p({}),
            u?.length > 0 &&
              (s && console.log(`React Flow: trigger node changes`, u),
              t?.(u)));
        },
        updateNodePositions: (e, t = !1) => {
          let n = [],
            r = [],
            {
              nodeLookup: i,
              triggerNodeChanges: a,
              connection: o,
              updateConnection: s,
              onNodesChangeMiddlewareMap: c,
            } = m();
          for (let [a, c] of e) {
            let e = i.get(a),
              l = !!(e?.expandParent && e?.parentId && c?.position),
              u = {
                id: a,
                type: `position`,
                position: l
                  ? {
                      x: Math.max(0, c.position.x),
                      y: Math.max(0, c.position.y),
                    }
                  : c.position,
                dragging: t,
              };
            if (e && o.inProgress && o.fromNode.id === e.id) {
              let t = nr(e, o.fromHandle, J.Left, !0);
              s({ ...o, from: t });
            }
            (l &&
              e.parentId &&
              n.push({
                id: a,
                parentId: e.parentId,
                rect: {
                  ...c.internals.positionAbsolute,
                  width: c.measured.width ?? 0,
                  height: c.measured.height ?? 0,
                },
              }),
              r.push(u));
          }
          if (n.length > 0) {
            let { parentLookup: e, nodeOrigin: t } = m(),
              a = yr(n, i, e, t);
            r.push(...a);
          }
          for (let e of c.values()) r = e(r);
          a(r);
        },
        triggerNodeChanges: (e) => {
          let {
            onNodesChange: t,
            setNodes: n,
            nodes: r,
            hasDefaultNodes: i,
            debug: a,
          } = m();
          e?.length &&
            (i && n(Qi(e, r)),
            a && console.log(`React Flow: trigger node changes`, e),
            t?.(e));
        },
        triggerEdgeChanges: (e) => {
          let {
            onEdgesChange: t,
            setEdges: n,
            edges: r,
            hasDefaultEdges: i,
            debug: a,
          } = m();
          e?.length &&
            (i && n($i(e, r)),
            a && console.log(`React Flow: trigger edge changes`, e),
            t?.(e));
        },
        addSelectedNodes: (e) => {
          let {
            multiSelectionActive: t,
            edgeLookup: n,
            nodeLookup: r,
            triggerNodeChanges: i,
            triggerEdgeChanges: a,
          } = m();
          if (t) {
            i(e.map((e) => ea(e, !0)));
            return;
          }
          (i(ta(r, new Set([...e]), !0)), a(ta(n)));
        },
        addSelectedEdges: (e) => {
          let {
            multiSelectionActive: t,
            edgeLookup: n,
            nodeLookup: r,
            triggerNodeChanges: i,
            triggerEdgeChanges: a,
          } = m();
          if (t) {
            a(e.map((e) => ea(e, !0)));
            return;
          }
          (a(ta(n, new Set([...e]))), i(ta(r, new Set(), !0)));
        },
        unselectNodesAndEdges: ({ nodes: e, edges: t } = {}) => {
          let {
              edges: n,
              nodes: r,
              nodeLookup: i,
              triggerNodeChanges: a,
              triggerEdgeChanges: o,
            } = m(),
            s = e || r,
            c = t || n,
            l = [];
          for (let e of s) {
            if (!e.selected) continue;
            let t = i.get(e.id);
            (t && (t.selected = !1), l.push(ea(e.id, !1)));
          }
          let u = [];
          for (let e of c) e.selected && u.push(ea(e.id, !1));
          (a(l), o(u));
        },
        setMinZoom: (e) => {
          let { panZoom: t, maxZoom: n } = m();
          (t?.setScaleExtent([e, n]), p({ minZoom: e }));
        },
        setMaxZoom: (e) => {
          let { panZoom: t, minZoom: n } = m();
          (t?.setScaleExtent([n, e]), p({ maxZoom: e }));
        },
        setTranslateExtent: (e) => {
          (m().panZoom?.setTranslateExtent(e), p({ translateExtent: e }));
        },
        resetSelectedElements: () => {
          let {
            edges: e,
            nodes: t,
            triggerNodeChanges: n,
            triggerEdgeChanges: r,
            elementsSelectable: i,
          } = m();
          if (!i) return;
          let a = t.reduce(
              (e, t) => (t.selected ? [...e, ea(t.id, !1)] : e),
              [],
            ),
            o = e.reduce((e, t) => (t.selected ? [...e, ea(t.id, !1)] : e), []);
          (n(a), r(o));
        },
        setNodeExtent: (e) => {
          let {
            nodes: t,
            nodeLookup: n,
            parentLookup: r,
            nodeOrigin: i,
            elevateNodesOnSelect: a,
            nodeExtent: o,
            zIndexMode: s,
          } = m();
          (e[0][0] === o[0][0] &&
            e[0][1] === o[0][1] &&
            e[1][0] === o[1][0] &&
            e[1][1] === o[1][1]) ||
            (mr(t, n, r, {
              nodeOrigin: i,
              nodeExtent: e,
              elevateNodesOnSelect: a,
              checkEquality: !1,
              zIndexMode: s,
            }),
            p({ nodeExtent: e }));
        },
        panBy: (e) => {
          let {
            transform: t,
            width: n,
            height: r,
            panZoom: i,
            translateExtent: a,
          } = m();
          return xr({
            delta: e,
            panZoom: i,
            transform: t,
            translateExtent: a,
            width: n,
            height: r,
          });
        },
        setCenter: async (e, t, n) => {
          let { width: r, height: i, maxZoom: a, panZoom: o } = m();
          if (!o) return Promise.resolve(!1);
          let s = n?.zoom === void 0 ? a : n.zoom;
          return (
            await o.setViewport(
              { x: r / 2 - e * s, y: i / 2 - t * s, zoom: s },
              {
                duration: n?.duration,
                ease: n?.ease,
                interpolate: n?.interpolate,
              },
            ),
            Promise.resolve(!0)
          );
        },
        cancelConnection: () => {
          p({ connection: { ...Lt } });
        },
        updateConnection: (e) => {
          p({ connection: e });
        },
        reset: () => p({ ...us() }),
      };
    }, Object.is);
function fs({
  initialNodes: e,
  initialEdges: t,
  defaultNodes: n,
  defaultEdges: r,
  initialWidth: i,
  initialHeight: a,
  initialMinZoom: o,
  initialMaxZoom: s,
  initialFitViewOptions: c,
  fitView: l,
  nodeOrigin: u,
  nodeExtent: d,
  zIndexMode: f,
  children: p,
}) {
  let [m] = (0, M.useState)(() =>
    ds({
      nodes: e,
      edges: t,
      defaultNodes: n,
      defaultEdges: r,
      width: i,
      height: a,
      fitView: l,
      minZoom: o,
      maxZoom: s,
      fitViewOptions: c,
      nodeOrigin: u,
      nodeExtent: d,
      zIndexMode: f,
    }),
  );
  return (0, R.jsx)(vi, {
    value: m,
    children: (0, R.jsx)(da, { children: p }),
  });
}
function ps({
  children: e,
  nodes: t,
  edges: n,
  defaultNodes: r,
  defaultEdges: i,
  width: a,
  height: o,
  fitView: s,
  fitViewOptions: c,
  minZoom: l,
  maxZoom: u,
  nodeOrigin: d,
  nodeExtent: f,
  zIndexMode: p,
}) {
  return (0, M.useContext)(_i)
    ? (0, R.jsx)(R.Fragment, { children: e })
    : (0, R.jsx)(fs, {
        initialNodes: t,
        initialEdges: n,
        defaultNodes: r,
        defaultEdges: i,
        initialWidth: a,
        initialHeight: o,
        fitView: s,
        initialFitViewOptions: c,
        initialMinZoom: l,
        initialMaxZoom: u,
        nodeOrigin: d,
        nodeExtent: f,
        zIndexMode: p,
        children: e,
      });
}
var ms = {
  width: `100%`,
  height: `100%`,
  overflow: `hidden`,
  position: `relative`,
  zIndex: 0,
};
function hs(
  {
    nodes: e,
    edges: t,
    defaultNodes: n,
    defaultEdges: r,
    className: i,
    nodeTypes: a,
    edgeTypes: o,
    onNodeClick: s,
    onEdgeClick: c,
    onInit: l,
    onMove: u,
    onMoveStart: d,
    onMoveEnd: f,
    onConnect: p,
    onConnectStart: m,
    onConnectEnd: h,
    onClickConnectStart: g,
    onClickConnectEnd: _,
    onNodeMouseEnter: y,
    onNodeMouseMove: b,
    onNodeMouseLeave: x,
    onNodeContextMenu: S,
    onNodeDoubleClick: C,
    onNodeDragStart: w,
    onNodeDrag: T,
    onNodeDragStop: E,
    onNodesDelete: D,
    onEdgesDelete: O,
    onDelete: k,
    onSelectionChange: A,
    onSelectionDragStart: j,
    onSelectionDrag: N,
    onSelectionDragStop: P,
    onSelectionContextMenu: F,
    onSelectionStart: I,
    onSelectionEnd: L,
    onBeforeDelete: z,
    connectionMode: B,
    connectionLineType: V = Rt.Bezier,
    connectionLineStyle: H,
    connectionLineComponent: U,
    connectionLineContainerStyle: W,
    deleteKeyCode: G = `Backspace`,
    selectionKeyCode: ee = `Shift`,
    selectionOnDrag: te = !1,
    selectionMode: ne = It.Full,
    panActivationKeyCode: K = `Space`,
    multiSelectionKeyCode: re = Sn() ? `Meta` : `Control`,
    zoomActivationKeyCode: ie = Sn() ? `Meta` : `Control`,
    snapToGrid: ae,
    snapGrid: oe,
    onlyRenderVisibleElements: se = !1,
    selectNodesOnDrag: ce,
    nodesDraggable: le,
    autoPanOnNodeFocus: ue,
    nodesConnectable: de,
    nodesFocusable: fe,
    nodeOrigin: pe = Li,
    edgesFocusable: me,
    edgesReconnectable: he,
    elementsSelectable: ge = !0,
    defaultViewport: _e = Ri,
    minZoom: ve = 0.5,
    maxZoom: ye = 2,
    translateExtent: be = jt,
    preventScrolling: xe = !0,
    nodeExtent: Se,
    defaultMarkerColor: Ce = `#b1b1b7`,
    zoomOnScroll: we = !0,
    zoomOnPinch: Te = !0,
    panOnScroll: Ee = !1,
    panOnScrollSpeed: De = 0.5,
    panOnScrollMode: Oe = Ft.Free,
    zoomOnDoubleClick: ke = !0,
    panOnDrag: Ae = !0,
    onPaneClick: je,
    onPaneMouseEnter: Me,
    onPaneMouseMove: Ne,
    onPaneMouseLeave: Pe,
    onPaneScroll: Fe,
    onPaneContextMenu: Ie,
    paneClickDistance: Le = 1,
    nodeClickDistance: Re = 0,
    children: ze,
    onReconnect: Be,
    onReconnectStart: Ve,
    onReconnectEnd: He,
    onEdgeContextMenu: Ue,
    onEdgeDoubleClick: We,
    onEdgeMouseEnter: Ge,
    onEdgeMouseMove: Ke,
    onEdgeMouseLeave: qe,
    reconnectRadius: Je = 10,
    onNodesChange: Ye,
    onEdgesChange: Xe,
    noDragClassName: Ze = `nodrag`,
    noWheelClassName: Qe = `nowheel`,
    noPanClassName: $e = `nopan`,
    fitView: et,
    fitViewOptions: tt,
    connectOnClick: nt,
    attributionPosition: rt,
    proOptions: it,
    defaultEdgeOptions: at,
    elevateNodesOnSelect: ot = !0,
    elevateEdgesOnSelect: st = !1,
    disableKeyboardA11y: ct = !1,
    autoPanOnConnect: lt,
    autoPanOnNodeDrag: ut,
    autoPanSpeed: dt,
    connectionRadius: ft,
    isValidConnection: pt,
    onError: mt,
    style: ht,
    id: gt,
    nodeDragThreshold: _t,
    connectionDragThreshold: vt,
    viewport: yt,
    onViewportChange: bt,
    width: xt,
    height: St,
    colorMode: Ct = `light`,
    debug: wt,
    onScroll: Tt,
    ariaLabelConfig: Et,
    zIndexMode: Dt = `basic`,
    ...Ot
  },
  kt,
) {
  let At = gt || `1`,
    q = Wi(Ct),
    Mt = (0, M.useCallback)(
      (e) => {
        (e.currentTarget.scrollTo({ top: 0, left: 0, behavior: `instant` }),
          Tt?.(e));
      },
      [Tt],
    );
  return (0, R.jsx)(`div`, {
    "data-testid": `rf__wrapper`,
    ...Ot,
    onScroll: Mt,
    style: { ...ht, ...ms },
    ref: kt,
    className: v([`react-flow`, i, q]),
    id: gt,
    role: `application`,
    children: (0, R.jsxs)(ps, {
      nodes: e,
      edges: t,
      width: xt,
      height: St,
      fitView: et,
      fitViewOptions: tt,
      minZoom: ve,
      maxZoom: ye,
      nodeOrigin: pe,
      nodeExtent: Se,
      zIndexMode: Dt,
      children: [
        (0, R.jsx)(ls, {
          onInit: l,
          onNodeClick: s,
          onEdgeClick: c,
          onNodeMouseEnter: y,
          onNodeMouseMove: b,
          onNodeMouseLeave: x,
          onNodeContextMenu: S,
          onNodeDoubleClick: C,
          nodeTypes: a,
          edgeTypes: o,
          connectionLineType: V,
          connectionLineStyle: H,
          connectionLineComponent: U,
          connectionLineContainerStyle: W,
          selectionKeyCode: ee,
          selectionOnDrag: te,
          selectionMode: ne,
          deleteKeyCode: G,
          multiSelectionKeyCode: re,
          panActivationKeyCode: K,
          zoomActivationKeyCode: ie,
          onlyRenderVisibleElements: se,
          defaultViewport: _e,
          translateExtent: be,
          minZoom: ve,
          maxZoom: ye,
          preventScrolling: xe,
          zoomOnScroll: we,
          zoomOnPinch: Te,
          zoomOnDoubleClick: ke,
          panOnScroll: Ee,
          panOnScrollSpeed: De,
          panOnScrollMode: Oe,
          panOnDrag: Ae,
          onPaneClick: je,
          onPaneMouseEnter: Me,
          onPaneMouseMove: Ne,
          onPaneMouseLeave: Pe,
          onPaneScroll: Fe,
          onPaneContextMenu: Ie,
          paneClickDistance: Le,
          nodeClickDistance: Re,
          onSelectionContextMenu: F,
          onSelectionStart: I,
          onSelectionEnd: L,
          onReconnect: Be,
          onReconnectStart: Ve,
          onReconnectEnd: He,
          onEdgeContextMenu: Ue,
          onEdgeDoubleClick: We,
          onEdgeMouseEnter: Ge,
          onEdgeMouseMove: Ke,
          onEdgeMouseLeave: qe,
          reconnectRadius: Je,
          defaultMarkerColor: Ce,
          noDragClassName: Ze,
          noWheelClassName: Qe,
          noPanClassName: $e,
          rfId: At,
          disableKeyboardA11y: ct,
          nodeExtent: Se,
          viewport: yt,
          onViewportChange: bt,
        }),
        (0, R.jsx)(Hi, {
          nodes: e,
          edges: t,
          defaultNodes: n,
          defaultEdges: r,
          onConnect: p,
          onConnectStart: m,
          onConnectEnd: h,
          onClickConnectStart: g,
          onClickConnectEnd: _,
          nodesDraggable: le,
          autoPanOnNodeFocus: ue,
          nodesConnectable: de,
          nodesFocusable: fe,
          edgesFocusable: me,
          edgesReconnectable: he,
          elementsSelectable: ge,
          elevateNodesOnSelect: ot,
          elevateEdgesOnSelect: st,
          minZoom: ve,
          maxZoom: ye,
          nodeExtent: Se,
          onNodesChange: Ye,
          onEdgesChange: Xe,
          snapToGrid: ae,
          snapGrid: oe,
          connectionMode: B,
          translateExtent: be,
          connectOnClick: nt,
          defaultEdgeOptions: at,
          fitView: et,
          fitViewOptions: tt,
          onNodesDelete: D,
          onEdgesDelete: O,
          onDelete: k,
          onNodeDragStart: w,
          onNodeDrag: T,
          onNodeDragStop: E,
          onSelectionDrag: N,
          onSelectionDragStart: j,
          onSelectionDragStop: P,
          onMove: u,
          onMoveStart: d,
          onMoveEnd: f,
          noPanClassName: $e,
          nodeOrigin: pe,
          rfId: At,
          autoPanOnConnect: lt,
          autoPanOnNodeDrag: ut,
          autoPanSpeed: dt,
          onError: mt,
          connectionRadius: ft,
          isValidConnection: pt,
          selectNodesOnDrag: ce,
          nodeDragThreshold: _t,
          connectionDragThreshold: vt,
          onBeforeDelete: z,
          debug: wt,
          ariaLabelConfig: Et,
          zIndexMode: Dt,
        }),
        (0, R.jsx)(Ii, { onSelectionChange: A }),
        ze,
        (0, R.jsx)(Ai, { proOptions: it, position: rt }),
        (0, R.jsx)(Oi, { rfId: At, disableKeyboardA11y: ct }),
      ],
    }),
  });
}
var gs = oa(hs),
  _s = (e) => e.domNode?.querySelector(`.react-flow__edgelabel-renderer`);
function vs({ children: e }) {
  let t = Q(_s);
  return t ? (0, gi.createPortal)(e, t) : null;
}
var ys = (e) => e.nodes;
function bs() {
  return Q(ys, T);
}
var xs = (e) => e.edges;
function Ss() {
  return Q(xs, T);
}
q.error014();
function Cs({ dimensions: e, lineWidth: t, variant: n, className: r }) {
  return (0, R.jsx)(`path`, {
    strokeWidth: t,
    d: `M${e[0] / 2} 0 V${e[1]} M0 ${e[1] / 2} H${e[0]}`,
    className: v([`react-flow__background-pattern`, n, r]),
  });
}
function ws({ radius: e, className: t }) {
  return (0, R.jsx)(`circle`, {
    cx: e,
    cy: e,
    r: e,
    className: v([`react-flow__background-pattern`, `dots`, t]),
  });
}
var Ts;
(function (e) {
  ((e.Lines = `lines`), (e.Dots = `dots`), (e.Cross = `cross`));
})((Ts ||= {}));
var Es = { [Ts.Dots]: 1, [Ts.Lines]: 1, [Ts.Cross]: 6 },
  Ds = (e) => ({ transform: e.transform, patternId: `pattern-${e.rfId}` });
function Os({
  id: e,
  variant: t = Ts.Dots,
  gap: n = 20,
  size: r,
  lineWidth: i = 1,
  offset: a = 0,
  color: o,
  bgColor: s,
  style: c,
  className: l,
  patternClassName: u,
}) {
  let d = (0, M.useRef)(null),
    { transform: f, patternId: p } = Q(Ds, T),
    m = r || Es[t],
    h = t === Ts.Dots,
    g = t === Ts.Cross,
    _ = Array.isArray(n) ? n : [n, n],
    y = [_[0] * f[2] || 1, _[1] * f[2] || 1],
    b = m * f[2],
    x = Array.isArray(a) ? a : [a, a],
    S = g ? [b, b] : y,
    C = [x[0] * f[2] || 1 + S[0] / 2, x[1] * f[2] || 1 + S[1] / 2],
    w = `${p}${e || ``}`;
  return (0, R.jsxs)(`svg`, {
    className: v([`react-flow__background`, l]),
    style: {
      ...c,
      ...ya,
      "--xy-background-color-props": s,
      "--xy-background-pattern-color-props": o,
    },
    ref: d,
    "data-testid": `rf__background`,
    children: [
      (0, R.jsx)(`pattern`, {
        id: w,
        x: f[0] % y[0],
        y: f[1] % y[1],
        width: y[0],
        height: y[1],
        patternUnits: `userSpaceOnUse`,
        patternTransform: `translate(-${C[0]},-${C[1]})`,
        children: h
          ? (0, R.jsx)(ws, { radius: b / 2, className: u })
          : (0, R.jsx)(Cs, {
              dimensions: S,
              lineWidth: i,
              variant: t,
              className: u,
            }),
      }),
      (0, R.jsx)(`rect`, {
        x: `0`,
        y: `0`,
        width: `100%`,
        height: `100%`,
        fill: `url(#${w})`,
      }),
    ],
  });
}
Os.displayName = `Background`;
var ks = (0, M.memo)(Os);
function As() {
  return (0, R.jsx)(`svg`, {
    xmlns: `http://www.w3.org/2000/svg`,
    viewBox: `0 0 32 32`,
    children: (0, R.jsx)(`path`, {
      d: `M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z`,
    }),
  });
}
function js() {
  return (0, R.jsx)(`svg`, {
    xmlns: `http://www.w3.org/2000/svg`,
    viewBox: `0 0 32 5`,
    children: (0, R.jsx)(`path`, { d: `M0 0h32v4.2H0z` }),
  });
}
function Ms() {
  return (0, R.jsx)(`svg`, {
    xmlns: `http://www.w3.org/2000/svg`,
    viewBox: `0 0 32 30`,
    children: (0, R.jsx)(`path`, {
      d: `M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z`,
    }),
  });
}
function Ns() {
  return (0, R.jsx)(`svg`, {
    xmlns: `http://www.w3.org/2000/svg`,
    viewBox: `0 0 25 32`,
    children: (0, R.jsx)(`path`, {
      d: `M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0 8 0 4.571 3.429 4.571 7.619v3.048H3.048A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047zm4.724-13.866H7.467V7.619c0-2.59 2.133-4.724 4.723-4.724 2.591 0 4.724 2.133 4.724 4.724v3.048z`,
    }),
  });
}
function Ps() {
  return (0, R.jsx)(`svg`, {
    xmlns: `http://www.w3.org/2000/svg`,
    viewBox: `0 0 25 32`,
    children: (0, R.jsx)(`path`, {
      d: `M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0c-4.114 1.828-1.37 2.133.305 2.438 1.676.305 4.42 2.59 4.42 5.181v3.048H3.047A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047z`,
    }),
  });
}
function Fs({ children: e, className: t, ...n }) {
  return (0, R.jsx)(`button`, {
    type: `button`,
    className: v([`react-flow__controls-button`, t]),
    ...n,
    children: e,
  });
}
var Is = (e) => ({
  isInteractive: e.nodesDraggable || e.nodesConnectable || e.elementsSelectable,
  minZoomReached: e.transform[2] <= e.minZoom,
  maxZoomReached: e.transform[2] >= e.maxZoom,
  ariaLabelConfig: e.ariaLabelConfig,
});
function Ls({
  style: e,
  showZoom: t = !0,
  showFitView: n = !0,
  showInteractive: r = !0,
  fitViewOptions: i,
  onZoomIn: a,
  onZoomOut: o,
  onFitView: s,
  onInteractiveChange: c,
  className: l,
  children: u,
  position: d = `bottom-left`,
  orientation: f = `vertical`,
  "aria-label": p,
}) {
  let m = $(),
    {
      isInteractive: h,
      minZoomReached: g,
      maxZoomReached: _,
      ariaLabelConfig: y,
    } = Q(Is, T),
    { zoomIn: b, zoomOut: x, fitView: S } = ma();
  return (0, R.jsxs)(ki, {
    className: v([
      `react-flow__controls`,
      f === `horizontal` ? `horizontal` : `vertical`,
      l,
    ]),
    position: d,
    style: e,
    "data-testid": `rf__controls`,
    "aria-label": p ?? y[`controls.ariaLabel`],
    children: [
      t &&
        (0, R.jsxs)(R.Fragment, {
          children: [
            (0, R.jsx)(Fs, {
              onClick: () => {
                (b(), a?.());
              },
              className: `react-flow__controls-zoomin`,
              title: y[`controls.zoomIn.ariaLabel`],
              "aria-label": y[`controls.zoomIn.ariaLabel`],
              disabled: _,
              children: (0, R.jsx)(As, {}),
            }),
            (0, R.jsx)(Fs, {
              onClick: () => {
                (x(), o?.());
              },
              className: `react-flow__controls-zoomout`,
              title: y[`controls.zoomOut.ariaLabel`],
              "aria-label": y[`controls.zoomOut.ariaLabel`],
              disabled: g,
              children: (0, R.jsx)(js, {}),
            }),
          ],
        }),
      n &&
        (0, R.jsx)(Fs, {
          className: `react-flow__controls-fitview`,
          onClick: () => {
            (S(i), s?.());
          },
          title: y[`controls.fitView.ariaLabel`],
          "aria-label": y[`controls.fitView.ariaLabel`],
          children: (0, R.jsx)(Ms, {}),
        }),
      r &&
        (0, R.jsx)(Fs, {
          className: `react-flow__controls-interactive`,
          onClick: () => {
            (m.setState({
              nodesDraggable: !h,
              nodesConnectable: !h,
              elementsSelectable: !h,
            }),
              c?.(!h));
          },
          title: y[`controls.interactive.ariaLabel`],
          "aria-label": y[`controls.interactive.ariaLabel`],
          children: h ? (0, R.jsx)(Ps, {}) : (0, R.jsx)(Ns, {}),
        }),
      u,
    ],
  });
}
Ls.displayName = `Controls`;
var Rs = (0, M.memo)(Ls);
function zs({
  id: e,
  x: t,
  y: n,
  width: r,
  height: i,
  style: a,
  color: o,
  strokeColor: s,
  strokeWidth: c,
  className: l,
  borderRadius: u,
  shapeRendering: d,
  selected: f,
  onClick: p,
}) {
  let { background: m, backgroundColor: h } = a || {},
    g = o || m || h;
  return (0, R.jsx)(`rect`, {
    className: v([`react-flow__minimap-node`, { selected: f }, l]),
    x: t,
    y: n,
    rx: u,
    ry: u,
    width: r,
    height: i,
    style: { fill: g, stroke: s, strokeWidth: c },
    shapeRendering: d,
    onClick: p ? (t) => p(t, e) : void 0,
  });
}
var Bs = (0, M.memo)(zs),
  Vs = (e) => e.nodes.map((e) => e.id),
  Hs = (e) => (e instanceof Function ? e : () => e);
function Us({
  nodeStrokeColor: e,
  nodeColor: t,
  nodeClassName: n = ``,
  nodeBorderRadius: r = 5,
  nodeStrokeWidth: i,
  nodeComponent: a = Bs,
  onClick: o,
}) {
  let s = Q(Vs, T),
    c = Hs(t),
    l = Hs(e),
    u = Hs(n),
    d =
      typeof window > `u` || window.chrome
        ? `crispEdges`
        : `geometricPrecision`;
  return (0, R.jsx)(R.Fragment, {
    children: s.map((e) =>
      (0, R.jsx)(
        Gs,
        {
          id: e,
          nodeColorFunc: c,
          nodeStrokeColorFunc: l,
          nodeClassNameFunc: u,
          nodeBorderRadius: r,
          nodeStrokeWidth: i,
          NodeComponent: a,
          onClick: o,
          shapeRendering: d,
        },
        e,
      ),
    ),
  });
}
function Ws({
  id: e,
  nodeColorFunc: t,
  nodeStrokeColorFunc: n,
  nodeClassNameFunc: r,
  nodeBorderRadius: i,
  nodeStrokeWidth: a,
  shapeRendering: o,
  NodeComponent: s,
  onClick: c,
}) {
  let {
    node: l,
    x: u,
    y: d,
    width: f,
    height: p,
  } = Q((t) => {
    let n = t.nodeLookup.get(e);
    if (!n) return { node: void 0, x: 0, y: 0, width: 0, height: 0 };
    let r = n.internals.userNode,
      { x: i, y: a } = n.internals.positionAbsolute,
      { width: o, height: s } = X(r);
    return { node: r, x: i, y: a, width: o, height: s };
  }, T);
  return !l || l.hidden || !wn(l)
    ? null
    : (0, R.jsx)(s, {
        x: u,
        y: d,
        width: f,
        height: p,
        style: l.style,
        selected: !!l.selected,
        className: r(l),
        color: t(l),
        borderRadius: i,
        strokeColor: n(l),
        strokeWidth: a,
        shapeRendering: o,
        onClick: c,
        id: l.id,
      });
}
var Gs = (0, M.memo)(Ws),
  Ks = (0, M.memo)(Us),
  qs = 200,
  Js = 150,
  Ys = (e) => !e.hidden,
  Xs = (e) => {
    let t = {
      x: -e.transform[0] / e.transform[2],
      y: -e.transform[1] / e.transform[2],
      width: e.width / e.transform[2],
      height: e.height / e.transform[2],
    };
    return {
      viewBB: t,
      boundingRect:
        e.nodeLookup.size > 0 ? dn(qt(e.nodeLookup, { filter: Ys }), t) : t,
      rfId: e.rfId,
      panZoom: e.panZoom,
      translateExtent: e.translateExtent,
      flowWidth: e.width,
      flowHeight: e.height,
      ariaLabelConfig: e.ariaLabelConfig,
    };
  },
  Zs = `react-flow__minimap-desc`;
function Qs({
  style: e,
  className: t,
  nodeStrokeColor: n,
  nodeColor: r,
  nodeClassName: i = ``,
  nodeBorderRadius: a = 5,
  nodeStrokeWidth: o,
  nodeComponent: s,
  bgColor: c,
  maskColor: l,
  maskStrokeColor: u,
  maskStrokeWidth: d,
  position: f = `bottom-right`,
  onClick: p,
  onNodeClick: m,
  pannable: h = !1,
  zoomable: g = !1,
  ariaLabel: _,
  inversePan: y,
  zoomStep: b = 1,
  offsetScale: x = 5,
}) {
  let S = $(),
    C = (0, M.useRef)(null),
    {
      boundingRect: w,
      viewBB: E,
      rfId: D,
      panZoom: O,
      translateExtent: k,
      flowWidth: A,
      flowHeight: j,
      ariaLabelConfig: N,
    } = Q(Xs, T),
    P = e?.width ?? qs,
    F = e?.height ?? Js,
    I = w.width / P,
    L = w.height / F,
    z = Math.max(I, L),
    B = z * P,
    V = z * F,
    H = x * z,
    U = w.x - (B - w.width) / 2 - H,
    W = w.y - (V - w.height) / 2 - H,
    G = B + H * 2,
    ee = V + H * 2,
    te = `${Zs}-${D}`,
    ne = (0, M.useRef)(0),
    K = (0, M.useRef)();
  ((ne.current = z),
    (0, M.useEffect)(() => {
      if (C.current && O)
        return (
          (K.current = Br({
            domNode: C.current,
            panZoom: O,
            getTransform: () => S.getState().transform,
            getViewScale: () => ne.current,
          })),
          () => {
            K.current?.destroy();
          }
        );
    }, [O]),
    (0, M.useEffect)(() => {
      K.current?.update({
        translateExtent: k,
        width: A,
        height: j,
        inversePan: y,
        pannable: h,
        zoomStep: b,
        zoomable: g,
      });
    }, [h, g, y, b, k, A, j]));
  let re = p
      ? (e) => {
          let [t, n] = K.current?.pointer(e) || [0, 0];
          p(e, { x: t, y: n });
        }
      : void 0,
    ie = m
      ? (0, M.useCallback)((e, t) => {
          let n = S.getState().nodeLookup.get(t).internals.userNode;
          m(e, n);
        }, [])
      : void 0,
    ae = _ ?? N[`minimap.ariaLabel`];
  return (0, R.jsx)(ki, {
    position: f,
    style: {
      ...e,
      "--xy-minimap-background-color-props": typeof c == `string` ? c : void 0,
      "--xy-minimap-mask-background-color-props":
        typeof l == `string` ? l : void 0,
      "--xy-minimap-mask-stroke-color-props": typeof u == `string` ? u : void 0,
      "--xy-minimap-mask-stroke-width-props":
        typeof d == `number` ? d * z : void 0,
      "--xy-minimap-node-background-color-props":
        typeof r == `string` ? r : void 0,
      "--xy-minimap-node-stroke-color-props": typeof n == `string` ? n : void 0,
      "--xy-minimap-node-stroke-width-props": typeof o == `number` ? o : void 0,
    },
    className: v([`react-flow__minimap`, t]),
    "data-testid": `rf__minimap`,
    children: (0, R.jsxs)(`svg`, {
      width: P,
      height: F,
      viewBox: `${U} ${W} ${G} ${ee}`,
      className: `react-flow__minimap-svg`,
      role: `img`,
      "aria-labelledby": te,
      ref: C,
      onClick: re,
      children: [
        ae && (0, R.jsx)(`title`, { id: te, children: ae }),
        (0, R.jsx)(Ks, {
          onClick: ie,
          nodeColor: r,
          nodeStrokeColor: n,
          nodeBorderRadius: a,
          nodeClassName: i,
          nodeStrokeWidth: o,
          nodeComponent: s,
        }),
        (0, R.jsx)(`path`, {
          className: `react-flow__minimap-mask`,
          d: `M${U - H},${W - H}h${G + H * 2}v${ee + H * 2}h${-G - H * 2}z
        M${E.x},${E.y}h${E.width}v${E.height}h${-E.width}z`,
          fillRule: `evenodd`,
          pointerEvents: `none`,
        }),
      ],
    }),
  });
}
Qs.displayName = `MiniMap`;
var $s = (0, M.memo)(Qs),
  ec = (e) => (t) => (e ? `${Math.max(1 / t.transform[2], 1)}` : void 0),
  tc = { [ti.Line]: `right`, [ti.Handle]: `bottom-right` };
function nc({
  nodeId: e,
  position: t,
  variant: n = ti.Handle,
  className: r,
  style: i = void 0,
  children: a,
  color: o,
  minWidth: s = 10,
  minHeight: c = 10,
  maxWidth: l = Number.MAX_VALUE,
  maxHeight: u = Number.MAX_VALUE,
  keepAspectRatio: d = !1,
  resizeDirection: f,
  autoScale: p = !0,
  shouldResize: m,
  onResizeStart: h,
  onResize: g,
  onResizeEnd: _,
}) {
  let y = Na(),
    b = typeof e == `string` ? e : y,
    x = $(),
    S = (0, M.useRef)(null),
    C = n === ti.Handle,
    w = Q((0, M.useCallback)(ec(C && p), [C, p]), T),
    E = (0, M.useRef)(null),
    D = t ?? tc[n];
  return (
    (0, M.useEffect)(() => {
      if (!(!S.current || !b))
        return (
          (E.current ||= hi({
            domNode: S.current,
            nodeId: b,
            getStoreItems: () => {
              let {
                nodeLookup: e,
                transform: t,
                snapGrid: n,
                snapToGrid: r,
                nodeOrigin: i,
                domNode: a,
              } = x.getState();
              return {
                nodeLookup: e,
                transform: t,
                snapGrid: n,
                snapToGrid: r,
                nodeOrigin: i,
                paneDomNode: a,
              };
            },
            onChange: (e, t) => {
              let {
                  triggerNodeChanges: n,
                  nodeLookup: r,
                  parentLookup: i,
                  nodeOrigin: a,
                } = x.getState(),
                o = [],
                s = { x: e.x, y: e.y },
                c = r.get(b);
              if (c && c.expandParent && c.parentId) {
                let t = c.origin ?? a,
                  n = e.width ?? c.measured.width ?? 0,
                  l = e.height ?? c.measured.height ?? 0,
                  u = yr(
                    [
                      {
                        id: c.id,
                        parentId: c.parentId,
                        rect: {
                          width: n,
                          height: l,
                          ...Tn(
                            { x: e.x ?? c.position.x, y: e.y ?? c.position.y },
                            { width: n, height: l },
                            c.parentId,
                            r,
                            t,
                          ),
                        },
                      },
                    ],
                    r,
                    i,
                    a,
                  );
                (o.push(...u),
                  (s.x = e.x ? Math.max(t[0] * n, e.x) : void 0),
                  (s.y = e.y ? Math.max(t[1] * l, e.y) : void 0));
              }
              if (s.x !== void 0 && s.y !== void 0) {
                let e = { id: b, type: `position`, position: { ...s } };
                o.push(e);
              }
              if (e.width !== void 0 && e.height !== void 0) {
                let t = {
                  id: b,
                  type: `dimensions`,
                  resizing: !0,
                  setAttributes: f
                    ? f === `horizontal`
                      ? `width`
                      : `height`
                    : !0,
                  dimensions: { width: e.width, height: e.height },
                };
                o.push(t);
              }
              for (let e of t) {
                let t = { ...e, type: `position` };
                o.push(t);
              }
              n(o);
            },
            onEnd: ({ width: e, height: t }) => {
              let n = {
                id: b,
                type: `dimensions`,
                resizing: !1,
                dimensions: { width: e, height: t },
              };
              x.getState().triggerNodeChanges([n]);
            },
          })),
          E.current.update({
            controlPosition: D,
            boundaries: {
              minWidth: s,
              minHeight: c,
              maxWidth: l,
              maxHeight: u,
            },
            keepAspectRatio: d,
            resizeDirection: f,
            onResizeStart: h,
            onResize: g,
            onResizeEnd: _,
            shouldResize: m,
          }),
          () => {
            E.current?.destroy();
          }
        );
    }, [D, s, c, l, u, d, h, g, _, m]),
    (0, R.jsx)(`div`, {
      className: v([
        `react-flow__resize-control`,
        `nodrag`,
        ...D.split(`-`),
        n,
        r,
      ]),
      ref: S,
      style: {
        ...i,
        scale: w,
        ...(o && { [C ? `backgroundColor` : `borderColor`]: o }),
      },
      children: a,
    })
  );
}
var rc = (0, M.memo)(nc);
function ic({
  nodeId: e,
  isVisible: t = !0,
  handleClassName: n,
  handleStyle: r,
  lineClassName: i,
  lineStyle: a,
  color: o,
  minWidth: s = 10,
  minHeight: c = 10,
  maxWidth: l = Number.MAX_VALUE,
  maxHeight: u = Number.MAX_VALUE,
  keepAspectRatio: d = !1,
  autoScale: f = !0,
  shouldResize: p,
  onResizeStart: m,
  onResize: h,
  onResizeEnd: g,
}) {
  return t
    ? (0, R.jsxs)(R.Fragment, {
        children: [
          ri.map((t) =>
            (0, R.jsx)(
              rc,
              {
                className: i,
                style: a,
                nodeId: e,
                position: t,
                variant: ti.Line,
                color: o,
                minWidth: s,
                minHeight: c,
                maxWidth: l,
                maxHeight: u,
                onResizeStart: m,
                keepAspectRatio: d,
                autoScale: f,
                shouldResize: p,
                onResize: h,
                onResizeEnd: g,
              },
              t,
            ),
          ),
          ni.map((t) =>
            (0, R.jsx)(
              rc,
              {
                className: n,
                style: r,
                nodeId: e,
                position: t,
                color: o,
                minWidth: s,
                minHeight: c,
                maxWidth: l,
                maxHeight: u,
                onResizeStart: m,
                keepAspectRatio: d,
                autoScale: f,
                shouldResize: p,
                onResize: h,
                onResizeEnd: g,
              },
              t,
            ),
          ),
        ],
      })
    : null;
}
function ac(e) {
  let { setNodes: t } = ma(),
    n = bs(),
    r = (0, M.useCallback)(
      (t) => {
        if (!e)
          return { title: t, description: void 0, node: void 0, data: void 0 };
        let r = n.find((t) => t.id === e);
        return r
          ? {
              title: r?.title || t,
              description: r?.description || r.data?.description,
              node: r,
              data: r.data,
            }
          : { title: t, description: void 0, node: void 0, data: void 0 };
      },
      [e, n],
    ),
    i = (0, M.useCallback)(() => {
      if (!e) return [];
      let t = n.find((t) => t.id === e);
      return (t && t.data?.block?.nodes) || [];
    }, [e, n]);
  return {
    saveNodeData: (0, M.useCallback)(
      (n) => {
        e &&
          t((t) =>
            t.map((t) => {
              if (t.id === e) {
                if (typeof n == `function`) return n(t);
                let { data: e, updater: r, ...i } = n;
                if (r) return r(t);
                let a = {};
                return (
                  Object.keys(i).forEach((e) => {
                    let t = i[e];
                    t !== void 0 && (a[e] = t);
                  }),
                  e !== void 0 && (a.data = { ...t.data, ...e }),
                  { ...t, ...a }
                );
              }
              return t;
            }),
          );
      },
      [e, t],
    ),
    getNodeData: r,
    getNodeBlockData: i,
  };
}
var oc = (e) => p(`get`, `/agent-mcp/mcpManage/api/listPage`, e),
  sc = (e = {}) => p(`post`, `/agent-microapp/graphAgent/createSession`, e),
  cc = (e) => p(`post`, `/agent-microapp/microApp/getGraphMicroApp`, e),
  lc = (e) => p(`post`, `/agent-microapp/component/workflowPage`, e),
  uc = (e) => {
    let t = e.trim();
    return t.startsWith(`Array`)
      ? `Arr`
      : t.startsWith(`File`)
        ? `File`
        : { Number: `Num`, String: `Str`, Object: `Obj`, Boolean: `Bool` }[t] ||
          t;
  };
function dc(e) {
  return (
    {
      [A.IteratorNode]: `循环开始`,
      [A.ParallelNode]: `批处理开始`,
      [A.ContainerNode]: `并行开始`,
    }[e] || `开始`
  );
}
function fc(e) {
  return (
    {
      [A.IteratorNode]: `迭代结束`,
      [A.ParallelNode]: `批处理结束`,
      [A.ContainerNode]: `并行结束`,
    }[e] || `结束`
  );
}
function pc(e, t, n = []) {
  if (e === A.MCPNode) {
    let e = t?.toolName;
    if (e) return e;
  }
  if (e === A.PluginNode) {
    let e = t?.compName;
    if (e) return e;
  }
  let r = Ae()[e] || `节点`,
    i = n.filter(
      (t) => t.type && (t.type === e || String(t.type) === String(e)),
    ),
    a = r.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`),
    o = RegExp(`^${a}(\\d+)$`),
    s = new Set();
  if (
    (i.forEach((e) => {
      let t = e.title;
      if (t)
        if (t === r) s.add(1);
        else {
          let e = t.match(o);
          if (e) {
            let t = parseInt(e[1], 10);
            s.add(t);
          }
        }
    }),
    s.size === 0)
  )
    return `${r}1`;
  let c = Array.from(s).sort((e, t) => e - t),
    l = 1;
  for (let e of c)
    if (e === l) l++;
    else break;
  return `${r}${l}`;
}
var mc = class {
  static CHARS = `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
  static generateNodeId(e) {
    return `${e.charAt(0).toUpperCase() + e.slice(1)}_${this.generateRandomString(4)}`;
  }
  static generateEdgeId(e, t, n, r) {
    return `${e}-${t}-${n}-${r}`;
  }
  static generateBranchId() {
    return this.generateRandomString(4);
  }
  static generateUniversalId(e = `id`) {
    return `${e}_${this.generateRandomString(12)}_${Date.now().toString(36)}`;
  }
  static generateRandomString(e) {
    let t = ``,
      n = this.CHARS.length,
      r = new Date().getTime() % 1e3;
    for (let i = 0; i < e; i++) {
      let e = Math.floor((Math.random() * n + r) % n);
      t += this.CHARS[e];
    }
    return t;
  }
};
function hc(e) {
  let {
      nodeType: t,
      nodeData: n = {},
      position: r,
      nodeId: i,
      title: a,
      existingNodes: o,
      getExtraFromData: s,
      autoOpen: c = !0,
    } = e,
    l = i || mc.generateNodeId(t.replace(`Node`, ``).toLowerCase()),
    u = s ? s(t, n) : n,
    d = s ? u : n,
    f;
  f =
    a ||
    (t === A.StartNode
      ? `开始`
      : t === A.EndNode
        ? `结束`
        : o === void 0
          ? Ae()[t] || ``
          : pc(t, n, o));
  let p = c ? { ...d, _autoOpen: !0 } : d;
  return [{ id: l, type: t, position: r, title: f, data: p }];
}
function gc(e = []) {
  let t = [];
  return (
    e.forEach((e) => {
      t.push({ type: e.type, title: e.title || e.data?.title });
    }),
    e.forEach((e) => {
      let n = e.type;
      [A.IteratorNode, A.ParallelNode, A.ContainerNode].includes(n) &&
        (e.data?.block?.nodes || []).forEach((e) => {
          t.push({ type: e.type, title: e.title || e.data?.title });
        });
    }),
    t
  );
}
function _c(e, t, n) {
  e.forEach((e) => {
    let r = String(e.id);
    if (!n.has(r)) {
      (t.push({ id: r, title: e.title || e.data?.title }), n.add(r));
      let i = e.type;
      if ([A.IteratorNode, A.ParallelNode, A.ContainerNode].includes(i)) {
        let r = e.data?.block?.nodes || [];
        r.length > 0 && _c(r, t, n);
      }
    }
  });
}
function vc(e = [], t = []) {
  let n = [],
    r = new Set();
  return (
    e.forEach((e) => {
      let t = String(e.id);
      r.has(t) ||
        (n.push({ id: t, title: e.title || e.data?.title }), r.add(t));
    }),
    t.forEach((e) => {
      let t = String(e.id);
      r.has(t) ||
        (n.push({ id: t, title: e.title || e.data?.title }), r.add(t));
    }),
    e.forEach((e) => {
      let t = e.type;
      if ([A.IteratorNode, A.ParallelNode, A.ContainerNode].includes(t)) {
        let t = e.data?.block?.nodes || [];
        t.length > 0 && _c(t, n, r);
      }
    }),
    n
  );
}
function yc(e, t, n) {
  return e.find((e) => e.id !== t && e.title === n)
    ? `节点标题不能重复，请使用其他标题`
    : null;
}
var bc = {
  label: `_label_1g0cm_1`,
  "model-name": `_model-name_1g0cm_6`,
  tag: `_tag_1g0cm_9`,
  "model-description": `_model-description_1g0cm_16`,
};
o();
var xc = ({ model: e }) =>
    (0, R.jsxs)(`div`, {
      className: bc.label,
      children: [
        (0, R.jsx)(i.Text, {
          className: bc[`model-name`],
          children: e?.modelName,
        }),
        !!e?.modelLabel?.length &&
          (0, R.jsx)(`span`, {
            children: e.modelLabel
              .split(`,`)
              .map((e, t) =>
                (0, R.jsx)(s, { className: bc.tag, children: e }, t),
              ),
          }),
        (0, R.jsx)(a, {
          title: e?.description,
          children: (0, R.jsx)(`span`, {
            className: bc[`model-description`],
            children: e?.description,
          }),
        }),
      ],
    }),
  Sc = (e) => {
    if (!e) return ``;
    let t = e.modelCode,
      n = e.supplierCode;
    return !t || !n ? `` : `${t}#${n}`;
  },
  Cc = (e) => (e ? (e.modelId == null ? Sc(e) : `${Sc(e)}#${e.modelId}`) : ``),
  wc = (e) => {
    if (!e || typeof e != `string`) return null;
    let t = e.split(`#`);
    return t.length >= 3
      ? { modelCode: t[0], supplierCode: t[1], modelId: t[2] }
      : t.length === 2
        ? { modelCode: t[0], supplierCode: t[1] }
        : null;
  },
  Tc = (e, t) => {
    let n = wc(t);
    if (n)
      return n.modelId != null && n.modelId !== ``
        ? e.find((e) => String(e.modelId) === String(n.modelId))
        : e.find(
            (e) =>
              e.modelCode === n.modelCode &&
              (e.supplierCode === n.supplierCode ||
                e.supplierName === n.supplierCode),
          );
  },
  Ec = (e) =>
    e.map((e) => ({
      label: M.createElement(xc, { key: e.modelId, model: e }),
      value: Cc(e),
      title: e.modelName,
    })),
  Dc = (e) => (e ? (e === `Double` ? `Number` : e) : `String`),
  Oc = ({ sample: e, paramType: t, code: n }) =>
    e && (K(n) || ie(n))
      ? t === `Boolean`
        ? e === `true`
        : t === `Number`
          ? Number(e)
          : e
      : ``,
  kc = (e) =>
    (e || []).map((e) => ({
      key: e.code,
      value: Oc({ sample: e.sample, paramType: e.paramType, code: e.code }),
      valueFrom: `input`,
      type: Dc(e.paramType),
      desc: e.name,
      enabled: !1,
    })),
  Ac = (e) => {
    let t = {};
    return (
      e.forEach((e) => {
        let n = e.supplierId;
        (t[n] ||
          (t[n] = {
            label: e.supplierName || `默认模型名称` + n,
            title: e.supplierName || `默认模型名称` + n,
            options: [],
          }),
          t[n].options.push({ ...e }));
      }),
      Object.values(t)
    );
  },
  jc = (e, t) => {
    let n = new Map(e.map((e) => [e.code, e])),
      r = new Set(t || []);
    return ee
      .filter((e) => !r.has(e))
      .map((e) => n.get(e))
      .filter(Boolean);
  },
  Mc = (e) => {
    let t = new Map(e.map((e) => [e.code, e]));
    return ne.map((e) => t.get(e)).filter(Boolean);
  },
  Nc = (e) => e.filter((e) => ie(e.code)),
  Pc = (e) => e.filter((e) => !K(e.code)),
  Fc = ({ modelList: e = [], modelId: t, originInParams: n = [] }) => {
    let r = kc(e.find((e) => e.modelId === t)?.paramDefineList || []),
      i = r.filter((e) => K(e.key)),
      a = r.filter((e) => !K(e.key)),
      o = (e) => n.filter((t) => e.some((e) => e.key === t.key));
    return { paramConfig: o(i), inParams: o(a) };
  };
o();
function Ic(e, t) {
  for (let n of e) {
    let e = n.type;
    if (
      [A.IteratorNode, A.ParallelNode, A.ContainerNode].includes(e) &&
      (n.data?.block?.nodes || []).some((e) => t.has(String(e.id)))
    )
      return e;
  }
  return null;
}
function Lc(e, t) {
  if (!e) return null;
  let n = Ae();
  return (
    n[e],
    n[t],
    [A.IteratorNode, A.ParallelNode, A.ContainerNode].includes(t)
      ? `子画布不能互相嵌套`
      : null
  );
}
function Rc(e) {
  return e.some((e) => e.data?.isInSubCanvas === !0);
}
function zc(e) {
  let t = e.filter((e) => e.data?.isInSubCanvas === !0);
  return new Set(t.map((e) => String(e.id)));
}
function Bc(e, t, n = {}) {
  let { showMessage: r = !0 } = n;
  if (!t || t.length === 0) return { valid: !0 };
  if (!Rc(t)) {
    if (e === A.ContainerNode)
      try {
        let { mainCanvasNodes: e } = j.getState();
        if ((e || []).filter((e) => e.type === A.ContainerNode).length >= 10) {
          let e = `最多只能添加10个${Ae()[A.ContainerNode] || `并行节点`}`;
          return (r && c.warning(e), { valid: !1, errorMessage: e });
        }
      } catch (e) {
        console.warn(`统计主画布并行节点数量时发生错误:`, e);
      }
    return { valid: !0 };
  }
  try {
    let { mainCanvasNodes: n } = j.getState(),
      i = Lc(Ic(n, zc(t)), e);
    return i
      ? (r && c.warning(i), { valid: !1, errorMessage: i })
      : { valid: !0 };
  } catch (e) {
    return (console.warn(`嵌套画布节点校验时发生错误:`, e), { valid: !0 });
  }
}
function Vc(e, t, n) {
  return Bc(e, t, { showMessage: !0, sourceNodeId: n }).valid;
}
var Hc = (e) => {
    switch (e.type) {
      case A.RuleNode: {
        let t = e.data?.rule;
        return Array.isArray(t)
          ? {
              ...e,
              data: {
                ...e.data,
                rule: t.map((t) => ({
                  ...t,
                  relNodeId: `${e.id}_${mc.generateBranchId()}`,
                })),
              },
            }
          : e;
      }
      case A.ExecuteConfirmNode: {
        let t = e.data?.executionBranch;
        return Array.isArray(t)
          ? {
              ...e,
              data: {
                ...e.data,
                executionBranch: t.map((e) => ({
                  ...e,
                  id: `execution_branch_${mc.generateBranchId()}`,
                  targetId: void 0,
                })),
              },
            }
          : e;
      }
      case A.IntentNode: {
        let t = e.data?.conditions;
        return Array.isArray(t)
          ? {
              ...e,
              data: {
                ...e.data,
                conditions: t.map((e) => ({
                  ...e,
                  conditionId:
                    e.conditionId === "default"
                      ? `default`
                      : `condition_${mc.generateBranchId()}`,
                  targetId: void 0,
                })),
              },
            }
          : e;
      }
      default:
        return e;
    }
  },
  Uc = (e) => e.map((e) => Hc(e)),
  Wc = {
    key: [
      { pattern: /^[A-Za-z_]/, message: `变量名只能以字母或下划线开头` },
      {
        pattern: /^[A-Za-z0-9_]+$/,
        message: `变量名只能包含字母、数字和下划线`,
      },
    ],
  },
  Gc = (e = {}) => ({ ...Wc, ...e }),
  Kc = (e, t) => e[t] ?? [],
  qc = (e, t) => {
    if (
      !e ||
      e.length === 0 ||
      !t?.some((e) => typeof e == `object` && `pattern` in e)
    )
      return e;
    let n = t.some(
        (e) =>
          typeof e == `object` &&
          `pattern` in e &&
          e.pattern instanceof RegExp &&
          e.pattern.toString().includes(`[A-Za-z0-9_]`),
      ),
      r = t.some(
        (e) =>
          typeof e == `object` &&
          `pattern` in e &&
          e.pattern instanceof RegExp &&
          e.pattern.toString().includes(`^[A-Za-z_]`),
      ),
      i = e;
    if (
      (n && (i = i.replace(/[^A-Za-z0-9_]/g, ``)),
      r && i.length > 0 && !/^[A-Za-z_]/.test(i))
    ) {
      let e = i.match(/[A-Za-z_][A-Za-z0-9_]*/);
      i = e ? e[0] : ``;
    }
    return i;
  },
  Jc = (function (e) {
    return (
      (e[(e.NUMBER = 1)] = `NUMBER`),
      (e[(e.STRING = 2)] = `STRING`),
      (e[(e.OBJECT = 3)] = `OBJECT`),
      (e[(e.ARRAY = 4)] = `ARRAY`),
      (e[(e.IMAGE_ARRAY = 5)] = `IMAGE_ARRAY`),
      (e[(e.VIDEO_ARRAY = 6)] = `VIDEO_ARRAY`),
      e
    );
  })({}),
  Yc = {
    [Jc.NUMBER]: `Number`,
    [Jc.STRING]: `String`,
    [Jc.OBJECT]: `Object`,
    [Jc.ARRAY]: `Array`,
    [Jc.IMAGE_ARRAY]: `Array<File<img>>`,
    [Jc.VIDEO_ARRAY]: `Array<File<vid>>`,
  },
  Xc = (e, t, n) => {
    let r = e.match(/^\$\{sys\.([^}]+)\}$/);
    if (r && n) {
      let [, e] = r,
        t = n.find((t) => (t.paramCode || t.value) === e);
      if (t) {
        let e = t.paramType || t.type;
        console.log(`typeEnum===`, e);
        let n = Yc[e];
        if (n) return n;
      }
    }
    let i = e.match(/^\$\{([^.]+)\.result\.(.+)\}$/);
    if (!i) return null;
    let [, a, o] = i,
      s = o.split(`.`),
      c = t.find((e) => String(e.id) === String(a));
    if (!c || !c.data) return null;
    let l = c.data.outputParams || c.data.outParams;
    if (!Array.isArray(l)) return null;
    let u = l;
    for (let e = 0; e < s.length; e++) {
      let t = s[e],
        n = u.find((e) => (e.key || e.paramCode) === t);
      if (!n) return null;
      if (e === s.length - 1) return n.type || null;
      if (((u = n.properties || n.children || []), !Array.isArray(u)))
        return null;
    }
    return null;
  },
  Zc = (e, t, n) => {
    let r = [`Array`, `Object`];
    return e.map((e) => {
      if (e.valueFrom === `refer` && e.type && r.includes(e.type) && e.value) {
        let r = Xc(e.value, t, n);
        if (r && r !== e.type) return { ...e, fullType: r };
      }
      return e;
    });
  };
export {
  _t as $,
  lc as A,
  j as At,
  fs as B,
  fc as C,
  De as Ct,
  sc as D,
  ge as Dt,
  uc as E,
  Ne as Et,
  Rs as F,
  bs as G,
  Qi as H,
  vs as I,
  Gn as J,
  ma as K,
  La as L,
  ks as M,
  vo as N,
  cc as O,
  ae as Ot,
  Fs as P,
  Dt as Q,
  $s as R,
  vc as S,
  Fe as St,
  yc as T,
  Ae as Tt,
  gs as U,
  $i as V,
  Ss as W,
  At as X,
  zn as Y,
  Tt as Z,
  Ac as _,
  Be as _t,
  Gc as a,
  st as at,
  hc as b,
  Re as bt,
  Fc as c,
  Xe as ct,
  Mc as d,
  ct as dt,
  mt as et,
  jc as f,
  Qe as ft,
  kc as g,
  Ue as gt,
  Nc as h,
  He as ht,
  Kc as i,
  ot as it,
  ac as j,
  A as jt,
  oc as k,
  z as kt,
  Sc as l,
  qe as lt,
  Pc as m,
  Ve as mt,
  Yc as n,
  gt as nt,
  Uc as o,
  at as ot,
  Tc as p,
  We as pt,
  J as q,
  qc as r,
  $e as rt,
  Vc as s,
  Je as st,
  Zc as t,
  ht as tt,
  Cc as u,
  Ye as ut,
  Ec as v,
  ze as vt,
  dc as w,
  Me as wt,
  gc as x,
  Ie as xt,
  mc as y,
  Le as yt,
  ic as z,
};
