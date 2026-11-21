import{a as ft,g as at,f as gt,d as mt}from"./chunk-ASOPGD6M-DYUdg8QL.js";import{_ as s,g as xt,s as kt,a as _t,b as vt,n as bt,o as wt,c as A,d as H,e as Tt,v as St}from"./sidebar-CcM-4_yp.js";import{d as tt}from"./arc-DMCbTmUU.js";import"./modulepreload-polyfill-B5Qt9EMX.js";import"./index-CdTgm28c.js";import"./i18n-b57E8EYG.js";import"./useSettings-CS-xfdW0.js";import"./index-1G0MRvKj.js";import"./useTranslation-WtPn4Fa0.js";import"./button-BEGRz3QU.js";import"./utils-C0EutI9V.js";import"./clsx-B-dksMZM.js";import"./proxy-C9frugAW.js";import"./browser-C8oXKADD.js";import"./client-CQ1hcK1l.js";import"./useLiquidGlass-BfIyFr8C.js";import"./_virtual_stub-crypto-BDMct_Gn-D7ZuWTsr.js";import"./getYouMindHost-BW5XiKRP.js";import"./refresh-ccw-BIEhTRJL.js";import"./index-CJNCxxua.js";import"./arrow-right-8vuRry-q.js";import"./switch-DwTZvLLE.js";import"./ExtensionSvg-B-kdueov.js";import"./fullPageCelebrate-BiUufqV5.js";import"./tweets-Be8YQyei.js";import"./index-BXxbW4z9.js";var X=(function(){var t=s(function(g,r,a,l){for(a=a||{},l=g.length;l--;a[g[l]]=r);return a},"o"),e=[6,8,10,11,12,14,16,17,18],n=[1,9],c=[1,10],i=[1,11],u=[1,12],h=[1,13],p=[1,14],d={trace:s(function(){},"trace"),yy:{},symbols_:{error:2,start:3,journey:4,document:5,EOF:6,line:7,SPACE:8,statement:9,NEWLINE:10,title:11,acc_title:12,acc_title_value:13,acc_descr:14,acc_descr_value:15,acc_descr_multiline_value:16,section:17,taskName:18,taskData:19,$accept:0,$end:1},terminals_:{2:"error",4:"journey",6:"EOF",8:"SPACE",10:"NEWLINE",11:"title",12:"acc_title",13:"acc_title_value",14:"acc_descr",15:"acc_descr_value",16:"acc_descr_multiline_value",17:"section",18:"taskName",19:"taskData"},productions_:[0,[3,3],[5,0],[5,2],[7,2],[7,1],[7,1],[7,1],[9,1],[9,2],[9,2],[9,1],[9,1],[9,2]],performAction:s(function(r,a,l,y,f,o,S){var _=o.length-1;switch(f){case 1:return o[_-1];case 2:this.$=[];break;case 3:o[_-1].push(o[_]),this.$=o[_-1];break;case 4:case 5:this.$=o[_];break;case 6:case 7:this.$=[];break;case 8:y.setDiagramTitle(o[_].substr(6)),this.$=o[_].substr(6);break;case 9:this.$=o[_].trim(),y.setAccTitle(this.$);break;case 10:case 11:this.$=o[_].trim(),y.setAccDescription(this.$);break;case 12:y.addSection(o[_].substr(8)),this.$=o[_].substr(8);break;case 13:y.addTask(o[_-1],o[_]),this.$="task";break}},"anonymous"),table:[{3:1,4:[1,2]},{1:[3]},t(e,[2,2],{5:3}),{6:[1,4],7:5,8:[1,6],9:7,10:[1,8],11:n,12:c,14:i,16:u,17:h,18:p},t(e,[2,7],{1:[2,1]}),t(e,[2,3]),{9:15,11:n,12:c,14:i,16:u,17:h,18:p},t(e,[2,5]),t(e,[2,6]),t(e,[2,8]),{13:[1,16]},{15:[1,17]},t(e,[2,11]),t(e,[2,12]),{19:[1,18]},t(e,[2,4]),t(e,[2,9]),t(e,[2,10]),t(e,[2,13])],defaultActions:{},parseError:s(function(r,a){if(a.recoverable)this.trace(r);else{var l=new Error(r);throw l.hash=a,l}},"parseError"),parse:s(function(r){var a=this,l=[0],y=[],f=[null],o=[],S=this.table,_="",B=0,J=0,ut=2,K=1,yt=o.slice.call(arguments,1),k=Object.create(this.lexer),E={yy:{}};for(var O in this.yy)Object.prototype.hasOwnProperty.call(this.yy,O)&&(E.yy[O]=this.yy[O]);k.setInput(r,E.yy),E.yy.lexer=k,E.yy.parser=this,typeof k.yylloc>"u"&&(k.yylloc={});var Y=k.yylloc;o.push(Y);var dt=k.options&&k.options.ranges;typeof E.yy.parseError=="function"?this.parseError=E.yy.parseError:this.parseError=Object.getPrototypeOf(this).parseError;function pt(b){l.length=l.length-2*b,f.length=f.length-b,o.length=o.length-b}s(pt,"popStack");function Q(){var b;return b=y.pop()||k.lex()||K,typeof b!="number"&&(b instanceof Array&&(y=b,b=y.pop()),b=a.symbols_[b]||b),b}s(Q,"lex");for(var v,P,w,q,C={},N,M,D,j;;){if(P=l[l.length-1],this.defaultActions[P]?w=this.defaultActions[P]:((v===null||typeof v>"u")&&(v=Q()),w=S[P]&&S[P][v]),typeof w>"u"||!w.length||!w[0]){var G="";j=[];for(N in S[P])this.terminals_[N]&&N>ut&&j.push("'"+this.terminals_[N]+"'");k.showPosition?G="Parse error on line "+(B+1)+`:
`+k.showPosition()+`
Expecting `+j.join(", ")+", got '"+(this.terminals_[v]||v)+"'":G="Parse error on line "+(B+1)+": Unexpected "+(v==K?"end of input":"'"+(this.terminals_[v]||v)+"'"),this.parseError(G,{text:k.match,token:this.terminals_[v]||v,line:k.yylineno,loc:Y,expected:j})}if(w[0]instanceof Array&&w.length>1)throw new Error("Parse Error: multiple actions possible at state: "+P+", token: "+v);switch(w[0]){case 1:l.push(v),f.push(k.yytext),o.push(k.yylloc),l.push(w[1]),v=null,J=k.yyleng,_=k.yytext,B=k.yylineno,Y=k.yylloc;break;case 2:if(M=this.productions_[w[1]][1],C.$=f[f.length-M],C._$={first_line:o[o.length-(M||1)].first_line,last_line:o[o.length-1].last_line,first_column:o[o.length-(M||1)].first_column,last_column:o[o.length-1].last_column},dt&&(C._$.range=[o[o.length-(M||1)].range[0],o[o.length-1].range[1]]),q=this.performAction.apply(C,[_,J,B,E.yy,w[1],f,o].concat(yt)),typeof q<"u")return q;M&&(l=l.slice(0,-1*M*2),f=f.slice(0,-1*M),o=o.slice(0,-1*M)),l.push(this.productions_[w[1]][0]),f.push(C.$),o.push(C._$),D=S[l[l.length-2]][l[l.length-1]],l.push(D);break;case 3:return!0}}return!0},"parse")},x=(function(){var g={EOF:1,parseError:s(function(a,l){if(this.yy.parser)this.yy.parser.parseError(a,l);else throw new Error(a)},"parseError"),setInput:s(function(r,a){return this.yy=a||this.yy||{},this._input=r,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:s(function(){var r=this._input[0];this.yytext+=r,this.yyleng++,this.offset++,this.match+=r,this.matched+=r;var a=r.match(/(?:\r\n?|\n).*/g);return a?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),r},"input"),unput:s(function(r){var a=r.length,l=r.split(/(?:\r\n?|\n)/g);this._input=r+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-a),this.offset-=a;var y=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),l.length-1&&(this.yylineno-=l.length-1);var f=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:l?(l.length===y.length?this.yylloc.first_column:0)+y[y.length-l.length].length-l[0].length:this.yylloc.first_column-a},this.options.ranges&&(this.yylloc.range=[f[0],f[0]+this.yyleng-a]),this.yyleng=this.yytext.length,this},"unput"),more:s(function(){return this._more=!0,this},"more"),reject:s(function(){if(this.options.backtrack_lexer)this._backtrack=!0;else return this.parseError("Lexical error on line "+(this.yylineno+1)+`. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).
`+this.showPosition(),{text:"",token:null,line:this.yylineno});return this},"reject"),less:s(function(r){this.unput(this.match.slice(r))},"less"),pastInput:s(function(){var r=this.matched.substr(0,this.matched.length-this.match.length);return(r.length>20?"...":"")+r.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:s(function(){var r=this.match;return r.length<20&&(r+=this._input.substr(0,20-r.length)),(r.substr(0,20)+(r.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:s(function(){var r=this.pastInput(),a=new Array(r.length+1).join("-");return r+this.upcomingInput()+`
`+a+"^"},"showPosition"),test_match:s(function(r,a){var l,y,f;if(this.options.backtrack_lexer&&(f={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(f.yylloc.range=this.yylloc.range.slice(0))),y=r[0].match(/(?:\r\n?|\n).*/g),y&&(this.yylineno+=y.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:y?y[y.length-1].length-y[y.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+r[0].length},this.yytext+=r[0],this.match+=r[0],this.matches=r,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(r[0].length),this.matched+=r[0],l=this.performAction.call(this,this.yy,this,a,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),l)return l;if(this._backtrack){for(var o in f)this[o]=f[o];return!1}return!1},"test_match"),next:s(function(){if(this.done)return this.EOF;this._input||(this.done=!0);var r,a,l,y;this._more||(this.yytext="",this.match="");for(var f=this._currentRules(),o=0;o<f.length;o++)if(l=this._input.match(this.rules[f[o]]),l&&(!a||l[0].length>a[0].length)){if(a=l,y=o,this.options.backtrack_lexer){if(r=this.test_match(l,f[o]),r!==!1)return r;if(this._backtrack){a=!1;continue}else return!1}else if(!this.options.flex)break}return a?(r=this.test_match(a,f[y]),r!==!1?r:!1):this._input===""?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+`. Unrecognized text.
`+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:s(function(){var a=this.next();return a||this.lex()},"lex"),begin:s(function(a){this.conditionStack.push(a)},"begin"),popState:s(function(){var a=this.conditionStack.length-1;return a>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:s(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:s(function(a){return a=this.conditionStack.length-1-Math.abs(a||0),a>=0?this.conditionStack[a]:"INITIAL"},"topState"),pushState:s(function(a){this.begin(a)},"pushState"),stateStackSize:s(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:s(function(a,l,y,f){switch(y){case 0:break;case 1:break;case 2:return 10;case 3:break;case 4:break;case 5:return 4;case 6:return 11;case 7:return this.begin("acc_title"),12;case 8:return this.popState(),"acc_title_value";case 9:return this.begin("acc_descr"),14;case 10:return this.popState(),"acc_descr_value";case 11:this.begin("acc_descr_multiline");break;case 12:this.popState();break;case 13:return"acc_descr_multiline_value";case 14:return 17;case 15:return 18;case 16:return 19;case 17:return":";case 18:return 6;case 19:return"INVALID"}},"anonymous"),rules:[/^(?:%(?!\{)[^\n]*)/i,/^(?:[^\}]%%[^\n]*)/i,/^(?:[\n]+)/i,/^(?:\s+)/i,/^(?:#[^\n]*)/i,/^(?:journey\b)/i,/^(?:title\s[^#\n;]+)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:section\s[^#:\n;]+)/i,/^(?:[^#:\n;]+)/i,/^(?::[^#\n;]+)/i,/^(?::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{acc_descr_multiline:{rules:[12,13],inclusive:!1},acc_descr:{rules:[10],inclusive:!1},acc_title:{rules:[8],inclusive:!1},INITIAL:{rules:[0,1,2,3,4,5,6,7,9,11,14,15,16,17,18,19],inclusive:!0}}};return g})();d.lexer=x;function m(){this.yy={}}return s(m,"Parser"),m.prototype=d,d.Parser=m,new m})();X.parser=X;var Mt=X,V="",U=[],R=[],F=[],$t=s(function(){U.length=0,R.length=0,V="",F.length=0,St()},"clear"),Et=s(function(t){V=t,U.push(t)},"addSection"),Pt=s(function(){return U},"getSections"),It=s(function(){let t=et();const e=100;let n=0;for(;!t&&n<e;)t=et(),n++;return R.push(...F),R},"getTasks"),At=s(function(){const t=[];return R.forEach(n=>{n.people&&t.push(...n.people)}),[...new Set(t)].sort()},"updateActors"),Ct=s(function(t,e){const n=e.substr(1).split(":");let c=0,i=[];n.length===1?(c=Number(n[0]),i=[]):(c=Number(n[0]),i=n[1].split(","));const u=i.map(p=>p.trim()),h={section:V,type:V,people:u,task:t,score:c};F.push(h)},"addTask"),Vt=s(function(t){const e={section:V,type:V,description:t,task:t,classes:[]};R.push(e)},"addTaskOrg"),et=s(function(){const t=s(function(n){return F[n].processed},"compileTask");let e=!0;for(const[n,c]of F.entries())t(n),e=e&&c.processed;return e},"compileTasks"),Rt=s(function(){return At()},"getActors"),rt={getConfig:s(()=>A().journey,"getConfig"),clear:$t,setDiagramTitle:wt,getDiagramTitle:bt,setAccTitle:vt,getAccTitle:_t,setAccDescription:kt,getAccDescription:xt,addSection:Et,getSections:Pt,getTasks:It,addTask:Ct,addTaskOrg:Vt,getActors:Rt},Ft=s(t=>`.label {
    font-family: 'trebuchet ms', verdana, arial, sans-serif;
    font-family: var(--mermaid-font-family);
    color: ${t.textColor};
  }
  .mouth {
    stroke: #666;
  }

  line {
    stroke: ${t.textColor}
  }

  .legend {
    fill: ${t.textColor};
  }

  .label text {
    fill: #333;
  }
  .label {
    color: ${t.textColor}
  }

  .face {
    ${t.faceColor?`fill: ${t.faceColor}`:"fill: #FFF8DC"};
    stroke: #999;
  }

  .node rect,
  .node circle,
  .node ellipse,
  .node polygon,
  .node path {
    fill: ${t.mainBkg};
    stroke: ${t.nodeBorder};
    stroke-width: 1px;
  }

  .node .label {
    text-align: center;
  }
  .node.clickable {
    cursor: pointer;
  }

  .arrowheadPath {
    fill: ${t.arrowheadColor};
  }

  .edgePath .path {
    stroke: ${t.lineColor};
    stroke-width: 1.5px;
  }

  .flowchart-link {
    stroke: ${t.lineColor};
    fill: none;
  }

  .edgeLabel {
    background-color: ${t.edgeLabelBackground};
    rect {
      opacity: 0.5;
    }
    text-align: center;
  }

  .cluster rect {
  }

  .cluster text {
    fill: ${t.titleColor};
  }

  div.mermaidTooltip {
    position: absolute;
    text-align: center;
    max-width: 200px;
    padding: 2px;
    font-family: 'trebuchet ms', verdana, arial, sans-serif;
    font-family: var(--mermaid-font-family);
    font-size: 12px;
    background: ${t.tertiaryColor};
    border: 1px solid ${t.border2};
    border-radius: 2px;
    pointer-events: none;
    z-index: 100;
  }

  .task-type-0, .section-type-0  {
    ${t.fillType0?`fill: ${t.fillType0}`:""};
  }
  .task-type-1, .section-type-1  {
    ${t.fillType0?`fill: ${t.fillType1}`:""};
  }
  .task-type-2, .section-type-2  {
    ${t.fillType0?`fill: ${t.fillType2}`:""};
  }
  .task-type-3, .section-type-3  {
    ${t.fillType0?`fill: ${t.fillType3}`:""};
  }
  .task-type-4, .section-type-4  {
    ${t.fillType0?`fill: ${t.fillType4}`:""};
  }
  .task-type-5, .section-type-5  {
    ${t.fillType0?`fill: ${t.fillType5}`:""};
  }
  .task-type-6, .section-type-6  {
    ${t.fillType0?`fill: ${t.fillType6}`:""};
  }
  .task-type-7, .section-type-7  {
    ${t.fillType0?`fill: ${t.fillType7}`:""};
  }

  .actor-0 {
    ${t.actor0?`fill: ${t.actor0}`:""};
  }
  .actor-1 {
    ${t.actor1?`fill: ${t.actor1}`:""};
  }
  .actor-2 {
    ${t.actor2?`fill: ${t.actor2}`:""};
  }
  .actor-3 {
    ${t.actor3?`fill: ${t.actor3}`:""};
  }
  .actor-4 {
    ${t.actor4?`fill: ${t.actor4}`:""};
  }
  .actor-5 {
    ${t.actor5?`fill: ${t.actor5}`:""};
  }
`,"getStyles"),Lt=Ft,Z=s(function(t,e){return mt(t,e)},"drawRect"),Bt=s(function(t,e){const c=t.append("circle").attr("cx",e.cx).attr("cy",e.cy).attr("class","face").attr("r",15).attr("stroke-width",2).attr("overflow","visible"),i=t.append("g");i.append("circle").attr("cx",e.cx-15/3).attr("cy",e.cy-15/3).attr("r",1.5).attr("stroke-width",2).attr("fill","#666").attr("stroke","#666"),i.append("circle").attr("cx",e.cx+15/3).attr("cy",e.cy-15/3).attr("r",1.5).attr("stroke-width",2).attr("fill","#666").attr("stroke","#666");function u(d){const x=tt().startAngle(Math.PI/2).endAngle(3*(Math.PI/2)).innerRadius(7.5).outerRadius(6.8181818181818175);d.append("path").attr("class","mouth").attr("d",x).attr("transform","translate("+e.cx+","+(e.cy+2)+")")}s(u,"smile");function h(d){const x=tt().startAngle(3*Math.PI/2).endAngle(5*(Math.PI/2)).innerRadius(7.5).outerRadius(6.8181818181818175);d.append("path").attr("class","mouth").attr("d",x).attr("transform","translate("+e.cx+","+(e.cy+7)+")")}s(h,"sad");function p(d){d.append("line").attr("class","mouth").attr("stroke",2).attr("x1",e.cx-5).attr("y1",e.cy+7).attr("x2",e.cx+5).attr("y2",e.cy+7).attr("class","mouth").attr("stroke-width","1px").attr("stroke","#666")}return s(p,"ambivalent"),e.score>3?u(i):e.score<3?h(i):p(i),c},"drawFace"),lt=s(function(t,e){const n=t.append("circle");return n.attr("cx",e.cx),n.attr("cy",e.cy),n.attr("class","actor-"+e.pos),n.attr("fill",e.fill),n.attr("stroke",e.stroke),n.attr("r",e.r),n.class!==void 0&&n.attr("class",n.class),e.title!==void 0&&n.append("title").text(e.title),n},"drawCircle"),ot=s(function(t,e){return gt(t,e)},"drawText"),Nt=s(function(t,e){function n(i,u,h,p,d){return i+","+u+" "+(i+h)+","+u+" "+(i+h)+","+(u+p-d)+" "+(i+h-d*1.2)+","+(u+p)+" "+i+","+(u+p)}s(n,"genPoints");const c=t.append("polygon");c.attr("points",n(e.x,e.y,50,20,7)),c.attr("class","labelBox"),e.y=e.y+e.labelMargin,e.x=e.x+.5*e.labelMargin,ot(t,e)},"drawLabel"),jt=s(function(t,e,n){const c=t.append("g"),i=at();i.x=e.x,i.y=e.y,i.fill=e.fill,i.width=n.width*e.taskCount+n.diagramMarginX*(e.taskCount-1),i.height=n.height,i.class="journey-section section-type-"+e.num,i.rx=3,i.ry=3,Z(c,i),ct(n)(e.text,c,i.x,i.y,i.width,i.height,{class:"journey-section section-type-"+e.num},n,e.colour)},"drawSection"),it=-1,zt=s(function(t,e,n){const c=e.x+n.width/2,i=t.append("g");it++,i.append("line").attr("id","task"+it).attr("x1",c).attr("y1",e.y).attr("x2",c).attr("y2",450).attr("class","task-line").attr("stroke-width","1px").attr("stroke-dasharray","4 2").attr("stroke","#666"),Bt(i,{cx:c,cy:300+(5-e.score)*30,score:e.score});const h=at();h.x=e.x,h.y=e.y,h.fill=e.fill,h.width=n.width,h.height=n.height,h.class="task task-type-"+e.num,h.rx=3,h.ry=3,Z(i,h);let p=e.x+14;e.people.forEach(d=>{const x=e.actors[d].color,m={cx:p,cy:e.y,r:7,fill:x,stroke:"#000",title:d,pos:e.actors[d].position};lt(i,m),p+=10}),ct(n)(e.task,i,h.x,h.y,h.width,h.height,{class:"task"},n,e.colour)},"drawTask"),Ot=s(function(t,e){ft(t,e)},"drawBackgroundRect"),ct=(function(){function t(i,u,h,p,d,x,m,g){const r=u.append("text").attr("x",h+d/2).attr("y",p+x/2+5).style("font-color",g).style("text-anchor","middle").text(i);c(r,m)}s(t,"byText");function e(i,u,h,p,d,x,m,g,r){const{taskFontSize:a,taskFontFamily:l}=g,y=i.split(/<br\s*\/?>/gi);for(let f=0;f<y.length;f++){const o=f*a-a*(y.length-1)/2,S=u.append("text").attr("x",h+d/2).attr("y",p).attr("fill",r).style("text-anchor","middle").style("font-size",a).style("font-family",l);S.append("tspan").attr("x",h+d/2).attr("dy",o).text(y[f]),S.attr("y",p+x/2).attr("dominant-baseline","central").attr("alignment-baseline","central"),c(S,m)}}s(e,"byTspan");function n(i,u,h,p,d,x,m,g){const r=u.append("switch"),l=r.append("foreignObject").attr("x",h).attr("y",p).attr("width",d).attr("height",x).attr("position","fixed").append("xhtml:div").style("display","table").style("height","100%").style("width","100%");l.append("div").attr("class","label").style("display","table-cell").style("text-align","center").style("vertical-align","middle").text(i),e(i,r,h,p,d,x,m,g),c(l,m)}s(n,"byFo");function c(i,u){for(const h in u)h in u&&i.attr(h,u[h])}return s(c,"_setTextAttrs"),function(i){return i.textPlacement==="fo"?n:i.textPlacement==="old"?t:e}})(),Yt=s(function(t){t.append("defs").append("marker").attr("id","arrowhead").attr("refX",5).attr("refY",2).attr("markerWidth",6).attr("markerHeight",4).attr("orient","auto").append("path").attr("d","M 0,0 V 4 L6,2 Z")},"initGraphics"),L={drawRect:Z,drawCircle:lt,drawSection:jt,drawText:ot,drawLabel:Nt,drawTask:zt,drawBackgroundRect:Ot,initGraphics:Yt},qt=s(function(t){Object.keys(t).forEach(function(n){z[n]=t[n]})},"setConf"),$={};function ht(t){const e=A().journey;let n=60;Object.keys($).forEach(c=>{const i=$[c].color,u={cx:20,cy:n,r:7,fill:i,stroke:"#000",pos:$[c].position};L.drawCircle(t,u);const h={x:40,y:n+7,fill:"#666",text:c,textMargin:e.boxTextMargin|5};L.drawText(t,h),n+=20})}s(ht,"drawActorLegend");var z=A().journey,I=z.leftMargin,Gt=s(function(t,e,n,c){const i=A().journey,u=A().securityLevel;let h;u==="sandbox"&&(h=H("#i"+e));const p=u==="sandbox"?H(h.nodes()[0].contentDocument.body):H("body");T.init();const d=p.select("#"+e);L.initGraphics(d);const x=c.db.getTasks(),m=c.db.getDiagramTitle(),g=c.db.getActors();for(const o in $)delete $[o];let r=0;g.forEach(o=>{$[o]={color:i.actorColours[r%i.actorColours.length],position:r},r++}),ht(d),T.insert(0,0,I,Object.keys($).length*50),Ht(d,x,0);const a=T.getBounds();m&&d.append("text").text(m).attr("x",I).attr("font-size","4ex").attr("font-weight","bold").attr("y",25);const l=a.stopy-a.starty+2*i.diagramMarginY,y=I+a.stopx+2*i.diagramMarginX;Tt(d,l,y,i.useMaxWidth),d.append("line").attr("x1",I).attr("y1",i.height*4).attr("x2",y-I-4).attr("y2",i.height*4).attr("stroke-width",4).attr("stroke","black").attr("marker-end","url(#arrowhead)");const f=m?70:0;d.attr("viewBox",`${a.startx} -25 ${y} ${l+f}`),d.attr("preserveAspectRatio","xMinYMin meet"),d.attr("height",l+f+25)},"draw"),T={data:{startx:void 0,stopx:void 0,starty:void 0,stopy:void 0},verticalPos:0,sequenceItems:[],init:s(function(){this.sequenceItems=[],this.data={startx:void 0,stopx:void 0,starty:void 0,stopy:void 0},this.verticalPos=0},"init"),updateVal:s(function(t,e,n,c){t[e]===void 0?t[e]=n:t[e]=c(n,t[e])},"updateVal"),updateBounds:s(function(t,e,n,c){const i=A().journey,u=this;let h=0;function p(d){return s(function(m){h++;const g=u.sequenceItems.length-h+1;u.updateVal(m,"starty",e-g*i.boxMargin,Math.min),u.updateVal(m,"stopy",c+g*i.boxMargin,Math.max),u.updateVal(T.data,"startx",t-g*i.boxMargin,Math.min),u.updateVal(T.data,"stopx",n+g*i.boxMargin,Math.max),d!=="activation"&&(u.updateVal(m,"startx",t-g*i.boxMargin,Math.min),u.updateVal(m,"stopx",n+g*i.boxMargin,Math.max),u.updateVal(T.data,"starty",e-g*i.boxMargin,Math.min),u.updateVal(T.data,"stopy",c+g*i.boxMargin,Math.max))},"updateItemBounds")}s(p,"updateFn"),this.sequenceItems.forEach(p())},"updateBounds"),insert:s(function(t,e,n,c){const i=Math.min(t,n),u=Math.max(t,n),h=Math.min(e,c),p=Math.max(e,c);this.updateVal(T.data,"startx",i,Math.min),this.updateVal(T.data,"starty",h,Math.min),this.updateVal(T.data,"stopx",u,Math.max),this.updateVal(T.data,"stopy",p,Math.max),this.updateBounds(i,h,u,p)},"insert"),bumpVerticalPos:s(function(t){this.verticalPos=this.verticalPos+t,this.data.stopy=this.verticalPos},"bumpVerticalPos"),getVerticalPos:s(function(){return this.verticalPos},"getVerticalPos"),getBounds:s(function(){return this.data},"getBounds")},W=z.sectionFills,st=z.sectionColours,Ht=s(function(t,e,n){const c=A().journey;let i="";const u=c.height*2+c.diagramMarginY,h=n+u;let p=0,d="#CCC",x="black",m=0;for(const[g,r]of e.entries()){if(i!==r.section){d=W[p%W.length],m=p%W.length,x=st[p%st.length];let l=0;const y=r.section;for(let o=g;o<e.length&&e[o].section==y;o++)l=l+1;const f={x:g*c.taskMargin+g*c.width+I,y:50,text:r.section,fill:d,num:m,colour:x,taskCount:l};L.drawSection(t,f,c),i=r.section,p++}const a=r.people.reduce((l,y)=>($[y]&&(l[y]=$[y]),l),{});r.x=g*c.taskMargin+g*c.width+I,r.y=h,r.width=c.diagramMarginX,r.height=c.diagramMarginY,r.colour=x,r.fill=d,r.num=m,r.actors=a,L.drawTask(t,r,c),T.insert(r.x,r.y,r.x+r.width+c.taskMargin,450)}},"drawTasks"),nt={setConf:qt,draw:Gt},xe={parser:Mt,db:rt,renderer:nt,styles:Lt,init:s(t=>{nt.setConf(t.journey),rt.clear()},"init")};export{xe as diagram};
