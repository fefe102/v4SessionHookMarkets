// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapCapHook} from "../src/SwapCapHook.sol";
import {WhitelistHook} from "../src/WhitelistHook.sol";
import {SwapCapHookAdapter, ISwapCapHook} from "../src/SwapCapHookAdapter.sol";
import {WhitelistHookAdapter, IWhitelistHook} from "../src/WhitelistHookAdapter.sol";
import {MockERC20} from "solmate/test/utils/mocks/MockERC20.sol";

library HookMinerLite {
    function compute(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        bytes32 data = keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash));
        return address(uint160(uint256(data)));
    }

    function find(
        address deployer,
        uint160 flags,
        bytes memory creationCode,
        bytes memory constructorArgs
    ) internal pure returns (address hookAddress, bytes32 salt) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i = 0; i < 160_444; i++) {
            salt = bytes32(i);
            hookAddress = compute(deployer, salt, initCodeHash);
            if ((uint160(hookAddress) & Hooks.ALL_HOOK_MASK) == flags) {
                return (hookAddress, salt);
            }
        }
        revert("HookMiner: no salt");
    }
}

contract V4Proof is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        address managerAddress = vm.envAddress("POOL_MANAGER");
        string memory template = vm.envString("TEMPLATE_TYPE");
        uint256 capAmount = vm.envOr("CAP_AMOUNT_IN", uint256(1000));
        address allowA = vm.envOr("ALLOWLIST_A", address(0x0000000000000000000000000000000000000001));
        address allowB = vm.envOr("ALLOWLIST_B", address(0x0000000000000000000000000000000000000002));
        uint24 fee = uint24(vm.envOr("V4_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("V4_TICK_SPACING", uint256(60))));
        string memory proofOut = vm.envString("PROOF_OUT");

        vm.startBroadcast();

        IPoolManager manager = IPoolManager(managerAddress);
        MockERC20 tokenA = new MockERC20("TokenA", "TKA", 18);
        MockERC20 tokenB = new MockERC20("TokenB", "TKB", 18);

        address broadcaster = msg.sender;
        tokenA.mint(broadcaster, 1_000_000 ether);
        tokenB.mint(broadcaster, 1_000_000 ether);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        address hookAddress;
        bytes32 salt;
        if (keccak256(bytes(template)) == keccak256(bytes("SWAP_CAP_HOOK"))) {
            SwapCapHook module = new SwapCapHook(capAmount);
            bytes memory args = abi.encode(manager, module);
            bytes32 initCodeHash = keccak256(abi.encodePacked(type(SwapCapHookAdapter).creationCode, args));
            for (uint256 i = 0; i < 160_444; i++) {
                bytes32 candidateSalt = bytes32(i);
                address candidate = HookMinerLite.compute(CREATE2_DEPLOYER, candidateSalt, initCodeHash);
                if ((uint160(candidate) & Hooks.ALL_HOOK_MASK) != flags) continue;
                if (candidate.code.length != 0) continue;
                hookAddress = candidate;
                salt = candidateSalt;
                break;
            }
            if (hookAddress == address(0)) revert("HookMiner: no salt");

            bytes memory initCode = abi.encodePacked(type(SwapCapHookAdapter).creationCode, abi.encode(manager, ISwapCapHook(address(module))));
            (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            require(ok, "CREATE2 deploy failed");
            require(hookAddress.code.length != 0, "Hook not deployed");
            if (ret.length == 20) {
                require(address(bytes20(ret)) == hookAddress, "Hook address mismatch");
            }
        } else {
            WhitelistHook module = new WhitelistHook(allowA, allowB);
            bytes memory args = abi.encode(manager, module);
            bytes32 initCodeHash = keccak256(abi.encodePacked(type(WhitelistHookAdapter).creationCode, args));
            for (uint256 i = 0; i < 160_444; i++) {
                bytes32 candidateSalt = bytes32(i);
                address candidate = HookMinerLite.compute(CREATE2_DEPLOYER, candidateSalt, initCodeHash);
                if ((uint160(candidate) & Hooks.ALL_HOOK_MASK) != flags) continue;
                if (candidate.code.length != 0) continue;
                hookAddress = candidate;
                salt = candidateSalt;
                break;
            }
            if (hookAddress == address(0)) revert("HookMiner: no salt");

            bytes memory initCode = abi.encodePacked(
                type(WhitelistHookAdapter).creationCode,
                abi.encode(manager, IWhitelistHook(address(module)))
            );
            (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            require(ok, "CREATE2 deploy failed");
            require(hookAddress.code.length != 0, "Hook not deployed");
            if (ret.length == 20) {
                require(address(bytes20(ret)) == hookAddress, "Hook address mismatch");
            }
        }

        PoolModifyLiquidityTest modifyLiquidity = new PoolModifyLiquidityTest(manager);
        PoolSwapTest swapTest = new PoolSwapTest(manager);

        tokenA.approve(address(modifyLiquidity), type(uint256).max);
        tokenB.approve(address(modifyLiquidity), type(uint256).max);
        tokenA.approve(address(swapTest), type(uint256).max);
        tokenB.approve(address(swapTest), type(uint256).max);

        Currency currency0 = Currency.wrap(address(tokenA));
        Currency currency1 = Currency.wrap(address(tokenB));
        if (Currency.unwrap(currency0) > Currency.unwrap(currency1)) {
            (currency0, currency1) = (currency1, currency0);
        }

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hookAddress)
        });

        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(0);
        manager.initialize(key, sqrtPriceX96);

        int24 tickLower = (TickMath.MIN_TICK / tickSpacing) * tickSpacing;
        int24 tickUpper = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
        IPoolManager.ModifyLiquidityParams memory params = IPoolManager.ModifyLiquidityParams({
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidityDelta: int128(1e18),
            salt: bytes32(0)
        });
        modifyLiquidity.modifyLiquidity(key, params, bytes(""));

        uint160 sqrtPriceLimitX96 = TickMath.getSqrtPriceAtTick(TickMath.MIN_TICK + 1);
        bool isSwapCap = keccak256(bytes(template)) == keccak256(bytes("SWAP_CAP_HOOK"));
        uint256 amountIn = 1e18;
        if (isSwapCap) {
            // Treat capAmount as the same units used in PoolManager swaps (token base units).
            // Swap with an amount that is guaranteed <= capAmount.
            if (capAmount == 0) revert("CAP_AMOUNT_IN=0");
            amountIn = capAmount / 2;
            if (amountIn == 0) amountIn = capAmount;
        }
        IPoolManager.SwapParams memory swapParams = IPoolManager.SwapParams({
            zeroForOne: true,
            // Negative = exact input in v4-core test helpers.
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });
        PoolSwapTest.TestSettings memory settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        bytes memory hookData = bytes("");
        if (!isSwapCap) {
            // See WhitelistHookAdapter: we pass the intended trader via hookData.
            hookData = abi.encode(allowA);
        }
        swapTest.swap(key, swapParams, settings, hookData);

        PoolId poolId = PoolIdLibrary.toId(key);

        string memory json = string.concat(
            "{",
            "\"chainId\":", vm.toString(block.chainid), ",",
            "\"hookAddress\":\"", vm.toString(hookAddress), "\",",
            "\"tokenAAddress\":\"", vm.toString(address(tokenA)), "\",",
            "\"tokenBAddress\":\"", vm.toString(address(tokenB)), "\",",
            "\"swapTestAddress\":\"", vm.toString(address(swapTest)), "\",",
            "\"poolKey\":{",
            "\"currency0\":\"", vm.toString(Currency.unwrap(key.currency0)), "\",",
            "\"currency1\":\"", vm.toString(Currency.unwrap(key.currency1)), "\",",
            "\"fee\":", vm.toString(uint256(key.fee)), ",",
            "\"tickSpacing\":", vm.toString(int256(key.tickSpacing)), ",",
            "\"hooks\":\"", vm.toString(address(key.hooks)), "\"",
            "},",
            "\"poolId\":\"", vm.toString(PoolId.unwrap(poolId)), "\"",
            "}"
        );

        vm.writeFile(proofOut, json);
        vm.stopBroadcast();
    }
}
