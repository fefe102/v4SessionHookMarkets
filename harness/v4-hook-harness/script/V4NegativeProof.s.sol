// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

contract V4NegativeProof is Script {
    function run() external {
        string memory proofIn = vm.envString("PROOF_IN");
        string memory template = vm.envString("TEMPLATE_TYPE");
        uint256 capAmount = vm.envOr("CAP_AMOUNT_IN", uint256(1000));

        // Read the proof output from V4Proof.s.sol.
        string memory json = vm.readFile(proofIn);
        address swapTestAddress = vm.parseJsonAddress(json, ".swapTestAddress");
        address currency0 = vm.parseJsonAddress(json, ".poolKey.currency0");
        address currency1 = vm.parseJsonAddress(json, ".poolKey.currency1");
        uint24 fee = uint24(vm.parseJsonUint(json, ".poolKey.fee"));
        int24 tickSpacing = int24(int256(vm.parseJsonUint(json, ".poolKey.tickSpacing")));
        address hooks = vm.parseJsonAddress(json, ".poolKey.hooks");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(currency0),
            currency1: Currency.wrap(currency1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hooks)
        });

        uint160 sqrtPriceLimitX96 = TickMath.getSqrtPriceAtTick(TickMath.MIN_TICK + 1);
        PoolSwapTest.TestSettings memory settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

        bool isSwapCap = keccak256(bytes(template)) == keccak256(bytes("SWAP_CAP_HOOK"));
        uint256 amountIn = 1e18;
        bytes memory hookData = bytes("");

        if (isSwapCap) {
            // Choose an amount guaranteed to exceed the cap (in token base units).
            if (capAmount == 0) revert("CAP_AMOUNT_IN=0");
            amountIn = capAmount + 1;
        } else {
            // Non-allowlisted trader to prove enforcement.
            address nonAllowlisted = address(0x0000000000000000000000000000000000000003);
            hookData = abi.encode(nonAllowlisted);
        }

        IPoolManager.SwapParams memory swapParams = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        vm.startBroadcast();
        // Intentionally expect this to revert if the hook enforcement is correct.
        PoolSwapTest(swapTestAddress).swap(key, swapParams, settings, hookData);
        vm.stopBroadcast();
    }
}

