import { Buffer } from "node:buffer";
import type { Locator, Page } from "@cloudflare/playwright";
import type { PreparedAnswer } from "../../shared/types";
import type { Env } from "../env";
import { type BrowserRunInput, type BrowserRunResult, escapeRe, type FormAdapter, isGraphqlQuery, pickComboOption, pickFirstSuggestion, runFormApplication, selectorFor } from "./browser-common";

// Ashby hosted application form (jobs.ashbyhq.com/<org>/<id>/application).
// Text inputs use the field path as id; Yes/No questions are buttons; multi-selects are
// labelled checkboxes; location is an autocomplete combobox.

/** The field's wrapper element, found through its label (works for widgets without ids). */
function container(page: Page, key: string): Locator {
  return page.locator(`label[for="${key.replace(/"/g, '\\"')}"]`).first().locator('xpath=ancestor::div[contains(@class,"fieldEntry")][1]');
}

const exactText = (label: string) => new RegExp(`^\\s*${escapeRe(label)}\\s*$`, "i");

async function fill(page: Page, a: PreparedAnswer, input: BrowserRunInput): Promise<string | null> {
  const values = Array.isArray(a.value) ? a.value : [a.value];
  const box = container(page, a.key);

  if (a.type === "file") {
    if (!/resume/i.test(a.key)) return "File uploads other than the resume are not automated";
    await page.locator(selectorFor(a.key)).setInputFiles({ name: input.resume.name, mimeType: "application/pdf", buffer: Buffer.from(input.resume.bytes) });
    try {
      await page.getByText(input.resume.name, { exact: false }).first().waitFor({ state: "visible", timeout: 8000 });
      return null;
    } catch {
      return input.mode === "dry_run" ? null : "Resume attachment was not confirmed by the page";
    }
  }
  if (a.type === "location") {
    const combo = box.locator('[role="combobox"]').first();
    if (!(await combo.count())) return "Field not found on the page";
    return pickFirstSuggestion(page, combo, values[0] ?? "");
  }
  if (a.type === "date") {
    const el = box.locator("input").first();
    if (!(await el.count())) return "Field not found on the page";
    // Typed as MM/DD/YYYY (an ISO string is parsed as UTC and can shift by a day).
    const iso = (values[0] ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    await el.fill(iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : (values[0] ?? ""));
    await page.keyboard.press("Escape").catch(() => {});
    return (await el.inputValue().catch(() => "")) ? null : "Date was not accepted";
  }
  if (a.type === "select" || a.type === "multiselect") {
    const scope: Page | Locator = (await box.count()) ? box : page;
    for (const v of values) {
      // Yes/No buttons, then labelled radios/checkboxes, then a combobox.
      const button = scope.locator("button").filter({ hasText: exactText(v) });
      if (await button.count()) {
        await button.first().click();
        continue;
      }
      const label = scope.locator("label").filter({ hasText: exactText(v) });
      if (await label.count()) {
        await label.first().click();
        continue;
      }
      const combo = scope.locator('[role="combobox"]').first();
      if (scope !== page && (await combo.count()) && (await pickComboOption(page, combo, v, async () => (await box.innerText().catch(() => "")) ?? ""))) continue;
      return `Option "${v}" not found`;
    }
    return null;
  }
  const el = page.locator(selectorFor(a.key)).first();
  if (!(await el.count())) return "Field not found on the page";
  await el.fill(values.join(", "));
  return null;
}

export const ashbyAdapter: FormAdapter = {
  readySelector: "#_systemfield_name, #_systemfield_email",
  fill,
  textInput: (page, a) => page.locator(selectorFor(a.key)).first(),
  submitButton: (page) => page.locator("button").filter({ hasText: /submit application/i }).first(),
  errorSelector: '[class*="_errorMessage"]:not(:empty), [class*="fieldError"]:not(:empty)',
  // The hosted form is rendered from GraphQL queries; submissions are mutations (blocked in dry run).
  isReadOnlyRequest: (method, url, postData) => method === "POST" && /jobs\.ashbyhq\.com\/api\/non-user-graphql/.test(url) && isGraphqlQuery(postData),
};

export function runAshbyApplication(env: Env, input: BrowserRunInput): Promise<BrowserRunResult> {
  // Ashby's apply page is the posting URL + "/application".
  const applyUrl = /\/application\/?$/.test(input.applyUrl) ? input.applyUrl : `${input.applyUrl.replace(/\/$/, "")}/application`;
  return runFormApplication(env, { ...input, applyUrl }, ashbyAdapter);
}
