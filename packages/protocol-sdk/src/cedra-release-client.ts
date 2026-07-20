import {
  Account,
  Cedra,
  CedraConfig,
  Network,
  type InputEntryFunctionData,
  type MultiAgentTransaction,
} from "@cedra-labs/ts-sdk";

/**
 * A release is deliberately a human-approved operation. This object contains
 * no key-loading or environment-variable logic: callers supply already
 * authorised signers and CI must never invoke `submitAfterApproval`.
 */
export interface ReleaseApproval {
  readonly releaseId: string;
  readonly approvedBy: readonly string[];
  readonly approvedAt: string;
}

export interface MultiAgentEntryRequest {
  readonly sender: Account;
  readonly additionalSigners: readonly Account[];
  readonly data: InputEntryFunctionData;
}

export function assertTwoPersonApproval(approval: ReleaseApproval): void {
  if (!approval.releaseId.trim()) {
    throw new Error("Release approval requires a release identifier.");
  }
  if (approval.approvedBy.length < 2) {
    throw new Error("A Testnet release requires two recorded approvers.");
  }
  if (new Set(approval.approvedBy).size !== approval.approvedBy.length) {
    throw new Error("Release approvers must be distinct.");
  }
  if (Number.isNaN(Date.parse(approval.approvedAt))) {
    throw new Error("Release approval requires an RFC3339-compatible timestamp.");
  }
}

/**
 * Official-SDK boundary for the multi-agent initialization calls required by
 * `test_faucet::initialize`, `pool::initialize`, and `seed_liquidity`.
 * Building and simulating are read-only. Submission is explicit and guarded
 * by a two-person approval object.
 */
export class CedraReleaseClient {
  public constructor(private readonly cedra: Cedra) {}

  public static forTestnet(): CedraReleaseClient {
    return new CedraReleaseClient(new Cedra(new CedraConfig({ network: Network.TESTNET })));
  }

  public async buildMultiAgent(request: MultiAgentEntryRequest): Promise<MultiAgentTransaction> {
    this.assertDistinctSigners(request);
    return this.cedra.transaction.build.multiAgent({
      sender: request.sender.accountAddress,
      secondarySignerAddresses: request.additionalSigners.map((signer) => signer.accountAddress),
      data: request.data,
    });
  }

  public async simulateMultiAgent(request: MultiAgentEntryRequest) {
    const transaction = await this.buildMultiAgent(request);
    return this.cedra.transaction.simulate.multiAgent({
      transaction,
      signerPublicKey: request.sender.publicKey,
      secondarySignersPublicKeys: request.additionalSigners.map((signer) => signer.publicKey),
    });
  }

  public async submitAfterApproval(
    request: MultiAgentEntryRequest,
    approval: ReleaseApproval,
  ) {
    assertTwoPersonApproval(approval);
    const transaction = await this.buildMultiAgent(request);
    const senderAuthenticator = this.cedra.transaction.sign({ signer: request.sender, transaction });
    const additionalSignersAuthenticators = request.additionalSigners.map((signer) => (
      this.cedra.transaction.sign({ signer, transaction })
    ));
    return this.cedra.transaction.submit.multiAgent({
      transaction,
      senderAuthenticator,
      additionalSignersAuthenticators,
    });
  }

  private assertDistinctSigners(request: MultiAgentEntryRequest): void {
    if (request.additionalSigners.length === 0) {
      throw new Error("A multi-agent operation requires at least one additional signer.");
    }
    const addresses = [request.sender, ...request.additionalSigners].map((signer) => signer.accountAddress.toString());
    if (new Set(addresses).size !== addresses.length) {
      throw new Error("Every multi-agent signer must have a distinct address.");
    }
  }
}
