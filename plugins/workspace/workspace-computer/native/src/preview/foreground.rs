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
use maka_computer_use::preview::{ForegroundAuthority, PresentationArea};
use maka_event_log::root_store::SessionStore;

#[derive(Clone)]
struct Foreground {
    owner: Weak<Computer>,
    feed: Weak<Feed>,
    target: String,
    revision: u64,
    observation: Arc<Authority>,
    work: SessionStore,
    stop: CancellationToken,
}
impl Foreground {
    fn current(&self, cancellation: &CancellationToken) -> Result<(), ToolError> {
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(failed("Computer presentation cancelled"));
        }
        self.work.work_custody().map_err(failed)?;
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| failed("Computer owner closed"))?;
        let feed = self
            .feed
            .upgrade()
            .ok_or_else(|| failed("Computer viewer closed"))?;
        if owner.stopping.is_cancelled() || feed.stop.is_cancelled() {
            return Err(failed("Computer presentation closed"));
        }
        current_epoch(&owner, &feed.session, &feed.binding)?;
        if !feed
            .epoch
            .preview
            .snapshot()
            .targets
            .iter()
            .any(|target| target.id == self.target && target.revision == self.revision)
        {
            return Err(failed("Computer presentation target changed"));
        }
        Ok(())
    }
}
impl ForegroundAuthority for Foreground {
    fn authorize(
        &self,
        subject: PreviewSubject,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let this = self.clone();
        Box::pin(async move {
            this.current(&cancellation)?;
            this.observation
                .authorize(subject, cancellation.clone())
                .await?;
            this.current(&cancellation)
        })
    }
    fn browser_effect_scope(&self) -> Option<Arc<dyn BrowserEffectScope>> {
        Some(Arc::new(self.clone()))
    }
}
impl BrowserEffectScope for Foreground {
    fn check_session_preparation(
        &self,
        binding: BrowserPreparationBinding,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let this = self.clone();
        Box::pin(async move {
            this.current(&cancellation)?;
            this.observation
                .check_session_preparation(binding, cancellation.clone())
                .await?;
            this.current(&cancellation)
        })
    }
}

pub(super) async fn present_target(
    owner: &Arc<Computer>,
    input: api::PresentTarget,
    context: &Context,
) -> Result<HandlerValue, ToolError> {
    let original = context
        .operation()
        .ok_or_else(|| failed("Computer presentation requires a client mutation"))?;
    let dispatch = context
        .operation_scope()
        .ok_or_else(|| failed("Computer presentation requires its actual dispatch"))?;
    if !matches!(
        context.scope().identity,
        maka_capabilities::call::Identity::Remote { .. }
    ) || context.work_custody().is_some()
        || dispatch.reference() != original
        || original.method != "presentTarget"
    {
        return Err(failed(
            "Computer presentation requires its actual top-level client mutation",
        ));
    }
    let area = &input.area;
    if ![
        area.x,
        area.y,
        area.width,
        area.height,
        area.x + area.width,
        area.y + area.height,
    ]
    .into_iter()
    .all(f64::is_finite)
        || area.width <= 0.0
        || area.height <= 0.0
    {
        return Err(failed(
            "Computer presentation requires a finite positive desktop area",
        ));
    }
    let feed = viewer_feed(
        owner,
        &input.session_id,
        &input.binding_id,
        &input.feed_id,
        context,
    )?;
    if !feed
        .slots
        .lock()
        .unwrap()
        .get(&input.target_id)
        .is_some_and(
            |slot| matches!(&slot.value, Some(Ok(frame)) if frame.revision == input.revision),
        )
    {
        return Err(failed(
            "Computer presentation requires a current frame in this viewer",
        ));
    }
    let epoch = feed.epoch.clone();
    let viewer = Arc::downgrade(&feed);
    drop(feed);
    let observation = epoch_authority(&epoch, &context.scope().cancellation)
        .ok_or_else(|| failed("Computer presentation has no live execution"))?;
    let basis = observation.access.current().await?.permission_basis();
    let operation = owner.store.operation(original).map_err(failed)?;
    let store = owner
        .store
        .session(&input.session_id)
        .await
        .map_err(failed)?;
    let scope = store.work_scope(Some(basis)).await.map_err(failed)?;
    let (lease, effects) = scope.accept(context.scope().cancellation.child_token());
    let work = lease.store();
    let operation = operation
        .acquire_work(dispatch, lease)
        .await
        .map_err(failed)?;
    let result = async {
        let custody = work.work_custody().map_err(failed)?;
        let effect = work
            .fork_effect()
            .map_err(failed)?
            .for_parent(Some(custody.as_ref()))
            .map_err(failed)?;
        let stop = effect.cancellation();
        let result = async {
            let authority = Arc::new(Foreground {
                owner: Arc::downgrade(owner),
                feed: viewer,
                target: input.target_id.clone(),
                revision: input.revision,
                observation,
                work: work.clone(),
                stop: stop.clone(),
            });
            authority.current(&stop)?;
            epoch
                .preview
                .present(
                    &input.target_id,
                    input.revision,
                    authority,
                    PresentationArea {
                        x: area.x,
                        y: area.y,
                        width: area.width,
                        height: area.height,
                    },
                    stop,
                )
                .await
        }
        .await;
        effect.finish(match &result {
            Err(
                ToolError::CleanupUnconfirmed(message)
                | ToolError::OperationCleanupUnconfirmed { message, .. },
            ) => Err(message.clone()),
            _ => Ok(()),
        });
        result
    }
    .await;
    let cleanup = match effects.seal() {
        Ok(_) => effects.settle().await,
        Err(error) => Err(error),
    };
    if let Err(cleanup) = cleanup {
        return match result {
            Err(
                error @ (ToolError::CleanupUnconfirmed(_)
                | ToolError::OperationCleanupUnconfirmed { .. }),
            ) => Err(error),
            _ => Err(ToolError::CleanupUnconfirmed(cleanup.to_string())),
        };
    }
    operation.finish_after_cleanup();
    Ok(serde_json::to_value(result?).map_err(failed)?.into())
}
