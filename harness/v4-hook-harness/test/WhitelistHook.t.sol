// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {WhitelistHook} from "../src/WhitelistHook.sol";

contract WhitelistHookTest is Test {
    function testAllowsAllowlisted() public {
        address a = address(0x1);
        address b = address(0x2);
        WhitelistHook hook = new WhitelistHook(a, b);
        assertTrue(hook.canSwap(a));
        assertTrue(hook.canSwap(b));
    }

    function testRejectsNonAllowlisted() public {
        WhitelistHook hook = new WhitelistHook(address(0x1), address(0x2));
        assertFalse(hook.canSwap(address(0x3)));
    }
}
