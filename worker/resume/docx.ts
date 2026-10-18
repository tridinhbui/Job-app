import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TabStopType, TextRun } from "docx";
import type { BaseResume, PersonalInfo } from "../../shared/types";
import { contactLine, formatRange } from "./pdf";

// ATS-friendly DOCX: one column, real headings, simple bullets, no tables/text boxes.
// Generated on demand (not stored) to save R2 writes.

const heading = (text: string) =>
  new Paragraph({
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999", space: 2 } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 22 })],
  });

const bullet = (text: string) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text, size: 20 })] });

const line = (left: string, right: string) =>
  new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: 10080 }],
    spacing: { before: 80 },
    children: [new TextRun({ text: left, bold: true, size: 20 }), new TextRun({ text: right ? `\t${right}` : "", size: 20, color: "555555" })],
  });

export async function renderResumeDocx(resume: BaseResume, personal: PersonalInfo): Promise<Uint8Array> {
  const name = `${personal.firstName} ${personal.lastName}`.trim() || "Resume";
  const children: Paragraph[] = [
    new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: name, bold: true, size: 36 })] }),
  ];
  if (resume.headline) children.push(new Paragraph({ children: [new TextRun({ text: resume.headline, size: 22, color: "444444" })] }));
  const contact = contactLine(personal);
  if (contact) children.push(new Paragraph({ children: [new TextRun({ text: contact, size: 18, color: "555555" })] }));

  if (resume.summary) children.push(heading("Summary"), new Paragraph({ children: [new TextRun({ text: resume.summary, size: 20 })] }));
  if (resume.skills.length) children.push(heading("Skills"), new Paragraph({ children: [new TextRun({ text: resume.skills.join(", "), size: 20 })] }));
  if (resume.experience.length) {
    children.push(heading("Experience"));
    for (const e of resume.experience) {
      children.push(line(`${e.title}${e.company ? `, ${e.company}` : ""}`, formatRange(e.start, e.end)));
      if (e.location) children.push(new Paragraph({ children: [new TextRun({ text: e.location, size: 18, color: "666666" })] }));
      children.push(...e.bullets.map(bullet));
    }
  }
  if (resume.projects.length) {
    children.push(heading("Projects"));
    for (const p of resume.projects) {
      children.push(line(p.name, p.url));
      children.push(...p.bullets.map(bullet));
      if (p.skills.length) children.push(new Paragraph({ children: [new TextRun({ text: `Technologies: ${p.skills.join(", ")}`, size: 18, color: "666666" })] }));
    }
  }
  if (resume.education.length) {
    children.push(heading("Education"));
    for (const e of resume.education) {
      const degree = [e.degree, e.field].filter(Boolean).join(", ");
      children.push(line(`${degree}${degree && e.school ? " - " : ""}${e.school}`, formatRange(e.start, e.end)));
      children.push(...e.details.map(bullet));
    }
  }
  if (resume.certifications.length) children.push(heading("Certifications"), ...resume.certifications.map(bullet));

  const doc = new Document({
    creator: "ApplyPilot",
    title: name,
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1080, right: 1080 } } }, children }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
