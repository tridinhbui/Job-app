// Checks every board in shared/companies.json still responds with jobs.
// Usage: node scripts/verify-companies.mjs
import { readFileSync } from "node:fs";

const companies = JSON.parse(readFileSync(new URL("../shared/companies.json", import.meta.url), "utf8"));
const url = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
};
const count = (ats, d) => (ats === "lever" ? d.length : d.jobs.length);

let failed = 0;
await Promise.all(
  companies.map(async (c) => {
    try {
      const res = await fetch(url[c.ats](c.token), { headers: { "user-agent": "ApplyPilotBot/0.1" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const n = count(c.ats, await res.json());
      if (n === 0) console.warn(`~ ${c.name} (${c.ats}:${c.token}) has 0 open jobs`);
    } catch (e) {
      failed++;
      console.error(`✗ ${c.name} (${c.ats}:${c.token}): ${e.message}`);
    }
  }),
);
console.log(`${companies.length - failed}/${companies.length} boards OK`);
process.exit(failed ? 1 : 0);
