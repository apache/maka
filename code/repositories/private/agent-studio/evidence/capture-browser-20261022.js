import { s as publishedRequest } from 'https://ai-copilot.cos.clife.cn/web-agent-paas/assets/js/request-BQG682hr.js';
import { F as publishedService } from 'https://ai-copilot.cos.clife.cn/web-agent-paas/assets/js/index.Dbe0HCQM.js';

(() => {
  const endpoint = 'http://127.0.0.1:4174';
  const asset = 'https://ai-copilot.cos.clife.cn/web-agent-paas/assets/js/';
  const sensitive = key => {
    const name = String(key).replace(/[-_\s]/g, '');
    if (/^(?:(?:max|min|default|input|output|total|used|remaining|completion|prompt)?tokens?(?:num|count|size|limit|budget|usage|length)?|tokeniz(?:er|ation))$/i.test(name)) return /^tokens?$/i.test(name);
    return /password|passwd|^pwd$|secret|credential|authorization|cookie|apikey|accesskey|privatekey|signingkey|sessionkey|(?:^|access|refresh|id|homing|session|auth|api|bearer|security)token$/i.test(name);
  };
  const cleanText = text => text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@').replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\b(?:sk-|sk_)[a-zA-Z0-9_-]{15,}/g, '[REDACTED]').replace(/([?&](?:[^=&]*(?:token|secret|credential|api[-_]?key|access[-_]?key|password|authorization|signature)|q-ak)=)[^&#\s"']+/gi, '$1[REDACTED]');
  function sanitize(value, depth = 0) {
    if (depth > 80) throw new Error('Sanitization depth exceeded');
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^[\[{]/.test(trimmed)) {
        try { return JSON.stringify(sanitize(JSON.parse(value), depth + 1)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      return cleanText(value);
    }
    if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const header = [value.key, value.name, value.header, value.headerName].some(name => typeof name === 'string' && sensitive(name));
    return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive(key) && !(header && /^(?:value|headervalue)$/i.test(key))).map(([key, item]) => [key, sanitize(item, depth + 1)]));
  }
  const fixture = sanitize({ token:'x', maxToken:2048, data:'{"apiKey":"x","maxToken":9,"headers":[{"key":"Authorization","value":"private"}]}' });
  if ('token' in fixture || fixture.maxToken !== 2048 || JSON.parse(fixture.data).headers[0].value !== undefined) throw new Error('Sanitizer self check failed');
  const state = window.__reaCapture ??= { status:'ready', requests:0, localWrites:0, errors:[], agents:[], versions:[], knowledge:null, busy:false, lastRequest:0, contracts:{} };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ok = response => !!response && response.success !== false && (response.success === true || response.code === 0 || response.errCode === 0);
  const listOf = response => Array.isArray(response.data) ? response.data : response.data?.records ?? response.data?.data ?? [];
  async function save(name, value) {
    const r = await fetch(endpoint + '/capture/' + name, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(sanitize(value))});
    if (!r.ok) throw new Error('Local save failed: ' + name + ' ' + r.status);
    state.localWrites++;
  }
  async function query(method, url, data) {
    await sleep(Math.max(0, 350 - (Date.now() - state.lastRequest)));
    state.lastRequest = Date.now(); state.requests++;
    (state.requestLog ??= []).push({method,url,data:sanitize(data),at:new Date().toISOString()});
    const response = sanitize(url.startsWith('/decision/') ? await publishedRequest({method, url, data}) : await publishedService(method, url, data, {hideMsg:true}));
    if (!ok(response)) { state.lastFailedResponse = response; throw new Error('Business query failed: ' + url + ' code=' + response?.code + ' errCode=' + response?.errCode); }
    return response;
  }
  async function guard(fn) {
    if (state.busy) throw new Error('Capture already running');
    state.busy = true;
    try { await fn(); } catch (error) { state.errors.push({phase:state.status,message:String(error.message)}); state.status='failed'; await save('capture-state.json', summary()); }
    finally { state.busy=false; }
  }
  function summary() { return {status:state.status, requests:state.requests,localWrites:state.localWrites,agentCount:state.agents.length,versionCount:state.versions.length,knowledgeCount:state.knowledge?.data?.length,errors:state.errors}; }
  state.summary = summary;
  state.sanitize = sanitize;
  state.query = query;
  state.save = save;
  state.ok = ok;
  state.listOf = listOf;
  state.guard = guard;
  state.startAgents = () => guard(async () => {
    state.status='agent-contracts';
    const index = await (await fetch(asset + 'index.Dbe0HCQM.js')).text();
    const names = [...new Set(index.match(/intelligentEngine-[a-zA-Z0-9_-]+\.js/g) ?? [])];
    if (names.length !== 1) throw new Error('Current version facade not uniquely found');
    const facade = await (await fetch(asset + names[0])).text();
    if (!facade.includes('e(`post`,`/agent-microapp/microAppVersion/findById`,t)')) throw new Error('Version contract changed');
    state.contracts.version = {source:asset + names[0],method:'post',url:'/agent-microapp/microAppVersion/findById',dataKeys:['id'],requestFacade:'index.F'};
    await save('contracts.json', state.contracts);
    state.status='agents';
    let total = state.agents.length || undefined;
    for (let pageNum = 1; !total || state.agents.length < total; pageNum++) {
      const response = await query('post','/decision/agent-microapp/microApp/findMicroAppPage',{pageNum,pageSize:100});
      if (!Array.isArray(response.data?.records)) throw new Error('Agent page shape changed');
      total ??= response.data.total;
      if (total !== response.data.total) throw new Error('Agent total changed during capture');
      state.agents.push(...response.data.records);
      await save('agents-page-' + pageNum + '.json',{pageNum,response});
      if (state.agents.length >= total) break;
      if (!response.data.records.length) throw new Error('Unexpected empty Agent page');
    }
    if (state.agents.length !== total || new Set(state.agents.map(x=>String(x.microAppId))).size !== total) throw new Error('Agent count or uniqueness mismatch');
    await save('agent-samples.json',{status:'complete',capturedAt:new Date().toISOString(),records:state.agents,total,captured:state.agents.length,errors:[]});
    state.status='versions';
    const ids = [...new Set(state.agents.map(x=>String(x.microAppVersionId)))];
    for (const id of ids) {
      if (state.versions.some(item => item.id === id)) continue;
      const response = await query('post',state.contracts.version.url,{id});
      if (!response.data || typeof response.data !== 'object' || String(response.data.microAppVersionId) !== id) throw new Error('Version detail invalid ' + id);
      state.versions.push({id,response});
      await save('version-' + id + '.json',{id,response});
    }
    await save('versions-20261022.json',{status:'complete',capturedAt:new Date().toISOString(),total:ids.length,captured:state.versions.length,errors:[],items:state.versions});
    state.status='agents-complete';
    await save('capture-state.json',summary());
  });
  state.startKnowledgeLists = () => guard(async () => {
    state.status='knowledge-lists';
    state.knowledge ??= await query('post','/decision/agent-kg/database/list',{baseType:null,name:''});
    if (!Array.isArray(state.knowledge.data)) throw new Error('Knowledge list shape changed');
    const safeId = id => typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
    if (!state.knowledge.data.every(x => safeId(x.baseId))) throw new Error('Unsafe numeric knowledge base ID: raw string response required');
    await save('knowledge-list.json',{status:'complete',total:state.knowledge.data.length,response:state.knowledge});
    state.baseLists ??= [];
    for (const base of state.knowledge.data) {
      const baseId = String(base.baseId);
      if (state.baseLists.some(x => x.baseId === baseId)) continue;
      const response = await query('post','/decision/agent-kg/doc/list',{baseId});
      if (!Array.isArray(response.data)) throw new Error('Document list shape changed ' + baseId);
      if (!response.data.every(x => safeId(x.docId) && (!x.baseId || safeId(x.baseId)))) throw new Error('Unsafe numeric document ID: raw string response required ' + baseId);
      const unit = {baseId,response};
      state.baseLists.push(unit);
      await save('base-' + baseId + '-list.json',unit);
    }
    const documentCount = state.baseLists.reduce((n,x)=>n+x.response.data.length,0);
    await save('knowledge-document-lists.json',{status:'complete',capturedAt:new Date().toISOString(),bases:state.baseLists,totalBases:state.knowledge.data.length,documentCount,errors:[]});
    state.status='knowledge-lists-complete';
    await save('capture-state.json',summary());
  });
  state.restoreCheckpoint = async () => {
    const load = async name => { const r = await fetch(endpoint + '/capture/' + name); if (!r.ok) throw new Error('Missing checkpoint ' + name); return r.json(); };
    const resume = await load('resume-checkpoint.json');
    const {agents,versions,knowledge,lists,interruption} = resume;
    state.agents = agents.records; state.versions = versions.items; state.knowledge = knowledge.response; state.baseLists = lists.bases;
    state.requests = interruption.requests; state.errors = interruption.errors; state.knowledgeUnits = [];
    state.knowledgeUnits = resume.units;
    state.docCheckpoints = Object.fromEntries(resume.documents.map(doc => [String(doc.docId),doc]));
    state.status='checkpoint-restored';
    return summary();
  };
  state.testSegmentPage = async docId => {
    const response = await query('post','/decision/agent-kg/segment/list',{docId,position:-1,size:1000});
    if (!Array.isArray(response.data)) throw new Error('Segment response shape changed');
    state.segmentTest = {docId,response};
    await save('segment-size1000-test.json',{docId,requestedSize:1000,position:-1,response});
    return {docId,returned:response.data.length,firstOrder:response.data[0]?.segmentOrder,lastOrder:response.data[response.data.length-1]?.segmentOrder};
  };
  state.startKnowledgeDetails = () => guard(async () => {
    if (!state.baseLists || state.baseLists.length !== state.knowledge.data.length) throw new Error('Complete knowledge lists required');
    state.status='knowledge-details';
    state.knowledgeUnits ??= [];
    for (const base of state.knowledge.data) {
      const baseId = String(base.baseId);
      if (state.knowledgeUnits.some(x => x.baseId === baseId && x.status === 'complete')) continue;
      const list = state.baseLists.find(x => x.baseId === baseId);
      const unit = {baseId,status:'partial',baseType:base.baseType,list,documents:[],segments:[],tables:[],qa:[],labels:[],errors:[]};
      const safe = async (kind, id, fn) => { try { return await fn(); } catch (error) { unit.errors.push({kind,id,message:String(error.message)}); return undefined; } };
      unit.info = await safe('baseDetails',baseId,()=>query('post','/decision/agent-kg/database/baseDetails',{baseId}));
      const labels = await safe('labels',baseId,()=>query('post','/agent-kg/database/selectLabels',{baseId}));
      if (labels) unit.labels.push({baseId,response:labels});
      if (Number(base.baseType) === 2) {
        const response = await safe('qa',baseId,()=>query('post','/agent-kg/qa/list',{baseId}));
        if (response) { if (!Array.isArray(response.data)) unit.errors.push({kind:'qa',id:baseId,message:'QA list shape changed'}); else unit.qa.push({baseId,response}); }
      }
      for (const row of list.response.data) {
        if (state.pauseRequested) { await save('base-' + baseId + '-partial.json',unit); state.status='knowledge-paused'; return; }
        const docId = String(row.docId);
        const checkpoint = state.docCheckpoints?.[docId];
        const info = checkpoint?.info ?? await safe('info',docId,()=>query('post','/agent-kg/doc/getInfo',{docId}));
        const config = checkpoint?.config ?? await safe('config',docId,()=>query('post','/agent-kg/doc/getConfig',{docId}));
        if (info && config) unit.documents.push({baseId,docId,info,config});
        if (Number(base.baseType) === 1) {
          const response = checkpoint?.table?.response ?? await safe('table',docId,()=>query('post','/agent-kg/doc/docTablePreview',{docId}));
          if (response) unit.tables.push({docId,response});
        } else if (Number(base.baseType) !== 2) {
          const response = checkpoint?.segments?.response ?? await safe('segments',docId,async()=>{
            const pageSize = 1000;
            let position=-1, combined=[], envelope;
            for (;;) {
              if (state.pauseRequested) { await save('segments-' + docId + '-partial.json',{docId,position,response:{...envelope,data:combined}}); throw new Error('Paused at request boundary'); }
              const part = state.segmentTest?.docId === docId && position === -1 ? state.segmentTest.response : await query('post','/decision/agent-kg/segment/list',{docId,position,size:pageSize});
              if (!Array.isArray(part.data)) throw new Error('Segment list shape changed');
              envelope ??= part;
              combined.push(...part.data);
              if (part.data.length < pageSize) break;
              const next = part.data[part.data.length-1].segmentOrder + 1;
              if (!Number.isFinite(next) || next <= position) throw new Error('Segment cursor failed to advance');
              position = next;
            }
            return {...envelope,data:combined};
          });
          if (response) unit.segments.push({docId,response});
        }
        await save('doc-' + docId + '.json',{baseId,docId,info,config,segments:unit.segments.find(x=>x.docId===docId),table:unit.tables.find(x=>x.docId===docId)});
      }
      if (!unit.errors.length && unit.documents.length === list.response.data.length) unit.status='complete';
      state.knowledgeUnits = state.knowledgeUnits.filter(x=>x.baseId!==baseId);
      state.knowledgeUnits.push(unit);
      await save('base-' + baseId + '-unit.json',unit);
      await save('knowledge-coverage.json',{status:state.knowledgeUnits.length===state.knowledge.data.length&&state.knowledgeUnits.every(x=>x.status==='complete')?'complete':'partial',totalBases:state.knowledge.data.length,capturedBases:state.knowledgeUnits.length,completeBases:state.knowledgeUnits.filter(x=>x.status==='complete').length,documentCount:state.baseLists.reduce((n,x)=>n+x.response.data.length,0),capturedDocuments:state.knowledgeUnits.reduce((n,x)=>n+x.documents.length,0),units:state.knowledgeUnits.map(x=>({baseId:x.baseId,status:x.status,documents:x.documents.length,expected:x.list.response.data.length,errors:x.errors}))});
    }
    const errors = state.knowledgeUnits.flatMap(x=>x.errors.map(error=>({baseId:x.baseId,...error})));
    const metadataErrors = errors.filter(x=>['baseDetails','info','config','list'].includes(x.kind));
    const contentErrors = errors.filter(x=>!['baseDetails','info','config','list'].includes(x.kind));
    await save('knowledge-documents.json',{status:metadataErrors.length?'partial':'complete',bases:state.baseLists,documents:state.knowledgeUnits.flatMap(x=>x.documents),baseDetails:state.knowledgeUnits.map(x=>({baseId:x.baseId,response:x.info})),errors:metadataErrors});
    await save('knowledge-content.json',{status:contentErrors.length?'partial':'complete',segments:state.knowledgeUnits.flatMap(x=>x.segments),tables:state.knowledgeUnits.flatMap(x=>x.tables),qa:state.knowledgeUnits.flatMap(x=>x.qa),labels:state.knowledgeUnits.flatMap(x=>x.labels),errors:contentErrors});
    state.status='knowledge-details-' + (errors.length?'partial':'complete');
    await save('capture-state.json',summary());
  });
  state.startSupport = () => guard(async () => {
    state.status='support-lists';
    state.supportItems ??= [];
    const plans = [
      {key:'mcp',method:'get',url:'/agent-mcp/mcpManage/api/listPage',data:{mcpServerName:'',pageNum:1,pageSize:100}},
      {key:'prompts',method:'post',url:'/agent-microapp/promptTemplate/findListByCondition',data:{}},
      {key:'promptLabels',method:'post',url:'/agent-microapp/promptLabel/findListByCondition',data:{}},
      {key:'teams',method:'get',url:'/decision/agent-microapp/pluginCollection/getPageList',data:{collectionName:'',pageNum:1,pageSize:100}},
      {key:'roles',method:'post',url:'/decision/agent-microapp/plugin/getAllList',data:{pageNum:1,pageSize:100,searchKey:''}},
      {key:'skills',method:'post',url:'/decision/agent-microapp/skill/getPage',data:{pageNum:1,pageSize:100}},
      {key:'plugins',method:'post',url:'/agent-microapp/component/page',data:{compName:'',pageNum:1,pageSize:100,releaseChannel:0}},
      {key:'legacyComponents',method:'get',url:'/agent-microapp/dict/compList',data:{}},
      {key:'legacySystemComponents',method:'get',url:'/agent-microapp/dict/sysComp',data:{}},
      {key:'userKnowledge',method:'post',url:'/agent-kg/database/getUserDataBase',data:{}},
      {key:'knowledgeLabels',method:'post',url:'/agent-kg/database/selectPaasDataBaseLabels',data:{}},
      {key:'defaultModels',method:'get',url:'/agent-microapp/dict/compList',data:{type:'default_bigModel'}},
      {key:'zeroCodePlugins',method:'get',url:'/agent-microapp/dict/list',data:{type:'zeroCodePlugin'}},
      {key:'canvasComponents',method:'get',url:'/agent-microapp/component/canvasCompList',data:{}},
      {key:'models',method:'get',url:'/paas-llm/v1/models/available/list',data:{}}
    ];
    state.supportErrors ??= [];
    for (const plan of plans) {
      if (state.supportItems.some(x=>x.key===plan.key)) continue;
      try {
        let response = await query(plan.method,plan.url,plan.data);
        const paged = !Array.isArray(response.data) && (Array.isArray(response.data?.records) || Array.isArray(response.data?.data));
        if (paged) {
          const property = Array.isArray(response.data.records) ? 'records' : 'data';
          const rows = [...response.data[property]];
          const total = response.data.total ?? response.data.totalSize;
          if (typeof total !== 'number') throw new Error('Paged support total missing ' + plan.key);
          for (let pageNum=2; rows.length < total; pageNum++) {
            const next = await query(plan.method,plan.url,{...plan.data,pageNum});
            if (!Array.isArray(next.data?.[property]) || !next.data[property].length) throw new Error('Unexpected empty support page ' + plan.key);
            rows.push(...next.data[property]);
          }
          if (rows.length !== total) throw new Error('Support list count mismatch ' + plan.key);
          response = {...response,data:{...response.data,[property]:rows}};
        }
        const item = {...plan,response};
        state.supportItems.push(item);
        await save('support-' + plan.key + '.json',item);
      } catch(error) { state.supportErrors.push({key:plan.key,message:String(error.message)}); }
    }
    state.supportItems.push({key:'knowledge',method:'post',url:'/agent-kg/database/list',data:{baseType:null,name:''},response:state.knowledge});
    const errors = state.supportErrors;
    await save('sidebar-data.json',{status:errors.some(x=>['mcp','prompts','promptLabels'].includes(x.key))?'partial':'complete',items:state.supportItems.filter(x=>['mcp','prompts','promptLabels','knowledge'].includes(x.key)),errors:errors.filter(x=>['mcp','prompts','promptLabels'].includes(x.key))});
    await save('component-data.json',{status:errors.some(x=>['teams','roles','skills','plugins'].includes(x.key))?'partial':'complete',items:state.supportItems.filter(x=>['teams','roles','skills','plugins','legacyComponents','legacySystemComponents','userKnowledge','knowledgeLabels'].includes(x.key)),errors});
    await save('support-lists.json',{status:errors.length?'partial':'complete',items:state.supportItems,errors});
    state.status='support-details';
    state.supportDetails ??= {plugins:[],roles:[],skills:[],teams:[],mcp:[],prompts:[],errors:[]};
    const detailPlans = [
      {key:'plugins',id:'compId',method:'get',url:'/agent-microapp/component/get',data:id=>({id})},
      {key:'roles',id:'pluginIdStr',method:'post',url:'/decision/agent-microapp/plugin/getDetails',data:id=>({pluginId:id})},
      {key:'skills',id:'skillId',method:'get',url:'/decision/agent-microapp/skill/findById',data:id=>({skillId:id})},
      {key:'teams',id:'collectionId',method:'get',url:'/decision/agent-microapp/pluginCollection/getDetails',data:id=>({collectionId:id})},
      {key:'mcp',id:'id',method:'get',url:id=>'/agent-mcp/mcpManage/api/getById/'+id,data:()=>({})},
      {key:'prompts',id:'promptId',method:'post',url:'/agent-microapp/promptTemplate/findById',data:id=>({promptId:id})}
    ];
    for (const plan of detailPlans) {
      const rows = listOf(state.supportItems.find(x=>x.key===plan.key)?.response ?? {});
      for (const row of rows) {
        const id = row[plan.id] ?? (plan.key === 'roles' ? row.pluginId : undefined);
        if (typeof id !== 'string' && !Number.isSafeInteger(id)) { state.supportDetails.errors.push({key:plan.key,idField:plan.id,message:'Missing or unsafe detail ID'});continue; }
        if (state.supportDetails[plan.key].some(x=>String(x[plan.id])===String(id))) continue;
        try {
          const response = await query(plan.method,typeof plan.url==='function'?plan.url(id):plan.url,plan.data(id));
          state.supportDetails[plan.key].push({[plan.id]:id,...plan.key==='roles'?{pluginId:id}:{},response});
        } catch(error) { state.supportDetails.errors.push({key:plan.key,id:String(id),message:String(error.message)}); }
        await save('detail-' + plan.key + '.json',state.supportDetails[plan.key]);
      }
    }
    await save('component-details.json',{status:state.supportDetails.errors.length?'partial':'complete',...state.supportDetails});
    state.status='support-complete';
    await save('capture-state.json',summary());
  });
  state.discover = async () => {
    const text = await (await fetch(asset + 'index.Dbe0HCQM.js')).text();
    const names = [...new Set(text.match(/(?:knowledge|doc\.api|qa-daatabase|skill-manage|intelligentEngine|page-config|mcp-details|mcp-service|prompt-word-library|component|table)[a-zA-Z0-9_.-]*\.js/g) ?? [])];
    return {names};
  };
})();
