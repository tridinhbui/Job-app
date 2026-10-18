import { describe, expect, it } from "vitest";
import { dedupeKey, normalizeToken } from "../worker/discovery/crawl";
import { extractJsonLd, isAllowed, parseRobots, postingToJob } from "../worker/discovery/jsonld";
import { annualize, extractSalary } from "../worker/discovery/salary";
import { htmlToText } from "../worker/lib/util";

describe("salary extraction", () => {
  it("parses common US ranges", () => {
    expect(extractSalary("The base salary range is $180,000 - $220,000 USD")).toMatchObject({ min: 180000, max: 220000, currency: "USD", period: "year" });
    expect(extractSalary("Pay: $150K–$190K plus equity")).toMatchObject({ min: 150000, max: 190000 });
    expect(extractSalary("$150-190K")).toMatchObject({ min: 150000, max: 190000 });
  });
  it("detects hourly and other currencies", () => {
    expect(extractSalary("$45 - $60 per hour")).toMatchObject({ min: 45, max: 60, period: "hour" });
    expect(extractSalary("£70k to £90k")).toMatchObject({ currency: "GBP", min: 70000, max: 90000 });
  });
  it("ignores non-salary numbers", () => {
    expect(extractSalary("We raised $5 - $10 million in funding")).toBeNull();
    expect(extractSalary("No numbers here")).toBeNull();
  });
  it("annualizes", () => {
    expect(annualize({ min: 50, max: 60, period: "hour" })).toEqual({ min: 104000, max: 124800 });
  });
});

describe("html to text", () => {
  it("decodes Greenhouse entity-escaped HTML", () => {
    const t = htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;");
    expect(t).toContain("Hello & welcome");
    expect(t).toContain("- Python");
  });
});

describe("tokens and dedupe", () => {
  it("accepts board URLs", () => {
    expect(normalizeToken("greenhouse", "https://job-boards.greenhouse.io/Stripe")).toBe("stripe");
    expect(normalizeToken("lever", "https://jobs.lever.co/palantir/abc")).toBe("palantir");
    expect(normalizeToken("ashby", "https://jobs.ashbyhq.com/openai")).toBe("openai");
    expect(() => normalizeToken("greenhouse", "bad token!")).toThrow();
  });
  it("normalizes dedupe keys", () => {
    expect(dedupeKey({ company: "Acme Inc", title: "Senior Engineer (Backend)", location: "New York, NY" })).toBe(
      dedupeKey({ company: "acme inc", title: "Senior Engineer", location: "New York NY" }),
    );
  });
});

describe("robots.txt", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/jobs\n\nUser-agent: OtherBot\nDisallow: /");
  it("applies longest-match precedence", () => {
    expect(isAllowed(rules, "/careers")).toBe(true);
    expect(isAllowed(rules, "/private/x")).toBe(false);
    expect(isAllowed(rules, "/private/jobs/1")).toBe(true);
  });
  it("respects a specific group", () => {
    expect(isAllowed(parseRobots("User-agent: ApplyPilotBot\nDisallow: /\n"), "/jobs")).toBe(false);
  });
});

describe("JSON-LD JobPosting", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"JobPosting","title":"Data Engineer","description":"<p>Spark and Airflow</p>","datePosted":"2026-09-01","hiringOrganization":{"name":"Example Co"},"jobLocation":{"address":{"addressLocality":"Berlin","addressCountry":"DE"}},"baseSalary":{"currency":"EUR","value":{"minValue":70000,"maxValue":90000,"unitText":"YEAR"}},"identifier":{"value":"de-1"}}]}</script>`;
  it("extracts postings from @graph", () => {
    const [p] = extractJsonLd(html);
    const job = postingToJob(p!, "https://example.com/jobs/1", "example.com");
    expect(job).toMatchObject({ title: "Data Engineer", company: "Example Co", location: "Berlin, DE", externalId: "de-1" });
    expect(job?.salary).toMatchObject({ min: 70000, max: 90000, currency: "EUR", period: "year" });
  });
  it("drops expired postings", () => {
    expect(postingToJob({ "@type": "JobPosting", title: "Old", validThrough: "2020-01-01" }, "https://x", "x")).toBeNull();
  });
});
