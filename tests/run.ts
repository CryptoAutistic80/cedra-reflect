import "./safe-client.test.js";
import "./finalized-read-adapter.test.js";
import "./indexer.test.js";
import "./durable-indexer.test.js";
import "./dashboard.test.js";
import { run } from "./harness.js";

await run();
