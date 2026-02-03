// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SwapCapHook} from "../src/SwapCapHook.sol";
import {WhitelistHook} from "../src/WhitelistHook.sol";

contract ChallengeTest is Test {
    function testReproduction() public {
        string memory template = vm.envString("TEMPLATE_TYPE");

        if (keccak256(bytes(template)) == keccak256(bytes("SWAP_CAP_HOOK"))) {
            uint256 cap = vm.envOr("CAP_AMOUNT_IN", uint256(1000));
            uint256 amountIn = vm.envOr("CHALLENGE_AMOUNT_IN", cap + 1);
            SwapCapHook hook = new SwapCapHook(cap);
            if (amountIn > cap) {
                assertFalse(hook.canSwap(amountIn), "swapcap should reject over-cap");
            } else {
                assertTrue(hook.canSwap(amountIn), "swapcap should allow under-cap");
            }
            return;
        }

        address a = vm.envOr("ALLOWLIST_A", address(0x0000000000000000000000000000000000000001));
        address b = vm.envOr("ALLOWLIST_B", address(0x0000000000000000000000000000000000000002));
        address trader = vm.envOr("CHALLENGE_TRADER", address(0x0000000000000000000000000000000000000003));
        WhitelistHook hook2 = new WhitelistHook(a, b);
        bool allowed = hook2.canSwap(trader);
        if (trader == a || trader == b) {
            assertTrue(allowed, "whitelist should allow allowlisted");
        } else {
            assertFalse(allowed, "whitelist should reject non-allowlisted");
        }
    }
}

