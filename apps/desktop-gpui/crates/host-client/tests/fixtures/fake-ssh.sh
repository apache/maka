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

# Stands in for OpenSSH's `ssh` in the SSH transport tests
# (crates/host-client/src/remote_tests.rs). Each test copies it into its own
# scratch directory as `ssh`, next to the files that script the run:
#
#   config             printed for `ssh -G` (default: three harmless lines)
#   mode               what a tunnel does (default `forward`):
#                        forward        wait for the test to create `go`, log
#                                       that the forward listens, stay up
#                        hostkey, auth  log OpenSSH's message for an unknown
#                                       host key or refused keys, exit 255
#                        conflict-once  the first tunnel logs that its local
#                                       port is taken and exits 255; later
#                                       ones forward
#   activation         printed on stdout by an operator activation (`-T`)
#   activation-stderr  printed on stderr by an operator activation
#   activation-exit    the activation's exit code (default 0)
#
# Every launch appends its arguments to `launches`, one line each, and a
# tunnel writes its pid to `pid` before it waits.
set -u
dir=$(dirname "$0")
printf '%s\n' "$*" >> "$dir/launches"

if [ "$1" = "-G" ]; then
  if [ -f "$dir/config" ]; then cat "$dir/config"; else printf 'user me\nhostname box\nport 22\n'; fi
  exit 0
fi

if [ "$1" = "-T" ]; then
  [ -f "$dir/activation-stderr" ] && cat "$dir/activation-stderr" >&2
  [ -f "$dir/activation" ] && cat "$dir/activation"
  exit "$(cat "$dir/activation-exit" 2>/dev/null || echo 0)"
fi

# A tunnel: -v -E <log> ... -L 127.0.0.1:<local>:127.0.0.1:<remote> ... <destination>
log=
forward=
while [ $# -gt 0 ]; do
  case "$1" in
    -E) log=$2; shift ;;
    -L) forward=$2; shift ;;
  esac
  shift
done
local_port=$(printf '%s' "$forward" | cut -d: -f2)
tunnels=$(grep -c -- ' -L ' "$dir/launches")
mode=$(cat "$dir/mode" 2>/dev/null || echo forward)
case "$mode" in
  hostkey)
    printf 'No ED25519 host key is known for box and you have requested strict checking.\r\nHost key verification failed.\r\n' >> "$log"
    exit 255 ;;
  auth)
    printf 'me@box: Permission denied (publickey).\r\n' >> "$log"
    exit 255 ;;
  conflict-once)
    if [ "$tunnels" -le 1 ]; then
      printf 'bind [127.0.0.1]:%s: Address already in use\r\n' "$local_port" >> "$log"
      exit 255
    fi ;;
esac
echo $$ > "$dir/pid"
while [ ! -f "$dir/go" ]; do sleep 0.05; done
printf 'debug1: Local forwarding listening on 127.0.0.1 port %s.\r\n' "$local_port" >> "$log"
exec sleep 60
