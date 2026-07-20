# Reflection Pilot dashboard

The dashboard is a static, accessible five-screen Testnet interface: Faucet,
Portfolio, Swap, Claim, and Protocol dashboard. Its immutable page header and
footer repeat the no-value Testnet boundary; there is no dismiss control.

`npm run dashboard` writes browser ES modules to `public/assets/`. Serve
`apps/dashboard/public/` using any static server and open `index.html`.

The committed preview uses `MockCedraReadAdapter`, so it makes no RPC request,
does not discover a wallet, and cannot submit a transaction. A deployment app
may inject an official-Cedra-SDK `CedraReadAdapter` for read methods and an
explicitly approved `CedraWriteAdapter` for submission. It must preserve the
draft-before-submit confirmation UX and the permanent warning.
