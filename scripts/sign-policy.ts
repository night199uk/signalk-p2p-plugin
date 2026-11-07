import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { identityFromPrivatePem } from "../src/identity.js";
import {
  defaultPolicy,
  signPolicy,
  verifyPolicy,
  type NetworkPolicy,
} from "../src/policy/policy.js";

const keyPath =
  process.env.SIGNALK_P2P_OPERATOR_KEY ??
  join(homedir(), ".config", "signalk-p2p", "operator", "operator.json");
const input = process.argv[2];
const output = process.argv[3] ?? "policy/default.json";

const key = JSON.parse(readFileSync(keyPath, "utf8")) as {
  publicKey: string;
  privateKeyPem: string;
};
const policy: NetworkPolicy = input
  ? (JSON.parse(readFileSync(input, "utf8")) as NetworkPolicy)
  : defaultPolicy();
const identity = identityFromPrivatePem(key.privateKeyPem);
const signed = signPolicy(policy, identity);
if (!verifyPolicy(signed, [key.publicKey], policy.topic)) {
  throw new Error("signed policy failed verification");
}
writeFileSync(output, JSON.stringify(signed, null, 2) + "\n");
console.log(
  `wrote ${output} (v${policy.version}, topic ${policy.topic}, ` +
    `operator ${key.publicKey.slice(0, 12)}…)`,
);
