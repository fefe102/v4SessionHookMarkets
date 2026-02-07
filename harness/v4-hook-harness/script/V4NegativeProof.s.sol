// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

contract NegativeSwapProbe {
    event NegativeSwapOutcome(bool reverted, string reason);

    address public immutable swapTest;

    constructor(address swapTestAddress, address currency0, address currency1) {
        swapTest = swapTestAddress;
        IERC20Minimal(currency0).approve(swapTestAddress, type(uint256).max);
        IERC20Minimal(currency1).approve(swapTestAddress, type(uint256).max);
    }

    function probeSwap(
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        PoolSwapTest.TestSettings calldata settings,
        bytes calldata hookData
    ) external {
        try PoolSwapTest(swapTest).swap(key, params, settings, hookData) returns (BalanceDelta) {
            emit NegativeSwapOutcome(false, "");
        } catch (bytes memory revertData) {
            emit NegativeSwapOutcome(true, _decodeRevertString(revertData));
        }
    }

    function _decodeRevertString(bytes memory revertData) internal pure returns (string memory) {
        if (revertData.length < 4) return "";

        bytes4 selector;
        assembly {
            selector := mload(add(revertData, 32))
        }

        // Error(string)
        if (selector == 0x08c379a0 && revertData.length >= 4 + 32 + 32) {
            bytes memory sliced = new bytes(revertData.length - 4);
            for (uint256 i = 4; i < revertData.length; i++) {
                sliced[i - 4] = revertData[i];
            }
            return abi.decode(sliced, (string));
        }

        return "";
    }
}

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
        // We do not want a reverted top-level tx (Foundry may not emit a broadcast artifact for it).
        // Instead, we call the swap through a probe contract that catches the revert and emits an event.
        NegativeSwapProbe probe = new NegativeSwapProbe(swapTestAddress, currency0, currency1);

        // Fund the probe so the swap has sufficient balances/allowances in case the hook is buggy.
        // For the expected enforcement revert path, funds should not be touched.
        uint256 fundAmount = 10 ether;
        IERC20Minimal(currency0).transfer(address(probe), fundAmount);
        IERC20Minimal(currency1).transfer(address(probe), fundAmount);

        probe.probeSwap(key, swapParams, settings, hookData);
        vm.stopBroadcast();
    }
}
