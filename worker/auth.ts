import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { HttpError } from "./lib/util";

// Cloudflare Access sits in front of the whole hostname. The Worker still verifies the
// Access JWT itself (defense in depth: a misconfigured route must never expose data).

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksCache.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, set);
  }
  return set;
}

export async function authenticate(request: Request, env: Env): Promise<string> {
  if (env.AUTH_MODE === "dev") {
    // Only usable when explicitly configured in .dev.vars, and never on a non-local host.
    const host = new URL(request.url).hostname;
    if (!env.DEV_USER_EMAIL || !(host === "localhost" || host === "127.0.0.1")) {
      throw new HttpError(401, "Dev auth is only allowed on localhost with DEV_USER_EMAIL set");
    }
    // E2E tests use an isolated throwaway user per run (dev mode on localhost only).
    const override = request.headers.get("x-dev-user");
    if (override && /^e2e-[\w.-]+@applypilot\.local$/.test(override)) return override.toLowerCase();
    return env.DEV_USER_EMAIL.toLowerCase();
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(500, "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new HttpError(401, "Missing Cloudflare Access token");
  try {
    const { payload } = await jwtVerify(token, jwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email) throw new Error("token has no email claim");
    return email.toLowerCase();
  } catch (e) {
    throw new HttpError(401, `Invalid Cloudflare Access token: ${(e as Error).message}`);
  }
}
