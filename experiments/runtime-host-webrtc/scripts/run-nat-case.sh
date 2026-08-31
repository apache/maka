#!/usr/bin/env bash
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

set -euo pipefail

mode=${1:?usage: run-nat-case.sh <dcutr|webrtc> <full-cone|udp-cone|endpoint-dependent|symmetric|udp-blocked>}
nat_kind=${2:?usage: run-nat-case.sh <dcutr|webrtc> <full-cone|udp-cone|endpoint-dependent|symmetric|udp-blocked>}
case "$mode" in dcutr|webrtc) ;; *) echo "invalid mode: $mode" >&2; exit 2 ;; esac
case "$nat_kind" in full-cone|udp-cone|endpoint-dependent|symmetric|udp-blocked) ;; *) echo "invalid NAT kind: $nat_kind" >&2; exit 2 ;; esac

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
binary=${MAKA_WEBRTC_HARNESS_BINARY:-$root/target/debug/webrtc-harness}
image=${MAKA_WEBRTC_HARNESS_IMAGE:-maka-webrtc-phase-zero:local}
nat_layers=${MAKA_WEBRTC_NAT_LAYERS:-1}
case "$nat_layers" in 1|2) ;; *) echo "NAT layers must be 1 or 2" >&2; exit 2 ;; esac
relay_transport=${MAKA_WEBRTC_RELAY_TRANSPORT:-tcp}
case "$relay_transport" in tcp|quic) ;; *) echo "relay transport must be tcp or quic" >&2; exit 2 ;; esac
stun_url=${MAKA_WEBRTC_STUN_URL:-stun:10.244.201.11:3478}
outer_nat_kind=${MAKA_WEBRTC_OUTER_NAT_KIND:-$nat_kind}
case "$outer_nat_kind" in full-cone|udp-cone|endpoint-dependent|symmetric|udp-blocked) ;;
    *) echo "invalid outer NAT kind: $outer_nat_kind" >&2; exit 2 ;;
esac
link_profile=${MAKA_WEBRTC_LINK_PROFILE:-clean}
case "$link_profile" in
    clean) endpoint_link_setup=: ;;
    delay) endpoint_link_setup='tc qdisc replace dev eth0 root netem delay 60ms 15ms' ;;
    loss) endpoint_link_setup='tc qdisc replace dev eth0 root netem loss 1%' ;;
    wan) endpoint_link_setup='tc qdisc replace dev eth0 root netem delay 60ms 15ms loss 1%' ;;
    *) echo "invalid link profile: $link_profile (expected clean, delay, loss, or wan)" >&2; exit 2 ;;
esac
prefix="maka-wrtc-l$nat_layers-$mode-$nat_kind-$$"

public_network="$prefix-public"
private_a_network="$prefix-private-a"
private_b_network="$prefix-private-b"
carrier_a_network="$prefix-carrier-a"
carrier_b_network="$prefix-carrier-b"
relay="$prefix-relay"
stun="$prefix-stun"
router_a="$prefix-router-a"
router_b="$prefix-router-b"
outer_a="$prefix-outer-a"
outer_b="$prefix-outer-b"
answer="$prefix-answer"
dial="$prefix-dial"

cleanup() {
    if [[ ${MAKA_KEEP_WEBRTC_TOPOLOGY:-0} == 1 ]]; then
        printf 'preserved topology: %s\n' "$prefix" >&2
        return
    fi
    docker rm --force "$dial" "$answer" "$router_a" "$router_b" "$outer_a" "$outer_b" \
        "$stun" "$relay" >/dev/null 2>&1 || true
    docker network rm "$private_a_network" "$private_b_network" "$carrier_a_network" \
        "$carrier_b_network" "$public_network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

test -x "$binary" || { echo "missing harness binary: $binary" >&2; exit 2; }
docker image inspect "$image" >/dev/null 2>&1 \
    || docker build --tag "$image" --file "$root/docker/Dockerfile" "$root"

docker network create --internal --subnet 10.244.201.0/24 "$public_network" >/dev/null
docker network create --internal --subnet 10.244.202.0/24 "$private_a_network" >/dev/null
docker network create --internal --subnet 10.244.203.0/24 "$private_b_network" >/dev/null
if [[ "$nat_layers" == 2 ]]; then
    docker network create --internal --subnet 10.244.204.0/24 "$carrier_a_network" >/dev/null
    docker network create --internal --subnet 10.244.205.0/24 "$carrier_b_network" >/dev/null
fi

if [[ "$relay_transport" == tcp ]]; then
    relay_listen=/ip4/10.244.201.10/tcp/44001
else
    relay_listen=/ip4/10.244.201.10/udp/44001/quic-v1
fi
docker run --detach --name "$relay" --network "$public_network" --ip 10.244.201.10 \
    --volume "$binary:/harness:ro" "$image" \
    /harness relay "$relay_listen" >/dev/null
docker run --detach --name "$stun" --network "$public_network" --ip 10.244.201.11 \
    "$image" turnserver --no-auth --stun-only --no-cli --no-tls --no-dtls \
    --listening-ip 10.244.201.11 --listening-port 3478 --log-file stdout --simple-log >/dev/null
sleep 0.2
docker inspect --format '{{.State.Running}}' "$stun" | grep -q true \
    || { docker logs "$stun" >&2; exit 1; }

start_router() {
    docker run --detach --name "$1" --network "$2" --ip "$3" \
        --cap-add NET_ADMIN --sysctl net.ipv4.ip_forward=1 \
        --volume /usr/sbin/conntrack:/usr/sbin/conntrack:ro "$image" sleep infinity >/dev/null
}

start_router "$router_a" "$private_a_network" 10.244.202.2
start_router "$router_b" "$private_b_network" 10.244.203.2
if [[ "$nat_layers" == 1 ]]; then
    docker network connect --ip 10.244.201.21 "$public_network" "$router_a"
    docker network connect --ip 10.244.201.22 "$public_network" "$router_b"
else
    start_router "$outer_a" "$carrier_a_network" 10.244.204.2
    start_router "$outer_b" "$carrier_b_network" 10.244.205.2
    docker network connect --ip 10.244.204.21 "$carrier_a_network" "$router_a"
    docker network connect --ip 10.244.205.22 "$carrier_b_network" "$router_b"
    docker network connect --ip 10.244.201.21 "$public_network" "$outer_a"
    docker network connect --ip 10.244.201.22 "$public_network" "$outer_b"
fi

configure_router() {
    local router_name=$1
    local private_probe=$2
    local public_address=$3
    local public_gateway=$4
    local public_probe=$5
    local unreachable_private_subnets=$6
    local router_nat_kind=$7
    docker exec --env NAT_KIND="$router_nat_kind" --env PRIVATE_PROBE="$private_probe" \
        --env PUBLIC_ADDRESS="$public_address" \
        --env PUBLIC_GATEWAY="$public_gateway" --env PUBLIC_PROBE="$public_probe" \
        --env UNREACHABLE_PRIVATE_SUBNETS="$unreachable_private_subnets" \
        "$router_name" bash -ceu '
        public_if=$(ip route get "$PUBLIC_PROBE" | sed -n "s/.* dev \([^ ]*\).*/\1/p")
        private_if=$(ip route get "$PRIVATE_PROBE" | sed -n "s/.* dev \([^ ]*\).*/\1/p")
        ip route replace default via "$PUBLIC_GATEWAY" dev "$public_if"
        iptables -P FORWARD DROP
        for subnet in $UNREACHABLE_PRIVATE_SUBNETS; do
            iptables -A FORWARD -i "$private_if" -o "$public_if" -d "$subnet" -j REJECT
        done
        iptables -A FORWARD -i "$private_if" -o "$public_if" -j ACCEPT
        iptables -A FORWARD -i "$public_if" -o "$private_if" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
        if [[ "$NAT_KIND" == udp-blocked ]]; then
            iptables -I FORWARD 1 -i "$private_if" -o "$public_if" -p udp -j REJECT
        fi
        if [[ "$NAT_KIND" == full-cone ]]; then
            iptables -t nat -A PREROUTING -i "$public_if" -d "$PUBLIC_ADDRESS" \
                -j NETMAP --to "$PRIVATE_PROBE/32"
            iptables -t nat -A POSTROUTING -o "$public_if" -s "$PRIVATE_PROBE" \
                -j NETMAP --to "$PUBLIC_ADDRESS/32"
        elif [[ "$NAT_KIND" == udp-cone ]]; then
            iptables -t nat -A PREROUTING -i "$public_if" -d "$PUBLIC_ADDRESS" -p udp \
                -j NETMAP --to "$PRIVATE_PROBE/32"
            iptables -t nat -A POSTROUTING -o "$public_if" -s "$PRIVATE_PROBE" -p udp \
                -j NETMAP --to "$PUBLIC_ADDRESS/32"
            iptables -t nat -A POSTROUTING -o "$public_if" -j MASQUERADE
        elif [[ "$NAT_KIND" == symmetric ]]; then
            iptables -t nat -A POSTROUTING -o "$public_if" -j MASQUERADE --random-fully
        else
            iptables -t nat -A POSTROUTING -o "$public_if" -j MASQUERADE
        fi
    '
}
if [[ "$nat_layers" == 1 ]]; then
    configure_router "$router_a" 10.244.202.3 10.244.201.21 10.244.201.1 \
        10.244.201.10 '10.244.203.0/24' "$nat_kind"
    configure_router "$router_b" 10.244.203.3 10.244.201.22 10.244.201.1 \
        10.244.201.10 '10.244.202.0/24' "$nat_kind"
else
    configure_router "$router_a" 10.244.202.3 10.244.204.21 10.244.204.2 \
        10.244.204.2 '10.244.203.0/24 10.244.205.0/24' "$nat_kind"
    configure_router "$router_b" 10.244.203.3 10.244.205.22 10.244.205.2 \
        10.244.205.2 '10.244.202.0/24 10.244.204.0/24' "$nat_kind"
    configure_router "$outer_a" 10.244.204.21 10.244.201.21 10.244.201.1 \
        10.244.201.10 '10.244.202.0/24 10.244.203.0/24 10.244.205.0/24' "$outer_nat_kind"
    configure_router "$outer_b" 10.244.205.22 10.244.201.22 10.244.201.1 \
        10.244.201.10 '10.244.202.0/24 10.244.203.0/24 10.244.204.0/24' "$outer_nat_kind"
fi
printf '{"case":"%s/%s","linkProfile":"%s","natLayers":%s,"outerNat":"%s","relayTransport":"%s","topology":"%s"}\n' \
    "$mode" "$nat_kind" "$link_profile" "$nat_layers" "$outer_nat_kind" "$relay_transport" "$prefix"

for _ in $(seq 1 50); do
    relay_peer=$(docker logs "$relay" 2>&1 | sed -n 's/.*"peerId":"\([^"]*\)".*/\1/p' | tail -1)
    [[ -n "$relay_peer" ]] && break
    sleep 0.1
done
[[ -n ${relay_peer:-} ]] || { docker logs "$relay" >&2; exit 1; }
relay_address="$relay_listen/p2p/$relay_peer"

docker run --detach --name "$answer" --network "$private_b_network" --ip 10.244.203.3 \
    --cap-add NET_ADMIN --env MAKA_WEBRTC_DIAGNOSTICS=1 \
    --volume "$binary:/harness:ro" "$image" bash -ceu \
    "ip route replace default via 10.244.203.2; $endpoint_link_setup; exec /harness answer $mode '$relay_address' '$stun_url'" >/dev/null

for _ in $(seq 1 300); do
    answer_peer=$(docker logs "$answer" 2>&1 | sed -n 's/.*"peerId":"\([^"]*\)".*/\1/p' | tail -1)
    [[ -n "$answer_peer" ]] && break
    docker inspect --format '{{.State.Running}}' "$answer" 2>/dev/null | grep -q true || break
    sleep 0.1
done
[[ -n ${answer_peer:-} ]] || { docker logs "$answer" >&2; exit 1; }

docker run --detach --name "$dial" --network "$private_a_network" --ip 10.244.202.3 \
    --cap-add NET_ADMIN --env MAKA_WEBRTC_DIAGNOSTICS=1 \
    --volume "$binary:/harness:ro" "$image" bash -ceu \
    "ip route replace default via 10.244.202.2; $endpoint_link_setup; exec /harness dial $mode '$relay_address' '$answer_peer' '$stun_url'" >/dev/null

if [[ ${MAKA_WEBRTC_CAPTURE_CONNTRACK:-0} == 1 ]]; then
    sleep 1
    routers=("$router_a" "$router_b")
    [[ "$nat_layers" == 1 ]] || routers+=("$outer_a" "$outer_b")
    for router_name in "${routers[@]}"; do
        printf '%s conntrack\n' "$router_name"
        docker exec "$router_name" conntrack -L -p udp 2>/dev/null || true
    done
fi

dial_status=$(docker wait "$dial")
dial_output=$(docker logs "$dial" 2>&1)

printf '%s\n' "$dial_output"
docker logs "$answer" 2>&1 || true
printf '{"case":"%s/%s","exitCode":%d}\n' "$mode" "$nat_kind" "$dial_status"
exit "$dial_status"
