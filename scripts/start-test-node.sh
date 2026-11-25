#!/usr/bin/env bash
#
# Starts a self-contained testing node (validator, sequencer, ntx-builder, and tx prover) from
# the standalone node executables, installed with `cargo install` at the node source pinned in
# Cargo.lock.
#
# Modes:
#   (no args)        start the node and stream its logs; Ctrl+C stops it
#   --background     return once the node's RPC is ready, leaving it running (used by CI)
#   --install-only   install the node binaries and exit (used by the CI build job)
#   --print-rev      print the cache key naming the node binaries this script installs, and exit
#   --help           print usage and exit
#
# Env vars:
#   MIDEN_VERIFICATION_BASE_FEE  genesis `verification_base_fee` (default 500; 0 disables fees)
#   MIDEN_NUM_FUNDER_WALLETS     number of funder wallets a fee-charging genesis declares
#   MIDEN_BATCH_BUILDER_WALLET   account that receives the batch builder's fees
#   MIDEN_ACCOUNT_ALLOWLIST      1 enforces the account allowlist, binds the administration
#                                API the tests create invitation codes through, and starts the
#                                funding service that pays each account which registers.
#                                0 (default) allows unrestricted account creation
#   MIDEN_GEN_GENESIS_BIN        path to a prebuilt gen-genesis binary (skips `cargo build`)
#   MIDEN_TEST_NODE_PREBUILT     1 skips Cargo.lock binary-version matching when prebuilt CI
#                                artifacts were unpacked into target/test-node/install

set -euo pipefail

usage() {
    cat <<EOF
Usage: $(basename "$0") [--background | --install-only | --print-rev | --help]

Starts a self-contained Miden testing node using binaries pinned in Cargo.lock.

Options:
  (no args)        Start the node in the foreground and stream logs
  --background     Return once RPC (and optional allowlist services) are ready
  --install-only   Install the standalone node binaries into target/test-node/install and exit
  --print-rev      Print the cache key for the pinned node binaries and exit
  --help, -h       Show this help message and exit
EOF
}

MODE="foreground"
case "${1:-}" in
    --background)   MODE="background" ;;
    --install-only) MODE="install-only" ;;
    --print-rev)    MODE="print-rev" ;;
    --help|-h)      usage; exit 0 ;;
    "")             ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/target/test-node"
BIN="$CACHE/install/bin"
BUILD="$CACHE/build"
GEN_GENESIS="${MIDEN_GEN_GENESIS_BIN:-${CARGO_TARGET_DIR:-$ROOT/target}/release/gen-genesis}"
DATA="$CACHE/data"
LOG_DIR="$DATA/logs"
PID_FILE="$CACHE/pids"

RPC="127.0.0.1:57291"   # matches the client default (`MIDEN_NODE_PORT`)
VALIDATOR="127.0.0.1:50101"
NTX="127.0.0.1:50301"
# Private administration API of the sequencer, bound only when allowlist enforcement is on.
ADMIN="127.0.0.1:50100"
PROVER_PORT=50051
PROVER="127.0.0.1:$PROVER_PORT"
# HTTP API of the funding service, started only when allowlist enforcement is on.
FUNDING="127.0.0.1:50401"
# Native asset base units the sequencer asks the funding service to pay each registered account.
FUNDING_AMOUNT=10000000
# How long a single network transaction proof may take. Shared so prover and ntx-builder stay aligned.
PROVER_TIMEOUT=300s
# Shared secret authorizing the ntx-builder to submit network transactions.
NETWORK_TX_AUTH="${MIDEN_NETWORK_TX_AUTH:-miden-client-testing-ntx-secret}"
# Genesis `verification_base_fee`. Every transaction pays out of its own account's vault.
VERIFICATION_BASE_FEE="${MIDEN_VERIFICATION_BASE_FEE:-500}"
# Account that receives the batch builder's fees in a P2ID note.
BATCH_BUILDER_WALLET="${MIDEN_BATCH_BUILDER_WALLET:-0xcc0000000000dd010000ee000000ff}"
# Account allowlist enforcement. Off by default unless explicitly opted in.
ACCOUNT_ALLOWLIST="${MIDEN_ACCOUNT_ALLOWLIST:-0}"
TEST_NODE_PREBUILT="${MIDEN_TEST_NODE_PREBUILT:-0}"

NODE_BINS=(
    miden-validator
    miden-node
    miden-ntx-builder
    miden-remote-prover
    miden-funding-service
    miden-note-transport
)

# Resolve the node source from Cargo.lock. By default, install the crates.io version that
# Cargo.lock locks for `miden-node-proto-build`. A git pin of the node in Cargo.lock takes
# precedence.
SRC_LINE="$(awk '/^name = "miden-node-proto-build"$/ { package = 1; next } package && /^source = / { print; exit } package && /^\[\[package\]\]/ { exit }' "$ROOT/Cargo.lock")"
case "$SRC_LINE" in
    'source = "git+'*) ;;
    *) SRC_LINE="" ;;
esac
if [ -n "$SRC_LINE" ]; then
    NODE_SOURCE="git"
    SRC="${SRC_LINE#*\"git+}"; SRC="${SRC%\"}"
    NODE_REV="${SRC##*#}"
    NODE_URL="${SRC%%#*}"; NODE_URL="${NODE_URL%%\?*}"
    NODE_DESC="$NODE_URL @ $NODE_REV"
else
    NODE_SOURCE="registry"
    NODE_VERSION="$(awk -F'"' '/^name = "miden-node-proto-build"$/ { package = 1; next } package && /^version = / { print $2; exit } package && /^\[\[package\]\]/ { exit }' "$ROOT/Cargo.lock")"
    [ -n "$NODE_VERSION" ] || {
        echo "error: no 0xMiden/node git source and no miden-node-proto-build version in Cargo.lock" >&2
        exit 1
    }
    NODE_REV="v$NODE_VERSION"
    NODE_DESC="crates.io @ $NODE_VERSION"
fi

# CI keys its cache of the installed binaries on this, covering the binary list and node source.
NODE_CACHE_KEY="$NODE_REV-bins.$(printf '%s\n' "${NODE_BINS[@]}" | cksum | cut -d' ' -f1)"

if [ "$MODE" = "print-rev" ]; then
    echo "$NODE_CACHE_KEY"
    exit 0
fi

node_binaries_installed() {
    local metadata="$CACHE/install/.crates.toml"
    for bin in "${NODE_BINS[@]}"; do
        [ -x "$BIN/$bin" ] || return 1
    done
    if [ "$TEST_NODE_PREBUILT" = "1" ]; then
        return 0
    fi
    [ -f "$metadata" ] || return 1

    # `.crates.toml` records each install as `"<bin> <version> (<source>)"`.
    for bin in "${NODE_BINS[@]}"; do
        if [ "$NODE_SOURCE" = "git" ]; then
            grep -F "\"$bin " "$metadata" | grep -Fq "#$NODE_REV)" || return 1
        else
            grep -Fq "\"$bin $NODE_VERSION (registry+" "$metadata" || return 1
        fi
    done
}

if node_binaries_installed; then
    echo "==> using cached node binaries ($NODE_DESC)"
else
    echo "==> installing node binaries ($NODE_DESC)"
    INSTALL_SPECS=("${NODE_BINS[@]}")
    if [ "$NODE_SOURCE" = "git" ]; then
        INSTALL_FLAGS=(--git "$NODE_URL" --rev "$NODE_REV")
    else
        INSTALL_FLAGS=()
        INSTALL_SPECS=()
        for bin in "${NODE_BINS[@]}"; do INSTALL_SPECS+=("$bin@$NODE_VERSION"); done
    fi
    # Override the profile to drop debug info and strip symbols to reduce artifact size.
    CARGO_PROFILE_RELEASE_DEBUG=false \
    CARGO_PROFILE_RELEASE_STRIP=symbols \
        cargo install --locked --root "$CACHE/install" --target-dir "$BUILD" \
        ${INSTALL_FLAGS[@]+"${INSTALL_FLAGS[@]}"} \
        "${INSTALL_SPECS[@]}"
fi

if [ "$MODE" = "install-only" ]; then
    echo "==> install-only: node binaries ready in $BIN"
    exit 0
fi

if (exec 3<>"/dev/tcp/${RPC%:*}/${RPC##*:}") 2>/dev/null; then
    exec 3>&- 3<&-
    echo "error: something is already listening on $RPC; run stop-test-node.sh first" >&2
    exit 1
fi

# Allowlist tests deploy each registered account with the note the funding service paid it. A
# fee-free genesis declares no wallet for the service to pay from, so the two cannot be combined.
if [ "$ACCOUNT_ALLOWLIST" = "1" ] && [ "$VERIFICATION_BASE_FEE" = "0" ]; then
    echo "error: MIDEN_ACCOUNT_ALLOWLIST=1 needs a fee-charging chain for the funding service." \
        "Unset MIDEN_VERIFICATION_BASE_FEE or set it above 0" >&2
    exit 1
fi

if [ -n "${MIDEN_GEN_GENESIS_BIN:-}" ] && [ -x "$GEN_GENESIS" ]; then
    echo "==> using prebuilt gen-genesis ($GEN_GENESIS)"
else
    echo "==> building gen-genesis"
    cargo build --release -p test-node-genesis --bin gen-genesis --locked
fi

echo "==> generating genesis + bootstrapping (verification_base_fee = $VERIFICATION_BASE_FEE)"
rm -rf "$DATA"
mkdir -p "$LOG_DIR" "$DATA/validator" "$DATA/node" "$DATA/ntx-builder" "$DATA/funding-service"
MIDEN_VERIFICATION_BASE_FEE="$VERIFICATION_BASE_FEE" "$GEN_GENESIS" "$DATA/genesis-config"
cp "$DATA/genesis-config/tst_faucet.mac" "$DATA/account.mac"
for mac in bridge_admin.mac ger_manager.mac bridge.mac agglayer_faucet.mac \
           native_faucet.mac faucet_operator.mac; do
    cp "$DATA/genesis-config/$mac" "$DATA/$mac"
done

# Hardcoded insecure test-only keys matching the validator golden storage-key bundle.
SIGNING_KEY="9cbcf0fc18b2a4afeff56ef43ad96af92e804fae64615c9802cff2a182e9cae2"
VALIDATOR_PUBLIC_KEY="020c06515b355a62133ae98e53e4b5d3e6ee9ff60ce20a436780e4e308a3ff3e9"
ENCRYPTION_KEY="9964dbb2590adeb415d3291b64a0a9991fbcac5adacb05ee17efee5296d081d7"

{
    "$BIN/miden-validator" genesis --genesis-block-directory "$DATA/genesis" \
        --accounts-directory "$DATA/accounts" \
        --accounts-config "$DATA/genesis-config/accounts.toml" \
        --native-faucet "$DATA/genesis-config/native_faucet.mac" \
        --funding-account "$DATA/genesis-config/funding_account.mac" \
        --verification-base-fee "$VERIFICATION_BASE_FEE" \
        --timestamp "$(date +%s)" \
        --validator.key "$VALIDATOR_PUBLIC_KEY"
    "$BIN/miden-validator" bootstrap --data-directory "$DATA/validator" \
        --genesis "$DATA/genesis/genesis.dat"
    "$BIN/miden-node" bootstrap --data-directory "$DATA/node" --genesis "$DATA/genesis/genesis.dat"
    "$BIN/miden-ntx-builder" bootstrap --data-directory "$DATA/ntx-builder" \
        --genesis "$DATA/genesis/genesis.dat"
} >"$LOG_DIR/bootstrap.log" 2>&1
if [ "$ACCOUNT_ALLOWLIST" = "1" ]; then
    FUNDING_ACCOUNT_ID="$(sed -n 's/^Funding account id: //p' "$LOG_DIR/bootstrap.log")"
    "$BIN/miden-funding-service" bootstrap --data-directory "$DATA/funding-service" \
        --account-id "$FUNDING_ACCOUNT_ID" --genesis "$DATA/genesis/genesis.dat" \
        >>"$LOG_DIR/bootstrap.log" 2>&1
fi
NATIVE_FAUCET_ID="$(sed -n 's/^Native faucet account id: //p' "$LOG_DIR/bootstrap.log")"
echo "==> native faucet $NATIVE_FAUCET_ID, operator wallet in $DATA/faucet_operator.mac"

# Expose the wallets generated from genesis `[[wallet]]` entries under target/test-node/data/funders.
if compgen -G "$DATA/accounts/wallet_*.mac" >/dev/null; then
    mkdir -p "$DATA/funders"
    cp "$DATA"/accounts/wallet_*.mac "$DATA/funders/"
    echo "==> exposed $(ls "$DATA/funders" | wc -l | tr -d ' ') funder wallets in $DATA/funders"
fi

echo "==> starting components"
: > "$PID_FILE"
start() {
    local name="$1"; shift
    RUST_LOG="${RUST_LOG:-info}" nohup perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV' "$@" \
        >"$LOG_DIR/$name.log" 2>&1 &
    echo "$!" >> "$PID_FILE"
}
cleanup() {
    trap - INT TERM
    if [ -n "${TAIL_PID:-}" ]; then kill "$TAIL_PID" 2>/dev/null || true; fi
    "$ROOT/scripts/stop-test-node.sh"
}
trap 'echo; cleanup; exit 0' INT TERM

STORAGE_KEY_FILE="$ROOT/scripts/testdata/insecure-golden-storage-key/storage-key.bundle"
start validator   "$BIN/miden-validator" start --listen "$VALIDATOR" --data-directory "$DATA/validator" \
    --signing-key.hex "$SIGNING_KEY" \
    --encryption-key.hex "$ENCRYPTION_KEY" \
    --storage-key.file "$STORAGE_KEY_FILE"

echo "==> waiting for validator on $VALIDATOR"
VALIDATOR_READY=""
for _ in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/${VALIDATOR%:*}/${VALIDATOR##*:}") 2>/dev/null; then
        exec 3>&- 3<&-
        VALIDATOR_READY=1
        break
    fi
    sleep 1
done
if [ -z "$VALIDATOR_READY" ]; then
    echo "error: validator did not become ready within 30s; see $LOG_DIR" >&2
    exit 1
fi

echo "==> creating and deploying the fee collector account"
if ! {
    "$BIN/miden-node" fee-collector create --data-directory "$DATA/node" &&
    "$BIN/miden-node" fee-collector deploy --data-directory "$DATA/node" \
        --validator.url "http://$VALIDATOR"
} >"$LOG_DIR/fee-collector.log" 2>&1; then
    echo "error: fee collector deployment failed; see $LOG_DIR/fee-collector.log" >&2
    tail -n 20 "$LOG_DIR/fee-collector.log" >&2
    exit 1
fi

if [ "$ACCOUNT_ALLOWLIST" = "1" ]; then
    SEQUENCER_ALLOWLIST_ARGS=(
        --admin.listen "$ADMIN"
        --funding-service.url "http://$FUNDING"
        --funding-service.amount "$FUNDING_AMOUNT"
    )
else
    SEQUENCER_ALLOWLIST_ARGS=(--disable-account-allowlist)
fi

start sequencer   "$BIN/miden-node" sequencer --rpc.listen "$RPC" --data-directory "$DATA/node" \
    --validator.url "http://$VALIDATOR" --ntx-builder.url "http://$NTX" \
    --rpc.network-tx-auth-header-value "$NETWORK_TX_AUTH" \
    --batch.builder.wallet-account-id "$BATCH_BUILDER_WALLET" \
    "${SEQUENCER_ALLOWLIST_ARGS[@]}" \
    --block.interval 3s --batch.interval 1s
start prover      "$BIN/miden-remote-prover" --kind=transaction --port="$PROVER_PORT" \
    --timeout "$PROVER_TIMEOUT" --capacity 8
sleep 2
start ntx-builder "$BIN/miden-ntx-builder" start --listen "$NTX" --rpc.url "http://$RPC" \
    --rpc.auth-header-value "$NETWORK_TX_AUTH" --tx-prover.url "http://$PROVER" \
    --tx-prover.timeout "$PROVER_TIMEOUT" \
    --max-cycles "$((1 << 18))" \
    --data-directory "$DATA/ntx-builder"
if [ "$ACCOUNT_ALLOWLIST" = "1" ]; then
    start funding-service "$BIN/miden-funding-service" start --listen "$FUNDING" \
        --rpc.url "http://$RPC" \
        --tx-prover.url "http://$PROVER" \
        --tx-prover.timeout "$PROVER_TIMEOUT" \
        --data-directory "$DATA/funding-service" \
        --signing-key-file "$DATA/genesis-config/funding_account.key" \
        --validator-signing-public-key "$VALIDATOR_PUBLIC_KEY" \
        --poll-interval 250ms
fi

wait_for_admin_api() {
    for _ in $(seq 1 30); do
        if (exec 3<>"/dev/tcp/${ADMIN%:*}/${ADMIN##*:}") 2>/dev/null; then
            exec 3>&- 3<&-
            return 0
        fi
        sleep 1
    done

    echo "error: admin API did not become ready on $ADMIN within 30s; see $LOG_DIR" >&2
    return 1
}

wait_for_funding_service() {
    for _ in $(seq 1 60); do
        if curl -sfo /dev/null "http://$FUNDING/status"; then
            return 0
        fi
        check_components_alive || return 1
        sleep 1
    done

    echo "error: funding service did not become ready on $FUNDING within 60s; see $LOG_DIR" >&2
    return 1
}

check_components_alive() {
    while read -r pid; do
        [ -n "$pid" ] || continue
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "error: a node service exited; see $LOG_DIR" >&2
            return 1
        fi
    done < "$PID_FILE"
}

echo "==> waiting for RPC on $RPC"
READY=""
for _ in $(seq 1 60); do
    if (exec 3<>"/dev/tcp/${RPC%:*}/${RPC##*:}") 2>/dev/null; then
        exec 3>&- 3<&-
        READY=1
        break
    fi
    check_components_alive || exit 1
    sleep 1
done
if [ -z "$READY" ]; then
    echo "error: RPC did not become ready within 60s; see $LOG_DIR" >&2
    exit 1
fi
echo "==> node is up (RPC on http://$RPC); logs in $LOG_DIR"

if [ "$ACCOUNT_ALLOWLIST" = "1" ]; then
    wait_for_admin_api
    wait_for_funding_service
    echo "==> account allowlist enforcement is ON (admin API on http://$ADMIN," \
        "registrations funded by http://$FUNDING)"
fi

if [ "$MODE" = "background" ]; then
    exit 0
fi

echo "==> streaming logs (Ctrl+C stops the node)"
perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV' tail -n +1 -F "$LOG_DIR"/*.log &
TAIL_PID=$!
while check_components_alive; do
    sleep 1
done
cleanup
exit 1
