// Pulls the live OpenAPI spec into spec/openapi.json. CI runs this and fails if
// the checked-in copy (and so the generated types) is stale.
import { writeFileSync } from "node:fs";

const res = await fetch("https://api.pixelvault.dev/openapi.json");
if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`);
const spec = await res.json();
writeFileSync("spec/openapi.json", JSON.stringify(spec, null, 2) + "\n");
console.log(`synced spec: ${Object.keys(spec.paths).length} paths`);
