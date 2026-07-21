# v0.2 Cedra Testnet dispatch-hook compatibility probe

The historical v0.1 hook record selected claim-backed behavior and remains
unchanged. v0.2 requires a fresh probe because automatic materialization and a
distinct `raw + pending` derived balance are now release requirements.

Use a disposable immutable probe deployment and CLI profiles that are not v0.1
or v0.2 release publishers. Record finalized transaction hashes, ledger
versions, raw/derived values, REST responses, CLI output, and gas.

| Check | Required v0.2 result |
|---|---|
| H1 publish/init | Dispatch-enabled asset publishes and initializes on Testnet |
| H2 native primary transfer | Standard transfer invokes sender/recipient hooks exactly once |
| H3 derived balance | Raw and pending are deliberately different; derived equals exact `raw + pending` |
| H4 internal reference settlement | Capability transfer does not recursively dispatch or advance accounting twice |
| H5 primary-store receive | Fresh primary recipient registers/materializes before incoming weight |
| H6 secondary store | Unsupported secondary-store receipt/withdrawal fails closed |
| H7 CLI/REST/read adapter | All observe the same metadata, raw, pending, and derived balance at one finalized boundary |
| H8 real wallet | Wallet displays/uses derived spendable balance and a standard touch materializes pending to raw |

Playwright may capture H8 browser-wallet evidence. It is not permission to
build a frontend.

## Acceptance

Automatic v0.2 publication is blocked unless H1–H8 pass with genuinely distinct
raw and derived balances. A wallet that displays only raw, a standard transfer
that cannot spend derived entitlement, unexpected recursive hook execution, or
any secondary-store acceptance is a release blocker.

The probe proves framework/wallet compatibility only. It does not prove the
full tRFL contract, package provenance, ownerless authority, LP accounting, or
canonical pilot load.
