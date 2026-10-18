import type { BrowserWorker } from "@cloudflare/playwright";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  JOBS_QUEUE: Queue<QueueMessage>;
  PREPARE_WORKFLOW: Workflow<PrepareParams>;
  SUBMIT_WORKFLOW: Workflow<SubmitParams>;
  AI: Ai;
  BROWSER: BrowserWorker;
  ASSETS: Fetcher;

  AUTH_MODE: "access" | "dev";
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_USER_EMAIL?: string;
  SUBMIT_MODE: "dry_run" | "live";
  AI_MODEL_FAST: string;
  AI_MODEL_QUALITY: string;
  AI_GATEWAY_ID: string;
  DEFAULT_MONTHLY_BUDGET_USD: string;

  /** Secret: base64-encoded 32-byte key used for AES-GCM encryption of personal data. */
  DATA_ENCRYPTION_KEY: string;
}

export type QueueMessage =
  | { type: "crawl"; sourceId: string }
  | { type: "match"; userId: string; full?: boolean; cursor?: { t: number; id: string } | null };

export interface PrepareParams {
  applicationId: string;
  userId: string;
  force?: boolean;
}

export interface SubmitParams {
  applicationId: string;
  userId: string;
  mode: "dry_run" | "live";
}
