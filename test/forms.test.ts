import { describe, expect, it } from "vitest";
import { adapterFor } from "../worker/apply/adapters";
import { parseAshbyUrl } from "../worker/apply/ashby-form";
import { parseLeverHtml, parseLeverUrl } from "../worker/apply/lever-form";
import { detectFromText, findInCatalog } from "../worker/discovery/detect";
import { extractContact } from "../worker/resume/import";

describe("adapter registry", () => {
  it("routes apply URLs", () => {
    expect(adapterFor("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1").id).toBe("greenhouse");
    expect(adapterFor("https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3/application").id).toBe("ashby");
    expect(adapterFor("https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply")).toMatchObject({ id: "lever", mode: "assisted" });
    expect(adapterFor("https://example.com/careers/123")).toMatchObject({ id: "manual", mode: "manual" });
  });
  it("parses ids", () => {
    expect(parseAshbyUrl("https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3")).toEqual({ org: "openai", jobId: "8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3" });
    expect(parseLeverUrl("https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply")).toEqual({ company: "palantir", postingId: "6ed76ce8-4156-4b60-b120-403538bd66cd" });
  });
});

describe("Lever form parsing", () => {
  const card = JSON.stringify({ fields: [{ type: "multiple-choice", text: "Are you authorized?", required: true, options: [{ text: "Yes" }, { text: "No" }] }, { type: "textarea", text: "Why us?", required: true }] }).replace(/"/g, "&quot;");
  const html = `<input name="resume" type="file"><input name="name"><input name="email"><input name="urls[LinkedIn]"><input type="hidden" value="${card}" name="cards[abc-123][baseTemplate]">`;
  it("reads standard fields and custom cards", () => {
    const f = parseLeverHtml(html);
    expect(f.map((x) => x.key)).toEqual(["resume", "name", "email", "urls[LinkedIn]", "cards[abc-123][field0]", "cards[abc-123][field1]"]);
    expect(f[4]).toMatchObject({ type: "select", required: true, options: [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }] });
    expect(f[5]).toMatchObject({ type: "textarea", label: "Why us?" });
  });
});

describe("source detection", () => {
  it("finds ATS boards in URLs and page HTML", () => {
    expect(detectFromText("https://job-boards.greenhouse.io/stripe/jobs/123")).toEqual({ ats: "greenhouse", token: "stripe" });
    expect(detectFromText('<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>')).toEqual({ ats: "greenhouse", token: "acme" });
    expect(detectFromText("https://jobs.lever.co/spotify")).toEqual({ ats: "lever", token: "spotify" });
    expect(detectFromText('<a href="https://jobs.ashbyhq.com/notion">Jobs</a>')).toEqual({ ats: "ashby", token: "notion" });
    expect(detectFromText("https://example.com/careers")).toBeNull();
  });
  it("matches catalog names loosely", () => {
    expect(findInCatalog("open ai")).toMatchObject({ ats: "ashby", token: "openai", name: "OpenAI" });
    expect(findInCatalog("Scale AI")).toMatchObject({ token: "scaleai" });
    expect(findInCatalog("Nonexistent Co")).toBeNull();
  });
});

describe("resume contact extraction", () => {
  it("extracts only what is present", () => {
    const c = extractContact("Jane Q. Doe\nAustin, TX | jane.doe@example.com | (512) 555-0199 | linkedin.com/in/janedoe\n\nEXPERIENCE");
    expect(c).toMatchObject({ firstName: "Jane", lastName: "Q. Doe", email: "jane.doe@example.com", phone: "(512) 555-0199", linkedin: "https://linkedin.com/in/janedoe", city: "Austin", region: "TX" });
    expect(extractContact("no contact info here at all").email).toBeUndefined();
  });
});

describe("dry-run request guard", async () => {
  const { isGraphqlQuery } = await import("../worker/apply/browser-common");
  it("allows GraphQL queries but never mutations", () => {
    expect(isGraphqlQuery(JSON.stringify({ query: "query ApiJobPosting { x }" }))).toBe(true);
    expect(isGraphqlQuery(JSON.stringify({ query: "mutation ApiSubmit { x }" }))).toBe(false);
    expect(isGraphqlQuery(JSON.stringify([{ query: "query A { x }" }, { query: "mutation B { y }" }]))).toBe(false);
    expect(isGraphqlQuery("not json")).toBe(false);
    expect(isGraphqlQuery(null)).toBe(false);
  });
});
