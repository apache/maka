#!/bin/sh
set -eu

mkdir -p /opt/maka-egress
: > /opt/maka-egress/hits.jsonl

exec mitmdump \
  --quiet \
  --listen-host 0.0.0.0 \
  --listen-port 8080 \
  --set block_global=false \
  --set confdir=/opt/maka-egress \
  --scripts /opt/maka-eval/egress_filter.py
