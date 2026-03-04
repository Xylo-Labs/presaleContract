// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Testnet USDT — 1,000,000 tokens pre-minted to the contract (faucet pool).
 *         Users call faucet() to receive 1,000 tokens from the pool.
 *         mint() is kept for Hardhat test helpers only.
 */
contract MockERC20 is ERC20 {
    uint8 private _customDecimals;
    uint256 private immutable _faucetAmount;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
        _faucetAmount = 1_000 * 10 ** uint256(decimals_);

        // Pre-mint 1,000,000 tokens to this contract — acts as the admin faucet pool
        _mint(address(this), 1_000_000 * 10 ** uint256(decimals_));
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    /// @notice Transfers 1,000 tokens from the faucet pool to `to`.
    ///         Anyone can call this; amount and source are fixed by the contract.
    function faucet(address to) external {
        require(to != address(0), "Invalid address");
        require(balanceOf(address(this)) >= _faucetAmount, "Faucet empty");
        _transfer(address(this), to, _faucetAmount);
    }

    /// @notice Returns the fixed amount given per faucet call.
    function faucetAmount() external view returns (uint256) {
        return _faucetAmount;
    }

    /// @dev Test helper — public mint. Not used by frontend.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
