"""Integer-only wallet, canonical-custody, and LP reward reference model.

The model is deliberately independent of the Move implementation.  It models
the economic state transitions and their ordering, including the two-index
boundary between the core reflection contract and the canonical AMM:

* registered wallet raw balances and the pool reserve are core reward shares;
* the pool reserve is represented exactly once, as one custody position;
* custody rewards are routed out of the core vault without changing reserves;
* each LP epoch has its own reward index, positions, and physical vault; and
* an LP payout enters a registered wallet at the current core index.

All quantities are base units.  Python's arbitrary-precision arithmetic is
used for intermediate calculations, but the model rejects values outside the
u128/u256 bounds used by the protocol design.
"""

from __future__ import annotations

import copy
import math
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Iterator, Mapping, Optional


MAGNITUDE = 10**24
MAX_U128 = (1 << 128) - 1
MAX_U256 = (1 << 256) - 1
BPS_DENOMINATOR = 10_000
DEFAULT_MAX_LIQUIDITY_RFL = 100_000_000_000
DEFAULT_MAX_LIQUIDITY_USD = 100_000_000_000
DEFAULT_MAX_WITHDRAWAL_SHARE_BPS = BPS_DENOMINATOR

LP_ACTIVE = "ACTIVE"
LP_CLAIM_ONLY = "CLAIM_ONLY"


class AccountingError(ValueError):
    """Raised when an operation violates an accounting precondition."""


class AuthorizationError(AccountingError):
    """Raised when a caller does not hold the required protocol role."""


class PoolBypassError(AccountingError):
    """Raised for an unsupported pool, vault, or delegated-custody movement."""


def _checked_u256_product(left: int, right: int, label: str) -> int:
    if left < 0 or right < 0:
        raise AccountingError(f"{label} has a negative unsigned operand")
    result = left * right
    if result > MAX_U256:
        raise AccountingError(f"{label} exceeds u256")
    return result


def _apply_signed_u256(base: int, correction: int, label: str) -> int:
    if base < 0 or base > MAX_U256 or abs(correction) > MAX_U256:
        raise AccountingError(f"{label} input exceeds u256")
    result = base + correction
    if result < 0 or result > MAX_U256:
        raise AccountingError(f"{label} signed application exceeds u256")
    return result


@dataclass(frozen=True)
class SwapResult:
    """Amounts produced by one canonical-pool swap, all in base units."""

    direction: str
    gross_amount: int
    reflection_fee: int
    net_rfl_amount: int
    amm_fee: int
    invariant_input: int
    quote_amount: int


@dataclass(frozen=True)
class LiquidityResult:
    """Amounts consumed or returned by one liquidity operation."""

    epoch: int
    lp_shares: int
    rfl_amount: int
    usd_amount: int
    final_exit: bool = False


@dataclass
class LpPosition:
    shares: int = 0
    correction: int = 0
    claimed: int = 0


@dataclass
class LpEpoch:
    epoch_id: int
    vault: str
    status: str = LP_ACTIVE
    index: int = 0
    index_remainder: int = 0
    total_shares: int = 0
    aggregate_correction: int = 0
    unallocated_rewards: int = 0
    rounding_reserve: int = 0
    lifetime_received: int = 0
    lifetime_claimed: int = 0
    quarantined: bool = False
    positions: Dict[str, LpPosition] = field(default_factory=dict)

    def accrued(self, owner: str) -> int:
        position = self.positions.get(owner)
        if position is None:
            return 0
        base = _checked_u256_product(position.shares, self.index, "LP position entitlement")
        magnified = _apply_signed_u256(base, position.correction, "LP position entitlement")
        return magnified // MAGNITUDE

    def pending(self, owner: str) -> int:
        position = self.positions.get(owner)
        if position is None:
            return 0
        result = self.accrued(owner) - position.claimed
        if result < 0:
            raise AssertionError("LP claims exceed accrued rewards")
        return result

    def aggregate_liability(self) -> int:
        base = _checked_u256_product(self.total_shares, self.index, "aggregate LP entitlement")
        magnified = _apply_signed_u256(base, self.aggregate_correction, "aggregate LP entitlement")
        result = magnified // MAGNITUDE - self.lifetime_claimed
        if result < 0:
            raise AssertionError("aggregate LP claims exceed entitlement")
        return result

class ReflectionModel:
    """Exact two-layer reference accounting for wallet and canonical-LP rewards.

    A core position's claimable amount is::

        floor((shares * index + correction) / MAGNITUDE) - settled

    Wallet ``settled`` is materialised rewards.  Custody ``settled`` is rewards
    routed to LP epochs.  LP positions use the same formula with an independent
    per-epoch index and cumulative claims as their settled amount.
    """

    CORE_STORES = frozenset({"reward_vault", "distribution_vault", "pool", "admin"})

    def __init__(
        self,
        *,
        fixed_supply: int,
        fee_bps: int = 100,
        amm_fee_bps: int = 30,
        admin: str = "admin",
        extra_exclusions: Iterable[str] = (),
    ) -> None:
        self._require_amount(fixed_supply, "fixed_supply", allow_zero=False)
        self._require_bps(fee_bps, "fee_bps", maximum=100)
        self._require_bps(amm_fee_bps, "amm_fee_bps", maximum=1_000)

        self.admin = admin
        self.fixed_supply = fixed_supply
        self.fee_bps = fee_bps
        self.amm_fee_bps = amm_fee_bps
        self.max_liquidity_rfl = DEFAULT_MAX_LIQUIDITY_RFL
        self.max_liquidity_usd = DEFAULT_MAX_LIQUIDITY_USD
        self.max_withdrawal_share_bps = DEFAULT_MAX_WITHDRAWAL_SHARE_BPS
        self.swaps_paused = False
        self.claims_paused = False
        self.pool_paused = False
        self.liquidity_paused = False
        self.lp_claims_paused = False
        self.shutdown_mode = False
        self.seeded = False

        # Core reward-index state.
        self.index = 0
        self.index_remainder = 0
        self.total_shares = 0
        self.aggregate_correction = 0
        self.unallocated_fees = 0
        self.rounding_reserve = 0
        self.lifetime_fees = 0
        self.lifetime_materialized = 0
        self.lifetime_custody_routed = 0

        # Wallet positions are explicitly registered.  Protocol stores and any
        # unregistered/delegated store are never silently interpreted as a
        # wallet reward position.
        self.exclusions = set(self.CORE_STORES)
        self.exclusions.add(admin)
        self.exclusions.update(extra_exclusions)
        self.registered_wallets: set[str] = set()
        self.raw: Dict[str, int] = {account: 0 for account in self.exclusions}
        self.quote: Dict[str, int] = {account: 0 for account in self.exclusions}
        self.correction: Dict[str, int] = {}
        self.materialized: Dict[str, int] = {}

        # Exactly one core custody position represents the canonical raw pool
        # reserve.  Its settled amount is cumulative reward routed downstream.
        self.custody_shares = 0
        self.custody_correction = 0
        self.custody_settled = 0

        # Epoch 1 exists before bootstrap, matching the canonical AMM package.
        self.active_epoch: Optional[int] = 1
        self.next_epoch = 2
        first_vault = self._lp_vault_name(1)
        self.raw[first_vault] = 0
        self.exclusions.add(first_vault)
        self.lp_epochs: Dict[int, LpEpoch] = {1: LpEpoch(1, first_vault)}

        self.events: list[dict[str, Any]] = []
        self._lock: Optional[str] = None
        self._transaction_depth = 0

        self.raw["distribution_vault"] = fixed_supply
        self._event("ProtocolInitialized", fixed_supply=fixed_supply, fee_bps=fee_bps)

    # ------------------------------------------------------------------
    # Public core and LP views
    # ------------------------------------------------------------------
    def raw_balance(self, account: str) -> int:
        return self.raw.get(account, 0)

    def quote_balance(self, account: str) -> int:
        return self.quote.get(account, 0)

    def is_excluded(self, account: str) -> bool:
        return account in self.exclusions or account not in self.registered_wallets

    def wallet_is_registered(self, account: str) -> bool:
        return account in self.registered_wallets

    def accrued(self, account: str) -> int:
        """Return cumulative core rewards for a wallet or ``pool`` custody."""
        if account == "pool":
            base = _checked_u256_product(self.custody_shares, self.index, "custody entitlement")
            numerator = _apply_signed_u256(base, self.custody_correction, "custody entitlement")
        elif account in self.registered_wallets:
            base = _checked_u256_product(self.raw_balance(account), self.index, "wallet entitlement")
            numerator = _apply_signed_u256(
                base, self.correction.get(account, 0), "wallet entitlement"
            )
        else:
            return 0
        if numerator < 0:
            raise AssertionError("negative accrued-reward numerator")
        return numerator // MAGNITUDE

    def pending(self, account: str) -> int:
        if account == "pool":
            settled = self.custody_settled
        elif account in self.registered_wallets:
            settled = self.materialized.get(account, 0)
        else:
            return 0
        result = self.accrued(account) - settled
        if result < 0:
            raise AssertionError("settled core rewards exceed accrued rewards")
        return result

    def pool_pending_rewards(self) -> int:
        return self.pending("pool")

    def effective_balance(self, account: str) -> int:
        return self.raw_balance(account) + self.pending(account)

    def combined_effective_balance(self, account: str) -> int:
        return self.effective_balance(account) + sum(
            epoch.pending(account) for epoch in self.lp_epochs.values()
        )

    @property
    def reward_vault_balance(self) -> int:
        return self.raw_balance("reward_vault")

    @property
    def distribution_vault_balance(self) -> int:
        return self.raw_balance("distribution_vault")

    @property
    def pool_rfl_reserve(self) -> int:
        return self.raw_balance("pool")

    @property
    def pool_usd_reserve(self) -> int:
        return self.quote_balance("pool")

    def core_gross_entitlement(self) -> int:
        base = _checked_u256_product(self.total_shares, self.index, "aggregate core entitlement")
        magnified = _apply_signed_u256(
            base, self.aggregate_correction, "aggregate core entitlement"
        )
        return magnified // MAGNITUDE

    def reflection_liability(self) -> int:
        result = (
            self.core_gross_entitlement()
            - self.lifetime_materialized
            - self.lifetime_custody_routed
        )
        if result < 0:
            raise AssertionError("aggregate core settlements exceed entitlement")
        return result

    def backing_surplus(self) -> int:
        return self.reward_vault_balance - self.reflection_liability()

    def total_effective_eligible(self) -> int:
        return sum(self.effective_balance(account) for account in self.eligible_accounts()) + self.effective_balance("pool")

    def eligible_accounts(self) -> Iterator[str]:
        yield from sorted(self.registered_wallets)

    def lp_epoch(self, epoch_id: int) -> LpEpoch:
        try:
            return self.lp_epochs[epoch_id]
        except KeyError as exc:
            raise AccountingError("unknown LP epoch") from exc

    def lp_shares(self, epoch_id: int, owner: str) -> int:
        position = self.lp_epoch(epoch_id).positions.get(owner)
        return 0 if position is None else position.shares

    def lp_pending(self, epoch_id: int, owner: str) -> int:
        return self.lp_epoch(epoch_id).pending(owner)

    def lp_vault_balance(self, epoch_id: int) -> int:
        return self.raw_balance(self.lp_epoch(epoch_id).vault)

    def active_lp_epoch(self) -> LpEpoch:
        if self.active_epoch is None:
            raise AccountingError("no active LP epoch")
        return self.lp_epoch(self.active_epoch)

    # ------------------------------------------------------------------
    # Administrative and distribution operations
    # ------------------------------------------------------------------
    def register_wallet(self, actor: str, account: Optional[str] = None) -> None:
        """Register a signer-authenticated primary wallet reward position."""
        account = actor if account is None else account
        if actor != account:
            raise AuthorizationError("wallet registration requires the account signer")
        self._register_wallet(account)
        self._event("WalletRegistered", account=account)

    def set_fee_bps(self, actor: str, fee_bps: int) -> None:
        self._require_admin(actor)
        self._require_bps(fee_bps, "fee_bps", maximum=100)
        self.fee_bps = fee_bps
        self._event("FeeConfigurationChanged", fee_bps=fee_bps)

    def set_swaps_paused(self, actor: str, paused: bool) -> None:
        self._require_admin(actor)
        self.swaps_paused = bool(paused)
        self._event("PauseStateChanged", swaps_paused=self.swaps_paused)

    def set_claims_paused(self, actor: str, paused: bool) -> None:
        self._require_admin(actor)
        self.claims_paused = bool(paused)
        self._event("PauseStateChanged", claims_paused=self.claims_paused)

    def configure_pool_pauses(
        self,
        actor: str,
        *,
        pool_paused: bool,
        liquidity_paused: bool,
        lp_claims_paused: bool,
    ) -> None:
        self._require_admin(actor)
        if self.shutdown_mode:
            raise AccountingError("cannot reconfigure pauses during shutdown")
        self.pool_paused = bool(pool_paused)
        self.liquidity_paused = bool(liquidity_paused)
        self.lp_claims_paused = bool(lp_claims_paused)
        self._event(
            "PoolPauseChanged",
            pool_paused=self.pool_paused,
            liquidity_paused=self.liquidity_paused,
            lp_claims_paused=self.lp_claims_paused,
            shutdown_mode=self.shutdown_mode,
        )

    def configure_liquidity_limits(
        self,
        actor: str,
        max_rfl_contribution: int,
        max_usd_contribution: int,
        max_withdrawal_share_bps: int,
    ) -> None:
        """Set caps on actual liquidity inputs and non-final LP burns."""
        self._require_admin(actor)
        self._require_amount(
            max_rfl_contribution, "max_rfl_contribution", allow_zero=False
        )
        self._require_amount(
            max_usd_contribution, "max_usd_contribution", allow_zero=False
        )
        self._require_amount(
            max_withdrawal_share_bps,
            "max_withdrawal_share_bps",
            allow_zero=False,
        )
        if max_withdrawal_share_bps > BPS_DENOMINATOR:
            raise AccountingError("max withdrawal share must not exceed 10,000 bps")
        self.max_liquidity_rfl = max_rfl_contribution
        self.max_liquidity_usd = max_usd_contribution
        self.max_withdrawal_share_bps = max_withdrawal_share_bps
        self._event(
            "LiquidityLimitsChanged",
            max_rfl_contribution=max_rfl_contribution,
            max_usd_contribution=max_usd_contribution,
            max_withdrawal_share_bps=max_withdrawal_share_bps,
        )

    def liquidity_limits(self) -> tuple[int, int, int]:
        return (
            self.max_liquidity_rfl,
            self.max_liquidity_usd,
            self.max_withdrawal_share_bps,
        )

    def mint_quote(self, actor: str, recipient: str, amount: int) -> None:
        self._require_admin(actor)
        self._require_amount(amount, "amount", allow_zero=False)
        self.quote[recipient] = self.quote_balance(recipient) + amount
        self._event("MockUsdMinted", recipient=recipient, amount=amount)

    def faucet_grant(self, actor: str, recipient: str, amount: int) -> None:
        """Untaxed grant that also authenticates/registers the recipient."""
        self._require_admin(actor)
        self._require_amount(amount, "amount", allow_zero=False)
        if amount > self.distribution_vault_balance:
            raise AccountingError("insufficient distribution-vault balance")
        self._validate_wallet_registration(recipient)
        self._register_wallet(recipient)
        self._debit_excluded("distribution_vault", amount)
        self._credit_wallet(recipient, amount)
        self._event("FaucetGrant", recipient=recipient, amount=amount)

    def seed_pool(
        self,
        actor: str,
        rfl_amount: int,
        usd_amount: int,
        *,
        beneficiary: str,
        min_lp_shares: int = 1,
    ) -> LiquidityResult:
        """Controlled first bootstrap with every LP share assigned."""
        self._require_admin(actor)
        self._validate_bootstrap(beneficiary, rfl_amount, usd_amount, min_lp_shares)
        if self.seeded or self.pool_rfl_reserve or self.pool_usd_reserve:
            raise AccountingError("pool is already seeded")
        epoch = self.active_lp_epoch()
        if epoch.epoch_id != 1 or epoch.total_shares != 0:
            raise AccountingError("first bootstrap requires the empty first epoch")
        shares = math.isqrt(rfl_amount * usd_amount)
        if shares < min_lp_shares:
            raise AccountingError("initial LP shares are below the minimum")
        if rfl_amount > self.distribution_vault_balance:
            raise AccountingError("insufficient distribution-vault balance")
        if usd_amount > self.quote_balance(actor):
            raise AccountingError("insufficient admin mock USD")

        self._debit_excluded("distribution_vault", rfl_amount)
        self._credit_custody(rfl_amount)
        self.quote[actor] = self.quote_balance(actor) - usd_amount
        self.quote["pool"] = self.pool_usd_reserve + usd_amount
        self._mint_lp(epoch, beneficiary, shares)
        self.seeded = True
        result = LiquidityResult(epoch.epoch_id, shares, rfl_amount, usd_amount)
        self._event("LiquiditySeeded", provider=beneficiary, **result.__dict__)
        return result

    def reseed_pool(
        self,
        actor: str,
        rfl_amount: int,
        usd_amount: int,
        *,
        beneficiary: str,
        min_lp_shares: int = 1,
    ) -> LiquidityResult:
        """Open a fresh epoch after a complete shutdown reserve exit."""
        self._require_admin(actor)
        self._validate_bootstrap(beneficiary, rfl_amount, usd_amount, min_lp_shares)
        if self.seeded or self.shutdown_mode or self.active_epoch is not None:
            raise AccountingError("previous pool epoch is still active")
        if self.pool_rfl_reserve or self.pool_usd_reserve or self.pool_pending_rewards():
            raise AccountingError("custody must be completely empty before reseed")
        shares = math.isqrt(rfl_amount * usd_amount)
        if shares < min_lp_shares:
            raise AccountingError("initial LP shares are below the minimum")
        if rfl_amount > self.distribution_vault_balance:
            raise AccountingError("insufficient distribution-vault balance")
        if usd_amount > self.quote_balance(actor):
            raise AccountingError("insufficient admin mock USD")

        epoch_id = self.next_epoch
        self.next_epoch += 1
        vault = self._lp_vault_name(epoch_id)
        self.raw[vault] = 0
        self.exclusions.add(vault)
        epoch = LpEpoch(epoch_id, vault)
        self.lp_epochs[epoch_id] = epoch
        self.active_epoch = epoch_id
        self._debit_excluded("distribution_vault", rfl_amount)
        self._credit_custody(rfl_amount)
        self.quote[actor] = self.quote_balance(actor) - usd_amount
        self.quote["pool"] = self.pool_usd_reserve + usd_amount
        self._mint_lp(epoch, beneficiary, shares)
        self.seeded = True
        result = LiquidityResult(epoch_id, shares, rfl_amount, usd_amount)
        self._event("LpEpochOpened", epoch=epoch_id, vault=vault)
        self._event("LiquiditySeeded", provider=beneficiary, **result.__dict__)
        return result

    def begin_shutdown(self, actor: str) -> None:
        self._require_admin(actor)
        if not self.seeded:
            raise AccountingError("pool is not seeded")
        self.pool_paused = True
        self.shutdown_mode = True
        self.liquidity_paused = False
        self._event("PoolShutdownStarted", epoch=self.active_lp_epoch().epoch_id)

    # ------------------------------------------------------------------
    # Wallet operations
    # ------------------------------------------------------------------
    def transfer(self, sender: str, recipient: str, amount: int, *, auto_materialize: bool = True) -> None:
        """Untaxed primary-wallet transfer; unsupported custody fails closed."""
        self._require_unlocked()
        self._require_amount(amount, "amount", allow_zero=False)
        if sender not in self.registered_wallets or recipient not in self.registered_wallets:
            raise PoolBypassError("both endpoints must be registered primary wallets")
        self._ensure_spendable(sender, amount, auto_materialize=auto_materialize)
        self._debit_wallet(sender, amount)
        self._credit_wallet(recipient, amount)
        self._event("WalletTransfer", sender=sender, recipient=recipient, amount=amount)

    def claim(self, account: str, amount: Optional[int] = None) -> int:
        """Materialise a core wallet reward without changing effective value."""
        self._require_unlocked()
        if self.claims_paused:
            raise AccountingError("claims are paused")
        self._require_registered_wallet(account)
        available = self.pending(account)
        amount = available if amount is None else amount
        self._require_amount(amount, "amount", allow_zero=False)
        if amount > available:
            raise AccountingError("claim exceeds pending rewards")
        self._materialize(account, amount, event_name="RewardsClaimed")
        return amount

    # ------------------------------------------------------------------
    # Canonical AMM swaps
    # ------------------------------------------------------------------
    def sell(self, seller: str, gross_rfl: int, *, min_quote_out: int = 0) -> SwapResult:
        """Sell tRFL; the pre-trade custody reserve participates exactly once."""
        self._require_swaps_live()
        self._require_amount(gross_rfl, "gross_rfl", allow_zero=False)
        self._require_amount(min_quote_out, "min_quote_out")
        with self._guard("swap"):
            self._require_registered_wallet(seller)
            self._validate_spendable(seller, gross_rfl, auto_materialize=True)
            reflection_fee = self._reflection_fee(gross_rfl)
            net_rfl = gross_rfl - reflection_fee
            invariant_input = self._amm_invariant_input(net_rfl)
            quote_out = self._constant_product_output(
                self.pool_usd_reserve, self.pool_rfl_reserve, invariant_input
            )
            if quote_out <= 0:
                raise AccountingError("swap output rounds to zero")
            if quote_out < min_quote_out:
                raise AccountingError("slippage: net quote output below minimum")

            # Debit gross first.  The fee advances across the seller's remaining
            # wallet units and the pre-trade custody units.  New reserve units
            # are attached only after that advance and receive no historical fee.
            self._ensure_spendable(seller, gross_rfl, auto_materialize=True)
            self._debit_wallet(seller, gross_rfl)
            self._credit_excluded("reward_vault", reflection_fee)
            self._advance_index(reflection_fee)
            self._credit_custody(net_rfl)
            self.quote["pool"] = self.pool_usd_reserve - quote_out
            self.quote[seller] = self.quote_balance(seller) + quote_out
            result = SwapResult(
                direction="sell",
                gross_amount=gross_rfl,
                reflection_fee=reflection_fee,
                net_rfl_amount=net_rfl,
                amm_fee=net_rfl - invariant_input,
                invariant_input=invariant_input,
                quote_amount=quote_out,
            )
            self._event("SwapExecuted", trader=seller, **result.__dict__)
            return result

    def buy(self, buyer: str, quote_in: int, *, min_net_rfl_out: int = 0) -> SwapResult:
        """Buy tRFL; purchased units cannot capture their own reflection fee."""
        self._require_swaps_live()
        self._require_amount(quote_in, "quote_in", allow_zero=False)
        self._require_amount(min_net_rfl_out, "min_net_rfl_out")
        with self._guard("swap"):
            if quote_in > self.quote_balance(buyer):
                raise AccountingError("insufficient mock USD")
            self._validate_wallet_registration(buyer)
            invariant_input = self._amm_invariant_input(quote_in)
            gross_rfl = self._constant_product_output(
                self.pool_rfl_reserve, self.pool_usd_reserve, invariant_input
            )
            if gross_rfl <= 0:
                raise AccountingError("swap output rounds to zero")
            reflection_fee = self._reflection_fee(gross_rfl)
            net_rfl = gross_rfl - reflection_fee
            if net_rfl <= 0 or net_rfl < min_net_rfl_out:
                raise AccountingError("slippage: net tRFL receipt below minimum")

            self.quote[buyer] = self.quote_balance(buyer) - quote_in
            self.quote["pool"] = self.pool_usd_reserve + quote_in
            self._debit_custody(gross_rfl)
            self._credit_excluded("reward_vault", reflection_fee)
            self._advance_index(reflection_fee)
            self._register_wallet(buyer)
            self._credit_wallet(buyer, net_rfl)
            result = SwapResult(
                direction="buy",
                gross_amount=gross_rfl,
                reflection_fee=reflection_fee,
                net_rfl_amount=net_rfl,
                amm_fee=quote_in - invariant_input,
                invariant_input=invariant_input,
                quote_amount=quote_in,
            )
            self._event("SwapExecuted", trader=buyer, **result.__dict__)
            return result

    # ------------------------------------------------------------------
    # Custody routing and LP operations
    # ------------------------------------------------------------------
    def checkpoint_pool(self) -> int:
        """Route all pool custody pending to the active LP epoch."""
        self._require_unlocked()
        if not self.seeded:
            raise AccountingError("pool is not seeded")
        with self._atomic(epoch_ids=(self.active_epoch,)), self._guard("checkpoint"):
            return self._checkpoint_active()

    def add_liquidity(
        self,
        provider: str,
        max_rfl: int,
        max_usd: int,
        *,
        min_lp_shares: int = 1,
    ) -> LiquidityResult:
        self._require_unlocked()
        self._require_amount(max_rfl, "max_rfl", allow_zero=False)
        self._require_amount(max_usd, "max_usd", allow_zero=False)
        self._require_amount(min_lp_shares, "min_lp_shares", allow_zero=False)
        self._require_registered_wallet(provider)
        if not self.seeded or self.liquidity_paused or self.shutdown_mode:
            raise AccountingError("liquidity additions are not live")
        with self._atomic(
            accounts=(provider,), epoch_ids=(self.active_epoch,)
        ), self._guard("liquidity"):
            self._checkpoint_active()
            epoch = self.active_lp_epoch()
            shares, rfl_used, usd_used = self.liquidity_mint_amounts(
                max_rfl,
                max_usd,
                self.pool_rfl_reserve,
                self.pool_usd_reserve,
                epoch.total_shares,
            )
            if rfl_used > self.max_liquidity_rfl or usd_used > self.max_liquidity_usd:
                raise AccountingError("actual liquidity contribution exceeds configured limit")
            if shares < min_lp_shares:
                raise AccountingError("minted LP shares are below the minimum")
            self._ensure_spendable(provider, rfl_used, auto_materialize=True)
            if usd_used > self.quote_balance(provider):
                raise AccountingError("insufficient mock USD")
            self._debit_wallet(provider, rfl_used)
            self._credit_custody(rfl_used)
            self.quote[provider] = self.quote_balance(provider) - usd_used
            self.quote["pool"] = self.pool_usd_reserve + usd_used
            self._mint_lp(epoch, provider, shares)
            result = LiquidityResult(epoch.epoch_id, shares, rfl_used, usd_used)
            self._event("LiquidityAdded", provider=provider, **result.__dict__)
            return result

    def remove_liquidity(
        self,
        provider: str,
        shares: int,
        *,
        min_rfl_output: int = 0,
        min_usd_output: int = 0,
    ) -> LiquidityResult:
        self._require_unlocked()
        self._require_amount(shares, "shares", allow_zero=False)
        self._require_amount(min_rfl_output, "min_rfl_output")
        self._require_amount(min_usd_output, "min_usd_output")
        if not self.seeded or (self.liquidity_paused and not self.shutdown_mode):
            raise AccountingError("liquidity removals are not live")
        with self._atomic(
            accounts=(provider,), epoch_ids=(self.active_epoch,)
        ), self._guard("liquidity"):
            self._checkpoint_active()
            epoch = self.active_lp_epoch()
            if shares > self.lp_shares(epoch.epoch_id, provider):
                raise AccountingError("insufficient LP shares")
            total = epoch.total_shares
            final_exit = shares == total
            if final_exit and not self.shutdown_mode:
                raise AccountingError("final reserve exit requires shutdown mode")
            if (
                not final_exit
                and shares * BPS_DENOMINATOR
                > total * self.max_withdrawal_share_bps
            ):
                raise AccountingError("non-final LP burn exceeds configured share limit")
            rfl_out, usd_out = self.liquidity_withdrawal_amounts(
                shares,
                total,
                self.pool_rfl_reserve,
                self.pool_usd_reserve,
            )
            if rfl_out <= 0 or usd_out <= 0:
                raise AccountingError("liquidity output rounds to zero")
            if rfl_out < min_rfl_output or usd_out < min_usd_output:
                raise AccountingError("liquidity output is below the minimum")

            self._burn_lp(epoch, provider, shares)
            self._debit_custody(rfl_out)
            self._register_wallet(provider)
            self._credit_wallet(provider, rfl_out)
            self.quote["pool"] = self.pool_usd_reserve - usd_out
            self.quote[provider] = self.quote_balance(provider) + usd_out
            if final_exit:
                if self.pool_rfl_reserve or self.pool_usd_reserve or self.pool_pending_rewards():
                    raise AssertionError("final exit left custody state behind")
                epoch.status = LP_CLAIM_ONLY
                self.active_epoch = None
                self.seeded = False
                self.shutdown_mode = False
            result = LiquidityResult(epoch.epoch_id, shares, rfl_out, usd_out, final_exit)
            self._event("LiquidityRemoved", provider=provider, **result.__dict__)
            return result

    def transfer_lp_shares(self, sender: str, recipient: str, shares: int) -> None:
        self._require_unlocked()
        self._require_amount(shares, "shares", allow_zero=False)
        if sender == recipient:
            raise AccountingError("LP share recipient must differ from sender")
        self._require_registered_wallet(sender)
        self._require_registered_wallet(recipient)
        if self.liquidity_paused or self.shutdown_mode:
            raise AccountingError("LP share transfers are paused")
        with self._atomic(
            accounts=(sender, recipient), epoch_ids=(self.active_epoch,)
        ), self._guard("lp-transfer"):
            self._checkpoint_active()
            epoch = self.active_lp_epoch()
            self._transfer_lp(epoch, sender, recipient, shares)
            self._event(
                "LpSharesTransferred",
                epoch=epoch.epoch_id,
                sender=sender,
                recipient=recipient,
                amount=shares,
            )

    def claim_lp(self, owner: str, epoch_id: int, amount: Optional[int] = None) -> int:
        """Pay an LP reward into a wallet at the current core index."""
        self._require_unlocked()
        if self.lp_claims_paused:
            raise AccountingError("LP claims are paused")
        self._require_registered_wallet(owner)
        with self._atomic(
            accounts=(owner,), epoch_ids=(epoch_id, self.active_epoch)
        ), self._guard("lp-claim"):
            if self.active_epoch == epoch_id:
                self._checkpoint_active()
            epoch = self.lp_epoch(epoch_id)
            if epoch.status not in {LP_ACTIVE, LP_CLAIM_ONLY}:
                raise AccountingError("LP epoch is not claimable")
            available = epoch.pending(owner)
            amount = available if amount in {None, 0} else amount
            self._require_amount(amount, "amount", allow_zero=False)
            if amount > available:
                raise AccountingError("LP claim exceeds pending rewards")

            position = epoch.positions[owner]
            position.claimed += amount
            epoch.lifetime_claimed += amount
            self._debit_excluded(epoch.vault, amount)
            # Correction on this core wallet credit excludes every historical
            # core index increment, including the one that funded the LP claim.
            self._credit_wallet(owner, amount)
            self._recompute_lp_rounding(epoch)
            self._event("LpRewardsClaimed", epoch=epoch_id, owner=owner, amount=amount)
            return amount

    # ------------------------------------------------------------------
    # Proportional liquidity arithmetic
    # ------------------------------------------------------------------
    @staticmethod
    def liquidity_mint_amounts(
        max_rfl: int,
        max_usd: int,
        reserve_rfl: int,
        reserve_usd: int,
        total_shares: int,
    ) -> tuple[int, int, int]:
        if min(max_rfl, max_usd, reserve_rfl, reserve_usd, total_shares) <= 0:
            raise AccountingError("proportional liquidity inputs must be positive")
        shares = min(
            max_rfl * total_shares // reserve_rfl,
            max_usd * total_shares // reserve_usd,
        )
        if shares <= 0:
            raise AccountingError("liquidity share output rounds to zero")
        rfl_used = ReflectionModel._ceil_div(shares * reserve_rfl, total_shares)
        usd_used = ReflectionModel._ceil_div(shares * reserve_usd, total_shares)
        if rfl_used <= 0 or usd_used <= 0 or rfl_used > max_rfl or usd_used > max_usd:
            raise AccountingError("liquidity input is not representably proportional")
        return shares, rfl_used, usd_used

    @staticmethod
    def liquidity_withdrawal_amounts(
        shares: int,
        total_shares: int,
        reserve_rfl: int,
        reserve_usd: int,
    ) -> tuple[int, int]:
        if shares <= 0 or total_shares <= 0 or shares > total_shares:
            raise AccountingError("invalid LP burn amount")
        if shares == total_shares:
            return reserve_rfl, reserve_usd
        return (
            shares * reserve_rfl // total_shares,
            shares * reserve_usd // total_shares,
        )

    # ------------------------------------------------------------------
    # Test-vector support and invariant audits
    # ------------------------------------------------------------------
    def apply_operation(self, operation: Mapping[str, Any]) -> Any:
        op = str(operation["op"])
        args = {key: value for key, value in operation.items() if key != "op"}
        handlers = {
            "register_wallet": self.register_wallet,
            "mint_quote": self.mint_quote,
            "faucet_grant": self.faucet_grant,
            "seed_pool": self.seed_pool,
            "reseed_pool": self.reseed_pool,
            "transfer": self.transfer,
            "claim": self.claim,
            "sell": self.sell,
            "buy": self.buy,
            "checkpoint_pool": self.checkpoint_pool,
            "add_liquidity": self.add_liquidity,
            "remove_liquidity": self.remove_liquidity,
            "transfer_lp_shares": self.transfer_lp_shares,
            "claim_lp": self.claim_lp,
            "begin_shutdown": self.begin_shutdown,
            "configure_liquidity_limits": self.configure_liquidity_limits,
            "set_fee_bps": self.set_fee_bps,
            "set_swaps_paused": self.set_swaps_paused,
            "set_claims_paused": self.set_claims_paused,
        }
        try:
            handler = handlers[op]
        except KeyError as exc:
            raise AccountingError(f"unknown test-vector operation: {op}") from exc
        return handler(**args)

    def assert_fast_invariants(self) -> None:
        """O(epochs) checks suitable for every randomized operation."""
        if not 0 <= self.fee_bps <= 100:
            raise AssertionError("reflection fee is outside the 0-100 bps policy")
        if self.max_liquidity_rfl <= 0 or self.max_liquidity_usd <= 0:
            raise AssertionError("liquidity contribution limits must be positive")
        if not 0 < self.max_withdrawal_share_bps <= BPS_DENOMINATOR:
            raise AssertionError("withdrawal share limit is outside 1-10,000 bps")
        if self.total_shares < 0 or self.custody_shares < 0:
            raise AssertionError("negative core shares")
        if not 0 <= self.index <= MAX_U256:
            raise AssertionError("core index is outside u256")
        if self.index_remainder < 0:
            raise AssertionError("negative core index remainder")
        if min(self.reward_vault_balance, self.pool_rfl_reserve, self.pool_usd_reserve) < 0:
            raise AssertionError("negative protocol reserve")
        if self.pool_rfl_reserve != self.custody_shares:
            raise AssertionError("raw pool reserve and custody shares diverged")
        if self.reward_vault_balance != (
            self.lifetime_fees
            - self.lifetime_materialized
            - self.lifetime_custody_routed
        ):
            raise AssertionError("core reward-vault movement is not fee-backed")
        if self.reward_vault_balance != (
            self.reflection_liability() + self.unallocated_fees + self.rounding_reserve
        ):
            raise AssertionError("core reward vault does not equal its named buckets")
        if sum(epoch.lifetime_received for epoch in self.lp_epochs.values()) != self.lifetime_custody_routed:
            raise AssertionError("custody route is not represented in exactly one LP epoch")
        for epoch in self.lp_epochs.values():
            if self.lp_vault_balance(epoch.epoch_id) != epoch.lifetime_received - epoch.lifetime_claimed:
                raise AssertionError("LP vault movement is not route-backed")
            if self.lp_vault_balance(epoch.epoch_id) != (
                epoch.aggregate_liability()
                + epoch.unallocated_rewards
                + epoch.rounding_reserve
            ):
                raise AssertionError("LP vault does not equal its named buckets")

    def assert_invariants(self) -> None:
        """Complete O(wallets + LP positions) invariant audit."""
        self.assert_fast_invariants()
        if sum(self.raw.values()) != self.fixed_supply:
            raise AssertionError("raw tRFL supply changed")
        wallet_shares = sum(self.raw_balance(account) for account in self.registered_wallets)
        if self.total_shares != wallet_shares + self.custody_shares:
            raise AssertionError("core total shares do not equal wallets plus custody")
        calculated_correction = self.custody_correction + sum(
            self.correction.get(account, 0) for account in self.registered_wallets
        )
        if calculated_correction != self.aggregate_correction:
            raise AssertionError("aggregate core correction drifted")
        if "pool" in self.registered_wallets:
            raise AssertionError("pool was double-counted as a wallet position")
        if sum(self.pending(account) for account in self.registered_wallets) + self.pool_pending_rewards() > self.reflection_liability():
            raise AssertionError("individual core pending exceeds aggregate liability")
        for account in self.registered_wallets:
            if account in self.exclusions:
                raise AssertionError("registered wallet is also excluded")
            if self.raw_balance(account) < 0 or self.pending(account) < 0:
                raise AssertionError(f"invalid registered wallet position: {account}")
        for account, balance in self.raw.items():
            if balance < 0:
                raise AssertionError(f"negative raw balance for {account}")
            if account not in self.registered_wallets and account not in self.exclusions:
                raise AssertionError(f"unsupported raw custody was silently accepted: {account}")

        active_count = 0
        for epoch_id, epoch in self.lp_epochs.items():
            if epoch.epoch_id != epoch_id or epoch.vault not in self.exclusions:
                raise AssertionError("LP epoch identity or vault exclusion drifted")
            if epoch.status == LP_ACTIVE:
                active_count += 1
                if self.active_epoch != epoch_id:
                    raise AssertionError("active LP status is not the routed epoch")
            elif epoch.status != LP_CLAIM_ONLY:
                raise AssertionError("unknown LP epoch status")
            calculated_shares = sum(position.shares for position in epoch.positions.values())
            calculated_lp_correction = sum(position.correction for position in epoch.positions.values())
            if calculated_shares != epoch.total_shares:
                raise AssertionError("LP total shares do not equal its positions")
            if calculated_lp_correction != epoch.aggregate_correction:
                raise AssertionError("aggregate LP correction drifted")
            if sum(epoch.pending(owner) for owner in epoch.positions) > epoch.aggregate_liability():
                raise AssertionError("individual LP pending exceeds aggregate liability")
            for owner, position in epoch.positions.items():
                if owner not in self.registered_wallets:
                    raise AssertionError("LP share owner is not a registered wallet")
                if position.shares < 0 or position.claimed < 0 or epoch.pending(owner) < 0:
                    raise AssertionError("invalid LP position")
        if active_count != (1 if self.active_epoch is not None else 0):
            raise AssertionError("LP active-epoch registry drifted")
        if self.active_epoch is not None and self.active_lp_epoch().total_shares == 0:
            if self.pool_rfl_reserve or self.custody_shares or self.pool_pending_rewards():
                raise AssertionError("zero LP shares coexist with live custody")
        if self.seeded:
            epoch = self.active_lp_epoch()
            if epoch.total_shares <= 0 or self.pool_rfl_reserve <= 0 or self.pool_usd_reserve <= 0:
                raise AssertionError("seeded pool lacks reserves or LP shares")
        elif self.pool_rfl_reserve or self.pool_usd_reserve:
            raise AssertionError("unseeded pool retains pricing reserves")

    # ------------------------------------------------------------------
    # Internal core accounting primitives
    # ------------------------------------------------------------------
    def _register_wallet(self, account: str) -> None:
        self._validate_wallet_registration(account)
        if account in self.registered_wallets:
            return
        self.registered_wallets.add(account)
        self.raw.setdefault(account, 0)
        self.quote.setdefault(account, 0)
        self.correction.setdefault(account, 0)
        self.materialized.setdefault(account, 0)

    def _validate_wallet_registration(self, account: str) -> None:
        if account in self.registered_wallets:
            return
        if account in self.exclusions or account in self.CORE_STORES or account == self.admin:
            raise AccountingError("protocol and excluded stores cannot register as wallets")
        if self.raw_balance(account) != 0:
            raise PoolBypassError("unregistered custody already holds tRFL")

    def _require_registered_wallet(self, account: str) -> None:
        if account not in self.registered_wallets:
            raise PoolBypassError("registered primary wallet required")

    def _debit_wallet(self, account: str, amount: int) -> None:
        self._require_registered_wallet(account)
        if amount > self.raw_balance(account):
            raise AccountingError("insufficient raw tRFL")
        self.raw[account] = self.raw_balance(account) - amount
        self.total_shares -= amount
        delta = _checked_u256_product(self.index, amount, "wallet debit correction")
        self._adjust_wallet_correction(account, delta)
        self._adjust_aggregate_correction(delta)

    def _credit_wallet(self, account: str, amount: int) -> None:
        self._require_registered_wallet(account)
        self.raw[account] = self.raw_balance(account) + amount
        self.total_shares += amount
        delta = _checked_u256_product(self.index, amount, "wallet credit correction")
        self._adjust_wallet_correction(account, -delta)
        self._adjust_aggregate_correction(-delta)

    def _debit_custody(self, amount: int) -> None:
        if amount > self.custody_shares or amount > self.pool_rfl_reserve:
            raise AccountingError("insufficient canonical custody")
        self.raw["pool"] = self.pool_rfl_reserve - amount
        self.custody_shares -= amount
        self.total_shares -= amount
        delta = _checked_u256_product(self.index, amount, "custody debit correction")
        self._adjust_custody_correction(delta)
        self._adjust_aggregate_correction(delta)

    def _credit_custody(self, amount: int) -> None:
        self.raw["pool"] = self.pool_rfl_reserve + amount
        self.custody_shares += amount
        self.total_shares += amount
        delta = _checked_u256_product(self.index, amount, "custody credit correction")
        self._adjust_custody_correction(-delta)
        self._adjust_aggregate_correction(-delta)

    def _debit_excluded(self, account: str, amount: int) -> None:
        if account not in self.exclusions:
            raise AccountingError("expected excluded sender")
        if amount > self.raw_balance(account):
            raise AccountingError("insufficient excluded tRFL")
        self.raw[account] = self.raw_balance(account) - amount

    def _credit_excluded(self, account: str, amount: int) -> None:
        if account not in self.exclusions:
            raise AccountingError("expected excluded recipient")
        self.raw[account] = self.raw_balance(account) + amount

    def _ensure_spendable(self, account: str, amount: int, *, auto_materialize: bool) -> None:
        self._validate_spendable(account, amount, auto_materialize=auto_materialize)
        shortfall = amount - self.raw_balance(account)
        if shortfall > 0:
            self._materialize(account, shortfall, event_name="RewardsMaterialized")

    def _validate_spendable(self, account: str, amount: int, *, auto_materialize: bool) -> None:
        self._require_registered_wallet(account)
        shortfall = amount - self.raw_balance(account)
        if shortfall <= 0:
            return
        if not auto_materialize:
            raise AccountingError("automatic materialisation is disabled")
        if self.claims_paused:
            raise AccountingError("claims are paused; pending balance cannot be spent")
        if shortfall > self.pending(account):
            raise AccountingError("insufficient effective tRFL")

    def _materialize(self, account: str, amount: int, *, event_name: str) -> None:
        if amount > self.pending(account) or amount > self.reward_vault_balance:
            raise AccountingError("materialisation exceeds backed pending rewards")
        self._debit_excluded("reward_vault", amount)
        self._credit_wallet(account, amount)
        self.materialized[account] = self.materialized.get(account, 0) + amount
        self.lifetime_materialized += amount
        self._event(event_name, account=account, amount=amount)

    def _advance_index(self, fee: int) -> None:
        if fee == 0:
            return
        self.lifetime_fees += fee
        if self.total_shares == 0:
            self.unallocated_fees += fee
            self._recompute_core_rounding()
            self._event("ReflectionFeeCollected", fee=fee, allocated=False)
            return
        numerator = _checked_u256_product(fee, MAGNITUDE, "core index numerator")
        if numerator + self.index_remainder > MAX_U256:
            raise AccountingError("core index numerator exceeds u256")
        numerator += self.index_remainder
        increment, self.index_remainder = divmod(numerator, self.total_shares)
        if self.index + increment > MAX_U256:
            raise AccountingError("global reflection index exceeds u256")
        self.index += increment
        self._recompute_core_rounding()
        self._event("ReflectionFeeCollected", fee=fee, allocated=True)
        self._event(
            "ReflectionIndexAdvanced",
            increment=increment,
            index=self.index,
            remainder=self.index_remainder,
            rounding_reserve=self.rounding_reserve,
        )

    def _recompute_core_rounding(self) -> None:
        named = self.reflection_liability() + self.unallocated_fees
        if named > self.reward_vault_balance:
            raise AssertionError("core reward vault is undercollateralised")
        self.rounding_reserve = self.reward_vault_balance - named

    # ------------------------------------------------------------------
    # Internal custody and LP accounting primitives
    # ------------------------------------------------------------------
    def _checkpoint_active(self) -> int:
        epoch = self._assert_active_epoch_healthy()
        if self.claims_paused:
            raise AccountingError("core claims and custody routing are paused")
        amount = self.pool_pending_rewards()
        if amount == 0:
            return 0
        if amount > self.reward_vault_balance:
            raise AssertionError("custody reward is missing from core vault")

        before_reserves = (self.pool_rfl_reserve, self.pool_usd_reserve)
        self._debit_excluded("reward_vault", amount)
        self._credit_excluded(epoch.vault, amount)
        self.custody_settled += amount
        self.lifetime_custody_routed += amount
        self._receive_lp_reward(epoch, amount)
        if before_reserves != (self.pool_rfl_reserve, self.pool_usd_reserve):
            raise AssertionError("custody checkpoint mutated AMM reserves")
        self._event("CustodyRewardsRouted", epoch=epoch.epoch_id, amount=amount)
        return amount

    def _receive_lp_reward(self, epoch: LpEpoch, amount: int) -> None:
        self._assert_epoch_healthy(epoch)
        epoch.lifetime_received += amount
        numerator = _checked_u256_product(amount, MAGNITUDE, "LP index numerator")
        if numerator + epoch.index_remainder > MAX_U256:
            raise AccountingError("LP index numerator exceeds u256")
        numerator += epoch.index_remainder
        increment, epoch.index_remainder = divmod(numerator, epoch.total_shares)
        if epoch.index + increment > MAX_U256:
            raise AccountingError("LP reward index exceeds u256")
        epoch.index += increment
        self._recompute_lp_rounding(epoch)
        self._event(
            "LpRewardIndexAdvanced",
            epoch=epoch.epoch_id,
            amount=amount,
            increment=increment,
            index=epoch.index,
            remainder=epoch.index_remainder,
            rounding_reserve=epoch.rounding_reserve,
        )

    def _mint_lp(self, epoch: LpEpoch, owner: str, amount: int) -> None:
        self._assert_lp_mutable(epoch)
        self._require_registered_wallet(owner)
        self._require_amount(amount, "LP mint amount", allow_zero=False)
        position = epoch.positions.setdefault(owner, LpPosition())
        if epoch.total_shares + amount > MAX_U128 or position.shares + amount > MAX_U128:
            raise AccountingError("LP share supply exceeds u128")
        delta = _checked_u256_product(amount, epoch.index, "LP mint correction")
        position.shares += amount
        self._adjust_lp_position_correction(position, -delta)
        epoch.total_shares += amount
        self._adjust_lp_aggregate_correction(epoch, -delta)

    def _burn_lp(self, epoch: LpEpoch, owner: str, amount: int) -> None:
        self._assert_lp_mutable(epoch)
        position = epoch.positions.get(owner)
        if position is None or amount > position.shares:
            raise AccountingError("insufficient LP shares")
        delta = _checked_u256_product(amount, epoch.index, "LP burn correction")
        position.shares -= amount
        self._adjust_lp_position_correction(position, delta)
        epoch.total_shares -= amount
        self._adjust_lp_aggregate_correction(epoch, delta)

    def _transfer_lp(self, epoch: LpEpoch, sender: str, recipient: str, amount: int) -> None:
        self._assert_lp_mutable(epoch)
        sender_position = epoch.positions.get(sender)
        if sender_position is None or amount > sender_position.shares:
            raise AccountingError("insufficient LP shares")
        recipient_position = epoch.positions.setdefault(recipient, LpPosition())
        delta = _checked_u256_product(amount, epoch.index, "LP transfer correction")
        sender_position.shares -= amount
        self._adjust_lp_position_correction(sender_position, delta)
        recipient_position.shares += amount
        self._adjust_lp_position_correction(recipient_position, -delta)

    def _recompute_lp_rounding(self, epoch: LpEpoch) -> None:
        named = epoch.aggregate_liability() + epoch.unallocated_rewards
        vault_balance = self.lp_vault_balance(epoch.epoch_id)
        if named > vault_balance:
            raise AssertionError("LP reward vault is undercollateralised")
        epoch.rounding_reserve = vault_balance - named

    @staticmethod
    def _assert_lp_mutable(epoch: LpEpoch) -> None:
        if epoch.status != LP_ACTIVE:
            raise AccountingError("LP epoch is not active")
        if epoch.quarantined:
            raise AccountingError("LP epoch is quarantined after zero-share routing")

    @staticmethod
    def _assert_epoch_healthy(epoch: LpEpoch) -> LpEpoch:
        if epoch.status != LP_ACTIVE:
            raise AccountingError("active LP epoch is not ACTIVE")
        if epoch.total_shares <= 0:
            raise AccountingError("active LP epoch has no shares")
        if epoch.quarantined:
            raise AccountingError("active LP epoch is quarantined")
        return epoch

    def _assert_active_epoch_healthy(self) -> LpEpoch:
        if self.active_epoch is None:
            raise AccountingError("no active LP epoch")
        return self._assert_epoch_healthy(self.active_lp_epoch())

    # ------------------------------------------------------------------
    # Validation and bounded arithmetic helpers
    # ------------------------------------------------------------------
    def _validate_bootstrap(
        self,
        beneficiary: str,
        rfl_amount: int,
        usd_amount: int,
        min_lp_shares: int,
    ) -> None:
        self._require_amount(rfl_amount, "rfl_amount", allow_zero=False)
        self._require_amount(usd_amount, "usd_amount", allow_zero=False)
        self._require_amount(min_lp_shares, "min_lp_shares", allow_zero=False)
        self._require_registered_wallet(beneficiary)
        if beneficiary == self.admin:
            raise AccountingError("operator cannot be the bootstrap LP beneficiary")

    def _adjust_wallet_correction(self, account: str, delta: int) -> None:
        updated = self.correction.get(account, 0) + delta
        self._require_signed_u256(updated, "wallet correction")
        self.correction[account] = updated

    def _adjust_custody_correction(self, delta: int) -> None:
        updated = self.custody_correction + delta
        self._require_signed_u256(updated, "custody correction")
        self.custody_correction = updated

    def _adjust_aggregate_correction(self, delta: int) -> None:
        updated = self.aggregate_correction + delta
        self._require_signed_u256(updated, "aggregate core correction")
        self.aggregate_correction = updated

    def _adjust_lp_position_correction(self, position: LpPosition, delta: int) -> None:
        updated = position.correction + delta
        self._require_signed_u256(updated, "LP position correction")
        position.correction = updated

    def _adjust_lp_aggregate_correction(self, epoch: LpEpoch, delta: int) -> None:
        updated = epoch.aggregate_correction + delta
        self._require_signed_u256(updated, "aggregate LP correction")
        epoch.aggregate_correction = updated

    def _reflection_fee(self, gross_amount: int) -> int:
        return gross_amount * self.fee_bps // 10_000

    def _amm_invariant_input(self, gross_input: int) -> int:
        return gross_input * (10_000 - self.amm_fee_bps) // 10_000

    @staticmethod
    def _constant_product_output(output_reserve: int, input_reserve: int, invariant_input: int) -> int:
        if input_reserve <= 0 or output_reserve <= 0:
            raise AccountingError("pool is not seeded")
        if invariant_input <= 0:
            raise AccountingError("AMM invariant input rounds to zero")
        return output_reserve * invariant_input // (input_reserve + invariant_input)

    def _require_swaps_live(self) -> None:
        self._require_unlocked()
        if not self.seeded:
            raise AccountingError("pool is not seeded")
        if self.swaps_paused or self.pool_paused or self.shutdown_mode:
            raise AccountingError("swaps are paused")
        self._assert_active_epoch_healthy()

    def _require_admin(self, actor: str) -> None:
        if actor != self.admin:
            raise AuthorizationError("admin authority required")

    def _require_unlocked(self) -> None:
        if self._lock is not None:
            raise AccountingError(f"re-entrant operation rejected while {self._lock} is active")

    @contextmanager
    def _guard(self, label: str) -> Iterator[None]:
        self._require_unlocked()
        self._lock = label
        try:
            yield
        finally:
            self._lock = None

    @contextmanager
    def _atomic(
        self,
        *,
        accounts: Iterable[str] = (),
        epoch_ids: Iterable[Optional[int]] = (),
    ) -> Iterator[None]:
        """Journal touched positions so a post-checkpoint abort is atomic.

        Copying a complete 1,024-position epoch for every randomized LP action
        would make the million-operation gate quadratic.  The canonical entry
        points touch at most two wallets and two epochs, so this records only
        those dictionary entries plus scalar protocol/epoch state.
        """
        if self._transaction_depth:
            self._transaction_depth += 1
            try:
                yield
            finally:
                self._transaction_depth -= 1
            return
        account_keys = set(accounts)
        selected_epoch_ids = {epoch_id for epoch_id in epoch_ids if epoch_id is not None}
        protocol_raw_keys = {"pool", "reward_vault"}
        for epoch_id in selected_epoch_ids:
            protocol_raw_keys.add(self.lp_epoch(epoch_id).vault)
        raw_keys = account_keys | protocol_raw_keys
        quote_keys = account_keys | {"pool"}

        scalar_backup = {
            key: value
            for key, value in self.__dict__.items()
            if key not in {"events", "_lock", "_transaction_depth"}
            and not isinstance(value, (dict, set, list))
        }
        raw_backup = {key: (key in self.raw, self.raw.get(key, 0)) for key in raw_keys}
        quote_backup = {key: (key in self.quote, self.quote.get(key, 0)) for key in quote_keys}
        correction_backup = {
            key: (key in self.correction, self.correction.get(key, 0)) for key in account_keys
        }
        materialized_backup = {
            key: (key in self.materialized, self.materialized.get(key, 0)) for key in account_keys
        }
        epoch_scalar_names = (
            "status",
            "index",
            "index_remainder",
            "total_shares",
            "aggregate_correction",
            "unallocated_rewards",
            "rounding_reserve",
            "lifetime_received",
            "lifetime_claimed",
            "quarantined",
        )
        epoch_backup: dict[int, tuple[dict[str, Any], dict[str, tuple[bool, Optional[LpPosition]]]]] = {}
        for epoch_id in selected_epoch_ids:
            epoch = self.lp_epoch(epoch_id)
            scalars = {name: getattr(epoch, name) for name in epoch_scalar_names}
            positions = {
                account: (
                    account in epoch.positions,
                    copy.deepcopy(epoch.positions.get(account)),
                )
                for account in account_keys
            }
            epoch_backup[epoch_id] = (scalars, positions)
        event_length = len(self.events)
        self._transaction_depth = 1
        try:
            yield
        except Exception:
            for key, value in scalar_backup.items():
                setattr(self, key, value)
            self._restore_dictionary_entries(self.raw, raw_backup)
            self._restore_dictionary_entries(self.quote, quote_backup)
            self._restore_dictionary_entries(self.correction, correction_backup)
            self._restore_dictionary_entries(self.materialized, materialized_backup)
            for epoch_id, (scalars, positions) in epoch_backup.items():
                epoch = self.lp_epoch(epoch_id)
                for name, value in scalars.items():
                    setattr(epoch, name, value)
                self._restore_dictionary_entries(epoch.positions, positions)
            del self.events[event_length:]
            self._lock = None
            raise
        finally:
            if self._transaction_depth:
                self._transaction_depth = 0

    @staticmethod
    def _restore_dictionary_entries(
        target: dict[Any, Any], backup: Mapping[Any, tuple[bool, Any]]
    ) -> None:
        for key, (present, value) in backup.items():
            if present:
                target[key] = value
            else:
                target.pop(key, None)

    def _event(self, name: str, **fields: Any) -> None:
        self.events.append({"event": name, **fields})

    @staticmethod
    def _lp_vault_name(epoch_id: int) -> str:
        return f"lp_reward_vault:{epoch_id}"

    @staticmethod
    def _ceil_div(numerator: int, denominator: int) -> int:
        if denominator <= 0:
            raise AccountingError("division denominator must be positive")
        return 0 if numerator == 0 else (numerator - 1) // denominator + 1

    @staticmethod
    def _require_signed_u256(value: int, name: str) -> None:
        if abs(value) > MAX_U256:
            raise AccountingError(f"{name} exceeds the supported u256 magnitude")

    @staticmethod
    def _require_amount(value: int, name: str, *, allow_zero: bool = True) -> None:
        if not isinstance(value, int) or isinstance(value, bool):
            raise AccountingError(f"{name} must be an integer")
        if value < 0 or value > MAX_U128 or (not allow_zero and value == 0):
            qualifier = "positive u128" if not allow_zero else "u128"
            raise AccountingError(f"{name} must be a {qualifier}")

    @staticmethod
    def _require_bps(value: int, name: str, *, maximum: int) -> None:
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= maximum:
            raise AccountingError(f"{name} must be between 0 and {maximum} basis points")
