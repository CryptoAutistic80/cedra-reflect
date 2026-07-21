"""Deterministic long-run accounting workload and provenance-safe reporting.

The quantitative gate counts only successful state-changing operations.  A
randomly selected branch that cannot run is a named no-op; a protocol-level
rejection is counted separately.  Neither can silently satisfy the requested
operation count.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import random
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Mapping, Optional

from .model import AccountingError, ReflectionModel
from .ownerless import (
    OwnerlessReflectionModel,
    V02_BOOTSTRAP_LP,
    V02_FAUCET_ACTOR,
    V02_FAUCET_GRANT,
    V02_FAUCET_TUSD_GRANT,
    V02_INITIAL_RFL_LIQUIDITY,
    V02_INITIAL_TUSD_LIQUIDITY,
)


DEFAULT_SEED: Final = "cedra-trfl-wallet-custody-lp-2026-07-20"
APPLIED: Final = "applied"
REJECTED: Final = "rejected"
NOOP: Final = "no-op"
OUTCOMES: Final = frozenset({APPLIED, REJECTED, NOOP})


@dataclass(frozen=True)
class WorkloadConfig:
    """Validated controls for one deterministic randomized workload."""

    successful_operations: int = 20_000
    holder_count: int = 32
    audit_frequency: int = 500
    max_attempts: Optional[int] = None
    seed: str = DEFAULT_SEED

    def __post_init__(self) -> None:
        if self.successful_operations < 1:
            raise ValueError("successful_operations must be at least one")
        if self.holder_count < 3:
            raise ValueError("holder_count must be at least three")
        if self.audit_frequency < 1:
            raise ValueError("audit_frequency must be at least one")
        if not self.seed:
            raise ValueError("seed must not be empty")
        effective_max = self.effective_max_attempts
        if effective_max < self.successful_operations:
            raise ValueError("max_attempts cannot be below successful_operations")

    @property
    def effective_max_attempts(self) -> int:
        if self.max_attempts is not None:
            return self.max_attempts
        # Invalid AMM/liquidity inputs are expected occasionally.  Four draws
        # per requested state transition leaves deterministic headroom while
        # still failing a stalled workload in bounded time.
        return self.successful_operations * 4


@dataclass
class WorkloadCounters:
    """Exact attempt accounting, including outcome-specific histograms."""

    attempts: int = 0
    successful: int = 0
    rejected: int = 0
    no_op: int = 0
    histogram: dict[str, int] = field(default_factory=dict)
    rejected_histogram: dict[str, int] = field(default_factory=dict)
    no_op_histogram: dict[str, int] = field(default_factory=dict)

    def record(self, operation: str, outcome: str) -> None:
        if not operation:
            raise ValueError("operation name must not be empty")
        if outcome not in OUTCOMES:
            raise ValueError(f"unknown workload outcome: {outcome}")
        self.attempts += 1
        if outcome == APPLIED:
            self.successful += 1
            target = self.histogram
        elif outcome == REJECTED:
            self.rejected += 1
            target = self.rejected_histogram
        else:
            self.no_op += 1
            target = self.no_op_histogram
        target[operation] = target.get(operation, 0) + 1
        self.assert_consistent()

    def assert_consistent(self) -> None:
        if self.attempts != self.successful + self.rejected + self.no_op:
            raise AssertionError("workload attempt counters do not reconcile")
        if self.successful != sum(self.histogram.values()):
            raise AssertionError("successful operation histogram does not reconcile")
        if self.rejected != sum(self.rejected_histogram.values()):
            raise AssertionError("rejected operation histogram does not reconcile")
        if self.no_op != sum(self.no_op_histogram.values()):
            raise AssertionError("no-op operation histogram does not reconcile")


@dataclass(frozen=True)
class GitProvenance:
    """Source identity captured without mutating the repository."""

    commit: Optional[str]
    clean: Optional[bool]


@dataclass
class WorkloadResult:
    """Completed workload, including its audited final model state."""

    config: WorkloadConfig
    counters: WorkloadCounters
    model: OwnerlessReflectionModel = field(repr=False)
    runtime_seconds: float
    final_state_digest: str
    emitted_events: int
    full_invariant_audits: int

    def report(self, provenance: GitProvenance) -> dict[str, Any]:
        self.counters.assert_consistent()
        return {
            "schema": "cedra-reflection-model-gate/v2",
            "release": self.model.release_identity,
            "lifecycle": self.model.lifecycle,
            "materialization_mode": "automatic-interaction",
            "automatic_materialization": self.model.automatic_materialization,
            "seed": self.config.seed,
            "requested_successful_operations": self.config.successful_operations,
            "max_attempts": self.config.effective_max_attempts,
            "attempts": self.counters.attempts,
            "successful": self.counters.successful,
            "rejected": self.counters.rejected,
            "no_op": self.counters.no_op,
            "histogram": dict(sorted(self.counters.histogram.items())),
            "rejected_histogram": dict(
                sorted(self.counters.rejected_histogram.items())
            ),
            "no_op_histogram": dict(sorted(self.counters.no_op_histogram.items())),
            "holder_count": self.config.holder_count,
            "audit_frequency": self.config.audit_frequency,
            "full_invariant_audits": self.full_invariant_audits,
            "runtime_seconds": self.runtime_seconds,
            "final_state_digest": self.final_state_digest,
            "emitted_events": self.emitted_events,
            "python_version": platform.python_version(),
            "git_commit": provenance.commit,
            "git_clean": provenance.clean,
        }


class WorkloadExhaustedError(RuntimeError):
    """Raised when bounded draws cannot realize the requested transitions."""


def config_from_environment() -> WorkloadConfig:
    """Build gate controls from the established REFLECTION_MODEL variables."""

    operations = int(os.environ.get("REFLECTION_MODEL_OPERATIONS", "20000"))
    max_attempts_text = os.environ.get("REFLECTION_MODEL_MAX_ATTEMPTS")
    return WorkloadConfig(
        successful_operations=operations,
        holder_count=int(os.environ.get("REFLECTION_MODEL_HOLDERS", "32")),
        audit_frequency=int(os.environ.get("REFLECTION_MODEL_CHECKPOINT", "500")),
        max_attempts=int(max_attempts_text) if max_attempts_text else None,
        seed=os.environ.get("REFLECTION_MODEL_SEED", DEFAULT_SEED),
    )


def build_random_model(holder_count: int) -> tuple[OwnerlessReflectionModel, list[str]]:
    """Create the deterministic funded state used by the quantitative gate."""

    if holder_count < 3:
        raise ValueError("holder_count must be at least three")
    model = OwnerlessReflectionModel(
        reflection_fee_bps=100,
    )
    model.seed_pool(
        "creator",
        V02_INITIAL_RFL_LIQUIDITY,
        V02_INITIAL_TUSD_LIQUIDITY,
        beneficiary=V02_BOOTSTRAP_LP,
    )
    model.seal_launch("creator")
    holders = [f"holder-{number:04d}" for number in range(holder_count)]
    for holder in holders:
        model.faucet_grant(V02_FAUCET_ACTOR, holder, V02_FAUCET_GRANT)
        model.faucet_grant_tusd(V02_FAUCET_ACTOR, holder, V02_FAUCET_TUSD_GRANT)
    model.transfer_lp_shares(
        V02_BOOTSTRAP_LP,
        holders[0],
        model.lp_shares(1, V02_BOOTSTRAP_LP) // 2,
    )
    model.assert_invariants()
    return model, holders


def _attempt_random_operation(
    model: OwnerlessReflectionModel,
    holders: list[str],
    rng: random.Random,
) -> tuple[str, str]:
    """Select one operation and classify its realized protocol outcome."""

    holder_count = len(holders)
    first_index = rng.randrange(holder_count)
    second_index = rng.randrange(holder_count)
    if first_index == second_index:
        second_index = (first_index + 1) % holder_count
    first = holders[first_index]
    second = holders[second_index]
    kind = rng.randrange(100)

    if kind < 24:
        operation = "transfer"
    elif kind < 43:
        operation = "sell"
    elif kind < 60:
        operation = "buy"
    elif kind < 70:
        operation = "claim"
    elif kind < 78:
        operation = "add_liquidity"
    elif kind < 85:
        operation = "transfer_lp_shares"
    elif kind < 91:
        operation = "claim_lp"
    elif kind < 97:
        operation = "remove_liquidity"
    else:
        operation = "faucet_tusd"

    try:
        if operation == "transfer":
            available = model.effective_balance(first)
            if not available:
                return operation, NOOP
            model.transfer(first, second, rng.randint(1, min(available, 2_000)))
        elif operation == "sell":
            available = model.effective_balance(first)
            if not available:
                return operation, NOOP
            model.sell(first, rng.randint(1, min(available, 2_000)))
        elif operation == "buy":
            available_quote = model.quote_balance(first)
            if not available_quote:
                return operation, NOOP
            model.buy(first, rng.randint(1, min(available_quote, 2_000)))
        elif operation == "claim":
            pending = model.pending(first)
            if not pending:
                return operation, NOOP
            model.claim(first, rng.randint(1, pending))
        elif operation == "add_liquidity":
            if not model.raw_balance(first) or not model.quote_balance(first):
                return operation, NOOP
            model.add_liquidity(
                first,
                rng.randint(1, min(model.raw_balance(first), 1_000)),
                rng.randint(1, min(model.quote_balance(first), 2_000)),
            )
        elif operation == "transfer_lp_shares":
            owned = model.lp_shares(1, first)
            if not owned:
                return operation, NOOP
            model.transfer_lp_shares(first, second, rng.randint(1, owned))
        elif operation == "claim_lp":
            pending = model.lp_pending(1, first)
            if not pending:
                return operation, NOOP
            model.claim_lp(first, 1, rng.randint(1, pending))
        elif operation == "remove_liquidity":
            owned = model.lp_shares(1, first)
            total = model.active_lp_epoch().total_shares
            if not owned or total <= 1:
                return operation, NOOP
            model.remove_liquidity(first, rng.randint(1, min(owned, total - 1)))
        else:
            model.advance_time(model.faucet_cooldown_seconds)
            model.faucet_grant_tusd(
                V02_FAUCET_ACTOR,
                first,
                V02_FAUCET_TUSD_GRANT,
            )
    except AccountingError:
        # Expected arithmetic/precondition failures remain observable in the
        # gate result instead of being silently treated as completed work.
        return operation, REJECTED
    return operation, APPLIED


def run_randomized_workload(config: WorkloadConfig) -> WorkloadResult:
    """Run until exactly the requested number of state transitions succeeds."""

    rng = random.Random(config.seed)
    model, holders = build_random_model(config.holder_count)
    counters = WorkloadCounters()
    emitted_events = len(model.events)
    model.events.clear()
    full_audits = 1  # build_random_model performs the initial full audit.
    started = time.perf_counter()

    while (
        counters.successful < config.successful_operations
        and counters.attempts < config.effective_max_attempts
    ):
        operation, outcome = _attempt_random_operation(model, holders, rng)
        counters.record(operation, outcome)
        emitted_events += len(model.events)
        # Event retention is not part of the accounting proof and retaining a
        # million-event journal would make this bounded state test memory-bound.
        model.events.clear()
        model.assert_fast_invariants()
        if (
            outcome == APPLIED
            and counters.successful % config.audit_frequency == 0
        ):
            model.assert_invariants()
            full_audits += 1

    if counters.successful != config.successful_operations:
        raise WorkloadExhaustedError(
            "randomized workload exhausted "
            f"{config.effective_max_attempts} attempts after "
            f"{counters.successful}/{config.successful_operations} successful "
            "state-changing operations"
        )

    model.assert_invariants()
    full_audits += 1
    counters.assert_consistent()
    runtime_seconds = time.perf_counter() - started
    return WorkloadResult(
        config=config,
        counters=counters,
        model=model,
        runtime_seconds=runtime_seconds,
        final_state_digest=accounting_state_digest(model),
        emitted_events=emitted_events,
        full_invariant_audits=full_audits,
    )


def accounting_state_digest(model: ReflectionModel) -> str:
    """Hash all durable accounting/configuration state in a canonical form."""

    epochs = []
    for epoch_id in sorted(model.lp_epochs):
        epoch = model.lp_epochs[epoch_id]
        epochs.append(
            {
                "epoch_id": epoch.epoch_id,
                "vault": epoch.vault,
                "status": epoch.status,
                "index": epoch.index,
                "index_remainder": epoch.index_remainder,
                "total_shares": epoch.total_shares,
                "aggregate_correction": epoch.aggregate_correction,
                "unallocated_rewards": epoch.unallocated_rewards,
                "rounding_reserve": epoch.rounding_reserve,
                "terminal_rounding_reserve": epoch.terminal_rounding_reserve,
                "retired_residue_magnified": epoch.retired_residue_magnified,
                "lifetime_received": epoch.lifetime_received,
                "lifetime_claimed": epoch.lifetime_claimed,
                "quarantined": epoch.quarantined,
                "positions": {
                    owner: {
                        "shares": position.shares,
                        "correction": position.correction,
                        "claimed": position.claimed,
                    }
                    for owner, position in sorted(epoch.positions.items())
                },
            }
        )
    payload = {
        "admin": model.admin,
        "fixed_supply": model.fixed_supply,
        "fee_bps": model.fee_bps,
        "amm_fee_bps": model.amm_fee_bps,
        "automatic_materialization": model.automatic_materialization,
        "max_reserve_bps": model.max_reserve_bps,
        "max_gross_swap": model.max_gross_swap,
        "max_liquidity_rfl": model.max_liquidity_rfl,
        "max_liquidity_usd": model.max_liquidity_usd,
        "max_withdrawal_share_bps": model.max_withdrawal_share_bps,
        "swaps_paused": model.swaps_paused,
        "claims_paused": model.claims_paused,
        "pool_paused": model.pool_paused,
        "liquidity_paused": model.liquidity_paused,
        "lp_claims_paused": model.lp_claims_paused,
        "shutdown_mode": model.shutdown_mode,
        "seeded": model.seeded,
        "index": model.index,
        "index_remainder": model.index_remainder,
        "total_shares": model.total_shares,
        "aggregate_correction": model.aggregate_correction,
        "unallocated_fees": model.unallocated_fees,
        "rounding_reserve": model.rounding_reserve,
        "lifetime_fees": model.lifetime_fees,
        "lifetime_materialized": model.lifetime_materialized,
        "lifetime_custody_routed": model.lifetime_custody_routed,
        "exclusions": sorted(model.exclusions),
        "registered_wallets": sorted(model.registered_wallets),
        "raw": dict(sorted(model.raw.items())),
        "quote": dict(sorted(model.quote.items())),
        "correction": dict(sorted(model.correction.items())),
        "materialized": dict(sorted(model.materialized.items())),
        "custody_shares": model.custody_shares,
        "custody_correction": model.custody_correction,
        "custody_settled": model.custody_settled,
        "active_epoch": model.active_epoch,
        "next_epoch": model.next_epoch,
        "lp_epochs": epochs,
    }
    if isinstance(model, OwnerlessReflectionModel):
        for legacy_field in (
            "admin",
            "swaps_paused",
            "claims_paused",
            "pool_paused",
            "liquidity_paused",
            "lp_claims_paused",
            "shutdown_mode",
            "next_epoch",
        ):
            payload.pop(legacy_field, None)
        payload.update(
            {
                "release": model.release_identity,
                "deployment_id": model.deployment_id,
                "network_label": model.network_label,
                "creator_provenance": model.creator,
                "lifecycle": model.lifecycle,
                "reflection_fee_bps": model.reflection_fee_bps,
                "decimals": model.decimals,
                "bootstrap": V02_BOOTSTRAP_LP,
                "initial_rfl_liquidity": V02_INITIAL_RFL_LIQUIDITY,
                "initial_tusd_liquidity": V02_INITIAL_TUSD_LIQUIDITY,
                "clock_seconds": model.clock_seconds,
                "last_trfl_claim": dict(sorted(model.last_trfl_claim.items())),
                "last_tusd_claim": dict(sorted(model.last_tusd_claim.items())),
            }
        )
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def read_git_provenance(repo_root: Path) -> GitProvenance:
    """Read commit and cleanliness with argv-only, non-mutating Git calls."""

    try:
        commit = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-C", str(repo_root), "status", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return GitProvenance(commit=None, clean=None)
    return GitProvenance(commit=commit or None, clean=not bool(status.strip()))


def write_json_report(path: Path, report: Mapping[str, Any]) -> None:
    """Atomically replace an explicitly requested machine-readable report."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
