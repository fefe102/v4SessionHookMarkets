// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract WhitelistHook {
    mapping(address => bool) public allowed;

    constructor(address a, address b) {
        allowed[a] = true;
        allowed[b] = true;
    }

    function canSwap(address trader) external view returns (bool) {
        return allowed[trader];
    }
}
