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

//! 250ms hedged multi-path dialer racing direct `A -> B` and approved
//! mesh transit `A -> C -> B`.

use crate::roster::{
    DialStrategy, DirectDialCandidate, PeerRouteResolution, TransitDialCandidate,
};
use maka_peer::PeerId;
use std::{future::Future, time::Duration};
use thiserror::Error;

pub const DEFAULT_HEDGE_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Error)]
pub enum DialError {
    #[error("no usable direct or mesh transit routes available for `{0}`")]
    NoRoutes(PeerId),
    #[error("all dial paths failed for `{peer_id}`: direct={direct_error:?}, transit={transit_error:?}")]
    AllPathsFailed {
        peer_id: PeerId,
        direct_error: Option<String>,
        transit_error: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WinningPath {
    Direct {
        endpoint: String,
    },
    MeshTransit {
        relay_peer_id: PeerId,
        relay_endpoint: String,
    },
}

#[derive(Debug)]
pub struct DialWinner<S> {
    pub stream: S,
    pub path: WinningPath,
}

async fn try_direct_candidates<S, F, Fut>(
    candidates: &[DirectDialCandidate],
    mut dial_direct: F,
) -> Result<DialWinner<S>, String>
where
    F: FnMut(DirectDialCandidate) -> Fut,
    Fut: Future<Output = Result<S, String>>,
{
    let mut last_error = String::from("no direct candidates");
    for candidate in candidates {
        let endpoint = candidate.endpoint.clone();
        match dial_direct(candidate.clone()).await {
            Ok(stream) => {
                return Ok(DialWinner {
                    stream,
                    path: WinningPath::Direct { endpoint },
                });
            }
            Err(err) => last_error = err,
        }
    }
    Err(last_error)
}

async fn try_transit_candidates<S, F, Fut>(
    candidates: &[TransitDialCandidate],
    mut dial_transit: F,
) -> Result<DialWinner<S>, String>
where
    F: FnMut(TransitDialCandidate, String) -> Fut,
    Fut: Future<Output = Result<S, String>>,
{
    let mut last_error = String::from("no transit candidates");
    for candidate in candidates {
        for relay_endpoint in &candidate.relay_endpoints {
            match dial_transit(candidate.clone(), relay_endpoint.clone()).await {
                Ok(stream) => {
                    return Ok(DialWinner {
                        stream,
                        path: WinningPath::MeshTransit {
                            relay_peer_id: candidate.relay_peer_id.clone(),
                            relay_endpoint: relay_endpoint.clone(),
                        },
                    });
                }
                Err(err) => last_error = err,
            }
        }
    }
    Err(last_error)
}

async fn race_primary_then_secondary<S, P, Sec>(
    primary: P,
    secondary: Sec,
    hedge_delay: Duration,
) -> Result<DialWinner<S>, (Option<String>, Option<String>)>
where
    P: Future<Output = Result<DialWinner<S>, String>>,
    Sec: Future<Output = Result<DialWinner<S>, String>>,
{
    let mut primary = std::pin::pin!(primary);
    let mut secondary = std::pin::pin!(secondary);

    // Phase 1: give `primary` a `hedge_delay` head start (default 250ms).
    let primary_err = tokio::select! {
        biased;
        res = &mut primary => match res {
            Ok(winner) => return Ok(winner),
            Err(err) => Some(err),
        },
        () = tokio::time::sleep(hedge_delay) => None,
    };

    // If primary already failed before hedge_delay, fall back to secondary immediately.
    if let Some(p_err) = primary_err {
        return match secondary.await {
            Ok(winner) => Ok(winner),
            Err(s_err) => Err((Some(p_err), Some(s_err))),
        };
    }

    // Phase 2: race primary and secondary concurrently; drop the slower loser.
    tokio::select! {
        res = &mut primary => match res {
            Ok(winner) => Ok(winner),
            Err(p_err) => match secondary.await {
                Ok(winner) => Ok(winner),
                Err(s_err) => Err((Some(p_err), Some(s_err))),
            },
        },
        res = &mut secondary => match res {
            Ok(winner) => Ok(winner),
            Err(s_err) => match primary.await {
                Ok(winner) => Ok(winner),
                Err(p_err) => Err((Some(p_err), Some(s_err))),
            },
        },
    }
}

/// Dials the target peer following `resolution.strategy`, hedging between direct
/// `A -> B` and approved mesh transit `A -> C -> B` without leaking losing dials.
pub async fn hedged_dial<S, FD, FutD, FT, FutT>(
    resolution: &PeerRouteResolution,
    dial_direct: FD,
    dial_transit: FT,
) -> Result<DialWinner<S>, DialError>
where
    FD: FnMut(DirectDialCandidate) -> FutD,
    FutD: Future<Output = Result<S, String>>,
    FT: FnMut(TransitDialCandidate, String) -> FutT,
    FutT: Future<Output = Result<S, String>>,
{
    match resolution.strategy {
        DialStrategy::Unavailable => Err(DialError::NoRoutes(resolution.target_peer_id.clone())),
        DialStrategy::DirectOnly => {
            try_direct_candidates(&resolution.direct_candidates, dial_direct)
                .await
                .map_err(|err| DialError::AllPathsFailed {
                    peer_id: resolution.target_peer_id.clone(),
                    direct_error: Some(err),
                    transit_error: None,
                })
        }
        DialStrategy::TransitOnly => {
            try_transit_candidates(&resolution.transit_candidates, dial_transit)
                .await
                .map_err(|err| DialError::AllPathsFailed {
                    peer_id: resolution.target_peer_id.clone(),
                    direct_error: None,
                    transit_error: Some(err),
                })
        }
        DialStrategy::HedgedDirectThenTransit { hedge_delay } => {
            let direct = try_direct_candidates(&resolution.direct_candidates, dial_direct);
            let transit = try_transit_candidates(&resolution.transit_candidates, dial_transit);
            race_primary_then_secondary(direct, transit, hedge_delay)
                .await
                .map_err(|(direct_error, transit_error)| DialError::AllPathsFailed {
                    peer_id: resolution.target_peer_id.clone(),
                    direct_error,
                    transit_error,
                })
        }
        DialStrategy::PreferTransitWithDirectFallback { hedge_delay } => {
            let transit = try_transit_candidates(&resolution.transit_candidates, dial_transit);
            let direct = try_direct_candidates(&resolution.direct_candidates, dial_direct);
            race_primary_then_secondary(transit, direct, hedge_delay)
                .await
                .map_err(|(transit_error, direct_error)| DialError::AllPathsFailed {
                    peer_id: resolution.target_peer_id.clone(),
                    direct_error,
                    transit_error,
                })
        }
    }
}
