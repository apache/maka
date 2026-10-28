// Facades describe native animation operations; frame evaluation, spring
// physics, keyframes and motion composition remain in the Rust core.
export function createAnimation(invoke, live, wake, environment) {
  const nodes = new WeakMap(), composites = new WeakMap(), derived = new Map(), pending = new Map();
  let nextNode = 2, nextAnimation = 2, nextComposite = 2;
  const allocate = kind => {
    const id = kind === "node" ? nextNode : kind === "animation" ? nextAnimation : nextComposite;
    if (id >= 0xfffffffe) throw new RangeError("animation IDs exhausted");
    if (kind === "node") nextNode += 2; else if (kind === "animation") nextAnimation += 2; else nextComposite += 2;
    return id;
  };
  const call = (op, args) => {
    if (!live()) throw new Error("the app was disposed");
    const result = invoke(op, args); wake(); return result;
  };
  const send = (...op) => call(500, [op]);
  const nodeFinalizer = new FinalizationRegistry(({id, key}) => {
    if (key && !derived.get(key)?.deref()) derived.delete(key);
    if (live()) send(6, id);
  });
  const compositeFinalizer = new FinalizationRegistry(key => { if (live()) send(11, key); });
  const idOf = node => { const data = nodes.get(node); if (!data) throw new TypeError("not an animated value"); return data.id; };
  function makeNode(prototype, inputs, op) {
    const candidate = allocate("node");
    let id = candidate;
    if (op) {
      const liveIds = [];
      for (const [id, peer] of derived) { if (peer.deref()) liveIds.push(id); else derived.delete(id); }
      id = call(507, [[op[0], candidate, ...op.slice(1)], liveIds]);
      if (id !== candidate) return derived.get(id).deref();
    }
    const node = Object.create(prototype);
    nodes.set(node, { id, inputs });
    Object.defineProperty(node, "__av", { value: id });
    nodeFinalizer.register(node, { id, key: op ? id : undefined });
    if (op) derived.set(id, new WeakRef(node));
    return node;
  }
  function AnimatedNode() { return makeNode(AnimatedNode.prototype, []); }
  function AnimatedValue(value = 0) {
    const node = makeNode(AnimatedValue.prototype, []);
    send(0, idOf(node), Number(value)); return node;
  }
  Object.setPrototypeOf(AnimatedValue.prototype, AnimatedNode.prototype);
  const derive = (op, inputs) => makeNode(AnimatedNode.prototype, inputs, op);
  const math = (op, a, b) => derive([2, op, a, b], [a,b].filter(v => nodes.has(v)));
  Object.assign(AnimatedNode.prototype, {
    interpolate(config) {
      const extrapolate = config.extrapolate ?? "clamp";
      return derive([1,idOf(this),config.inputRange,config.outputRange,config.extrapolateLeft ?? extrapolate,config.extrapolateRight ?? extrapolate,config.easing], [this]);
    },
    diffClamp(min,max,options) { return derive([7,idOf(this),min,max,!!options?.snap], [this]); },
    add(b) { return math("add",this,b); }, sub(b) { return math("sub",this,b); },
    mul(b) { return math("mul",this,b); }, div(b) { return math("div",this,b); }, mod(b) { return math("mod",this,b); },
  });
  const wait = (op, read = false, callback, composite) => {
    const id = allocate("animation");
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending.set(id, { resolve, read, callback, composite: composite && new WeakRef(composite) });
    try { op(id); } catch (error) { pending.delete(id); throw error; }
    return promise;
  };
  const start = (node, spec) => wait(id => send(4, idOf(node), id, spec));
  Object.assign(AnimatedValue.prototype, {
    set(value) { send(3,idOf(this),value); },
    stop() { send(5,idOf(this)); return this.getValue().then(value => ({ value })); },
    getValue() { return wait(id => send(15,idOf(this),id), true); },
    setOffset(value) { send(12,idOf(this),value); },
    flattenOffset() { send(13,idOf(this)); }, extractOffset() { send(14,idOf(this)); },
    timing(to,options) { return start(this,{...options,type:"timing",to}); },
    spring(to,options) { return start(this,{...options,type:"spring",to}); },
    decay(options) { return start(this,{...options,type:"decay"}); },
    keyframes(keyframes,options) { return Animated.keyframes(this,{...options,keyframes}).start(); },
  });
  function composite(spec, inputs) {
    const key = allocate("composite");
    const data = { key, spec, inputs, running: 0 };
    const object = {
      start(callback) {
        this.stop();
        return wait(id => { data.running = id; send(8,id,key,spec); }, false, typeof callback === "function" ? callback : undefined, object);
      },
      stop() { if (data.running) send(9,data.running); },
      reset() { send(10,key); },
    };
    composites.set(object,data); compositeFinalizer.register(object,key); return object;
  }
  const driver = (type,node,config = {}) => {
    const {toValue,...rest} = config;
    return composite({...rest,type,node:idOf(node),...(toValue === undefined ? {} : {to:toValue})},[node]);
  };
  const group = (type,list,extra = {}) => {
    const children = (Array.isArray(list) ? list : []).map(c=>composites.get(c)).filter(Boolean);
    return composite({type,children:children.map(c=>c.spec),...extra},children.flatMap(c=>c.inputs));
  };
  const Animated = {
    timing:(node,config)=>driver("timing",node,config), spring:(node,config)=>driver("spring",node,config), decay:(node,config)=>driver("decay",node,config),
    sequence:list=>group("sequence",list), parallel:(list,options)=>group("parallel",list,{stopTogether:options?.stopTogether ?? true}),
    delay:ms=>composite({type:"delay",ms},[]),
    stagger(ms,list,options) { return group("parallel",(Array.isArray(list)?list:[]).map((item,index)=>group("sequence",[this.delay(Number(ms)*call(506,[options,index,list.length])),item])),{stopTogether:true}); },
    loop(animation,options) {
      const data = composites.get(animation); if (!data) throw new TypeError("loop: an animation");
      return composite({type:"loop",child:data.spec,iterations:options?.iterations ?? -1,reset:options?.resetBeforeIteration ?? true},data.inputs);
    },
    keyframes(node,config) { return composite({...config,type:"keyframes",node:idOf(node)},[node]); },
    add:(a,b)=>math("add",a,b),subtract:(a,b)=>math("sub",a,b),multiply:(a,b)=>math("mul",a,b),divide:(a,b)=>math("div",a,b),modulo:(a,b)=>math("mod",a,b),
    diffClamp:(node,min,max,options)=>AnimatedNode.prototype.diffClamp.call(node,min,max,options),
    sampleSpring:(config={},fps)=>call(502,[{...config,type:"spring",to:config.toValue},config.from,fps]),
    sampleDecay:(config={},fps)=>call(502,[{...config,type:"decay",to:config.toValue},config.from,fps]),
  };
  const tables = call(501, []), motions = tables.motions;
  const mode = (e,mode) => {
    if (Array.isArray(e) && mode === "out") return [1-e[2],1-e[3],1-e[0],1-e[1]];
    if (e && typeof e === "object" && !Array.isArray(e)) return {...e,mode};
    if (mode === "out" && e === "easeIn") return "easeOut";
    if (mode === "out" && e === "easeOut") return "easeIn";
    return e;
  };
  const Easing = {linear:"linear",ease:"ease",bezier:(...points)=>points.slice(0,4),steps:(steps,position)=>({steps,...(position===undefined?{}:{position})}),
    in:e=>mode(e,"in"),out:e=>mode(e,"out"),inOut:e=>mode(e,"inOut"),sample:(e,count)=>call(503,[e,Number(count)])};
  for (const [curve,param,initial] of tables.curves) Easing[curve] = param === null ? {curve,mode:"in"} : (value=initial)=>({curve,param:value,mode:"in"});
  const channels = ["opacity","translateX","translateY","rotate","rotateX","rotateY","scale","scaleX","scaleY"];
  const identity = channel => channel === "opacity" || channel.startsWith("scale") ? 1 : 0;
  function createMotion(options = {}) {
    const starts = options.enter === undefined ? [] : call(504,[options.enter]);
    const motion = Object.fromEntries(channels.map((channel,index)=>[channel,AnimatedValue(starts[index] ?? options.initial?.[channel] ?? identity(channel))]));
    const transform = channels.slice(1,6).map(channel=>({[channel]:motion[channel]}));
    transform.push({scaleX:motion.scale.mul(motion.scaleX)},{scaleY:motion.scale.mul(motion.scaleY)});
    Object.assign(motion, {
      transform, style:{opacity:motion.opacity,transform},
      animation(value,config) {
        const reduced = environment.api.reduceMotion() && !config?.ignoreReduceMotion && !value?.ignoreReduceMotion;
        const base = typeof value === "string" ? motions[value] : value;
        const spec = config && typeof config === "object" && base ? {...base,...config} : value;
        return composite({type:"motion",nodes:channels.map(channel=>idOf(motion[channel])),motion:spec,reduced},channels.map(channel=>motion[channel]));
      },
      play(value,config) { return this.animation(value,config).start(); },
      stop() { for(const channel of channels) send(5,idOf(motion[channel])); },
      reset() { for(const channel of channels) motion[channel].set(identity(channel)); },
    });
    if(options.enter!==undefined) motion.play(options.enter,options);
    return motion;
  }
  const timers = new Set();
  const LayoutAnimation = {
    Types:Object.fromEntries(tables.types.map(name=>[name,name])),Properties:Object.fromEntries(tables.properties.map(name=>[name,name])),Presets:tables.presets,
    create(duration,type="easeInEaseOut",property="opacity") { return {duration,create:{type,property},update:{type},delete:{type,property}}; },
    configureNext(config,onEnd) {
      call(505,[config]);
      if(typeof onEnd==="function") { const timer=setTimeout(()=>{timers.delete(timer);if(live())onEnd();},config?.duration);timers.add(timer); }
    },
  };
  for(const name of ["easeInEaseOut","linear","spring"]) LayoutAnimation[name]=onEnd=>LayoutAnimation.configureNext(tables.presets[name],onEnd);
  return {
    api:{AnimatedNode,AnimatedValue,createAnimatedValue:AnimatedValue,Animated,Easing,createMotion,motions,LayoutAnimation},
    finished(results) {
      let failure;
      for(const [id,finished,value] of results) {
        const end=pending.get(id); if(!end)continue; pending.delete(id);
        const data=composites.get(end.composite?.deref()); if(data?.running===id)data.running=0;
        try { end.callback?.({finished}); } catch(error) { failure ??= error; }
        finally { end.resolve(end.read ? value ?? 0 : { finished }); }
      }
      if(failure)throw failure;
    },
    dispose() { for(const timer of timers)clearTimeout(timer);timers.clear();for(const end of pending.values())end.resolve(end.read?0:{finished:false});pending.clear();derived.clear(); },
  };
}
