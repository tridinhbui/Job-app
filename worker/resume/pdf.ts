import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { BaseResume, PersonalInfo } from "../../shared/types";

// ATS-friendly PDF: single column, real text (no images/tables), standard fonts,
// conventional section headings. Rendered in the Worker with pdf-lib (no browser time).

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN_X = 54;
const MARGIN_Y = 50;
const BODY = 10;
const LINE = 13.2;

/** Standard PDF fonts only support WinAnsi; map common Unicode punctuation and drop the rest. */
export function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–‒]/g, "-")
    .replace(/[—―]/g, "--")
    .replace(/…/g, "...")
    .replace(/[•●▪◦∙]/g, "-")
    .replace(/[  -​]/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e\xa1-\xff\n]/g, "");
}

export function formatRange(start: string, end: string) {
  const f = (s: string) => {
    const m = s.match(/^(\d{4})(?:-(\d{2}))?/);
    if (!m) return s;
    if (!m[2]) return m[1]!;
    return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1] ?? ""} ${m[1]}`;
  };
  if (!start && !end) return "";
  return `${start ? f(start) : ""} - ${end ? f(end) : "Present"}`;
}

export function contactLine(p: PersonalInfo): string {
  const loc = [p.city, p.region, p.country].filter(Boolean).join(", ");
  return [p.email, p.phone, loc, p.linkedin, p.github, p.website].filter(Boolean).join("  |  ");
}

class Writer {
  page: PDFPage;
  y = PAGE_H - MARGIN_Y;
  constructor(
    private doc: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
  ) {
    this.page = doc.addPage([PAGE_W, PAGE_H]);
  }

  private ensure(h: number) {
    if (this.y - h < MARGIN_Y) {
      this.page = this.doc.addPage([PAGE_W, PAGE_H]);
      this.y = PAGE_H - MARGIN_Y;
    }
  }

  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const para of toWinAnsi(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) line = next;
        else {
          if (line) lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(text: string, opts: { size?: number; bold?: boolean; indent?: number; color?: number; gapAfter?: number } = {}) {
    const size = opts.size ?? BODY;
    const font = opts.bold ? this.bold : this.regular;
    const x = MARGIN_X + (opts.indent ?? 0);
    const lh = size * 1.32;
    for (const line of this.wrap(text, font, size, PAGE_W - MARGIN_X - x)) {
      this.ensure(lh);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: rgb(opts.color ?? 0.1, opts.color ?? 0.1, opts.color ?? 0.1) });
      this.y -= lh;
    }
    this.y -= opts.gapAfter ?? 0;
  }

  /** Left text + right-aligned text on the same line (e.g. title and dates). */
  split(left: string, right: string, size = BODY) {
    this.ensure(LINE);
    const r = toWinAnsi(right);
    const rw = this.regular.widthOfTextAtSize(r, size);
    const maxLeft = PAGE_W - 2 * MARGIN_X - rw - 12;
    const l = this.wrap(left, this.bold, size, maxLeft);
    this.page.drawText(l[0] ?? "", { x: MARGIN_X, y: this.y - size, size, font: this.bold, color: rgb(0.1, 0.1, 0.1) });
    if (r) this.page.drawText(r, { x: PAGE_W - MARGIN_X - rw, y: this.y - size, size, font: this.regular, color: rgb(0.3, 0.3, 0.3) });
    this.y -= size * 1.32;
    for (const extra of l.slice(1)) this.text(extra, { bold: true, size });
  }

  bullet(text: string) {
    const size = BODY;
    const indent = 12;
    const lines = this.wrap(text, this.regular, size, PAGE_W - 2 * MARGIN_X - indent);
    lines.forEach((line, i) => {
      this.ensure(LINE);
      if (i === 0) this.page.drawText("-", { x: MARGIN_X + 2, y: this.y - size, size, font: this.regular });
      this.page.drawText(line, { x: MARGIN_X + indent, y: this.y - size, size, font: this.regular, color: rgb(0.1, 0.1, 0.1) });
      this.y -= LINE;
    });
  }

  heading(title: string) {
    this.y -= 6;
    this.ensure(28);
    this.page.drawText(title.toUpperCase(), { x: MARGIN_X, y: this.y - 11, size: 11, font: this.bold, color: rgb(0.08, 0.08, 0.08) });
    this.y -= 15;
    this.page.drawLine({
      start: { x: MARGIN_X, y: this.y },
      end: { x: PAGE_W - MARGIN_X, y: this.y },
      thickness: 0.6,
      color: rgb(0.6, 0.6, 0.6),
    });
    this.y -= 5;
  }
}

export async function renderResumePdf(resume: BaseResume, personal: PersonalInfo, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const name = `${personal.firstName} ${personal.lastName}`.trim() || "Resume";
  doc.setTitle(title ? `${name} - ${title}` : name);
  doc.setAuthor(name);
  doc.setCreator("ApplyPilot");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold);

  w.text(name, { size: 18, bold: true, gapAfter: 1 });
  if (resume.headline) w.text(resume.headline, { size: 11, color: 0.25 });
  const contact = contactLine(personal);
  if (contact) w.text(contact, { size: 9, color: 0.3, gapAfter: 2 });

  if (resume.summary) {
    w.heading("Summary");
    w.text(resume.summary);
  }
  if (resume.skills.length) {
    w.heading("Skills");
    w.text(resume.skills.join(", "));
  }
  if (resume.experience.length) {
    w.heading("Experience");
    for (const e of resume.experience) {
      w.split(`${e.title}${e.company ? `, ${e.company}` : ""}`, formatRange(e.start, e.end));
      if (e.location) w.text(e.location, { size: 9, color: 0.35 });
      for (const b of e.bullets) w.bullet(b);
      w.y -= 4;
    }
  }
  if (resume.projects.length) {
    w.heading("Projects");
    for (const p of resume.projects) {
      w.split(p.name, p.url);
      for (const b of p.bullets) w.bullet(b);
      if (p.skills.length) w.text(`Technologies: ${p.skills.join(", ")}`, { size: 9, color: 0.35 });
      w.y -= 4;
    }
  }
  if (resume.education.length) {
    w.heading("Education");
    for (const e of resume.education) {
      const degree = [e.degree, e.field].filter(Boolean).join(", ");
      w.split(`${degree}${degree && e.school ? " - " : ""}${e.school}`, formatRange(e.start, e.end));
      for (const d of e.details) w.bullet(d);
    }
  }
  if (resume.certifications.length) {
    w.heading("Certifications");
    for (const c of resume.certifications) w.bullet(c);
  }
  return doc.save();
}
