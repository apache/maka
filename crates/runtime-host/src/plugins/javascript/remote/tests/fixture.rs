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

use super::*;
use maka_js_runtime::plugin::{Bridge, Error as VmError, Module};
use maka_plugins::remote;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub(super) const SOURCE: &str = r#"
let activations = 0, opened = 0, waiting = 0, closed = 0;
const authorities = [];
export default async function activate(ctx) {
  activations++;
  await ctx.remote.stream('idle', (_, caller) => {
    opened++;
    authorities.push(caller.remoteAuthority);
    let stopped = false, wake;
    return {
      async next() {
        if (stopped) return { done: true };
        waiting++;
        await new Promise(resolve => { wake = resolve; });
        waiting--;
        return { done: true };
      },
      cancel() { stopped = true; wake?.(); },
      close() { closed++; },
    };
  });
  await ctx.remote.method('stats', () => ({ activations, opened, waiting, closed, authorities }));
}
"#;
pub(super) const BLOCKER: &str = r#"
const pending = [];
export async function wait(key) {
  const result = new Promise(resolve => pending.push(resolve));
  await Deno.core.ops.op_maka_plugin(key, 'started', null);
  return await result;
}
export function cancel() { for (const resolve of pending.splice(0)) resolve('released'); }
export function streamNext() { throw new Error('arbitrary stream export must not run'); }
export function streamClose() { throw new Error('arbitrary stream export must not run'); }
"#;

pub(super) struct Started(pub Semaphore);
impl Bridge for Started {
    fn call(&self, method: String, _: Value) -> BoxFuture<'static, Result<Value, VmError>> {
        assert_eq!(method, "started");
        self.0.add_permits(1);
        Box::pin(async { Ok(Value::Null) })
    }
}
struct Views;
impl remote::Views for Views {
    fn authorize(
        &self,
        _: maka_plugins::authorization::Request,
    ) -> BoxFuture<'_, Result<maka_plugins::call::Owned, Error>> {
        Box::pin(async { Err(Error::Retired) })
    }
    fn session(&self) -> BoxFuture<'_, Result<remote::SessionView, Error>> {
        Box::pin(async { Err(Error::Retired) })
    }
    fn workspace(
        &self,
        _: remote::WorkspaceViewInput,
    ) -> BoxFuture<'_, Result<remote::SessionView, Error>> {
        Box::pin(async { Err(Error::Retired) })
    }
    fn query_database(
        &self,
        _: maka_plugins::filesystem::database::Read,
    ) -> BoxFuture<
        '_,
        Result<
            Vec<maka_plugins::filesystem::database::Table>,
            maka_plugins::filesystem::database::Error,
        >,
    > {
        panic!("fixture has no database authority")
    }
}
pub(super) fn caller() -> Caller {
    Caller {
        connection_id: uuid::Uuid::new_v4(),
        client_instance_id: "idle-stream-test".into(),
        document_id: uuid::Uuid::new_v4(),
        session_id: None,
        access: remote::Access::Granted,
        views: Arc::new(Views),
        resources: Arc::default(),
        cancellation: CancellationToken::new(),
    }
}

pub(super) fn remote(
    module: &Module,
    registrations: &Value,
    calls: &Arc<super::super::super::invocation::Calls>,
    name: &str,
) -> Remote {
    Remote(Arc::new(Callback {
        module: module.clone(),
        id: registrations
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap()["callback"]
            .as_u64()
            .unwrap() as u32,
        calls: calls.clone(),
    }))
}

pub(super) const RETENTION: &str = r#"
let activations = 0, store;
const text = '界'.repeat(3 * 1024 * 1024);
const block = revision => ({
  key: { turn: 'turn', message: 'large', part: 'text' },
  revision: String(revision), kind: 'assistant', content: { text },
});
export default async function activate(ctx) {
  activations++;
  store = await ctx.tui.transcriptResource('pressure', {
    blocks: [block(1)], timings: [{ turn: 'turn', start_ms: 1 }],
  });
  await ctx.remote.method('control', async input => {
    if (input.kind === 'replace') {
      store.replace(block(input.revision));
      store.timing({ turn: 'turn', start_ms: input.revision });
    }
    if (input.kind === 'close') await store.close();
    return { activations, textBytes: 9 * 1024 * 1024, ...store.stats };
  });
}
"#;
