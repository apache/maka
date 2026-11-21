import{p as B}from"./chunk-TMUBEWPD-BIiztzpO.js";import{V as y,P as z,aF as U,_ as p,g as j,s as Z,a as q,b as H,n as J,o as K,l as F,c as Q,C as X,G as Y,a4 as tt,e as et,v as rt,E as at}from"./sidebar-CcM-4_yp.js";import{p as nt}from"./gitGraph-YCYPL57B-BaKMK9g9.js";import{d as O}from"./arc-DMCbTmUU.js";import{o as it}from"./ordinal-Cboi1Yqb.js";import"./modulepreload-polyfill-B5Qt9EMX.js";import"./index-CdTgm28c.js";import"./i18n-b57E8EYG.js";import"./useSettings-CS-xfdW0.js";import"./index-1G0MRvKj.js";import"./useTranslation-WtPn4Fa0.js";import"./button-BEGRz3QU.js";import"./utils-C0EutI9V.js";import"./clsx-B-dksMZM.js";import"./proxy-C9frugAW.js";import"./browser-C8oXKADD.js";import"./client-CQ1hcK1l.js";import"./useLiquidGlass-BfIyFr8C.js";import"./_virtual_stub-crypto-BDMct_Gn-D7ZuWTsr.js";import"./getYouMindHost-BW5XiKRP.js";import"./refresh-ccw-BIEhTRJL.js";import"./index-CJNCxxua.js";import"./arrow-right-8vuRry-q.js";import"./switch-DwTZvLLE.js";import"./ExtensionSvg-B-kdueov.js";import"./fullPageCelebrate-BiUufqV5.js";import"./tweets-Be8YQyei.js";import"./index-BXxbW4z9.js";import"./_baseUniq-Dq6fIKUZ.js";import"./_basePickBy-D31E4b4W.js";import"./clone-rCK80mDc.js";import"./init-Gi6I4Gst.js";function ot(t,r){return r<t?-1:r>t?1:r>=t?0:NaN}function st(t){return t}function lt(){var t=st,r=ot,f=null,o=y(0),u=y(z),x=y(0);function i(e){var a,l=(e=U(e)).length,d,A,h=0,c=new Array(l),n=new Array(l),v=+o.apply(this,arguments),w=Math.min(z,Math.max(-z,u.apply(this,arguments)-v)),m,T=Math.min(Math.abs(w)/l,x.apply(this,arguments)),$=T*(w<0?-1:1),g;for(a=0;a<l;++a)(g=n[c[a]=a]=+t(e[a],a,e))>0&&(h+=g);for(r!=null?c.sort(function(S,C){return r(n[S],n[C])}):f!=null&&c.sort(function(S,C){return f(e[S],e[C])}),a=0,A=h?(w-l*$)/h:0;a<l;++a,v=m)d=c[a],g=n[d],m=v+(g>0?g*A:0)+$,n[d]={data:e[d],index:a,value:g,startAngle:v,endAngle:m,padAngle:T};return n}return i.value=function(e){return arguments.length?(t=typeof e=="function"?e:y(+e),i):t},i.sortValues=function(e){return arguments.length?(r=e,f=null,i):r},i.sort=function(e){return arguments.length?(f=e,r=null,i):f},i.startAngle=function(e){return arguments.length?(o=typeof e=="function"?e:y(+e),i):o},i.endAngle=function(e){return arguments.length?(u=typeof e=="function"?e:y(+e),i):u},i.padAngle=function(e){return arguments.length?(x=typeof e=="function"?e:y(+e),i):x},i}var ct=at.pie,G={sections:new Map,showData:!1},b=G.sections,P=G.showData,pt=structuredClone(ct),ut=p(()=>structuredClone(pt),"getConfig"),dt=p(()=>{b=new Map,P=G.showData,rt()},"clear"),gt=p(({label:t,value:r})=>{b.has(t)||(b.set(t,r),F.debug(`added new section: ${t}, with value: ${r}`))},"addSection"),mt=p(()=>b,"getSections"),ft=p(t=>{P=t},"setShowData"),ht=p(()=>P,"getShowData"),R={getConfig:ut,clear:dt,setDiagramTitle:K,getDiagramTitle:J,setAccTitle:H,getAccTitle:q,setAccDescription:Z,getAccDescription:j,addSection:gt,getSections:mt,setShowData:ft,getShowData:ht},vt=p((t,r)=>{B(t,r),r.setShowData(t.showData),t.sections.map(r.addSection)},"populateDb"),St={parse:p(async t=>{const r=await nt("pie",t);F.debug(r),vt(r,R)},"parse")},yt=p(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${t.pieOuterStrokeColor};
    stroke-width: ${t.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${t.pieTitleTextSize};
    fill: ${t.pieTitleTextColor};
    font-family: ${t.fontFamily};
  }
  .slice {
    font-family: ${t.fontFamily};
    fill: ${t.pieSectionTextColor};
    font-size:${t.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${t.pieLegendTextColor};
    font-family: ${t.fontFamily};
    font-size: ${t.pieLegendTextSize};
  }
`,"getStyles"),xt=yt,At=p(t=>{const r=[...t.entries()].map(o=>({label:o[0],value:o[1]})).sort((o,u)=>u.value-o.value);return lt().value(o=>o.value)(r)},"createPieArcs"),wt=p((t,r,f,o)=>{F.debug(`rendering pie chart
`+t);const u=o.db,x=Q(),i=X(u.getConfig(),x.pie),e=40,a=18,l=4,d=450,A=d,h=Y(r),c=h.append("g");c.attr("transform","translate("+A/2+","+d/2+")");const{themeVariables:n}=x;let[v]=tt(n.pieOuterStrokeWidth);v??=2;const w=i.textPosition,m=Math.min(A,d)/2-e,T=O().innerRadius(0).outerRadius(m),$=O().innerRadius(m*w).outerRadius(m*w);c.append("circle").attr("cx",0).attr("cy",0).attr("r",m+v/2).attr("class","pieOuterCircle");const g=u.getSections(),S=At(g),C=[n.pie1,n.pie2,n.pie3,n.pie4,n.pie5,n.pie6,n.pie7,n.pie8,n.pie9,n.pie10,n.pie11,n.pie12],D=it(C);c.selectAll("mySlices").data(S).enter().append("path").attr("d",T).attr("fill",s=>D(s.data.label)).attr("class","pieCircle");let W=0;g.forEach(s=>{W+=s}),c.selectAll("mySlices").data(S).enter().append("text").text(s=>(s.data.value/W*100).toFixed(0)+"%").attr("transform",s=>"translate("+$.centroid(s)+")").style("text-anchor","middle").attr("class","slice"),c.append("text").text(u.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText");const M=c.selectAll(".legend").data(D.domain()).enter().append("g").attr("class","legend").attr("transform",(s,E)=>{const k=a+l,L=k*D.domain().length/2,_=12*a,V=E*k-L;return"translate("+_+","+V+")"});M.append("rect").attr("width",a).attr("height",a).style("fill",D).style("stroke",D),M.data(S).append("text").attr("x",a+l).attr("y",a-l).text(s=>{const{label:E,value:k}=s.data;return u.getShowData()?`${E} [${k}]`:E});const I=Math.max(...M.selectAll("text").nodes().map(s=>s?.getBoundingClientRect().width??0)),N=A+e+a+l+I;h.attr("viewBox",`0 0 ${N} ${d}`),et(h,d,N,i.useMaxWidth)},"draw"),Ct={draw:wt},re={parser:St,db:R,renderer:Ct,styles:xt};export{re as diagram};
