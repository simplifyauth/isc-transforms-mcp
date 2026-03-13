// src/cli/addkey.ts
// Usage: node dist/cli/addkey.js --email user@example.com --plan enterprise [--note "Order #123"]
// Prints the generated key so you can copy-paste it to the customer.

import { generateApiKey, upsertApiKey, listApiKeys } from "../apikeys.js";

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const email  = get("--email");
const plan   = (get("--plan") ?? "enterprise") as "personal" | "enterprise";
const note   = get("--note");
const action = get("--action") ?? "add";   // add | list | deactivate

if (action === "list") {
  const keys = listApiKeys();
  if (keys.length === 0) {
    console.log("No keys found.");
  } else {
    keys.forEach((k) =>
      console.log(`${k.active ? "✓" : "✗"} ${k.key}  ${k.plan.padEnd(12)} ${k.email}`)
    );
  }
  process.exit(0);
}

if (!email) {
  console.error("Usage: node dist/cli/addkey.js --email <email> [--plan enterprise|personal] [--note <note>]");
  console.error("       node dist/cli/addkey.js --action list");
  process.exit(1);
}

const key = generateApiKey();
upsertApiKey(key, {
  email,
  plan,
  active: true,
  createdAt: new Date().toISOString().slice(0, 10),
  note,
});

console.log(`\n✓ API key created`);
console.log(`  Key:   ${key}`);
console.log(`  Email: ${email}`);
console.log(`  Plan:  ${plan}`);
console.log(`\nSend this key to the customer. They add it to their Claude Desktop config:`);
console.log(`  "ISC_MCP_LICENSE_KEY": "${key}"\n`);
