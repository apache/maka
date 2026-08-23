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

set -eu

STATE_DIR=/opt/maka-egress-state
CERT_DIR=/opt/maka-egress

mkdir -p "$STATE_DIR" "$CERT_DIR"
# Create the audit log if this is the first start. Truncating here would erase
# hits already written if the proxy restarts mid-trial, and the trial would
# look like an honest zero-hit run.
touch "$STATE_DIR/hits.jsonl"

# confdir holds the CA private key and this cell's audit log, so it stays
# container-private and only the certificate reaches the volume the subject
# mounts. Creating the CA here instead of letting mitmdump create it on startup
# publishes the certificate before the proxy port opens, so the health gate
# cannot release `main` against a missing or left-over certificate.
python -c 'import sys
from mitmproxy.certs import CertStore
CertStore.from_store(sys.argv[1], "mitmproxy", 2048)' "$STATE_DIR"
# Publish by rename so a restart cannot expose a truncated certificate to a
# subject that is already running against the previous one.
cp "$STATE_DIR/mitmproxy-ca-cert.pem" "$CERT_DIR/.mitmproxy-ca-cert.pem"
mv "$CERT_DIR/.mitmproxy-ca-cert.pem" "$CERT_DIR/mitmproxy-ca-cert.pem"

# The subject only needs this address so HTTPS_PROXY can keep using the
# service hostname after the namespace policy refuses Docker DNS.
ip="$(getent ahostsv4 "$(hostname)" | awk 'NR == 1 { print $1 }')"
case "$ip" in
  "" | 127.*)
    echo "could not publish Eval egress proxy IPv4" >&2
    exit 1
    ;;
esac
printf '%s\n' "$ip" > "$CERT_DIR/.proxy-ipv4"
mv "$CERT_DIR/.proxy-ipv4" "$CERT_DIR/proxy-ipv4"

exec mitmdump \
  --quiet \
  --listen-host 0.0.0.0 \
  --listen-port 8080 \
  --set block_global=false \
  --set confdir="$STATE_DIR" \
  --scripts /opt/maka-eval/egress_filter.py
