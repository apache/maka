#!/bin/sh
set -eu

STATE_DIR=/opt/maka-egress-state
CERT_DIR=/opt/maka-egress

mkdir -p "$STATE_DIR" "$CERT_DIR"
: > "$STATE_DIR/hits.jsonl"

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

exec mitmdump \
  --quiet \
  --listen-host 0.0.0.0 \
  --listen-port 8080 \
  --set block_global=false \
  --set confdir="$STATE_DIR" \
  --scripts /opt/maka-eval/egress_filter.py
