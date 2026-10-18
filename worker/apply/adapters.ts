import type { FormField } from "../../shared/types";
import type { Env } from "../env";
import { parseAshbyUrl, fetchAshbyForm } from "./ashby-form";
import { runAshbyApplication } from "./ashby-browser";
import type { BrowserRunInput, BrowserRunResult } from "./browser-common";
import { fetchGreenhouseForm, parseGreenhouseUrl } from "./greenhouse-form";
import { runGreenhouseApplication } from "./greenhouse-browser";
import { fetchLeverForm, parseLeverUrl } from "./lever-form";

// Registry of application adapters.
//  - automated: form read via API + filled in a browser; submit after approval.
//  - assisted:  form read so answers can be prepared, but the user submits (CAPTCHA'd sites).
//  - manual:    no form access; the user applies with the tailored resume.

export type AdapterId = "greenhouse" | "ashby" | "lever" | "manual" | "fixture";

interface Adapter {
  id: AdapterId;
  mode: "automated" | "assisted" | "manual";
  match(url: string): boolean;
  loadForm?(url: string): Promise<FormField[]>;
  run?(env: Env, input: BrowserRunInput): Promise<BrowserRunResult>;
}

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export const ADAPTERS: Adapter[] = [
  {
    id: "greenhouse",
    mode: "automated",
    match: (url) => /(^|\.)greenhouse\.io$/.test(host(url)) && !!parseGreenhouseUrl(url),
    loadForm: (url) => {
      const gh = parseGreenhouseUrl(url)!;
      return fetchGreenhouseForm(gh.board, gh.jobId);
    },
    run: runGreenhouseApplication,
  },
  {
    id: "ashby",
    mode: "automated",
    match: (url) => host(url) === "jobs.ashbyhq.com" && !!parseAshbyUrl(url),
    loadForm: (url) => {
      const a = parseAshbyUrl(url)!;
      return fetchAshbyForm(a.org, a.jobId);
    },
    run: runAshbyApplication,
  },
  {
    // Local development only: the Greenhouse-like fixture form served by worker/dev.ts.
    id: "fixture",
    mode: "automated",
    match: (url) => {
      try {
        const u = new URL(url);
        return (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.pathname === "/api/dev/fixture/greenhouse";
      } catch {
        return false;
      }
    },
    loadForm: async (url) => (await (await fetch(new URL("/api/dev/fixture/questions", url))).json()) as FormField[],
    run: runGreenhouseApplication,
  },
  {
    id: "lever",
    mode: "assisted",
    match: (url) => /(^|\.)lever\.co$/.test(host(url)) && !!parseLeverUrl(url),
    loadForm: (url) => {
      const l = parseLeverUrl(url)!;
      return fetchLeverForm(l.company, l.postingId);
    },
  },
];

const MANUAL: Adapter = { id: "manual", mode: "manual", match: () => true };

export function adapterFor(applyUrl: string): Adapter {
  return ADAPTERS.find((a) => a.match(applyUrl)) ?? MANUAL;
}

export function adapterById(id: string | null | undefined): Adapter {
  return ADAPTERS.find((a) => a.id === id) ?? MANUAL;
}
