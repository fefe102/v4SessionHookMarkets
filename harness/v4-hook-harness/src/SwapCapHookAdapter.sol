// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

interface ISwapCapHook {
    function canSwap(uint256 amountIn) external view returns (bool);
}

contract SwapCapHookAdapter {
    using BeforeSwapDeltaLibrary for BeforeSwapDelta;

    IPoolManager public immutable manager;
    ISwapCapHook public immutable module;

    constructor(IPoolManager _manager, ISwapCapHook _module) {
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
        address,
        PoolKey calldata,
        IPoolManager.SwapParams calldata params,
        bytes calldata
    ) external view returns (bytes4, BeforeSwapDelta, uint24) {
        require(msg.sender == address(manager), "ONLY_MANAGER");
        uint256 amount = params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        require(module.canSwap(amount), "CAP");
        return (SwapCapHookAdapter.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO, 0);
    }
}
