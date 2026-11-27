#!/usr/bin/env bash
# Simulates a $100 buy of Bankr stock indexes through BankrIndexRouter against live Base mainnet state
# (eth_call, nothing is sent). Forge's fork mode can't run this: Coinbase stocks are B20 precompiles that only
# exist in Base's own node. Usage: forge build && bash script/simulate-bankr-index.sh [rpc]
set -euo pipefail
cd "$(dirname "$0")/.."
C=${CAST:-cast}; R=${1:-https://base-rpc.publicnode.com}
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
VENUE=0x27826d88468904cF97C2DcE28E344A16E3693645
FROM=0x00000000000000000000000000000000000bA5ce
PROBE=$($C compute-address $FROM --nonce 0 | awk '{print $NF}')
BAL=$($C index address "$PROBE" 9)  # USDC balances slot
INIT=$(node -e 'console.log(require("./out/BankrIndexProbe.sol/BankrIndexProbe.json").bytecode.object)')
run(){ local NAME=$1 INDEX=$2
  local ARGS; ARGS=$($C abi-encode "f(address,address)" "$INDEX" $VENUE)
  local RES; RES=$($C rpc eth_call "{\"from\":\"$FROM\",\"data\":\"$INIT${ARGS:2}\",\"gas\":\"0x1c9c380\"}" latest \
    "{\"$USDC\":{\"stateDiff\":{\"$BAL\":\"$($C to-uint256 100000000)\"}}}" --rpc-url "$R" | tr -d '"')
  node -e "const h='$RES'.slice(2);const out=BigInt('0x'+h.slice(0,64)),nav=BigInt('0x'+h.slice(64,128));
    const atNav=100n*10n**26n/nav; console.log('$NAME: \$100 ->',(Number(out)/1e18).toFixed(6),'shares | NAV/share \$'+(Number(nav)/1e8).toFixed(4),'| fill vs NAV:',(Number(out*10000n/atNav)/100).toFixed(2)+'%')"
}
run MAG7 0x4a2f6e708868d503fd6401c24dd13bb44136591f
run CSUITE 0xfbc906144e4919ec075fe2edec2a18583177eb3f
run SPACE 0xfb6c6bad1ab0c4a14ac7b86593c3f099b615df41
