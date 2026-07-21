"""Ownerless v0.2 automatic-reflection reference model.

This is intentionally a separate release model from :class:`ReflectionModel`,
which remains the legacy v0.1 pilot oracle.  The v0.2 surface has one creation
configuration, one launch seal, one LP epoch, and one permissionless terminal
close.  It has no post-launch owner, pause, fee, limit, or reseed authority.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from .model import (
    AccountingError,
    AuthorizationError,
    BPS_DENOMINATOR,
    DEFAULT_MAX_GROSS_SWAP,
    DEFAULT_MAX_LIQUIDITY_RFL,
    DEFAULT_MAX_LIQUIDITY_USD,
    DEFAULT_MAX_RESERVE_BPS,
    DEFAULT_MAX_WITHDRAWAL_SHARE_BPS,
    LiquidityResult,
    MAX_U64,
    ReflectionModel,
    SwapResult,
)


CONFIGURING = "CONFIGURING"
LIVE = "LIVE"
CLOSED = "CLOSED"

V02_RELEASE = "testnet-v0.2.0-ownerless"
V02_FIXED_SUPPLY = 1_000_000_000_000_000
V02_TOKEN_DECIMALS = 6
V02_DEFAULT_REFLECTION_FEE_BPS = 100
V02_MAX_REFLECTION_FEE_BPS = 500
V02_AMM_FEE_BPS = 30
V02_MAX_RESERVE_BPS = DEFAULT_MAX_RESERVE_BPS
V02_MAX_GROSS_SWAP = DEFAULT_MAX_GROSS_SWAP
V02_MAX_LIQUIDITY_RFL = DEFAULT_MAX_LIQUIDITY_RFL
V02_MAX_LIQUIDITY_USD = DEFAULT_MAX_LIQUIDITY_USD
V02_MAX_WITHDRAWAL_SHARE_BPS = DEFAULT_MAX_WITHDRAWAL_SHARE_BPS
V02_FAUCET_ACTOR = "v0.2-faucet"
V02_FAUCET_GRANT = 1_000_000_000
V02_FAUCET_TUSD_GRANT = 1_000_000_000
V02_FAUCET_COOLDOWN_SECONDS = 3_600
V02_BOOTSTRAP_LP = "bootstrap_lp"
V02_INITIAL_RFL_LIQUIDITY = 500_000_000
V02_INITIAL_TUSD_LIQUIDITY = 500_000_000

TRIGGER_MANUAL = 0
TRIGGER_SEND = 1
TRIGGER_RECEIVE = 2
TRIGGER_BUY_PRE = 3
TRIGGER_BUY_POST = 4
TRIGGER_SELL_PRE = 5
TRIGGER_SELL_POST = 6
TRIGGER_LIQUIDITY_IN = 7
TRIGGER_LIQUIDITY_OUT = 8
TRIGGER_LP_PAYOUT = 9
TRIGGER_FAUCET = 10

MATERIALIZATION_TRIGGERS = frozenset(range(TRIGGER_MANUAL, TRIGGER_FAUCET + 1))


class OwnerlessReflectionModel(ReflectionModel):
    """Independent v0.2 oracle with immutable automatic materialisation.

    The creator can fund and seed the initial launch only while CONFIGURING.
    ``seal_launch`` destroys that authority in the model.  Thereafter every
    economic endpoint is permissionless/user-authenticated and terminal reserve
    closure is driven by the final LP holder rather than an administrator.
    """

    def __init__(
        self,
        *,
        fixed_supply: int = V02_FIXED_SUPPLY,
        creator: str = "creator",
        reflection_fee_bps: int = V02_DEFAULT_REFLECTION_FEE_BPS,
        deployment_id: str = "cedra-reflect-ownerless-v0.2",
        network_label: str = "cedra-testnet",
        decimals: int = V02_TOKEN_DECIMALS,
    ) -> None:
        if fixed_supply != V02_FIXED_SUPPLY:
            raise AccountingError("ownerless v0.2 fixed supply is source-bound")
        if not deployment_id or deployment_id == "reflection-pilot-001":
            raise AccountingError("v0.2 requires a distinct non-empty deployment identity")
        if network_label != "cedra-testnet":
            raise AccountingError("ownerless v0.2 model is Testnet-bound")
        if decimals != V02_TOKEN_DECIMALS:
            raise AccountingError("ownerless v0.2 decimals are source-bound")
        super().__init__(
            fixed_supply=fixed_supply,
            fee_bps=reflection_fee_bps,
            amm_fee_bps=V02_AMM_FEE_BPS,
            automatic_materialization=True,
            max_reserve_bps=V02_MAX_RESERVE_BPS,
            max_gross_swap=V02_MAX_GROSS_SWAP,
            admin=creator,
            _maximum_reflection_fee_bps=V02_MAX_REFLECTION_FEE_BPS,
        )
        self.creator = creator
        self.deployment_id = deployment_id
        self.network_label = network_label
        self.release_identity = V02_RELEASE
        self.decimals = decimals
        self.lifecycle = CONFIGURING
        self._creation_reflection_fee_bps = reflection_fee_bps
        self.faucet_trfl_grant = V02_FAUCET_GRANT
        self.faucet_tusd_grant = V02_FAUCET_TUSD_GRANT
        self.faucet_cooldown_seconds = V02_FAUCET_COOLDOWN_SECONDS
        self.clock_seconds = 0
        self.last_trfl_claim: dict[str, int] = {}
        self.last_tusd_claim: dict[str, int] = {}

        # The launch transaction mints exactly the source-bound bootstrap tUSD
        # and consumes it into the canonical pool. It is never creator funds.
        self._credit_quote(creator, V02_INITIAL_TUSD_LIQUIDITY)

        # v0.1 emitted ProtocolInitialized.  Replace it rather than presenting
        # one deployment as both release generations.
        self.events.clear()
        self._event(
            "TokenCreated",
            version=2,
            release_major=0,
            release_minor=2,
            release_patch=0,
            deployment_id=deployment_id,
            network_label=network_label,
            metadata="token_metadata",
            reward_vault="reward_vault",
            distribution_vault="distribution_vault",
            reflection_fee_bps=reflection_fee_bps,
            total_supply=fixed_supply,
            decimals=decimals,
        )

    # ------------------------------------------------------------------
    # Immutable creation and lifecycle
    # ------------------------------------------------------------------
    @property
    def reflection_fee_bps(self) -> int:
        return self._creation_reflection_fee_bps

    def seal_launch(self, actor: str) -> None:
        self._require_configuring_creator(actor)
        if not self.seeded or self.active_epoch != 1:
            raise AccountingError("launch requires the seeded first and only LP epoch")
        self.lifecycle = LIVE
        self._event(
            "LaunchSealed",
            reflection_fee_bps=self.reflection_fee_bps,
            amm_fee_bps=V02_AMM_FEE_BPS,
            max_reserve_bps=V02_MAX_RESERVE_BPS,
            max_gross_swap=V02_MAX_GROSS_SWAP,
            max_liquidity_rfl=V02_MAX_LIQUIDITY_RFL,
            max_liquidity_usd=V02_MAX_LIQUIDITY_USD,
            max_withdrawal_share_bps=V02_MAX_WITHDRAWAL_SHARE_BPS,
            faucet_trfl_grant=V02_FAUCET_GRANT,
            faucet_tusd_grant=V02_FAUCET_TUSD_GRANT,
            faucet_cooldown_seconds=V02_FAUCET_COOLDOWN_SECONDS,
            bootstrap=V02_BOOTSTRAP_LP,
            seed_rfl=V02_INITIAL_RFL_LIQUIDITY,
            seed_usd=V02_INITIAL_TUSD_LIQUIDITY,
            metadata="token_metadata",
            reward_vault="reward_vault",
            distribution_vault="distribution_vault",
            pool_store="pool",
        )

    def seed_pool(
        self,
        actor: str,
        rfl_amount: int,
        usd_amount: int,
        *,
        beneficiary: str,
        min_lp_shares: int = 1,
    ) -> LiquidityResult:
        self._require_configuring_creator(actor)
        if (
            rfl_amount != V02_INITIAL_RFL_LIQUIDITY
            or usd_amount != V02_INITIAL_TUSD_LIQUIDITY
            or beneficiary != V02_BOOTSTRAP_LP
            or min_lp_shares != 1
        ):
            raise AccountingError("ownerless v0.2 bootstrap constants are source-bound")
        return super().seed_pool(
            actor,
            rfl_amount,
            usd_amount,
            beneficiary=beneficiary,
            min_lp_shares=min_lp_shares,
        )

    def mint_quote(self, actor: str, recipient: str, amount: int) -> None:
        raise AuthorizationError("ownerless v0.2 exposes no arbitrary quote mint")

    def register_wallet(self, actor: str, account: Optional[str] = None) -> None:
        self._require_token_transferable()
        super().register_wallet(actor, account)

    # ------------------------------------------------------------------
    # Automatic wallet and LP endpoints
    # ------------------------------------------------------------------
    def transfer(self, sender: str, recipient: str, amount: int) -> None:
        self._require_token_transferable()
        with self._atomic(accounts=(sender, recipient), epoch_ids=(self.active_epoch,)):
            self._validate_wallet_registration(recipient)
            self._register_wallet(recipient)
            self._materialize_all(sender, TRIGGER_SEND)
            self._materialize_all(recipient, TRIGGER_RECEIVE)
            super().transfer(sender, recipient, amount)

    def claim(self, account: str, amount: Optional[int] = None) -> int:
        self._require_token_transferable()
        self._require_registered_wallet(account)
        with self._atomic(accounts=(account,), epoch_ids=(self.active_epoch,)):
            available = self.pending(account)
            requested = available if amount is None else amount
            self._require_token_amount(requested, "amount", allow_zero=False)
            if requested > available:
                raise AccountingError("claim exceeds pending rewards")
            self._materialize(
                account,
                requested,
                event_name="RewardsMaterialized",
                trigger=TRIGGER_MANUAL,
            )
            self._event(
                "RewardsClaimed",
                account=account,
                amount=requested,
                total_claimed=self.materialized[account],
            )
            return requested

    def sell(self, seller: str, gross_rfl: int, *, min_quote_out: int = 0) -> SwapResult:
        self._require_live()
        with self._atomic(accounts=(seller,), epoch_ids=(self.active_epoch,)):
            self._checkpoint_active()
            self._materialize_all(seller, TRIGGER_SELL_PRE)
            result = super().sell(seller, gross_rfl, min_quote_out=min_quote_out)
            self._materialize_all(seller, TRIGGER_SELL_POST)
            self._checkpoint_active()
            return result

    def buy(self, buyer: str, quote_in: int, *, min_net_rfl_out: int = 0) -> SwapResult:
        self._require_live()
        with self._atomic(accounts=(buyer,), epoch_ids=(self.active_epoch,)):
            self._checkpoint_active()
            self._materialize_all(buyer, TRIGGER_BUY_PRE)
            result = super().buy(buyer, quote_in, min_net_rfl_out=min_net_rfl_out)
            self._materialize_all(buyer, TRIGGER_BUY_POST)
            self._checkpoint_active()
            return result

    def add_liquidity(
        self,
        provider: str,
        max_rfl: int,
        max_usd: int,
        *,
        min_lp_shares: int = 1,
    ) -> LiquidityResult:
        self._require_live()
        with self._atomic(accounts=(provider,), epoch_ids=(self.active_epoch,)):
            self._checkpoint_active()
            self._pay_lp_endpoint(self.active_lp_epoch(), provider)
            self._materialize_all(provider, TRIGGER_LIQUIDITY_IN)
            return super().add_liquidity(
                provider,
                max_rfl,
                max_usd,
                min_lp_shares=min_lp_shares,
            )

    def remove_liquidity(
        self,
        provider: str,
        shares: int,
        *,
        min_rfl_output: int = 0,
        min_usd_output: int = 0,
    ) -> LiquidityResult:
        self._require_live()
        with self._atomic(accounts=(provider,), epoch_ids=(self.active_epoch,)):
            self._checkpoint_active()
            epoch = self.active_lp_epoch()
            self._pay_lp_endpoint(epoch, provider)
            self._materialize_all(provider, TRIGGER_LIQUIDITY_OUT)
            final_exit = shares == epoch.total_shares
            if final_exit:
                # The final LP holder supplies the only authority required for
                # terminal reserve closure.  This flag is an internal reuse of
                # v0.1 withdrawal arithmetic, not an exposed admin mode.
                self.shutdown_mode = True
            result = super().remove_liquidity(
                provider,
                shares,
                min_rfl_output=min_rfl_output,
                min_usd_output=min_usd_output,
            )
            if final_exit:
                self.lifecycle = CLOSED
                self._event("PoolClosed", pool_store="pool", epoch=1)
            return result

    def transfer_lp_shares(self, sender: str, recipient: str, shares: int) -> None:
        self._require_live()
        with self._atomic(accounts=(sender, recipient), epoch_ids=(self.active_epoch,)):
            self._require_amount(shares, "shares", allow_zero=False)
            if sender == recipient:
                raise AccountingError("LP share recipient must differ from sender")
            self._validate_wallet_registration(recipient)
            self._checkpoint_active()
            epoch = self.active_lp_epoch()
            self._pay_lp_endpoint(epoch, sender)
            self._pay_lp_endpoint(epoch, recipient)
            self._transfer_lp(epoch, sender, recipient, shares)
            self._event(
                "LpSharesTransferred",
                epoch=1,
                sender=sender,
                recipient=recipient,
                amount=shares,
            )

    def claim_lp(self, owner: str, epoch_id: int, amount: Optional[int] = None) -> int:
        self._require_token_transferable()
        if epoch_id != 1:
            raise AccountingError("ownerless v0.2 has exactly one LP epoch")
        with self._atomic(accounts=(owner,), epoch_ids=(1,)):
            if self.lifecycle == LIVE:
                self._checkpoint_active()
            epoch = self.lp_epoch(1)
            available = epoch.pending(owner)
            requested = available if amount in {None, 0} else amount
            self._require_token_amount(requested, "amount", allow_zero=False)
            if requested > available:
                raise AccountingError("LP claim exceeds pending rewards")
            return self._pay_lp_amount(epoch, owner, requested, automatic=False)

    def faucet_grant(self, actor: str, recipient: str, amount: int) -> None:
        self._require_live()
        if actor != V02_FAUCET_ACTOR or amount != V02_FAUCET_GRANT:
            raise AuthorizationError("v0.2 faucet actor and grant are immutable constants")
        self._assert_faucet_available(self.last_trfl_claim, recipient)
        with self._atomic(accounts=(recipient,), epoch_ids=(self.active_epoch,)):
            self._materialize_all(recipient, TRIGGER_FAUCET)
            if amount > self.distribution_vault_balance:
                raise AccountingError("insufficient distribution-vault balance")
            self._validate_wallet_registration(recipient)
            self._register_wallet(recipient)
            self._debit_excluded("distribution_vault", amount)
            self._credit_wallet(recipient, amount)
            self._event("FaucetGrant", recipient=recipient, amount=amount, operator=actor)
        self.last_trfl_claim[recipient] = self.clock_seconds

    def faucet_grant_tusd(self, actor: str, recipient: str, amount: int) -> None:
        self._require_live()
        if actor != V02_FAUCET_ACTOR or amount != V02_FAUCET_TUSD_GRANT:
            raise AuthorizationError("v0.2 tUSD faucet actor and grant are immutable constants")
        self._assert_faucet_available(self.last_tusd_claim, recipient)
        self._credit_quote(recipient, amount)
        self._event("MockUsdMinted", recipient=recipient, amount=amount, operator=actor)
        self.last_tusd_claim[recipient] = self.clock_seconds

    def advance_time(self, seconds: int) -> None:
        self._require_amount(seconds, "seconds", allow_zero=False)
        if self.clock_seconds + seconds > MAX_U64:
            raise AccountingError("faucet clock exceeds u64")
        self.clock_seconds += seconds

    def apply_operation(self, operation: Mapping[str, Any]) -> Any:
        """Apply only the v0.2 public lifecycle/economic vector surface."""
        op = str(operation["op"])
        args = {key: value for key, value in operation.items() if key != "op"}
        handlers = {
            "seed_pool": self.seed_pool,
            "seal_launch": self.seal_launch,
            "register_wallet": self.register_wallet,
            "faucet_grant": self.faucet_grant,
            "faucet_grant_tusd": self.faucet_grant_tusd,
            "transfer": self.transfer,
            "claim": self.claim,
            "sell": self.sell,
            "buy": self.buy,
            "checkpoint_pool": self.checkpoint_pool,
            "add_liquidity": self.add_liquidity,
            "remove_liquidity": self.remove_liquidity,
            "transfer_lp_shares": self.transfer_lp_shares,
            "claim_lp": self.claim_lp,
        }
        try:
            handler = handlers[op]
        except KeyError as exc:
            raise AccountingError(f"unknown ownerless v0.2 operation: {op}") from exc
        return handler(**args)

    # ------------------------------------------------------------------
    # Removed v0.1 authority and lifecycle surfaces
    # ------------------------------------------------------------------
    def _ownerless(self, *_args: object, **_kwargs: object) -> None:
        raise AuthorizationError("ownerless v0.2 has no post-creation admin surface")

    set_fee_bps = _ownerless
    set_swaps_paused = _ownerless
    set_claims_paused = _ownerless
    configure_pool_pauses = _ownerless
    configure_swap_limits = _ownerless
    configure_liquidity_limits = _ownerless
    begin_shutdown = _ownerless
    reseed_pool = _ownerless

    # ------------------------------------------------------------------
    # v0.2 invariants and helpers
    # ------------------------------------------------------------------
    def assert_fast_invariants(self) -> None:
        super().assert_fast_invariants()
        if self.release_identity != V02_RELEASE or self.deployment_id == "reflection-pilot-001":
            raise AssertionError("v0.1 and v0.2 deployment identities are not separate")
        if self.lifecycle not in {CONFIGURING, LIVE, CLOSED}:
            raise AssertionError("unknown ownerless lifecycle")
        if not self.automatic_materialization:
            raise AssertionError("ownerless materialisation must always be automatic")
        if not 0 <= self.reflection_fee_bps <= V02_MAX_REFLECTION_FEE_BPS:
            raise AssertionError("creation reflection fee is outside 0-500 bps")
        if self.fee_bps != self._creation_reflection_fee_bps:
            raise AssertionError("creation reflection fee changed after initialization")
        if self.fixed_supply != V02_FIXED_SUPPLY or self.decimals != V02_TOKEN_DECIMALS:
            raise AssertionError("source-bound token constants changed")
        if (
            self.faucet_trfl_grant != V02_FAUCET_GRANT
            or self.faucet_tusd_grant != V02_FAUCET_TUSD_GRANT
            or self.faucet_cooldown_seconds != V02_FAUCET_COOLDOWN_SECONDS
        ):
            raise AssertionError("source-bound faucet constants changed")
        if not 0 <= self.clock_seconds <= MAX_U64:
            raise AssertionError("faucet clock is outside u64")
        if any(
            timestamp < 0 or timestamp > self.clock_seconds
            for timestamp in (*self.last_trfl_claim.values(), *self.last_tusd_claim.values())
        ):
            raise AssertionError("faucet claim timestamp is invalid")
        if (
            self.amm_fee_bps != V02_AMM_FEE_BPS
            or self.max_reserve_bps != V02_MAX_RESERVE_BPS
            or self.max_gross_swap != V02_MAX_GROSS_SWAP
            or self.max_liquidity_rfl != V02_MAX_LIQUIDITY_RFL
            or self.max_liquidity_usd != V02_MAX_LIQUIDITY_USD
            or self.max_withdrawal_share_bps != V02_MAX_WITHDRAWAL_SHARE_BPS
        ):
            raise AssertionError("ownerless AMM constants changed after construction")
        if len(self.lp_epochs) != 1 or self.next_epoch != 2:
            raise AssertionError("ownerless v0.2 created a second LP epoch")
        if self.lifecycle == CONFIGURING and self.active_epoch != 1:
            raise AssertionError("configuring launch lost epoch one")
        if self.lifecycle == LIVE and (not self.seeded or self.active_epoch != 1):
            raise AssertionError("live launch is not bound to seeded epoch one")
        if self.lifecycle == CLOSED and (self.seeded or self.active_epoch is not None):
            raise AssertionError("closed launch retains an active pool")

    def _require_configuring_creator(self, actor: str) -> None:
        if self.lifecycle != CONFIGURING or actor != self.creator:
            raise AuthorizationError("only the creator may complete pre-seal configuration")

    def _require_live(self) -> None:
        if self.lifecycle != LIVE:
            raise AccountingError("ownerless economic endpoint requires LIVE lifecycle")

    def _require_token_transferable(self) -> None:
        if self.lifecycle not in {LIVE, CLOSED}:
            raise AccountingError("token endpoint requires LIVE or CLOSED lifecycle")

    def _lp_owner_is_valid(self, owner: str) -> bool:
        # v0.2 LP shares are address-bound. A recipient primary store is
        # registered lazily only when a payout or reserve withdrawal occurs.
        return owner not in self.exclusions and (
            owner in self.registered_wallets or self.raw_balance(owner) == 0
        )

    def _materialize_all(self, account: str, trigger: int) -> int:
        if trigger not in MATERIALIZATION_TRIGGERS:
            raise AccountingError("unknown automatic materialization trigger")
        if account not in self.registered_wallets:
            return 0
        amount = self.pending(account)
        if amount == 0:
            return 0
        self._materialize(
            account,
            amount,
            event_name="RewardsMaterialized",
            trigger=trigger,
        )
        return amount

    def _assert_faucet_available(self, claims: dict[str, int], account: str) -> None:
        previous = claims.get(account)
        if previous is not None and self.clock_seconds - previous < V02_FAUCET_COOLDOWN_SECONDS:
            raise AccountingError("faucet claim is still in cooldown")

    def _pay_lp_endpoint(self, epoch: object, owner: str) -> int:
        # The concrete type is deliberately not exported into this public
        # module surface; the base oracle owns the LpEpoch representation.
        lp_epoch = epoch
        pending = lp_epoch.pending(owner)  # type: ignore[attr-defined]
        if pending == 0:
            return 0
        return self._pay_lp_amount(lp_epoch, owner, pending, automatic=True)

    def _pay_lp_amount(self, lp_epoch: object, owner: str, amount: int, *, automatic: bool) -> int:
        self._validate_wallet_registration(owner)
        self._register_wallet(owner)
        self._materialize_all(owner, TRIGGER_LP_PAYOUT)
        position = lp_epoch.positions[owner]  # type: ignore[attr-defined]
        position.claimed = self._require_u256_sum(
            position.claimed,
            amount,
            "v0.2 LP endpoint claimed rewards",
        )
        lp_epoch.lifetime_claimed = self._require_u256_sum(  # type: ignore[attr-defined]
            lp_epoch.lifetime_claimed,  # type: ignore[attr-defined]
            amount,
            "v0.2 LP endpoint lifetime claims",
        )
        self._debit_excluded(lp_epoch.vault, amount)  # type: ignore[attr-defined]
        self._credit_wallet(owner, amount)
        self._recompute_lp_rounding(lp_epoch)  # type: ignore[arg-type]
        self._event(
            "LpRewardsClaimed",
            epoch=lp_epoch.epoch_id,  # type: ignore[attr-defined]
            owner=owner,
            amount=amount,
            total_claimed=position.claimed,
            automatic=automatic,
        )
        return amount
