// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PoolTwapFeed, ICLPoolOracle} from "../src/feeds/PoolTwapFeed.sol";

/// Reads every Coinbase stock pool without a Chainlink feed through PoolTwapFeed's checks, against live Base.
/// Nothing is sent. forge script script/ScanTwapPools.s.sol --fork-url <base rpc>
contract ScanTwapPools is Script {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        _scan("AAOI", 0xfb35D41801893197b5A4d477D0Bf6737D2AD6106, 0xb200000000000000000000cf36D05963A3E2205c);
        _scan("ADBE", 0x80997E422e1d03f8d41Fe831A306df674128050d, 0xB20000000000000000000034533Ed3961f222Cd4);
        _scan("AMD", 0x138Cb591C4A7D854D796E1906af8228d84CB7642, 0xB2000000000000000000000d8Ce462E99ee7A47B);
        _scan("AVGO", 0x086A1447D0851F0aeA9D09D6c547fEC8E97be413, 0xB200000000000000000000Fc737aeA6196aB5a4c);
        _scan("BE", 0xDe2BfE5409aD9e825cdB3562A06EDaFb9d753DFc, 0xb20000000000000000000016f9dfe862feBA122b);
        _scan("BRK.B", 0xBc5682De77d729397739982a577b7963eF2f6556, 0xb20000000000000000000024170488e788CBbCb4);
        _scan("CRWV", 0x4D942B4239e0894E5a80ca2b3944e3467F4Ee464, 0xB200000000000000000000F111184A74720787E6);
        _scan("GME", 0xe1199A8B3cC490e2538AdBD24c4853f78Cbcaa07, 0xb2000000000000000000007790ed6E48e06eD935);
        _scan("HIMS", 0x41D7793FAa4Ca181B6f021423fF3F9015C00b2ff, 0xB20000000000000000000043a599976181Bcf336);
        _scan("HOOD", 0x25B45fF27bd03dAfa0C0bf458762FFD0911fA9de, 0xb2000000000000000000006F944897540579D3f2);
        _scan("KO", 0x59C7a81E752fCa11b89E29Fa98E56A6f2eAD5fb3, 0xb200000000000000000000ffef181DB6dC5ed6A3);
        _scan("LITE", 0x16B8228cD097865d8F5A534B95e42e17D84551b0, 0xB200000000000000000000eDA6C2c6F11E0F838f);
        _scan("LLY", 0x2b7ee4623ec6AfbC1e587b2668c0ED8F3ff44949, 0xB200000000000000000000f1a0F91e34892E4718);
        _scan("MCD", 0x743f16eE460aB7401321e7F35c3FD187Eff7d711, 0xb200000000000000000000d2f4cf2f7DEBB244BB);
        _scan("MRNA", 0x4ae3780242F43ef63C471Fb8c2E9D30ec5fd5821, 0xB200000000000000000000e215e9B76ecBA02468);
        _scan("MRVL", 0x611ab290422d534D9595b01e648911fefA963137, 0xB200000000000000000000eC3c4c7395Cc609813);
        _scan("MU", 0x41e21950362B1014bC629252ecFFF8fcA5F1646C, 0xb200000000000000000000Fd2f87532B90095211);
        _scan("NFLX", 0x67Ba8dBeDC6D7f93f0F5967Aa2420715f1edC756, 0xb20000000000000000000058B8c947e44011dFE6);
        _scan("NOW", 0xe2935CD42271a31afDeDAEebc1e491214202E6b0, 0xB20000000000000000000082Cd2C7801305808Df);
        _scan("ORCL", 0x62B5452E80E50B047dcF6dd3Fb6a1D266C678eB5, 0xb200000000000000000000347AFbA223D7B6b63C);
        _scan("PLTR", 0xA0473ceD0cd1bfB857e3E04B5FA4b6aF18C5e44d, 0xb2000000000000000000007d16372840dF4dAbbe);
        _scan("SNOW", 0x20812d6c78D972EeA8DF85319eC721DB1e67B31F, 0xB2000000000000000000004AcDC9A922FCfBCc7f);
        _scan("TTWO", 0x18907cAE5a9c7b45F85c5d2e1F7508C27c134f83, 0xB200000000000000000000f720C26062Bc3067Da);
        _scan("UBER", 0x10658504d00D3D65610c0FD72a81B6926109117A, 0xb200000000000000000000cAE20cb1446462e24c);
        _scan("WDC", 0x8468bFD8A3c5bB04C44dabF3329D7902F340B12b, 0xb2000000000000000000008fde21a1F5c69FeC0b);
    }

    function _scan(string memory name, address pool, address token) internal {
        ICLPoolOracle p = ICLPoolOracle(pool);
        (uint160 a, int24 t, uint16 i, uint16 c, uint16 next, bool u) = p.slot0();
        // Pretend the pool already keeps enough history, to see the other checks now.
        if (next < 1200) vm.mockCall(pool, abi.encodeWithSelector(ICLPoolOracle.slot0.selector), abi.encode(a, t, i, c, uint16(1200), u));
        PoolTwapFeed f = new PoolTwapFeed{salt: keccak256(bytes(name))}(p, token, USDC, 8, 6, 1800, 6, 150, 1);
        vm.clearMockedCalls();
        (uint256 price, PoolTwapFeed.Status s,, uint256 depth) = f.read();
        console.log(string.concat(name, " status=", vm.toString(uint8(s)), " price=", vm.toString(price / 1e6), " depth$=", vm.toString(depth / 1e6), " obs=", vm.toString(c), "/", vm.toString(next)));
    }
}
