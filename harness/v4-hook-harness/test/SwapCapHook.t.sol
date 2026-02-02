// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SwapCapHook} from "../src/SwapCapHook.sol";

contract SwapCapHookTest is Test {
    function testAllowsUnderCap() public {
        uint256 cap = vm.envOr("CAP_AMOUNT_IN", uint256(1000));
        SwapCapHook hook = new SwapCapHook(cap);
        assertTrue(hook.canSwap(cap / 2));
    }

    function testRejectsOverCap() public {
        uint256 cap = vm.envOr("CAP_AMOUNT_IN", uint256(1000));
        SwapCapHook hook = new SwapCapHook(cap);
        assertFalse(hook.canSwap(cap + 1));
    }
}
