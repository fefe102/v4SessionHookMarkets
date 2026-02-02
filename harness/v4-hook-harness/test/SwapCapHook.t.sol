// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SwapCapHook} from "../src/SwapCapHook.sol";

contract SwapCapHookTest is Test {
    function testAllowsUnderCap() public {
        SwapCapHook hook = new SwapCapHook(1000);
        assertTrue(hook.canSwap(500));
    }

    function testRejectsOverCap() public {
        SwapCapHook hook = new SwapCapHook(1000);
        assertFalse(hook.canSwap(1500));
    }
}
