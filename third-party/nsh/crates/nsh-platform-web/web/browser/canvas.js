// Drawings are decoded and replayed by Rust. JavaScript records the public
// Canvas 2D facade; method/property metadata comes from the core's enums.
export function createCanvas(invoke, reactive, dom, live, wake) {
  const recordings = new WeakMap(), retained = new WeakMap();
  const call = (op,args) => { if(!live())throw new Error("the app was disposed");const result=invoke(op,args);wake();return result; };
  const specs = call(600,[]);
  const data = object => {const r=recordings.get(object);if(!r)throw new TypeError("not a canvas context or path");return r;};
  const snapshot = (value,depth=0) => {
    if(depth>64)return null;
    const r=recordings.get(value);
    if(r)return r.out.map(v=>snapshot(v,depth+1));
    if(value&&typeof value==="object"&&typeof value.__av==="number")return value;
    if(Array.isArray(value))return value.map(v=>snapshot(v,depth+1));
    return ["number","string","boolean"].includes(typeof value)?value:null;
  };
  const record = (object,code,args) => {const r=data(object);if(!r.closed)r.out.push(code,...args.map(v=>snapshot(v)));};
  const make = (prototype,kind,size) => {const object=Object.create(prototype);recordings.set(object,{kind,out:[],state:{},stack:[],closed:false,size});return object;};
  function CanvasRenderingContext2D(){throw new TypeError("Illegal constructor");}
  function CanvasGradient(){throw new TypeError("Illegal constructor");}
  function Path2D(source){
    if(!new.target)throw new TypeError("Path2D requires new");
    const path=make(Path2D.prototype,"path");
    if(recordings.get(source)?.kind==="path")data(path).out=snapshot(source);
    else if(typeof source==="string")data(path).out=[50,source];
    return path;
  }
  const install = (prototype,methods) => {for(const method of methods)Object.defineProperty(prototype,method.name,{configurable:true,writable:true,value:function(...args){record(this,method.code,method.defaults.map((value,index)=>args[index]===undefined?value:args[index]));}});};
  install(Path2D.prototype,specs.path);install(CanvasRenderingContext2D.prototype,[...specs.path,...specs.context]);
  const roundRect = function(x,y,width,height,radii=0){
    const r=Array.isArray(radii)?radii.slice(0,4):[radii];const get=i=>r[i]??0;
    const corners=r.length===4?[get(0),get(1),get(2),get(3)]:r.length===3?[get(0),get(1),get(2),get(1)]:r.length===2?[get(0),get(1),get(0),get(1)]:[get(0),get(0),get(0),get(0)];
    record(this,16,[x,y,width,height,...corners]);
  };
  Object.assign(Path2D.prototype,{roundRect,addPath(path){if(recordings.get(path)?.kind==="path")data(this).out.push(...snapshot(path));}});
  const properties=[...specs.properties,{name:"fillStyle",code:24,initial:"#000"},{name:"strokeStyle",code:25,initial:"#000"},{name:"shadowOffsetX",initial:0},{name:"shadowOffsetY",initial:0}];
  for(const property of properties)Object.defineProperty(CanvasRenderingContext2D.prototype,property.name,{
    configurable:true,get(){const state=data(this).state;return Object.hasOwn(state,property.name)?state[property.name]:property.initial;},
    set(value){const state=data(this).state;state[property.name]=value;if(property.code!==undefined)record(this,property.code,[value]);else record(this,36,[state.shadowOffsetX??0,state.shadowOffsetY??0]);},
  });
  Object.defineProperty(CanvasRenderingContext2D.prototype,"canvas",{get(){return data(this).size;}});
  const isPath = value => recordings.get(value)?.kind==="path";
  const fillLike = (object,code,first,rule) => record(object,code,isPath(first)?[first,rule??"nonzero"]:[null,first??"nonzero"]);
  const gradient = (kind,args,count) => {const object=make(CanvasGradient.prototype,"gradient");data(object).out=[kind,...Array.from({length:count},(_,i)=>Number(args[i])),[]];return object;};
  Object.assign(CanvasGradient.prototype,{addColorStop(offset,color){data(this).out.at(-1).push(Number(offset),String(color));}});
  Object.assign(CanvasRenderingContext2D.prototype,{
    roundRect,
    save(){const r=data(this);r.stack.push({...r.state});record(this,0,[]);},
    restore(){const r=data(this);if(r.stack.length){r.state=r.stack.pop();record(this,1,[]);}},
    resetTransform(){record(this,6,[1,0,0,1,0,0]);},
    setLineDash(segments){const dash=Array.isArray(segments)?segments.map(Number):[];data(this).state.lineDash=dash;record(this,30,[dash]);},
    getLineDash(){return [...(data(this).state.lineDash??[])];},
    fill(first,rule){fillLike(this,18,first,rule);},clip(first,rule){fillLike(this,20,first,rule);},stroke(path){record(this,19,[isPath(path)?path:null]);},
    fillText(text,x,y,maxWidth){record(this,40,[String(text),x,y,maxWidth??null]);},strokeText(text,x,y,maxWidth){record(this,41,[String(text),x,y,maxWidth??null]);},
    measureText(text){return {width:call(603,[this.font,this.fontVariantNumeric,typeof text==="string"?text:""])};},
    isPointInPath(...args){const path=isPath(args[0])?snapshot(args.shift()):null;return call(602,[data(this).out,path,Number(args[0]),Number(args[1]),args[2],false]);},
    isPointInStroke(...args){const path=isPath(args[0])?snapshot(args.shift()):null;return call(602,[data(this).out,path,Number(args[0]),Number(args[1]),undefined,true]);},
    createLinearGradient(...args){return gradient(0,args,4);},createRadialGradient(...args){return gradient(1,args,6);},createConicGradient(...args){return gradient(2,args,3);},
    drawImage(image,...args){
      const uri=typeof image==="string"?image:image?.url;
      const size=typeof image==="object"?image?.size:null;
      if(args.length>=8)record(this,42,[uri,args.slice(0,4),...args.slice(4,8)]);
      else if(args.length>=4)record(this,42,[uri,null,...args.slice(0,4)]);
      else record(this,42,[uri,null,args[0]??0,args[1]??0,size?.width??NaN,size?.height??NaN]);
    },
  });
  function Canvas(props){
    const node=dom.rt.element("canvas");
    dom.rt.spread(node,reactive.split(props,["draw","onLayout"])[1]);
    const size=reactive.signal(null,{equals:(a,b)=>a?.width===b?.width&&a?.height===b?.height});
    dom.rt.prop(node,"onLayout",e=>{size.set({...e.bounds.size});props.onLayout?.(e);});
    reactive.renderEffect(()=>{
      const dimensions=size();if(!dimensions)return;
      const context=make(CanvasRenderingContext2D.prototype,"context",dimensions);
      let failed=false,error;
      try{props.draw(context,dimensions);}catch(thrown){failed=true;error=thrown;}
      const r=data(context);r.closed=true;retained.set(node,r.out);
      try{call(601,[node,r.out]);}catch(thrown){if(!failed)throw thrown;}
      if(failed)throw error;
    });
    return node;
  }
  return {Canvas,Path2D,CanvasRenderingContext2D,CanvasGradient};
}
