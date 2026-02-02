// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SwapCapHook {
    uint256 public capAmountIn;

    constructor(uint256 _capAmountIn) {
        capAmountIn = _capAmountIn;
    }

    function canSwap(uint256 amountIn) external view returns (bool) {
        return amountIn <= capAmountIn;
    }
}
