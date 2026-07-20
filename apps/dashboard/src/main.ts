// Keep the static dashboard's browser module graph independent of the real
// Cedra SDK. The barrel also exports the release client, which is intended for
// Node-based signing/submission and imports a bare package specifier.
import {
  MockCedraReadAdapter,
  type MockReadState,
} from "../../../packages/protocol-sdk/src/mock-adapter.js";
import {
  ReflectionPilotClient,
  TESTNET_NO_VALUE_WARNING,
} from "../../../packages/protocol-sdk/src/safe-client.js";
import type { Address } from "../../../packages/protocol-sdk/src/types.js";

const DEMO_ACCOUNT = "0xpilot" as Address;
const BPS_DENOMINATOR = 10_000n;

export const screenDefinitions = [
  { id: "faucet", label: "Faucet" },
  { id: "portfolio", label: "Portfolio" },
  { id: "swap", label: "Swap" },
  { id: "claim", label: "Claim" },
  { id: "protocol", label: "Protocol dashboard" },
] as const;

type ScreenId = (typeof screenDefinitions)[number]["id"];

const demoState: MockReadState = {
  portfolio: {
    account: DEMO_ACCOUNT,
    effectiveTrfl: 1_275_400n,
    rawTrfl: 1_263_000n,
    pendingReflections: 12_400n,
    lifetimeClaimed: 48_200n,
    eligibleSupply: 99_000_000n,
    holderShares: 1_263_000n,
    ledgerVersion: 42_018n,
  },
  protocol: {
    automaticMaterialization: false,
    eligibleHolders: 1_042n,
    eligibleSupply: 99_000_000n,
    rewardVaultBalance: 2_180_000n,
    reflectionLiability: 2_180_000n,
    lifetimeSwapFees: 4_880_000n,
    lifetimeMaterialized: 2_700_000n,
    currentIndex: 2_202_020_202_020n,
    indexRemainder: 17n,
    pool: {
      trflReserve: 41_000_000n,
      tusdReserve: 15_050_000_000n,
      swapsPaused: false,
      maximumGrossSwap: 1_000_000n,
      maximumReserveBps: 500n,
      maximumRflContribution: 100_000_000_000n,
      maximumTusdContribution: 100_000_000_000n,
      maximumNonFinalWithdrawalShareBps: 10_000n,
      ledgerVersion: 42_018n,
    },
    claimsPaused: false,
    packageVersion: "testnet-v0.1.0",
    ledgerVersion: 42_018n,
  },
  faucetTrfl: {
    asset: "tRFL",
    account: DEMO_ACCOUNT,
    grantAmount: 100_000n,
    cooldownEndsAtUnixSeconds: 1_800_000_000n,
    canClaim: true,
  },
  faucetTusd: {
    asset: "tUSD",
    account: DEMO_ACCOUNT,
    grantAmount: 1_000_000n,
    cooldownEndsAtUnixSeconds: 1_800_000_000n,
    canClaim: true,
  },
};

const client = new ReflectionPilotClient(new MockCedraReadAdapter(demoState), {
  nowUnixSeconds: () => 1_700_000_000n,
});

function formatAmount(value: bigint): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) {
    element.textContent = value;
  }
}

function setStatus(message: string): void {
  setText("interaction-status", message);
}

function isScreenId(value: string): value is ScreenId {
  return screenDefinitions.some((screen) => screen.id === value);
}

function showScreen(target: ScreenId): void {
  for (const screen of screenDefinitions) {
    const section = document.getElementById(`screen-${screen.id}`);
    const button = document.querySelector<HTMLButtonElement>(`[data-screen="${screen.id}"]`);
    if (section !== null) {
      section.hidden = screen.id !== target;
    }
    if (button !== null) {
      button.setAttribute("aria-current", screen.id === target ? "page" : "false");
    }
  }
  document.getElementById(`screen-${target}`)?.focus();
}

async function populateReadModel(): Promise<void> {
  const [portfolio, protocol, trflFaucet, tusdFaucet] = await Promise.all([
    client.getPortfolio(DEMO_ACCOUNT),
    client.getProtocol(),
    client.getFaucetStatus(DEMO_ACCOUNT, "tRFL"),
    client.getFaucetStatus(DEMO_ACCOUNT, "tUSD"),
  ]);

  setText("banner-warning", TESTNET_NO_VALUE_WARNING);
  setText("portfolio-effective", `${formatAmount(portfolio.effectiveTrfl)} tRFL`);
  setText("portfolio-raw", `${formatAmount(portfolio.rawTrfl)} tRFL`);
  setText("portfolio-pending", `${formatAmount(portfolio.pendingReflections)} tRFL`);
  setText("portfolio-claimed", `${formatAmount(portfolio.lifetimeClaimed)} tRFL`);
  const share = portfolio.eligibleSupply === 0n
    ? 0n
    : (portfolio.holderShares * BPS_DENOMINATOR) / portfolio.eligibleSupply;
  setText("portfolio-share", `${formatAmount(share)} bps of eligible supply`);
  setText("faucet-trfl", `${formatAmount(trflFaucet.grantAmount)} tRFL`);
  setText("faucet-tusd", `${formatAmount(tusdFaucet.grantAmount)} tUSD`);
  setText("faucet-cooldown", trflFaucet.canClaim ? "Ready in this deterministic preview" : `Available after ${trflFaucet.cooldownEndsAtUnixSeconds}`);
  setText("claim-pending", `${formatAmount(portfolio.pendingReflections)} tRFL`);
  setText("claim-estimated-gas", "Wallet connection required for a Testnet gas estimate");

  setText("protocol-holders", formatAmount(protocol.eligibleHolders));
  setText("protocol-supply", `${formatAmount(protocol.eligibleSupply)} tRFL`);
  setText("protocol-vault", `${formatAmount(protocol.rewardVaultBalance)} tRFL`);
  setText("protocol-liability", `${formatAmount(protocol.reflectionLiability)} tRFL`);
  setText("protocol-surplus", `${formatAmount(protocol.rewardVaultBalance - protocol.reflectionLiability)} tRFL`);
  setText("protocol-fees", `${formatAmount(protocol.lifetimeSwapFees)} tRFL`);
  setText("protocol-materialized", `${formatAmount(protocol.lifetimeMaterialized)} tRFL`);
  setText("protocol-index", formatAmount(protocol.currentIndex));
  setText("protocol-reserves", `${formatAmount(protocol.pool.trflReserve)} tRFL / ${formatAmount(protocol.pool.tusdReserve)} tUSD`);
  setText("protocol-version", protocol.packageVersion);
  setText("protocol-paused", protocol.pool.swapsPaused || protocol.claimsPaused ? "Paused" : "Active");
  setText("protocol-ledger", `Observed ledger version ${formatAmount(protocol.ledgerVersion)}`);
  setStatus("Deterministic preview data loaded. No network or wallet was contacted.");
}

async function quoteSwap(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#swap-amount");
  const directionControl = document.querySelector<HTMLSelectElement>("#swap-direction");
  if (input === null || directionControl === null) {
    return;
  }
  try {
    const grossAmount = BigInt(input.value);
    const quote = await client.quoteSwap({
      direction: directionControl.value === "buy" ? "buy" : "sell",
      grossAmount,
      slippageBps: 100n,
      deadlineUnixSeconds: 1_700_000_900n,
    });
    setText("swap-gross", formatAmount(quote.grossAmount));
    setText("swap-reflection-fee", formatAmount(quote.reflectionFee));
    setText("swap-amm-fee", formatAmount(quote.ammFee));
    setText("swap-net-received", formatAmount(quote.netUserReceipt));
    setText("swap-minimum-received", formatAmount(quote.minimumNetUserReceipt));
    setText("swap-impact", `${formatAmount(quote.priceImpactBps)} bps`);
    setText("swap-deadline", quote.deadlineUnixSeconds.toString());
    setStatus("Quote updated from the deterministic mock adapter. No network or wallet was contacted.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to calculate the quote.";
    setStatus(message);
  }
}

function wireInteractions(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-screen]")) {
    button.addEventListener("click", () => {
      const target = button.dataset.screen;
      if (target !== undefined && isScreenId(target)) {
        showScreen(target);
      }
    });
  }

  document.getElementById("quote-swap")?.addEventListener("click", () => {
    void quoteSwap();
  });
  for (const trigger of document.querySelectorAll<HTMLButtonElement>("[data-draft]")) {
    trigger.addEventListener("click", () => {
      setStatus("Transaction draft prepared only. Submission remains disabled until the deployed release application injects an approved wallet writer.");
    });
  }
}

function initialize(): void {
  wireInteractions();
  showScreen("faucet");
  void populateReadModel().catch(() => {
    setStatus("The read-only preview data could not be loaded.");
  });
}

// Exported screen definitions are also used by Node-side tests. Do not touch
// browser globals until the browser module is actually loaded in a document.
if (typeof document !== "undefined") {
  initialize();
}
