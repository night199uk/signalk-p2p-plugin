import { formatPayloadReport, payloadSpike } from "./payload.js";
import {
  formatReplicationTable,
  replicationSpike,
  type ReplicationResult,
} from "./replicate.js";
import { formatSwarmReport, swarmSpike } from "./swarm.js";

async function main(): Promise<void> {
  console.log(formatPayloadReport(payloadSpike()));
  console.log();

  const results: ReplicationResult[] = [];
  for (const batchSize of [1, 5, 10, 50, 100]) {
    results.push(await replicationSpike({ snapshots: 1000, batchSize }));
  }
  console.log(formatReplicationTable(results));

  if (process.argv.includes("--swarm")) {
    console.log();
    console.log(formatSwarmReport(await swarmSpike()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
