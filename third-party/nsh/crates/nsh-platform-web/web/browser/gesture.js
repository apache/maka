// Responder callbacks stay browser functions; Rust accumulates gesture
// coordinates/velocity and the platform owns pointer capture/scroll blocking.
export function createGestures(invoke, values, reactive, dom, live, wake) {
  const raw = ["onTouchStart","onTouchMove","onTouchEnd","onTouchCancel"];
  const questions = ["onStartShouldSetResponder","onMoveShouldSetResponder"];
  const responderNames = ["onResponderGrant","onResponderReject","onResponderStart","onResponderMove","onResponderEnd","onResponderRelease","onResponderTerminate","onResponderTerminationRequest"];
  const names = new Set([...raw,...raw.map(n=>n+"Capture"),...questions,...questions.map(n=>n+"Capture"),...responderNames]);
  const handlers=new WeakMap(),gated=new WeakSet(),paths=new Map();
  let responder=null,blocks=false,nextState=0;
  const call=(op,args)=>{if(!live())throw new Error("the app was disposed");const result=invoke(op,args);wake();return result;};
  const finalizer=new FinalizationRegistry(id=>{if(live())call(702,[id]);});
  const newGesture=()=>{const holder={id:call(700,[])};finalizer.register(holder,holder.id);return holder;};
  const gesture=newGesture();let negotiation={};
  const update=(holder,event,reset=false)=>call(701,[holder.id,event,reset]);
  const node=id=>values.nodes.get(id)?.deref();
  const handler=(id,name)=>handlers.get(node(id))?.get(name);
  const run=(id,name,...args)=>{const fn=handler(id,name);return fn?.(...args);};
  const command=(id,name,value)=>call(314,[id,name,value]);
  const release=()=>{responder=null;if(blocks){blocks=false;command(1,"clearJsResponder");}};
  const takeOver=(id,event)=>{
    if(responder!==null){
      if(run(responder,"onResponderTerminationRequest",event)===false){run(id,"onResponderReject",event);return;}
      run(responder,"onResponderTerminate",event);
    }
    responder=id;const block=run(id,"onResponderGrant",event)===true;
    if(block)command(id,"setJsResponder",true);else if(blocks)command(1,"clearJsResponder");blocks=block;
  };
  const negotiate=(kind,path,event)=>{
    let from=0;
    if(responder!==null){while(from<path.length&&!call(313,[path[from],responder]))from++;if(path[from]===responder)from++;}
    const asked=path.slice(from);
    for(const [ids,name] of [[asked.slice().reverse(),kind+"Capture"],[asked,kind]]){
      for(const id of ids){if(gated.has(node(id)))continue;if(run(id,name,event,negotiation)===true){if(id!==responder)takeOver(id,event);return;}}
    }
  };
  const point=p=>{const {identifier,target,pageX,pageY,locationX,locationY,timestamp}=p;return {identifier,target,pageX,pageY,locationX,locationY,timestamp};};
  const dispatch=touch=>reactive.batch(()=>reactive.untracked(()=>{
    const lifted=touch.phase==="end"||touch.phase==="cancel";
    for(const p of touch.points)if(touch.phase==="start"&&p.changed)paths.set(p.identifier,p.path.filter(id=>handlers.get(node(id))?.size));
    const down=touch.points.filter(p=>!lifted||!p.changed),changed=touch.points.filter(p=>p.changed);if(!changed.length)return;
    const event={...point(changed[0]),touches:down.map(point),changedTouches:changed.map(point),stopped:false,stopPropagation(){this.stopped=true;}};event.nativeEvent=event;
    const path=paths.get(changed[0].identifier)??[];
    if(touch.phase==="start"||touch.phase==="move")negotiation=update(gesture,event,touch.phase==="start"&&touch.points.length===1);
    try{
      const name={start:"onTouchStart",move:"onTouchMove",end:"onTouchEnd",cancel:"onTouchCancel"}[touch.phase];
      for(const [ids,prop]of[[path.slice().reverse(),name+"Capture"],[path,name]])for(const id of ids){if(event.stopped)break;run(id,prop,event);}
      event.stopped=false;
      if(touch.activated!=null&&gated.has(node(touch.activated))&&handlers.get(node(touch.activated))?.size&&responder!==touch.activated)takeOver(touch.activated,event);
      if(touch.phase==="start")negotiate(questions[0],path,event);else if(touch.phase==="move")negotiate(questions[1],path,event);
      if(responder!==null){
        const id=responder;
        if(touch.phase==="cancel"){run(id,"onResponderTerminate",event);release();}
        else{run(id,{start:"onResponderStart",move:"onResponderMove",end:"onResponderEnd"}[touch.phase],event);if(touch.phase==="end"&&!down.length){release();run(id,"onResponderRelease",event);}}
      }
    }finally{if(lifted)for(const p of changed)paths.delete(p.identifier);}
  }));
  const PanResponder={create(config={}){
    const holder=newGesture(),state={stateID:++nextState,moveX:0,moveY:0,x0:0,y0:0,dx:0,dy:0,vx:0,vy:0,numberActiveTouches:0};
    const set=(e,reset=false)=>Object.assign(state,update(holder,e,reset));
    const run=(name,e,fallback)=>typeof config[name]==="function"?config[name](e,state):fallback;
    return {panHandlers:{
      onStartShouldSetResponderCapture(e){if(e.touches.length===1)set(e,true);state.numberActiveTouches=e.touches.length;return run("onStartShouldSetPanResponderCapture",e,false);},
      onStartShouldSetResponder:e=>run("onStartShouldSetPanResponder",e,false),
      onMoveShouldSetResponderCapture(e){set(e);return run("onMoveShouldSetPanResponderCapture",e,false);},
      onMoveShouldSetResponder(e){set(e);return run("onMoveShouldSetPanResponder",e,false);},
      onResponderGrant(e){set(e,true);run("onPanResponderGrant",e);return run("onShouldBlockNativeResponder",e,true);},
      onResponderReject:e=>run("onPanResponderReject",e),
      onResponderStart(e){set(e);return run("onPanResponderStart",e);},
      onResponderMove(e){set(e);return run("onPanResponderMove",e);},
      onResponderEnd(e){set(e);return run("onPanResponderEnd",e);},
      onResponderRelease(e){try{return run("onPanResponderRelease",e);}finally{state.stateID=++nextState;}},
      onResponderTerminate(e){try{return run("onPanResponderTerminate",e);}finally{state.stateID=++nextState;}},
      onResponderTerminationRequest:e=>run("onPanResponderTerminationRequest",e,true),
    }};
  }};
  return {PanResponder,isProp:name=>names.has(name),gate(node,value){if(value==null)gated.delete(node);else gated.add(node);},
    set(node,name,value){let map=handlers.get(node);if(!map)handlers.set(node,map=new Map());if(typeof value==="function")map.set(name,value);else map.delete(name);dom.listen(node,"onTouch",map.size?()=>{}:undefined);},
    dispatch,
  };
}
