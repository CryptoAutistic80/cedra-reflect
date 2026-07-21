# Cedra Reflect v0.2 Testnet deployment evidence

Date: 2026-07-21
Network: Cedra Testnet, chain id 2
Source commit: `c95c4fea55dc6dba77e25b35744d4a695663d464`
Status: deployed and live-tested; not yet canonical

## Addresses

| Role | Address |
|---|---|
| Core publisher | `0xab143b5378b1744e5b1971fdd54631a0af4c076b226d5d74102bee4211fc2116` |
| Assets publisher | `0xe11b73d13d614bb1259879496301dc5a34724766c8107f7330806e83f72e7ade` |
| AMM publisher | `0x60e977ada672ddfa52cc075683085d77182714d0910d91bee598dad3de72e658` |
| Bootstrap LP | `0x7c52f952c1f9d7fb08dc9ea2d5919360d982c1c069266d040f2b83f5e1522768` |
| Alice | `0xe16634563507bcb856fd111a4021ae851c452bffbe863e3d652c6cbdecb91da9` |
| Bob | `0x754582fa4d2bca282123e0b077c192f501b6ab1542e1e45c20397266003e954f` |
| Carol | `0x1074f6c470cf4f92f6c7b9c2de2da07d196b207dbf9c885abb8587d48f9a22fe` |
| Dave | `0x0e63fc569c4fef70db3a68e660a3e581fcad6143b9f48ea76917135a8813adf0` |
| tRFL metadata | `0xd653359229f241a8a518f02ae54189005d80108125b8a219ecd63836206ef48b` |

Alice, Bob, Carol and Dave used separate fresh Testnet CLI profiles. Private
keys remain only in the ignored mode-0600 CLI configuration.

## Publication and launch

| Operation | Transaction | Gas | Simulation before submission |
|---|---|---:|---|
| Core publish | `0x76f748552a683ee651f8d0586e87baaae11299ee8478edb4ab85540a35cb5ec6` | 19,430 | **No — CLI 1.0.4 submitted despite `--assume-no`** |
| Core initialize, 100 bps | `0xfb0448798bef80311e3fa72434cec2c3db42c8cd158ca0bf957b8104de959253` | 4,800 | Yes, same object |
| Assets publish | `0x56392f987f33eda7bcec34f54fcd08573c23ebf77bf59ae4acc21371778bb768` | 6,393 | Yes, same object |
| AMM publish | `0xc0f18bda3e9dd538b04158f7dd4e35ca89a14cdedd71a5988aa3e591fda7e9fe` | 17,115 | Yes, same object |
| Atomic four-signer launch | `0x04d59bee70d50246ba056257b89b652bb91f727ed23e43317a798a52a07bbaea` | 7,179 | Yes, same object |

The core-publish simulation gap is retained as an evidence defect; it is not
silently relabelled as a simulation. The package finalized successfully and
was subsequently checked against the exact artifact. This deployment cannot
satisfy a strict all-mutations-simulated release gate without a fresh publish.

All packages have on-chain upgrade number `0`, immutable policy `2`, and exact
artifact-matching source digests:

| Package | Source digest |
|---|---|
| ReflectionCore | `156EFE58B6E6FAD96185774CE80295CF291AA9A24A6DD81649E9C0719A16B4D8` |
| TestAssets | `FFB40EC4DCDA90500E2877213E930C18E7D32EF6809AAD358F58AA9D30B77577` |
| TestAmm | `4CD4EFB03865A6C6EEC3E15AF5BCC81CB486AE93C91182F9F7B55D226E6DB720` |

Immediately after launch the views returned fee `100`, lifecycle `LIVE`,
sealed `true`, closed `false`, fixed supply `1,000,000,000,000,000`, reserves
`500,000,000 / 500,000,000`, bootstrap LP shares `500,000,000`, and zero core
and LP reward-vault balances.

## Automatic reflection exercise

A checkpointed ten-cycle run alternated five buys and five sells of
`10,000,000` input units. Every transaction used the same object for simulation
and submission. Maximum finalized swap gas was 36.

- Alice pending was zero after every trade.
- Bob, Carol and Dave raw balances remained exactly `1,000,000,000` throughout.
- Their pending/derived balances increased after every trade, ending at
  `440,820` pending each.
- Pool core pending was zero after every trade.
- LP vault and bootstrap effective entitlement increased after every trade,
  ending at `216,324` each.
- Physical fixed supply reconciled exactly after every trade.
- Final recorded transaction:
  `0x3c843ec4e8fb54e5878649a9870bc0287f0b820745a252b80c41c4cb2f6683b7`
  at ledger version `149723348`.

Standard framework primary-store transfers then touched Bob, Carol and Dave.
Each converted exactly `440,820` pending into raw balance, ended with pending
zero, and transferred one unit to Alice. Representative transaction:
`0xfadb1880a4338b58d6ff21e67d4dc4c364bd4ff0b5902ccac6485ba78fd28d2c`.

After a later buy, Carol showed raw `1,000,440,819`, pending `44,009`, and
effective `1,000,484,828`. Both Cedra CLI's standard
`primary_fungible_store::balance` view and the direct Testnet REST view returned
`1,000,484,828`. Carol then used permissionless `claim_all`; transaction
`0xf84f0e47f03c919e6a1acf4cfe134d4545c5a7e9f1becb7add9e46147ad07bd6`
used 14 gas and left pending zero.

## LP movement

- Alice add: `0x6cffacf79c2ea29906f9646c8ce6a998635a140360005f34c607beff63083dec`
- Reward-bearing transfer to Bob:
  `0xf70320f73070950ae07a3b0152d49ba869524c0c633fc1be25e739fa424acf1c`
- Alice partial remove:
  `0x4f29fa2c5d7a352637bdc3126aebfeded119f356ae3a80a21e7631d8b135e500`
- Bob full-position, non-final remove:
  `0x0d59513b50f52e4af483d697cd0c52cc436bccf7ddd0eb6839d37d99674806aa`

Alice's transfer materialized `546` LP reward units into raw tRFL before
moving 24,945,191 shares. Her partial removal materialized 275. Bob's complete
position removal materialized 548 and left his shares/pending at zero. The pool
remained `LIVE` and core pool pending remained zero.

The bootstrap LP then exercised the direct permissionless claim-all fallback
for epoch 1. Transaction
`0x45044a7b7bf26373394a17dd88c4f47ef2aca537f4d9a72424a451e46f47e59d`
used the same successful simulation object for submission, consumed 1,928 gas,
paid exactly `238,115` raw tRFL, left bootstrap LP pending at zero, left pool
core pending at zero, and left the pool `LIVE`. A post-claim read-only snapshot
again reconciled the complete physical fixed supply exactly and confirmed
custody shares equal the canonical tRFL reserve.

Repeated initialization and repeated launch simulations abort with
`E_ALREADY_INITIALIZED`. The deployed ABI contains no setter, pause, rotation,
shutdown, reseed, blacklist or recovery entry point.

## Open gates

- The core publish lacks pre-submit simulation evidence because of the recorded
  CLI behavior.
- Secondary-store rejection and real-wallet display/Playwright evidence remain
  open.
- Final fragmented close and post-close rejection remain open. The bootstrap
  position is intentionally retained so the full pilot can continue.
- The 50,000 finalized transactions, 10,000 swaps, 1,000 holders and 100 LP
  positions canonical-pilot gates remain open.
- v0.1 retirement remains a separate unexecuted operator action.

This record proves a live Testnet deployment and bounded live behavior. It does
not claim canonical-pilot completion, mainnet readiness or external review.
