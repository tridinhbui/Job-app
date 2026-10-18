import { Download, FileUp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { emptyResume } from "../../shared/defaults";
import type { BaseResume, ResumeEducation, ResumeExperience, ResumeProject } from "../../shared/types";
import { api, useApi } from "../api";
import { timeAgoT, useT } from "../i18n";
import { Badge, Button, Card, CardHeader, ErrorNote, Field, inputCls, Spinner, TagInput, useToast } from "../ui";

const rid = () => Math.random().toString(36).slice(2, 10);
const lines = (s: string) => s.split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);

interface ResumeResponse {
  resume: BaseResume;
  version: number;
  tailored: { job_id: string; method: string; created_at: number; resume_version: number; title: string; company: string }[];
}

function BulletsEditor({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const t = useT();
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [value]);
  return (
    <textarea
      className={`${inputCls} min-h-[110px] font-[450] leading-relaxed`}
      value={text}
      placeholder={placeholder ?? t("Mỗi dòng một thành tích", "One achievement per line")}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(lines(text))}
    />
  );
}

function ExperienceCard({ e, onChange, onRemove }: { e: ResumeExperience; onChange: (e: ResumeExperience) => void; onRemove: () => void }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-zinc-200 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("Chức danh", "Title")}>
          <input className={inputCls} value={e.title} onChange={(x) => onChange({ ...e, title: x.target.value })} />
        </Field>
        <Field label={t("Công ty", "Company")}>
          <input className={inputCls} value={e.company} onChange={(x) => onChange({ ...e, company: x.target.value })} />
        </Field>
        <Field label={t("Địa điểm", "Location")}>
          <input className={inputCls} value={e.location} onChange={(x) => onChange({ ...e, location: x.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Bắt đầu", "Start")} hint="YYYY-MM">
            <input className={inputCls} placeholder="2021-03" value={e.start} onChange={(x) => onChange({ ...e, start: x.target.value.trim() })} />
          </Field>
          <Field label={t("Kết thúc", "End")} hint={t("Để trống = hiện tại", "Empty = present")}>
            <input className={inputCls} placeholder={t("Hiện tại", "Present")} value={e.end} onChange={(x) => onChange({ ...e, end: x.target.value.trim() })} />
          </Field>
        </div>
      </div>
      <Field label={t("Thành tích", "Achievements")} className="mt-3">
        <BulletsEditor value={e.bullets} onChange={(bullets) => onChange({ ...e, bullets })} />
      </Field>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="h-3 w-3" /> {t("Xoá vị trí", "Remove role")}
        </Button>
      </div>
    </div>
  );
}

export default function ResumeEditor() {
  const t = useT();
  const { data, error, loading, reload } = useApi<ResumeResponse>("/resume");
  const [resume, setResume] = useState<BaseResume>(emptyResume());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<{ text: string; note?: string; method: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (data && !dirty) setResume(data.resume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const update = (patch: Partial<BaseResume>) => {
    setResume((r) => ({ ...r, ...patch }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api("/resume", { method: "PUT", json: resume });
      setDirty(false);
      toast(t("Đã lưu resume — đang chấm điểm lại việc làm", "Resume saved — re-matching jobs"));
      void reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const onImport = async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api<{ draft: BaseResume | null; text: string; method: string; note?: string }>("/resume/import", { method: "POST", body: fd });
      if (res.draft) {
        setResume(res.draft);
        setDirty(true);
        toast(t("Đã nhập — kiểm tra từng phần rồi lưu", "Imported — review each section, then save"));
      }
      setImportNote({ text: res.text, note: res.note, method: res.method });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (error) return <ErrorNote message={error} />;
  if (loading || !data) return <Spinner />;

  const setExp = (i: number, e: ResumeExperience) => update({ experience: resume.experience.map((x, j) => (j === i ? e : x)) });
  const setEdu = (i: number, e: ResumeEducation) => update({ education: resume.education.map((x, j) => (j === i ? e : x)) });
  const setProj = (i: number, p: ResumeProject) => update({ projects: resume.projects.map((x, j) => (j === i ? p : x)) });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
        <Button onClick={() => fileRef.current?.click()} loading={importing}>
          <FileUp className="h-3.5 w-3.5" /> {t("Nhập từ file", "Import file")}
        </Button>
        <a href="/api/resume/base.pdf" target="_blank" rel="noreferrer">
          <Button disabled={dirty}>
            <Download className="h-3.5 w-3.5" /> PDF
          </Button>
        </a>
        <a href="/api/resume/base.docx">
          <Button disabled={dirty}>
            <Download className="h-3.5 w-3.5" /> DOCX
          </Button>
        </a>
        <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
          {t("Lưu resume", "Save resume")}
        </Button>
      </div>

      {importNote && (
        <Card className="mb-4">
          <CardHeader
            title={importNote.method === "ai" ? t("Đã nhập và sắp xếp bằng AI", "Imported with AI structuring") : t("Đã trích xuất văn bản", "Text extracted")}
            subtitle={importNote.note}
            action={
              <Button size="sm" variant="ghost" onClick={() => setImportNote(null)}>
                {t("Đóng", "Dismiss")}
              </Button>
            }
          />
          {importNote.method !== "ai" && <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700">{importNote.text}</pre>}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title={t("Tiêu đề & tóm tắt", "Headline & summary")} />
            <div className="space-y-3">
              <Field label={t("Tiêu đề", "Headline")}>
                <input className={inputCls} value={resume.headline} placeholder="Senior Backend Engineer · Distributed systems" onChange={(e) => update({ headline: e.target.value })} />
              </Field>
              <Field label={t("Tóm tắt", "Summary")}>
                <textarea className={`${inputCls} min-h-[100px]`} value={resume.summary} onChange={(e) => update({ summary: e.target.value })} />
              </Field>
              <Field label={t("Kỹ năng", "Skills")} hint={t("Nhấn Enter hoặc dấu phẩy để thêm. Chỉ kỹ năng có ở đây hoặc trong kinh nghiệm mới được dùng.", "Press Enter or comma to add. Only skills listed here or in your experience are ever used.")}>
                <TagInput value={resume.skills} onChange={(skills) => update({ skills })} placeholder="TypeScript, PostgreSQL, Kubernetes…" />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title={t("Kinh nghiệm", "Experience")}
              subtitle={t("Gần nhất trước.", "Most recent first.")}
              action={
                <Button size="sm" onClick={() => update({ experience: [{ id: rid(), title: "", company: "", location: "", start: "", end: "", bullets: [] }, ...resume.experience] })}>
                  <Plus className="h-3 w-3" /> {t("Thêm vị trí", "Add role")}
                </Button>
              }
            />
            <div className="space-y-3">
              {resume.experience.length === 0 && <p className="text-sm text-zinc-500">{t("Chưa có vị trí nào. Nhập file resume hoặc thêm vị trí.", "No roles yet. Import a resume file or add a role.")}</p>}
              {resume.experience.map((e, i) => (
                <ExperienceCard key={e.id} e={e} onChange={(x) => setExp(i, x)} onRemove={() => update({ experience: resume.experience.filter((_, j) => j !== i) })} />
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={t("Dự án", "Projects")}
              action={
                <Button size="sm" onClick={() => update({ projects: [...resume.projects, { id: rid(), name: "", url: "", bullets: [], skills: [] }] })}>
                  <Plus className="h-3 w-3" /> {t("Thêm dự án", "Add project")}
                </Button>
              }
            />
            <div className="space-y-3">
              {resume.projects.map((p, i) => (
                <div key={p.id} className="rounded-lg border border-zinc-200 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("Tên", "Name")}>
                      <input className={inputCls} value={p.name} onChange={(e) => setProj(i, { ...p, name: e.target.value })} />
                    </Field>
                    <Field label="URL">
                      <input className={inputCls} value={p.url} onChange={(e) => setProj(i, { ...p, url: e.target.value })} />
                    </Field>
                  </div>
                  <Field label={t("Chi tiết", "Details")} className="mt-3">
                    <BulletsEditor value={p.bullets} onChange={(bullets) => setProj(i, { ...p, bullets })} />
                  </Field>
                  <Field label={t("Công nghệ", "Technologies")} className="mt-3">
                    <TagInput value={p.skills} onChange={(skills) => setProj(i, { ...p, skills })} />
                  </Field>
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => update({ projects: resume.projects.filter((_, j) => j !== i) })}>
                      <Trash2 className="h-3 w-3" /> {t("Xoá", "Remove")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={t("Học vấn", "Education")}
              action={
                <Button size="sm" onClick={() => update({ education: [...resume.education, { id: rid(), school: "", degree: "", field: "", start: "", end: "", details: [] }] })}>
                  <Plus className="h-3 w-3" /> {t("Thêm", "Add")}
                </Button>
              }
            />
            <div className="space-y-3">
              {resume.education.map((e, i) => (
                <div key={e.id} className="grid gap-3 rounded-lg border border-zinc-200 p-4 sm:grid-cols-2">
                  <Field label={t("Trường", "School")}>
                    <input className={inputCls} value={e.school} onChange={(x) => setEdu(i, { ...e, school: x.target.value })} />
                  </Field>
                  <Field label={t("Bằng cấp", "Degree")}>
                    <input className={inputCls} value={e.degree} onChange={(x) => setEdu(i, { ...e, degree: x.target.value })} />
                  </Field>
                  <Field label={t("Chuyên ngành", "Field of study")}>
                    <input className={inputCls} value={e.field} onChange={(x) => setEdu(i, { ...e, field: x.target.value })} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("Bắt đầu", "Start")}>
                      <input className={inputCls} value={e.start} placeholder="2016" onChange={(x) => setEdu(i, { ...e, start: x.target.value })} />
                    </Field>
                    <Field label={t("Kết thúc", "End")}>
                      <input className={inputCls} value={e.end} placeholder="2020" onChange={(x) => setEdu(i, { ...e, end: x.target.value })} />
                    </Field>
                  </div>
                  <div className="sm:col-span-2 flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => update({ education: resume.education.filter((_, j) => j !== i) })}>
                      <Trash2 className="h-3 w-3" /> {t("Xoá", "Remove")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title={t("Chứng chỉ", "Certifications")} />
            <TagInput value={resume.certifications} onChange={(certifications) => update({ certifications })} placeholder="AWS Solutions Architect – Associate (2023)" />
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="flex gap-3">
              <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-sm text-zinc-600">
                <div className="font-medium text-zinc-900">{t("Không bịa nội dung", "No fabrication")}</div>
                {t("Việc điều chỉnh chỉ sắp xếp và diễn đạt lại nội dung của bạn. Bộ kiểm tra từ chối mọi câu AI viết có thêm con số, công cụ hay kỹ năng bạn không có.", "Tailoring only reorders and rephrases your own content. A guard rejects any AI rewrite that adds a number, tool or skill you didn’t write.")}
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title={t("Các bản đã điều chỉnh", "Tailored versions")} subtitle={t(`Resume gốc v${data.version}`, `Master resume v${data.version}`)} />
            {data.tailored.length === 0 ? (
              <p className="text-sm text-zinc-500">{t("Sẽ xuất hiện sau khi bạn chuẩn bị hồ sơ.", "Appears after you prepare an application.")}</p>
            ) : (
              <ul className="space-y-3">
                {data.tailored.map((tv) => (
                  <li key={`${tv.job_id}-${tv.resume_version}-${tv.created_at}`} className="text-sm">
                    <div className="truncate font-medium">{tv.title}</div>
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      {tv.company} · {timeAgoT(t, tv.created_at)}
                      <Badge tone={tv.method === "ai" ? "violet" : "zinc"}>{tv.method === "ai" ? "AI" : t("Quy tắc", "Rules")}</Badge>
                      {tv.resume_version !== data.version && <Badge tone="amber">{t("bản cũ", "older")}</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
