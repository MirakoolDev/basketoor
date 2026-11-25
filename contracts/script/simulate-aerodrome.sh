#!/usr/bin/env bash
# Simulates a $100 buy through AerodromeCLAdapter against live Base mainnet state (eth_call with state
# overrides, nothing is sent). Forge's fork mode can't run this: Coinbase stocks are B20 precompiles
# that only exist in Base's own node, so the simulation has to run on a real Base RPC.
# Usage: forge build && bash script/simulate-aerodrome.sh [rpc]
set -euo pipefail
cd "$(dirname "$0")/.."
C=${CAST:-cast}; R=${1:-https://mainnet.base.org}
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X=0x00000000000000000000000000000000000bA5ce; RCP=0x00000000000000000000000000000000000Beef1
CODE=$(node -e 'console.log(require("./out/AerodromeCLAdapter.sol/AerodromeCLAdapter.json").deployedBytecode.object)')
pad(){ $C to-uint256 "$1"; }
bal=$($C index address $X 9); inner=$($C index address $X 10); allw=$($C index address $X "$inner")  # USDC balances / allowances slots
run(){ local NAME=$1 TOKEN=$2 POOL=$3 FEED=$4
  local ps; ps=$($C index address "$TOKEN" "$($C index address $USDC 2)")  # adapter pools[USDC][token]
  local OUT; OUT=$($C call $X "swap(address,address,uint256,uint256,address)(uint256)" $USDC "$TOKEN" 100000000 0 $RCP \
    --from $X --override-code "$X:$CODE" \
    --override-state-diff "$X:$ps:$(pad "$POOL"),$USDC:$bal:$(pad 1000000000),$USDC:$allw:$(pad 1000000000)" --rpc-url "$R" | cut -d' ' -f1)
  local PRICE; PRICE=$($C call "$FEED" "latestAnswer()(int256)" --rpc-url "$R" | cut -d' ' -f1)
  node -e "const e=100e6*1e16/($PRICE*1e6);console.log('$NAME: \$100 ->',($OUT/1e8).toFixed(6),'| fill vs Chainlink:',($OUT/e*100).toFixed(2)+'%')"
}
run NVDAc 0xb20000000000000000000078ee7ce2fE4908108C 0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC 0x04689a41629776563E6822F76f2e57D148d28513
run AAPLc 0xb200000000000000000000C2e324d24d7eEcd1fb 0xF5FCB9CDAFcE67d50AfEf298F88E709d2B946BA6 0x787f13dEa48Db0897CbCDD985de77809D837F988
