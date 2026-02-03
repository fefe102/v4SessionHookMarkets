// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

interface IWhitelistHook {
    function canSwap(address trader) external view returns (bool);
}

contract WhitelistHookAdapter {
    using BeforeSwapDeltaLibrary for BeforeSwapDelta;

    IPoolManager public immutable manager;
    IWhitelistHook public immutable module;

    constructor(IPoolManager _manager, IWhitelistHook _module) {
        manager = _manager;
        module = _module;
    }

    function getHookPermissions() external pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function beforeSwap(
        address sender,
        PoolKey calldata,
        IPoolManager.SwapParams calldata,
        bytes calldata
    ) external view returns (bytes4, BeforeSwapDelta, uint24) {
        require(msg.sender == address(manager), "ONLY_MANAGER");
        require(module.canSwap(sender), "NOT_ALLOWLISTED");
        return (WhitelistHookAdapter.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
