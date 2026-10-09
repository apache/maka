#!/bin/sh
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# Stands in for packages/runtime-host/dist/execution-candidate-main.js in the
# launcher tests (crates/host-client/src/launcher/tests.rs), run as
# `/bin/sh fake-candidate.sh <candidate arguments>`.
#
# It accepts exactly the arguments of parseInteractiveRuntimeHostCandidateArguments
# (packages/runtime-host/src/candidate-cli.ts), appends one line per launch to
# $FAKE_CANDIDATE_LOG, then plays the mode for this launch: the Nth word of
# $FAKE_CANDIDATE_MODES, or its last word.
#
#   register  write registration.json for $FAKE_CANDIDATE_ENDPOINT, stay up
#             for $FAKE_CANDIDATE_LIFETIME seconds, then remove it and exit 0
#   lose      exit 2, as a candidate that lost the owner lock does
#   fail65    write a startup diagnostic, exit 65 (stored_data_incompatible)
#   fail70    write a startup diagnostic, exit 70 (internal_startup_failure,
#             which the launcher retries)
#   crash70   print to stderr, exit 70 (internal_startup_failure)
#   hang      never register; exit 0 after $FAKE_CANDIDATE_LIFETIME seconds
set -u

all_args="$*"
root=
root_id=
attempt=
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "missing value for $1" >&2; exit 64; }
  case "$1" in
    --root) root=$2 ;;
    --expected-root-id) root_id=$2 ;;
    --startup-attempt-id) attempt=$2 ;;
    --initial-connection-timeout-ms | --idle-grace-ms | --handshake-timeout-ms | --generation) ;;
    *) echo "unknown argument $1" >&2; exit 64 ;;
  esac
  shift 2
done
[ -n "$root" ] && [ -n "$root_id" ] && [ -n "$attempt" ] || { echo "incomplete arguments" >&2; exit 64; }

echo "pid=$$ pipe=${MAKA_RUNTIME_HOST_STDERR_PIPE:-} cwd=$(pwd) args=$all_args" >> "$FAKE_CANDIDATE_LOG"
launch=$(wc -l < "$FAKE_CANDIDATE_LOG" | tr -d ' ')
mode=
index=0
for word in $FAKE_CANDIDATE_MODES; do
  index=$((index + 1))
  mode=$word
  [ "$index" -eq "$launch" ] && break
done

control="$FAKE_CANDIDATE_CONTROL_DIR/$root_id"
lifetime=${FAKE_CANDIDATE_LIFETIME:-3}

# write_diagnostic <reason>: the file writeCandidateStartupDiagnostic writes.
write_diagnostic() {
  mkdir -p "$control"
  cat > "$control/startup-diagnostic.$attempt.json" <<JSON
{"schemaVersion":1,"rootId":"$root_id","startupAttemptId":"$attempt","candidatePid":$$,"capturedAt":"2026-09-25T00:00:00.000Z","reason":"$1","errorChain":[{"name":"StoredSessionMessageError","code":"stored_session_message_incompatible","message":"session s1 has an unreadable message"}],"logs":[]}
JSON
}
case "$mode" in
  register)
    mkdir -p "$control"
    cat > "$control/registration.json.$$" <<JSON
{"kind":"maka-runtime-host","schemaVersion":1,"rootId":"$root_id","hostEpoch":"fake-epoch-$launch","endpoint":"$FAKE_CANDIDATE_ENDPOINT","protocolMin":0,"protocolMax":0,"compatibilityEpoch":$FAKE_CANDIDATE_EPOCH,"compositionId":"maka.interactive","compositionRevision":"3","lifecycleMode":"ephemeral","state":"ready","pid":$$,"createdAt":"2026-09-25T00:00:00.000Z"}
JSON
    mv "$control/registration.json.$$" "$control/registration.json"
    sleep "$lifetime"
    rm -f "$control/registration.json"
    exit 0
    ;;
  lose)
    exit 2
    ;;
  fail65)
    write_diagnostic stored_data_incompatible
    echo "[runtime-host] startup failed: StoredSessionMessageError" >&2
    exit 65
    ;;
  fail70)
    write_diagnostic internal_startup_failure
    echo "[runtime-host] startup failed: fake internal failure" >&2
    exit 70
    ;;
  crash70)
    echo "[runtime-host] startup failed: fake internal failure" >&2
    exit 70
    ;;
  hang)
    sleep "$lifetime"
    exit 0
    ;;
  *)
    echo "unknown mode $mode" >&2
    exit 64
    ;;
esac
