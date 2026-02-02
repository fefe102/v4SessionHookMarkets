// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {WhitelistHook} from "../src/WhitelistHook.sol";

contract WhitelistHookTest is Test {
    function testAllowsAllowlisted() public {
        address a = vm.envOr("ALLOWLIST_A", address(0x0000000000000000000000000000000000000001));
        address b = vm.envOr("ALLOWLIST_B", address(0x0000000000000000000000000000000000000002));
        WhitelistHook hook = new WhitelistHook(a, b);
        assertTrue(hook.canSwap(a));
        assertTrue(hook.canSwap(b));
    }

    function testRejectsNonAllowlisted() public {
        address a = vm.envOr("ALLOWLIST_A", address(0x0000000000000000000000000000000000000001));
        address b = vm.envOr("ALLOWLIST_B", address(0x0000000000000000000000000000000000000002));
        WhitelistHook hook = new WhitelistHook(a, b);
        assertFalse(hook.canSwap(address(0x0000000000000000000000000000000000000003)));
    }
}
