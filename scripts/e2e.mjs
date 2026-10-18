// End-to-end check of the browser engine against a local fixture form (never a real employer).
// Requires `npm run dev` running. Usage: npm run test:e2e
const base = process.env.APP_URL ?? "http://localhost:5173";
const res = await fetch(`${base}/api/dev/e2e`, { method: "POST" });
const body = await res.json();
for (const [name, ok] of Object.entries(body.checks ?? {})) console.log(`${ok ? "✓" : "✗"} ${name}`);
if (!body.ok) {
  console.error(JSON.stringify(body.runs ?? body, null, 2));
  process.exit(1);
}
console.log("Browser engine E2E passed.");
