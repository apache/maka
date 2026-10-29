/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationInput, LogScope, RuntimeEvent},
    execution::{CodeLanguage, ToolMode},
    language::Language,
    model::{
        ModelEvent, ModelFinishReason, ModelToolCall,
        assembly::{AttemptBinding, AttemptWriter},
    },
    tool_call::ToolOrigin,
    tools::{ToolExecutor, ToolFuture},
};
use maka_code_runtime::CellLimits;
use maka_event_log::EventLog;
use maka_tools::{
    CodeExecutor, RunTools, ToolCatalog, ToolDefinition, ToolHandler, ToolNesting,
    ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct Echo;
impl ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo-tool".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        Box::pin(async move { Ok(input) })
    }
}

#[tokio::test]
async fn selected_python_runs_through_exec_grammar_catalog_and_durable_journal() {
    tokio::time::timeout(std::time::Duration::from_secs(15),async {
        let directory=tempfile::tempdir().unwrap();
        let log=Arc::new(EventLog::open(&directory.path().join("events.sqlite")).await.unwrap());
        let invocation=Invocation {session_id:"python-session".into(),turn_id:"turn".into(),run_id:"run".into(),invocation_id:"invocation".into()};
        log.create_session(&invocation.session_id,"create",&json!({}),1).await.unwrap();
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(),Fact::InvocationOpened {
            configuration:None,input:InvocationInput::Message {source_messages:vec![],content:"test".into(),request_fingerprint:None}
        })).unwrap()).await.unwrap();
        let catalog=ToolCatalog::new([ToolRegistration {
            definition:ToolDefinition {freeform:None,output_schema:None,provider:None,name:"echo-tool".into(),description:"Echo an integer".into(),input_schema:json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"],"additionalProperties":false})},
            handler:ToolHandler::Immediate(Arc::new(Echo)),nesting:ToolNesting::Nestable,semantics:ToolSemantics::Parallel,
        }]).unwrap();
        let executor=CodeExecutor::new(CellLimits::default()).unwrap().with_python_worker(env!("CARGO_BIN_EXE_maka-python-worker").into()).unwrap();
        let loaded=maka_tools::availability::LoadedTools::new(maka_session_state::Backend::temporary().unwrap().session("python-session"));
        for (step,language,source,expected) in [
            ("python",CodeLanguage::Python,"# @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}\nresult=await tools.echo_tool(n=7)\nstore('receipt',result)\ntext(result)",json!([{"kind":"text","text":"{\"n\":7}"}])),
            ("javascript",CodeLanguage::JavaScript,"text(load('receipt'));",json!([{"kind":"text","text":"{\"n\":7}"}])),
        ] {
            let run=RunTools::new(Language::En,log.clone(),invocation.clone(),catalog.clone(),ToolMode::CodeMode,executor.clone().with_language(language),loaded.clone());
            let request=run.capture(".",CancellationToken::new()).await.unwrap();
            let definitions=request.definitions();let definition=definitions.iter().find(|tool|tool.name=="exec").unwrap();
            if language==CodeLanguage::Python {
                assert!(definition.description.contains("Input JSON Schema"));
                assert!(definition.description.contains("await tools.echo_tool(input)"));
                let grammar=serde_json::to_value(&definition.freeform).unwrap().to_string();
                assert!(grammar.contains("# @exec:"));
                assert!(!definition.description.contains("declare const tools"));
            }
            let call=ModelToolCall {id:step.into(),name:"exec".into(),input:json!(source).into(),provider_options:None,provider_executed:false};
            let mut writer=AttemptWriter::new(AttemptBinding {
                invocation:invocation.clone(),step_id:step.into(),purpose:maka_agent_facts::context::ModelPurpose::Main,
            },false).unwrap();
            writer.push(ModelEvent::ToolCall(call.clone()),std::time::SystemTime::now()).unwrap();
            writer.push(ModelEvent::Finished {
                reason:ModelFinishReason::ToolCalls,usage:Default::default(),provider_options:None,
            },std::time::SystemTime::now()).unwrap();
            let facts=[
                Fact::ModelRequested {context_breakdown:None,item_acceptance:false,step_id:step.into(),model_id:"fixture".into(),source_scope:LogScope::Root,source_high_water:0,source_digest:String::new(),effective_source_digest:None,input_digest:String::new(),route_identity:String::new(),checkpoint_event_id:None,purpose:maka_agent_facts::context::ModelPurpose::Main,context:None},
                Fact::ModelCompleted {step_id:step.into(),output:writer.completed().unwrap().completion()},
            ];
            log.append_batch(&facts.map(|fact|EventWrite::plain(RuntimeEvent::new(invocation.clone(),fact)).unwrap())).await.unwrap();
            let result=request.into_step(step).invoke(&call,None,CancellationToken::new()).await.unwrap();
            assert_eq!(result["state"],"completed","{result}");
            assert_eq!(result["result"]["ok"],true,"{result}");
            assert_eq!(result["content"],expected);
            run.shutdown().await.unwrap();
        }
        let prefix=log.prefix(100,1024*1024).await.unwrap();
        assert_eq!(prefix.events.iter().filter(|event|matches!(&event.event.fact,Fact::ToolDispatched {name,call,..} if name=="echo-tool" && matches!(call.origin,ToolOrigin::CodeMode {..}))).count(),1);
        assert!(log.invocation_recovery(&invocation).await.unwrap().uncertain_operations.is_empty());
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    }).await.unwrap();
}
