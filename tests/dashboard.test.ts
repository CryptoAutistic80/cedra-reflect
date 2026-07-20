import { screenDefinitions } from "../apps/dashboard/src/main.js";
import { TESTNET_NO_VALUE_WARNING } from "../packages/protocol-sdk/src/index.js";
import { equal, ok, test } from "./harness.js";

test("dashboard exposes all five planned screens and the permanent no-value warning", () => {
  equal(screenDefinitions.length, 5, "Dashboard must have the five planned screens");
  equal(screenDefinitions.map((screen) => screen.id).join(","), "faucet,portfolio,swap,claim,protocol", "Screen sequence must cover the planned user flow");
  ok(TESTNET_NO_VALUE_WARNING.includes("NO MONETARY VALUE"), "All transaction drafts must carry the no-value warning");
});
