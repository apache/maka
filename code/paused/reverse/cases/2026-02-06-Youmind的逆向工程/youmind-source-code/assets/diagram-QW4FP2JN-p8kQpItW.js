import{p as w}from"./chunk-TMUBEWPD-BIiztzpO.js";import{_ as l,s as B,g as S,n as F,o as z,a as P,b as W,C as v,G as D,e as T,v as E,D as _,E as A,l as x}from"./sidebar-CcM-4_yp.js";import{p as N}from"./gitGraph-YCYPL57B-BaKMK9g9.js";import"./modulepreload-polyfill-B5Qt9EMX.js";import"./index-CdTgm28c.js";import"./i18n-b57E8EYG.js";import"./useSettings-CS-xfdW0.js";import"./index-1G0MRvKj.js";import"./useTranslation-WtPn4Fa0.js";import"./button-BEGRz3QU.js";import"./utils-C0EutI9V.js";import"./clsx-B-dksMZM.js";import"./proxy-C9frugAW.js";import"./browser-C8oXKADD.js";import"./client-CQ1hcK1l.js";import"./useLiquidGlass-BfIyFr8C.js";import"./_virtual_stub-crypto-BDMct_Gn-D7ZuWTsr.js";import"./getYouMindHost-BW5XiKRP.js";import"./refresh-ccw-BIEhTRJL.js";import"./index-CJNCxxua.js";import"./arrow-right-8vuRry-q.js";import"./switch-DwTZvLLE.js";import"./ExtensionSvg-B-kdueov.js";import"./fullPageCelebrate-BiUufqV5.js";import"./tweets-Be8YQyei.js";import"./index-BXxbW4z9.js";import"./_baseUniq-Dq6fIKUZ.js";import"./_basePickBy-D31E4b4W.js";import"./clone-rCK80mDc.js";var C={packet:[]},h=structuredClone(C),L=A.packet,Y=l(()=>{const t=v({...L,..._().packet});return t.showBits&&(t.paddingY+=10),t},"getConfig"),G=l(()=>h.packet,"getPacket"),I=l(t=>{t.length>0&&h.packet.push(t)},"pushWord"),M=l(()=>{E(),h=structuredClone(C)},"clear"),u={pushWord:I,getPacket:G,getConfig:Y,clear:M,setAccTitle:W,getAccTitle:P,setDiagramTitle:z,getDiagramTitle:F,getAccDescription:S,setAccDescription:B},O=1e4,H=l(t=>{w(t,u);let e=-1,o=[],n=1;const{bitsPerRow:s}=u.getConfig();for(let{start:a,end:r,label:d}of t.blocks){if(r&&r<a)throw new Error(`Packet block ${a} - ${r} is invalid. End must be greater than start.`);if(a!==e+1)throw new Error(`Packet block ${a} - ${r??a} is not contiguous. It should start from ${e+1}.`);for(e=r??a,x.debug(`Packet block ${a} - ${e} with label ${d}`);o.length<=s+1&&u.getPacket().length<O;){const[f,c]=K({start:a,end:r,label:d},n,s);if(o.push(f),f.end+1===n*s&&(u.pushWord(o),o=[],n++),!c)break;({start:a,end:r,label:d}=c)}}u.pushWord(o)},"populate"),K=l((t,e,o)=>{if(t.end===void 0&&(t.end=t.start),t.start>t.end)throw new Error(`Block start ${t.start} is greater than block end ${t.end}.`);return t.end+1<=e*o?[t,void 0]:[{start:t.start,end:e*o-1,label:t.label},{start:e*o,end:t.end,label:t.label}]},"getNextFittingBlock"),R={parse:l(async t=>{const e=await N("packet",t);x.debug(e),H(e)},"parse")},U=l((t,e,o,n)=>{const s=n.db,a=s.getConfig(),{rowHeight:r,paddingY:d,bitWidth:f,bitsPerRow:c}=a,b=s.getPacket(),i=s.getDiagramTitle(),g=r+d,p=g*(b.length+1)-(i?0:r),m=f*c+2,k=D(e);k.attr("viewbox",`0 0 ${m} ${p}`),T(k,p,m,a.useMaxWidth);for(const[$,y]of b.entries())X(k,y,$,a);k.append("text").text(i).attr("x",m/2).attr("y",p-g/2).attr("dominant-baseline","middle").attr("text-anchor","middle").attr("class","packetTitle")},"draw"),X=l((t,e,o,{rowHeight:n,paddingX:s,paddingY:a,bitWidth:r,bitsPerRow:d,showBits:f})=>{const c=t.append("g"),b=o*(n+a)+a;for(const i of e){const g=i.start%d*r+1,p=(i.end-i.start+1)*r-s;if(c.append("rect").attr("x",g).attr("y",b).attr("width",p).attr("height",n).attr("class","packetBlock"),c.append("text").attr("x",g+p/2).attr("y",b+n/2).attr("class","packetLabel").attr("dominant-baseline","middle").attr("text-anchor","middle").text(i.label),!f)continue;const m=i.end===i.start,k=b-2;c.append("text").attr("x",g+(m?p/2:0)).attr("y",k).attr("class","packetByte start").attr("dominant-baseline","auto").attr("text-anchor",m?"middle":"start").text(i.start),m||c.append("text").attr("x",g+p).attr("y",k).attr("class","packetByte end").attr("dominant-baseline","auto").attr("text-anchor","end").text(i.end)}},"drawWord"),j={draw:U},q={byteFontSize:"10px",startByteColor:"black",endByteColor:"black",labelColor:"black",labelFontSize:"12px",titleColor:"black",titleFontSize:"14px",blockStrokeColor:"black",blockStrokeWidth:"1",blockFillColor:"#efefef"},J=l(({packet:t}={})=>{const e=v(q,t);return`
	.packetByte {
		font-size: ${e.byteFontSize};
	}
	.packetByte.start {
		fill: ${e.startByteColor};
	}
	.packetByte.end {
		fill: ${e.endByteColor};
	}
	.packetLabel {
		fill: ${e.labelColor};
		font-size: ${e.labelFontSize};
	}
	.packetTitle {
		fill: ${e.titleColor};
		font-size: ${e.titleFontSize};
	}
	.packetBlock {
		stroke: ${e.blockStrokeColor};
		stroke-width: ${e.blockStrokeWidth};
		fill: ${e.blockFillColor};
	}
	`},"styles"),St={parser:R,db:u,renderer:j,styles:J};export{St as diagram};
