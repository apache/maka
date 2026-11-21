import{g as De,s as Ce}from"./chunk-5HRBRIJM-wOc4RWt6.js";import{_ as i,n as xe,o as Ae,s as Le,g as Ie,b as Re,a as Oe,l as b,c as x,r as Ne,u as we,k as U,v as $e,a9 as Pe}from"./sidebar-CcM-4_yp.js";var Ot=(function(){var t=i(function($,o,u,n){for(u=u||{},n=$.length;n--;u[$[n]]=o);return u},"o"),e=[1,2],c=[1,3],a=[1,4],d=[2,4],r=[1,9],p=[1,11],g=[1,16],l=[1,17],_=[1,18],v=[1,19],O=[1,32],L=[1,20],f=[1,21],A=[1,22],I=[1,23],B=[1,24],Y=[1,26],N=[1,27],w=[1,28],st=[1,29],it=[1,30],rt=[1,31],at=[1,34],nt=[1,35],lt=[1,36],ot=[1,37],X=[1,33],S=[1,4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],ct=[1,4,5,14,15,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],Vt=[4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],kt={trace:i(function(){},"trace"),yy:{},symbols_:{error:2,start:3,SPACE:4,NL:5,SD:6,document:7,line:8,statement:9,classDefStatement:10,styleStatement:11,cssClassStatement:12,idStatement:13,DESCR:14,"-->":15,HIDE_EMPTY:16,scale:17,WIDTH:18,COMPOSIT_STATE:19,STRUCT_START:20,STRUCT_STOP:21,STATE_DESCR:22,AS:23,ID:24,FORK:25,JOIN:26,CHOICE:27,CONCURRENT:28,note:29,notePosition:30,NOTE_TEXT:31,direction:32,acc_title:33,acc_title_value:34,acc_descr:35,acc_descr_value:36,acc_descr_multiline_value:37,classDef:38,CLASSDEF_ID:39,CLASSDEF_STYLEOPTS:40,DEFAULT:41,style:42,STYLE_IDS:43,STYLEDEF_STYLEOPTS:44,class:45,CLASSENTITY_IDS:46,STYLECLASS:47,direction_tb:48,direction_bt:49,direction_rl:50,direction_lr:51,eol:52,";":53,EDGE_STATE:54,STYLE_SEPARATOR:55,left_of:56,right_of:57,$accept:0,$end:1},terminals_:{2:"error",4:"SPACE",5:"NL",6:"SD",14:"DESCR",15:"-->",16:"HIDE_EMPTY",17:"scale",18:"WIDTH",19:"COMPOSIT_STATE",20:"STRUCT_START",21:"STRUCT_STOP",22:"STATE_DESCR",23:"AS",24:"ID",25:"FORK",26:"JOIN",27:"CHOICE",28:"CONCURRENT",29:"note",31:"NOTE_TEXT",33:"acc_title",34:"acc_title_value",35:"acc_descr",36:"acc_descr_value",37:"acc_descr_multiline_value",38:"classDef",39:"CLASSDEF_ID",40:"CLASSDEF_STYLEOPTS",41:"DEFAULT",42:"style",43:"STYLE_IDS",44:"STYLEDEF_STYLEOPTS",45:"class",46:"CLASSENTITY_IDS",47:"STYLECLASS",48:"direction_tb",49:"direction_bt",50:"direction_rl",51:"direction_lr",53:";",54:"EDGE_STATE",55:"STYLE_SEPARATOR",56:"left_of",57:"right_of"},productions_:[0,[3,2],[3,2],[3,2],[7,0],[7,2],[8,2],[8,1],[8,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,3],[9,4],[9,1],[9,2],[9,1],[9,4],[9,3],[9,6],[9,1],[9,1],[9,1],[9,1],[9,4],[9,4],[9,1],[9,2],[9,2],[9,1],[10,3],[10,3],[11,3],[12,3],[32,1],[32,1],[32,1],[32,1],[52,1],[52,1],[13,1],[13,1],[13,3],[13,3],[30,1],[30,1]],performAction:i(function(o,u,n,y,T,s,K){var h=s.length-1;switch(T){case 3:return y.setRootDoc(s[h]),s[h];case 4:this.$=[];break;case 5:s[h]!="nl"&&(s[h-1].push(s[h]),this.$=s[h-1]);break;case 6:case 7:this.$=s[h];break;case 8:this.$="nl";break;case 12:this.$=s[h];break;case 13:const J=s[h-1];J.description=y.trimColon(s[h]),this.$=J;break;case 14:this.$={stmt:"relation",state1:s[h-2],state2:s[h]};break;case 15:const Dt=y.trimColon(s[h]);this.$={stmt:"relation",state1:s[h-3],state2:s[h-1],description:Dt};break;case 19:this.$={stmt:"state",id:s[h-3],type:"default",description:"",doc:s[h-1]};break;case 20:var F=s[h],H=s[h-2].trim();if(s[h].match(":")){var ht=s[h].split(":");F=ht[0],H=[H,ht[1]]}this.$={stmt:"state",id:F,type:"default",description:H};break;case 21:this.$={stmt:"state",id:s[h-3],type:"default",description:s[h-5],doc:s[h-1]};break;case 22:this.$={stmt:"state",id:s[h],type:"fork"};break;case 23:this.$={stmt:"state",id:s[h],type:"join"};break;case 24:this.$={stmt:"state",id:s[h],type:"choice"};break;case 25:this.$={stmt:"state",id:y.getDividerId(),type:"divider"};break;case 26:this.$={stmt:"state",id:s[h-1].trim(),note:{position:s[h-2].trim(),text:s[h].trim()}};break;case 29:this.$=s[h].trim(),y.setAccTitle(this.$);break;case 30:case 31:this.$=s[h].trim(),y.setAccDescription(this.$);break;case 32:case 33:this.$={stmt:"classDef",id:s[h-1].trim(),classes:s[h].trim()};break;case 34:this.$={stmt:"style",id:s[h-1].trim(),styleClass:s[h].trim()};break;case 35:this.$={stmt:"applyClass",id:s[h-1].trim(),styleClass:s[h].trim()};break;case 36:y.setDirection("TB"),this.$={stmt:"dir",value:"TB"};break;case 37:y.setDirection("BT"),this.$={stmt:"dir",value:"BT"};break;case 38:y.setDirection("RL"),this.$={stmt:"dir",value:"RL"};break;case 39:y.setDirection("LR"),this.$={stmt:"dir",value:"LR"};break;case 42:case 43:this.$={stmt:"state",id:s[h].trim(),type:"default",description:""};break;case 44:this.$={stmt:"state",id:s[h-2].trim(),classes:[s[h].trim()],type:"default",description:""};break;case 45:this.$={stmt:"state",id:s[h-2].trim(),classes:[s[h].trim()],type:"default",description:""};break}},"anonymous"),table:[{3:1,4:e,5:c,6:a},{1:[3]},{3:5,4:e,5:c,6:a},{3:6,4:e,5:c,6:a},t([1,4,5,16,17,19,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],d,{7:7}),{1:[2,1]},{1:[2,2]},{1:[2,3],4:r,5:p,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:l,19:_,22:v,24:O,25:L,26:f,27:A,28:I,29:B,32:25,33:Y,35:N,37:w,38:st,42:it,45:rt,48:at,49:nt,50:lt,51:ot,54:X},t(S,[2,5]),{9:38,10:12,11:13,12:14,13:15,16:g,17:l,19:_,22:v,24:O,25:L,26:f,27:A,28:I,29:B,32:25,33:Y,35:N,37:w,38:st,42:it,45:rt,48:at,49:nt,50:lt,51:ot,54:X},t(S,[2,7]),t(S,[2,8]),t(S,[2,9]),t(S,[2,10]),t(S,[2,11]),t(S,[2,12],{14:[1,39],15:[1,40]}),t(S,[2,16]),{18:[1,41]},t(S,[2,18],{20:[1,42]}),{23:[1,43]},t(S,[2,22]),t(S,[2,23]),t(S,[2,24]),t(S,[2,25]),{30:44,31:[1,45],56:[1,46],57:[1,47]},t(S,[2,28]),{34:[1,48]},{36:[1,49]},t(S,[2,31]),{39:[1,50],41:[1,51]},{43:[1,52]},{46:[1,53]},t(ct,[2,42],{55:[1,54]}),t(ct,[2,43],{55:[1,55]}),t(S,[2,36]),t(S,[2,37]),t(S,[2,38]),t(S,[2,39]),t(S,[2,6]),t(S,[2,13]),{13:56,24:O,54:X},t(S,[2,17]),t(Vt,d,{7:57}),{24:[1,58]},{24:[1,59]},{23:[1,60]},{24:[2,46]},{24:[2,47]},t(S,[2,29]),t(S,[2,30]),{40:[1,61]},{40:[1,62]},{44:[1,63]},{47:[1,64]},{24:[1,65]},{24:[1,66]},t(S,[2,14],{14:[1,67]}),{4:r,5:p,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:l,19:_,21:[1,68],22:v,24:O,25:L,26:f,27:A,28:I,29:B,32:25,33:Y,35:N,37:w,38:st,42:it,45:rt,48:at,49:nt,50:lt,51:ot,54:X},t(S,[2,20],{20:[1,69]}),{31:[1,70]},{24:[1,71]},t(S,[2,32]),t(S,[2,33]),t(S,[2,34]),t(S,[2,35]),t(ct,[2,44]),t(ct,[2,45]),t(S,[2,15]),t(S,[2,19]),t(Vt,d,{7:72}),t(S,[2,26]),t(S,[2,27]),{4:r,5:p,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:l,19:_,21:[1,73],22:v,24:O,25:L,26:f,27:A,28:I,29:B,32:25,33:Y,35:N,37:w,38:st,42:it,45:rt,48:at,49:nt,50:lt,51:ot,54:X},t(S,[2,21])],defaultActions:{5:[2,1],6:[2,2],46:[2,46],47:[2,47]},parseError:i(function(o,u){if(u.recoverable)this.trace(o);else{var n=new Error(o);throw n.hash=u,n}},"parseError"),parse:i(function(o){var u=this,n=[0],y=[],T=[null],s=[],K=this.table,h="",F=0,H=0,ht=2,J=1,Dt=s.slice.call(arguments,1),E=Object.create(this.lexer),V={yy:{}};for(var Ct in this.yy)Object.prototype.hasOwnProperty.call(this.yy,Ct)&&(V.yy[Ct]=this.yy[Ct]);E.setInput(o,V.yy),V.yy.lexer=E,V.yy.parser=this,typeof E.yylloc>"u"&&(E.yylloc={});var xt=E.yylloc;s.push(xt);var me=E.options&&E.options.ranges;typeof V.yy.parseError=="function"?this.parseError=V.yy.parseError:this.parseError=Object.getPrototypeOf(this).parseError;function ke(D){n.length=n.length-2*D,T.length=T.length-D,s.length=s.length-D}i(ke,"popStack");function Mt(){var D;return D=y.pop()||E.lex()||J,typeof D!="number"&&(D instanceof Array&&(y=D,D=y.pop()),D=u.symbols_[D]||D),D}i(Mt,"lex");for(var m,M,C,At,z={},dt,R,Ut,ft;;){if(M=n[n.length-1],this.defaultActions[M]?C=this.defaultActions[M]:((m===null||typeof m>"u")&&(m=Mt()),C=K[M]&&K[M][m]),typeof C>"u"||!C.length||!C[0]){var Lt="";ft=[];for(dt in K[M])this.terminals_[dt]&&dt>ht&&ft.push("'"+this.terminals_[dt]+"'");E.showPosition?Lt="Parse error on line "+(F+1)+`:
`+E.showPosition()+`
Expecting `+ft.join(", ")+", got '"+(this.terminals_[m]||m)+"'":Lt="Parse error on line "+(F+1)+": Unexpected "+(m==J?"end of input":"'"+(this.terminals_[m]||m)+"'"),this.parseError(Lt,{text:E.match,token:this.terminals_[m]||m,line:E.yylineno,loc:xt,expected:ft})}if(C[0]instanceof Array&&C.length>1)throw new Error("Parse Error: multiple actions possible at state: "+M+", token: "+m);switch(C[0]){case 1:n.push(m),T.push(E.yytext),s.push(E.yylloc),n.push(C[1]),m=null,H=E.yyleng,h=E.yytext,F=E.yylineno,xt=E.yylloc;break;case 2:if(R=this.productions_[C[1]][1],z.$=T[T.length-R],z._$={first_line:s[s.length-(R||1)].first_line,last_line:s[s.length-1].last_line,first_column:s[s.length-(R||1)].first_column,last_column:s[s.length-1].last_column},me&&(z._$.range=[s[s.length-(R||1)].range[0],s[s.length-1].range[1]]),At=this.performAction.apply(z,[h,H,F,V.yy,C[1],T,s].concat(Dt)),typeof At<"u")return At;R&&(n=n.slice(0,-1*R*2),T=T.slice(0,-1*R),s=s.slice(0,-1*R)),n.push(this.productions_[C[1]][0]),T.push(z.$),s.push(z._$),Ut=K[n[n.length-2]][n[n.length-1]],n.push(Ut);break;case 3:return!0}}return!0},"parse")},be=(function(){var $={EOF:1,parseError:i(function(u,n){if(this.yy.parser)this.yy.parser.parseError(u,n);else throw new Error(u)},"parseError"),setInput:i(function(o,u){return this.yy=u||this.yy||{},this._input=o,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:i(function(){var o=this._input[0];this.yytext+=o,this.yyleng++,this.offset++,this.match+=o,this.matched+=o;var u=o.match(/(?:\r\n?|\n).*/g);return u?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),o},"input"),unput:i(function(o){var u=o.length,n=o.split(/(?:\r\n?|\n)/g);this._input=o+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-u),this.offset-=u;var y=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),n.length-1&&(this.yylineno-=n.length-1);var T=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:n?(n.length===y.length?this.yylloc.first_column:0)+y[y.length-n.length].length-n[0].length:this.yylloc.first_column-u},this.options.ranges&&(this.yylloc.range=[T[0],T[0]+this.yyleng-u]),this.yyleng=this.yytext.length,this},"unput"),more:i(function(){return this._more=!0,this},"more"),reject:i(function(){if(this.options.backtrack_lexer)this._backtrack=!0;else return this.parseError("Lexical error on line "+(this.yylineno+1)+`. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).
`+this.showPosition(),{text:"",token:null,line:this.yylineno});return this},"reject"),less:i(function(o){this.unput(this.match.slice(o))},"less"),pastInput:i(function(){var o=this.matched.substr(0,this.matched.length-this.match.length);return(o.length>20?"...":"")+o.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:i(function(){var o=this.match;return o.length<20&&(o+=this._input.substr(0,20-o.length)),(o.substr(0,20)+(o.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:i(function(){var o=this.pastInput(),u=new Array(o.length+1).join("-");return o+this.upcomingInput()+`
`+u+"^"},"showPosition"),test_match:i(function(o,u){var n,y,T;if(this.options.backtrack_lexer&&(T={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(T.yylloc.range=this.yylloc.range.slice(0))),y=o[0].match(/(?:\r\n?|\n).*/g),y&&(this.yylineno+=y.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:y?y[y.length-1].length-y[y.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+o[0].length},this.yytext+=o[0],this.match+=o[0],this.matches=o,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(o[0].length),this.matched+=o[0],n=this.performAction.call(this,this.yy,this,u,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),n)return n;if(this._backtrack){for(var s in T)this[s]=T[s];return!1}return!1},"test_match"),next:i(function(){if(this.done)return this.EOF;this._input||(this.done=!0);var o,u,n,y;this._more||(this.yytext="",this.match="");for(var T=this._currentRules(),s=0;s<T.length;s++)if(n=this._input.match(this.rules[T[s]]),n&&(!u||n[0].length>u[0].length)){if(u=n,y=s,this.options.backtrack_lexer){if(o=this.test_match(n,T[s]),o!==!1)return o;if(this._backtrack){u=!1;continue}else return!1}else if(!this.options.flex)break}return u?(o=this.test_match(u,T[y]),o!==!1?o:!1):this._input===""?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+`. Unrecognized text.
`+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:i(function(){var u=this.next();return u||this.lex()},"lex"),begin:i(function(u){this.conditionStack.push(u)},"begin"),popState:i(function(){var u=this.conditionStack.length-1;return u>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:i(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:i(function(u){return u=this.conditionStack.length-1-Math.abs(u||0),u>=0?this.conditionStack[u]:"INITIAL"},"topState"),pushState:i(function(u){this.begin(u)},"pushState"),stateStackSize:i(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:i(function(u,n,y,T){switch(y){case 0:return 41;case 1:return 48;case 2:return 49;case 3:return 50;case 4:return 51;case 5:break;case 6:break;case 7:return 5;case 8:break;case 9:break;case 10:break;case 11:break;case 12:return this.pushState("SCALE"),17;case 13:return 18;case 14:this.popState();break;case 15:return this.begin("acc_title"),33;case 16:return this.popState(),"acc_title_value";case 17:return this.begin("acc_descr"),35;case 18:return this.popState(),"acc_descr_value";case 19:this.begin("acc_descr_multiline");break;case 20:this.popState();break;case 21:return"acc_descr_multiline_value";case 22:return this.pushState("CLASSDEF"),38;case 23:return this.popState(),this.pushState("CLASSDEFID"),"DEFAULT_CLASSDEF_ID";case 24:return this.popState(),this.pushState("CLASSDEFID"),39;case 25:return this.popState(),40;case 26:return this.pushState("CLASS"),45;case 27:return this.popState(),this.pushState("CLASS_STYLE"),46;case 28:return this.popState(),47;case 29:return this.pushState("STYLE"),42;case 30:return this.popState(),this.pushState("STYLEDEF_STYLES"),43;case 31:return this.popState(),44;case 32:return this.pushState("SCALE"),17;case 33:return 18;case 34:this.popState();break;case 35:this.pushState("STATE");break;case 36:return this.popState(),n.yytext=n.yytext.slice(0,-8).trim(),25;case 37:return this.popState(),n.yytext=n.yytext.slice(0,-8).trim(),26;case 38:return this.popState(),n.yytext=n.yytext.slice(0,-10).trim(),27;case 39:return this.popState(),n.yytext=n.yytext.slice(0,-8).trim(),25;case 40:return this.popState(),n.yytext=n.yytext.slice(0,-8).trim(),26;case 41:return this.popState(),n.yytext=n.yytext.slice(0,-10).trim(),27;case 42:return 48;case 43:return 49;case 44:return 50;case 45:return 51;case 46:this.pushState("STATE_STRING");break;case 47:return this.pushState("STATE_ID"),"AS";case 48:return this.popState(),"ID";case 49:this.popState();break;case 50:return"STATE_DESCR";case 51:return 19;case 52:this.popState();break;case 53:return this.popState(),this.pushState("struct"),20;case 54:break;case 55:return this.popState(),21;case 56:break;case 57:return this.begin("NOTE"),29;case 58:return this.popState(),this.pushState("NOTE_ID"),56;case 59:return this.popState(),this.pushState("NOTE_ID"),57;case 60:this.popState(),this.pushState("FLOATING_NOTE");break;case 61:return this.popState(),this.pushState("FLOATING_NOTE_ID"),"AS";case 62:break;case 63:return"NOTE_TEXT";case 64:return this.popState(),"ID";case 65:return this.popState(),this.pushState("NOTE_TEXT"),24;case 66:return this.popState(),n.yytext=n.yytext.substr(2).trim(),31;case 67:return this.popState(),n.yytext=n.yytext.slice(0,-8).trim(),31;case 68:return 6;case 69:return 6;case 70:return 16;case 71:return 54;case 72:return 24;case 73:return n.yytext=n.yytext.trim(),14;case 74:return 15;case 75:return 28;case 76:return 55;case 77:return 5;case 78:return"INVALID"}},"anonymous"),rules:[/^(?:default\b)/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:[^\}]%%[^\n]*)/i,/^(?:[\n]+)/i,/^(?:[\s]+)/i,/^(?:((?!\n)\s)+)/i,/^(?:#[^\n]*)/i,/^(?:%[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:classDef\s+)/i,/^(?:DEFAULT\s+)/i,/^(?:\w+\s+)/i,/^(?:[^\n]*)/i,/^(?:class\s+)/i,/^(?:(\w+)+((,\s*\w+)*))/i,/^(?:[^\n]*)/i,/^(?:style\s+)/i,/^(?:[\w,]+\s+)/i,/^(?:[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:state\s+)/i,/^(?:.*<<fork>>)/i,/^(?:.*<<join>>)/i,/^(?:.*<<choice>>)/i,/^(?:.*\[\[fork\]\])/i,/^(?:.*\[\[join\]\])/i,/^(?:.*\[\[choice\]\])/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:["])/i,/^(?:\s*as\s+)/i,/^(?:[^\n\{]*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n\s\{]+)/i,/^(?:\n)/i,/^(?:\{)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:\})/i,/^(?:[\n])/i,/^(?:note\s+)/i,/^(?:left of\b)/i,/^(?:right of\b)/i,/^(?:")/i,/^(?:\s*as\s*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n]*)/i,/^(?:\s*[^:\n\s\-]+)/i,/^(?:\s*:[^:\n;]+)/i,/^(?:[\s\S]*?end note\b)/i,/^(?:stateDiagram\s+)/i,/^(?:stateDiagram-v2\s+)/i,/^(?:hide empty description\b)/i,/^(?:\[\*\])/i,/^(?:[^:\n\s\-\{]+)/i,/^(?:\s*:[^:\n;]+)/i,/^(?:-->)/i,/^(?:--)/i,/^(?::::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{LINE:{rules:[9,10],inclusive:!1},struct:{rules:[9,10,22,26,29,35,42,43,44,45,54,55,56,57,71,72,73,74,75],inclusive:!1},FLOATING_NOTE_ID:{rules:[64],inclusive:!1},FLOATING_NOTE:{rules:[61,62,63],inclusive:!1},NOTE_TEXT:{rules:[66,67],inclusive:!1},NOTE_ID:{rules:[65],inclusive:!1},NOTE:{rules:[58,59,60],inclusive:!1},STYLEDEF_STYLEOPTS:{rules:[],inclusive:!1},STYLEDEF_STYLES:{rules:[31],inclusive:!1},STYLE_IDS:{rules:[],inclusive:!1},STYLE:{rules:[30],inclusive:!1},CLASS_STYLE:{rules:[28],inclusive:!1},CLASS:{rules:[27],inclusive:!1},CLASSDEFID:{rules:[25],inclusive:!1},CLASSDEF:{rules:[23,24],inclusive:!1},acc_descr_multiline:{rules:[20,21],inclusive:!1},acc_descr:{rules:[18],inclusive:!1},acc_title:{rules:[16],inclusive:!1},SCALE:{rules:[13,14,33,34],inclusive:!1},ALIAS:{rules:[],inclusive:!1},STATE_ID:{rules:[48],inclusive:!1},STATE_STRING:{rules:[49,50],inclusive:!1},FORK_STATE:{rules:[],inclusive:!1},STATE:{rules:[9,10,36,37,38,39,40,41,46,47,51,52,53],inclusive:!1},ID:{rules:[9,10],inclusive:!1},INITIAL:{rules:[0,1,2,3,4,5,6,7,8,10,11,12,15,17,19,22,26,29,32,35,53,57,68,69,70,71,72,73,74,76,77,78],inclusive:!0}}};return $})();kt.lexer=be;function ut(){this.yy={}}return i(ut,"Parser"),ut.prototype=kt,kt.Parser=ut,new ut})();Ot.parser=Ot;var As=Ot,Ge="LR",qt="TB",_t="state",wt="relation",Be="classDef",Ye="style",Fe="applyClass",tt="default",Qt="divider",Zt="fill:none",te="fill: #333",ee="c",se="text",ie="normal",It="rect",Rt="rectWithTitle",Ve="stateStart",Me="stateEnd",jt="divider",Ht="roundedWithTitle",Ue="note",je="noteGroup",et="statediagram",He="state",ze=`${et}-${He}`,re="transition",We="note",Xe="note-edge",Ke=`${re} ${Xe}`,Je=`${et}-${We}`,qe="cluster",Qe=`${et}-${qe}`,Ze="cluster-alt",ts=`${et}-${Ze}`,ae="parent",ne="note",es="state",$t="----",ss=`${$t}${ne}`,zt=`${$t}${ae}`,le=i((t,e=qt)=>{if(!t.doc)return e;let c=e;for(const a of t.doc)a.stmt==="dir"&&(c=a.value);return c},"getDir"),is=i(function(t,e){return e.db.extract(e.db.getRootDocV2()),e.db.getClasses()},"getClasses"),rs=i(async function(t,e,c,a){b.info("REF0:"),b.info("Drawing state diagram (v2)",e);const{securityLevel:d,state:r,layout:p}=x();a.db.extract(a.db.getRootDocV2());const g=a.db.getData(),l=De(e,d);g.type=a.type,g.layoutAlgorithm=p,g.nodeSpacing=r?.nodeSpacing||50,g.rankSpacing=r?.rankSpacing||50,g.markers=["barb"],g.diagramId=e,await Ne(g,l);const _=8;we.insertTitle(l,"statediagramTitleText",r?.titleTopMargin??25,a.db.getDiagramTitle()),Ce(l,_,et,r?.useMaxWidth??!0)},"draw"),Ls={getClasses:is,draw:rs,getDir:le},St=new Map,P=0;function yt(t="",e=0,c="",a=$t){const d=c!==null&&c.length>0?`${a}${c}`:"";return`${es}-${t}${d}-${e}`}i(yt,"stateDomId");var as=i((t,e,c,a,d,r,p,g)=>{b.trace("items",e),e.forEach(l=>{switch(l.stmt){case _t:Q(t,l,c,a,d,r,p,g);break;case tt:Q(t,l,c,a,d,r,p,g);break;case wt:{Q(t,l.state1,c,a,d,r,p,g),Q(t,l.state2,c,a,d,r,p,g);const _={id:"edge"+P,start:l.state1.id,end:l.state2.id,arrowhead:"normal",arrowTypeEnd:"arrow_barb",style:Zt,labelStyle:"",label:U.sanitizeText(l.description,x()),arrowheadStyle:te,labelpos:ee,labelType:se,thickness:ie,classes:re,look:p};d.push(_),P++}break}})},"setupDoc"),Wt=i((t,e=qt)=>{let c=e;if(t.doc)for(const a of t.doc)a.stmt==="dir"&&(c=a.value);return c},"getDir");function q(t,e,c){if(!e.id||e.id==="</join></fork>"||e.id==="</choice>")return;e.cssClasses&&(Array.isArray(e.cssCompiledStyles)||(e.cssCompiledStyles=[]),e.cssClasses.split(" ").forEach(d=>{if(c.get(d)){const r=c.get(d);e.cssCompiledStyles=[...e.cssCompiledStyles,...r.styles]}}));const a=t.find(d=>d.id===e.id);a?Object.assign(a,e):t.push(e)}i(q,"insertOrUpdateNode");function oe(t){return t?.classes?.join(" ")??""}i(oe,"getClassesFromDbInfo");function ce(t){return t?.styles??[]}i(ce,"getStylesFromDbInfo");var Q=i((t,e,c,a,d,r,p,g)=>{const l=e.id,_=c.get(l),v=oe(_),O=ce(_);if(b.info("dataFetcher parsedItem",e,_,O),l!=="root"){let L=It;e.start===!0?L=Ve:e.start===!1&&(L=Me),e.type!==tt&&(L=e.type),St.get(l)||St.set(l,{id:l,shape:L,description:U.sanitizeText(l,x()),cssClasses:`${v} ${ze}`,cssStyles:O});const f=St.get(l);e.description&&(Array.isArray(f.description)?(f.shape=Rt,f.description.push(e.description)):f.description?.length>0?(f.shape=Rt,f.description===l?f.description=[e.description]:f.description=[f.description,e.description]):(f.shape=It,f.description=e.description),f.description=U.sanitizeTextOrArray(f.description,x())),f.description?.length===1&&f.shape===Rt&&(f.type==="group"?f.shape=Ht:f.shape=It),!f.type&&e.doc&&(b.info("Setting cluster for XCX",l,Wt(e)),f.type="group",f.isGroup=!0,f.dir=Wt(e),f.shape=e.type===Qt?jt:Ht,f.cssClasses=`${f.cssClasses} ${Qe} ${r?ts:""}`);const A={labelStyle:"",shape:f.shape,label:f.description,cssClasses:f.cssClasses,cssCompiledStyles:[],cssStyles:f.cssStyles,id:l,dir:f.dir,domId:yt(l,P),type:f.type,isGroup:f.type==="group",padding:8,rx:10,ry:10,look:p};if(A.shape===jt&&(A.label=""),t&&t.id!=="root"&&(b.trace("Setting node ",l," to be child of its parent ",t.id),A.parentId=t.id),A.centerLabel=!0,e.note){const I={labelStyle:"",shape:Ue,label:e.note.text,cssClasses:Je,cssStyles:[],cssCompilesStyles:[],id:l+ss+"-"+P,domId:yt(l,P,ne),type:f.type,isGroup:f.type==="group",padding:x().flowchart.padding,look:p,position:e.note.position},B=l+zt,Y={labelStyle:"",shape:je,label:e.note.text,cssClasses:f.cssClasses,cssStyles:[],id:l+zt,domId:yt(l,P,ae),type:"group",isGroup:!0,padding:16,look:p,position:e.note.position};P++,Y.id=B,I.parentId=B,q(a,Y,g),q(a,I,g),q(a,A,g);let N=l,w=I.id;e.note.position==="left of"&&(N=I.id,w=l),d.push({id:N+"-"+w,start:N,end:w,arrowhead:"none",arrowTypeEnd:"",style:Zt,labelStyle:"",classes:Ke,arrowheadStyle:te,labelpos:ee,labelType:se,thickness:ie,look:p})}else q(a,A,g)}e.doc&&(b.trace("Adding nodes children "),as(e,e.doc,c,a,d,!r,p,g))},"dataFetcher"),ns=i(()=>{St.clear(),P=0},"reset"),Pt="[*]",ue="start",he=Pt,de="end",Xt="color",Kt="fill",ls="bgFill",os=",";function Gt(){return new Map}i(Gt,"newClassesList");var Tt=[],Bt=[],fe=Ge,Et=[],W=Gt(),pe=i(()=>({relations:[],states:new Map,documents:{}}),"newDoc"),vt={root:pe()},k=vt.root,Z=0,Jt=0,cs={LINE:0,DOTTED_LINE:1},us={AGGREGATION:0,EXTENSION:1,COMPOSITION:2,DEPENDENCY:3},pt=i(t=>JSON.parse(JSON.stringify(t)),"clone"),hs=i(t=>{b.info("Setting root doc",t),Et=t},"setRootDoc"),ds=i(()=>Et,"getRootDoc"),gt=i((t,e,c)=>{if(e.stmt===wt)gt(t,e.state1,!0),gt(t,e.state2,!1);else if(e.stmt===_t&&(e.id==="[*]"?(e.id=c?t.id+"_start":t.id+"_end",e.start=c):e.id=e.id.trim()),e.doc){const a=[];let d=[],r;for(r=0;r<e.doc.length;r++)if(e.doc[r].type===Qt){const p=pt(e.doc[r]);p.doc=pt(d),a.push(p),d=[]}else d.push(e.doc[r]);if(a.length>0&&d.length>0){const p={stmt:_t,id:Pe(),type:"divider",doc:pt(d)};a.push(pt(p)),e.doc=a}e.doc.forEach(p=>gt(e,p,!0))}},"docTranslator"),Yt=i(()=>(gt({id:"root"},{id:"root",doc:Et},!0),{id:"root",doc:Et}),"getRootDocV2"),fs=i(t=>{let e;t.doc?e=t.doc:e=t,b.info(e),Se(!0),b.info("Extract initial document:",e),e.forEach(r=>{switch(b.warn("Statement",r.stmt),r.stmt){case _t:G(r.id.trim(),r.type,r.doc,r.description,r.note,r.classes,r.styles,r.textStyles);break;case wt:Ee(r.state1,r.state2,r.description);break;case Be:ve(r.id.trim(),r.classes);break;case Ye:{const p=r.id.trim().split(","),g=r.styleClass.split(",");p.forEach(l=>{let _=j(l);if(_===void 0){const v=l.trim();G(v),_=j(v)}_.styles=g.map(v=>v.replace(/;/g,"")?.trim())})}break;case Fe:Ft(r.id.trim(),r.styleClass);break}});const c=ye(),d=x().look;ns(),Q(void 0,Yt(),c,Tt,Bt,!0,d,W),Tt.forEach(r=>{if(Array.isArray(r.label)){if(r.description=r.label.slice(1),r.isGroup&&r.description.length>0)throw new Error("Group nodes can only have label. Remove the additional description for node ["+r.id+"]");r.label=r.label[0]}})},"extract"),G=i(function(t,e=tt,c=null,a=null,d=null,r=null,p=null,g=null){const l=t?.trim();if(k.states.has(l)?(k.states.get(l).doc||(k.states.get(l).doc=c),k.states.get(l).type||(k.states.get(l).type=e)):(b.info("Adding state ",l,a),k.states.set(l,{id:l,descriptions:[],type:e,doc:c,note:d,classes:[],styles:[],textStyles:[]})),a&&(b.info("Setting state description",l,a),typeof a=="string"&&Nt(l,a.trim()),typeof a=="object"&&a.forEach(_=>Nt(l,_.trim()))),d){const _=k.states.get(l);_.note=d,_.note.text=U.sanitizeText(_.note.text,x())}r&&(b.info("Setting state classes",l,r),(typeof r=="string"?[r]:r).forEach(v=>Ft(l,v.trim()))),p&&(b.info("Setting state styles",l,p),(typeof p=="string"?[p]:p).forEach(v=>Ts(l,v.trim()))),g&&(b.info("Setting state styles",l,p),(typeof g=="string"?[g]:g).forEach(v=>Es(l,v.trim())))},"addState"),Se=i(function(t){Tt=[],Bt=[],vt={root:pe()},k=vt.root,Z=0,W=Gt(),t||$e()},"clear"),j=i(function(t){return k.states.get(t)},"getState"),ye=i(function(){return k.states},"getStates"),ps=i(function(){b.info("Documents = ",vt)},"logDocuments"),Ss=i(function(){return k.relations},"getRelations");function bt(t=""){let e=t;return t===Pt&&(Z++,e=`${ue}${Z}`),e}i(bt,"startIdIfNeeded");function mt(t="",e=tt){return t===Pt?ue:e}i(mt,"startTypeIfNeeded");function ge(t=""){let e=t;return t===he&&(Z++,e=`${de}${Z}`),e}i(ge,"endIdIfNeeded");function _e(t="",e=tt){return t===he?de:e}i(_e,"endTypeIfNeeded");function Te(t,e,c){let a=bt(t.id.trim()),d=mt(t.id.trim(),t.type),r=bt(e.id.trim()),p=mt(e.id.trim(),e.type);G(a,d,t.doc,t.description,t.note,t.classes,t.styles,t.textStyles),G(r,p,e.doc,e.description,e.note,e.classes,e.styles,e.textStyles),k.relations.push({id1:a,id2:r,relationTitle:U.sanitizeText(c,x())})}i(Te,"addRelationObjs");var Ee=i(function(t,e,c){if(typeof t=="object")Te(t,e,c);else{const a=bt(t.trim()),d=mt(t),r=ge(e.trim()),p=_e(e);G(a,d),G(r,p),k.relations.push({id1:a,id2:r,title:U.sanitizeText(c,x())})}},"addRelation"),Nt=i(function(t,e){const c=k.states.get(t),a=e.startsWith(":")?e.replace(":","").trim():e;c.descriptions.push(U.sanitizeText(a,x()))},"addDescription"),ys=i(function(t){return t.substring(0,1)===":"?t.substr(2).trim():t.trim()},"cleanupLabel"),gs=i(()=>(Jt++,"divider-id-"+Jt),"getDividerId"),ve=i(function(t,e=""){W.has(t)||W.set(t,{id:t,styles:[],textStyles:[]});const c=W.get(t);e?.split(os).forEach(a=>{const d=a.replace(/([^;]*);/,"$1").trim();if(RegExp(Xt).exec(a)){const p=d.replace(Kt,ls).replace(Xt,Kt);c.textStyles.push(p)}c.styles.push(d)})},"addStyleClass"),_s=i(function(){return W},"getClasses"),Ft=i(function(t,e){t.split(",").forEach(function(c){let a=j(c);if(a===void 0){const d=c.trim();G(d),a=j(d)}a.classes.push(e)})},"setCssClass"),Ts=i(function(t,e){const c=j(t);c!==void 0&&c.styles.push(e)},"setStyle"),Es=i(function(t,e){const c=j(t);c!==void 0&&c.textStyles.push(e)},"setTextStyle"),vs=i(()=>fe,"getDirection"),bs=i(t=>{fe=t},"setDirection"),ms=i(t=>t&&t[0]===":"?t.substr(1).trim():t.trim(),"trimColon"),ks=i(()=>{const t=x();return{nodes:Tt,edges:Bt,other:{},config:t,direction:le(Yt())}},"getData"),Is={getConfig:i(()=>x().state,"getConfig"),getData:ks,addState:G,clear:Se,getState:j,getStates:ye,getRelations:Ss,getClasses:_s,getDirection:vs,addRelation:Ee,getDividerId:gs,setDirection:bs,cleanupLabel:ys,lineType:cs,relationType:us,logDocuments:ps,getRootDoc:ds,setRootDoc:hs,getRootDocV2:Yt,extract:fs,trimColon:ms,getAccTitle:Oe,setAccTitle:Re,getAccDescription:Ie,setAccDescription:Le,addStyleClass:ve,setCssClass:Ft,addDescription:Nt,setDiagramTitle:Ae,getDiagramTitle:xe},Ds=i(t=>`
defs #statediagram-barbEnd {
    fill: ${t.transitionColor};
    stroke: ${t.transitionColor};
  }
g.stateGroup text {
  fill: ${t.nodeBorder};
  stroke: none;
  font-size: 10px;
}
g.stateGroup text {
  fill: ${t.textColor};
  stroke: none;
  font-size: 10px;

}
g.stateGroup .state-title {
  font-weight: bolder;
  fill: ${t.stateLabelColor};
}

g.stateGroup rect {
  fill: ${t.mainBkg};
  stroke: ${t.nodeBorder};
}

g.stateGroup line {
  stroke: ${t.lineColor};
  stroke-width: 1;
}

.transition {
  stroke: ${t.transitionColor};
  stroke-width: 1;
  fill: none;
}

.stateGroup .composit {
  fill: ${t.background};
  border-bottom: 1px
}

.stateGroup .alt-composit {
  fill: #e0e0e0;
  border-bottom: 1px
}

.state-note {
  stroke: ${t.noteBorderColor};
  fill: ${t.noteBkgColor};

  text {
    fill: ${t.noteTextColor};
    stroke: none;
    font-size: 10px;
  }
}

.stateLabel .box {
  stroke: none;
  stroke-width: 0;
  fill: ${t.mainBkg};
  opacity: 0.5;
}

.edgeLabel .label rect {
  fill: ${t.labelBackgroundColor};
  opacity: 0.5;
}
.edgeLabel {
  background-color: ${t.edgeLabelBackground};
  p {
    background-color: ${t.edgeLabelBackground};
  }
  rect {
    opacity: 0.5;
    background-color: ${t.edgeLabelBackground};
    fill: ${t.edgeLabelBackground};
  }
  text-align: center;
}
.edgeLabel .label text {
  fill: ${t.transitionLabelColor||t.tertiaryTextColor};
}
.label div .edgeLabel {
  color: ${t.transitionLabelColor||t.tertiaryTextColor};
}

.stateLabel text {
  fill: ${t.stateLabelColor};
  font-size: 10px;
  font-weight: bold;
}

.node circle.state-start {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node .fork-join {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node circle.state-end {
  fill: ${t.innerEndBackground};
  stroke: ${t.background};
  stroke-width: 1.5
}
.end-state-inner {
  fill: ${t.compositeBackground||t.background};
  // stroke: ${t.background};
  stroke-width: 1.5
}

.node rect {
  fill: ${t.stateBkg||t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: 1px;
}
.node polygon {
  fill: ${t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};;
  stroke-width: 1px;
}
#statediagram-barbEnd {
  fill: ${t.lineColor};
}

.statediagram-cluster rect {
  fill: ${t.compositeTitleBackground};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: 1px;
}

.cluster-label, .nodeLabel {
  color: ${t.stateLabelColor};
  // line-height: 1;
}

.statediagram-cluster rect.outer {
  rx: 5px;
  ry: 5px;
}
.statediagram-state .divider {
  stroke: ${t.stateBorder||t.nodeBorder};
}

.statediagram-state .title-state {
  rx: 5px;
  ry: 5px;
}
.statediagram-cluster.statediagram-cluster .inner {
  fill: ${t.compositeBackground||t.background};
}
.statediagram-cluster.statediagram-cluster-alt .inner {
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.statediagram-cluster .inner {
  rx:0;
  ry:0;
}

.statediagram-state rect.basic {
  rx: 5px;
  ry: 5px;
}
.statediagram-state rect.divider {
  stroke-dasharray: 10,10;
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.note-edge {
  stroke-dasharray: 5;
}

.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}
.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}

.statediagram-note text {
  fill: ${t.noteTextColor};
}

.statediagram-note .nodeLabel {
  color: ${t.noteTextColor};
}
.statediagram .edgeLabel {
  color: red; // ${t.noteTextColor};
}

#dependencyStart, #dependencyEnd {
  fill: ${t.lineColor};
  stroke: ${t.lineColor};
  stroke-width: 1;
}

.statediagramTitleText {
  text-anchor: middle;
  font-size: 18px;
  fill: ${t.textColor};
}
`,"getStyles"),Rs=Ds;export{Is as a,As as b,Ls as c,Rs as s};
