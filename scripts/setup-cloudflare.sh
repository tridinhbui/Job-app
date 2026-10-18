#!/usr/bin/env bash
# One-time provisioning of ApplyPilot's Cloudflare resources, then deploy.
# Idempotent: re-running skips resources that already exist.
# Requires: `npx wrangler login` (or CLOUDFLARE_API_TOKEN) and a Workers Paid plan
# for production-sized CPU limits (see README "Plans & limits").
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> D1 database"
d1_id() {
  npx wrangler d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const db=JSON.parse(s).find(d=>d.name==="applypilot");console.log(db?db.uuid:"")})'
}
DB_ID=$(d1_id)
if [ -z "$DB_ID" ]; then
  npx wrangler d1 create applypilot
  DB_ID=$(d1_id)
fi
[ -n "$DB_ID" ] || { echo "Could not determine D1 database id"; exit 1; }
node -e '
const fs=require("fs");const f="wrangler.jsonc";
fs.writeFileSync(f, fs.readFileSync(f,"utf8").replace(/"database_id": "[^"]*"/, `"database_id": "${process.argv[1]}"`));
' "$DB_ID"
echo "    database_id = $DB_ID"

echo "==> R2 bucket"
npx wrangler r2 bucket create applypilot-files 2>/dev/null || echo "    (exists)"

echo "==> Queues"
npx wrangler queues create applypilot-jobs 2>/dev/null || echo "    (exists)"
npx wrangler queues create applypilot-jobs-dlq 2>/dev/null || echo "    (exists)"

echo "==> Remote migrations"
npx wrangler d1 migrations apply applypilot --remote

echo "==> Build & deploy"
npm run build
npx wrangler deploy

# The secret is set after the first deploy so the Worker exists (setting it creates a new version).
echo "==> Encryption key secret"
if ! npx wrangler secret list 2>/dev/null | grep -q DATA_ENCRYPTION_KEY; then
  # Saved to a git-ignored, owner-only file so it can be moved to a password manager.
  (umask 077; openssl rand -base64 32 | tr -d '\n' > .encryption-key.backup)
  npx wrangler secret put DATA_ENCRYPTION_KEY < .encryption-key.backup
  echo "    New DATA_ENCRYPTION_KEY saved to .encryption-key.backup — move it to a password manager."
  echo "    Losing it makes all stored personal data and files unreadable."
fi

cat <<'MSG'

Deployed. Before using it:
  1. Protect the hostname with Cloudflare Access (Zero Trust > Access > Applications),
     allowing only your email.
  2. Copy the application's AUD tag and your team domain into wrangler.jsonc vars
     (ACCESS_AUD, ACCESS_TEAM_DOMAIN = <team>.cloudflareaccess.com) and deploy again.
  3. SUBMIT_MODE stays "dry_run" until you deliberately change it to "live".
MSG
