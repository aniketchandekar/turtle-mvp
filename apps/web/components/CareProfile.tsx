'use client';

import { useEffect, useState } from 'react';
import type { ConsentRecord, OnboardingSnapshot, OnboardingStepId } from '@turtle/shared';
import { CheckCircle2, Download, History, PauseCircle, Pencil, Save, ShieldCheck, X } from 'lucide-react';
import { PrivacyControls } from './PrivacyControls';
import { TurtleLogo } from './TurtleLogo';

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8787';
const CAREGIVER_ID = process.env.NEXT_PUBLIC_CAREGIVER_ID ?? 'local-caregiver';

const HIDDEN = new Set<OnboardingStepId>(['ai_data_consent', 'patient_authorization', 'caregiver_review', 'patient_review', 'wrap_up', 'complete']);

export function CareProfile({ isOpen, onClose, snapshot, onRefresh }: { isOpen: boolean; onClose(): void; snapshot: OnboardingSnapshot | null; onRefresh(): Promise<void> }) {
  const [editing, setEditing] = useState<OnboardingStepId | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    void fetch(`${SERVER_URL}/caregivers/${encodeURIComponent(CAREGIVER_ID)}/consents`)
      .then((res) => res.ok ? res.json() : { records: [] })
      .then((body: { records?: ConsentRecord[] }) => setConsents(body.records ?? []))
      .catch(() => setConsents([]));
  }, [isOpen]);

  if (!isOpen) return null;
  const answers = Object.entries(snapshot?.answers ?? {}).filter(([step]) => !HIDDEN.has(step as OnboardingStepId)) as Array<[OnboardingStepId, { raw: string; normalized: string | number | boolean | null; confirmedAt: string | null; skipped: boolean }]>;

  async function save(stepId: OnboardingStepId) {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`${SERVER_URL}/caregivers/${encodeURIComponent(CAREGIVER_ID)}/onboarding/profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepId, value: value.trim(), captureMethod: 'typed' }) });
      if (res.ok) { await onRefresh(); setEditing(null); }
    } finally { setSaving(false); }
  }

  async function revoke(record: ConsentRecord) {
    setRevoking(record.id);
    try {
      const res = await fetch(`${SERVER_URL}/caregivers/${encodeURIComponent(CAREGIVER_ID)}/consents/${record.consent_type}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoked', evidence: 'Revoked from family care record', actor: 'caregiver', subject: record.subject, captureMethod: 'typed', locale: snapshot?.locale ?? 'en' }),
      });
      if (res.ok) window.location.reload();
    } finally { setRevoking(null); }
  }

  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-[#0b192c]/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="care-profile-title" onClick={onClose}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto bg-[#f8fafc] shadow-[-24px_0_70px_rgba(11,25,44,.24)]" onClick={(event) => event.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[#dbe4f0] bg-white/95 px-6 py-5 backdrop-blur sm:px-8">
          <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#1d4ed8] text-[#fbbf24]"><TurtleLogo className="h-5 w-5 fill-current" /></span><div><h2 id="care-profile-title" className="m-0 text-xl font-extrabold text-[#0b192c]">Family care record</h2><p className="m-0 mt-0.5 text-xs text-[#64748b]">Confirmed context, consent, and privacy controls</p></div></div>
          <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full border border-[#cbd5e1] bg-white text-[#64748b] hover:bg-[#eff6ff] hover:text-[#1d4ed8]" aria-label="Close care profile"><X className="h-4 w-4" /></button>
        </header>

        <div className="space-y-6 p-6 sm:p-8">
          <section className="rounded-3xl border border-[#dbe4f0] bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between"><div><h3 className="m-0 text-sm font-extrabold text-[#0b192c]">Captured details</h3><p className="m-0 mt-1 text-xs text-[#64748b]">Every answer can be corrected. Raw wording remains visible.</p></div><CheckCircle2 className="h-5 w-5 text-emerald-600" /></div>
            <div className="mt-5 divide-y divide-[#e2e8f0]">
              {answers.map(([stepId, answer]) => <div key={stepId} className="py-4 first:pt-0 last:pb-0">{editing === stepId ? <div className="flex gap-2"><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} className="h-11 min-w-0 flex-1 rounded-xl border border-[#93c5fd] px-3 text-sm outline-none ring-4 ring-[#eff6ff]" aria-label={`Correct ${stepId}`} /><button type="button" disabled={saving} onClick={() => void save(stepId)} className="grid h-11 w-11 place-items-center rounded-xl bg-[#1d4ed8] text-white disabled:opacity-50" aria-label="Save correction"><Save className="h-4 w-4" /></button></div> : <button type="button" onClick={() => { setEditing(stepId); setValue(answer.raw); }} className="group flex w-full items-start justify-between gap-4 text-left"><span><span className="block text-[10px] font-extrabold uppercase tracking-[.12em] text-[#64748b]">{stepId.replaceAll('_', ' ')}</span><span className={`mt-1 block text-sm font-semibold ${answer.skipped ? 'italic text-amber-700' : 'text-[#0b192c]'}`}>{answer.skipped ? 'Skipped — tap to complete' : answer.raw}</span>{answer.normalized !== null && String(answer.normalized) !== answer.raw ? <span className="mt-1 block text-[11px] text-[#64748b]">Stored category: {String(answer.normalized)}</span> : null}</span><span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#1d4ed8] opacity-70 group-hover:opacity-100"><Pencil className="h-3.5 w-3.5" />Tap to fix</span></button>}</div>)}
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#dbe4f0] bg-white p-4"><PauseCircle className="h-5 w-5 text-[#f59e0b]" /><p className="mt-3 mb-0 text-sm font-extrabold">Future calls paused</p><p className="mt-1 mb-0 text-xs leading-5 text-[#64748b]">No weekly call or message is active in this web release.</p></div>
            <a href={`${SERVER_URL}/caregivers/${encodeURIComponent(CAREGIVER_ID)}/export`} download className="rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] p-4 text-[#1d4ed8] no-underline hover:border-[#60a5fa]"><Download className="h-5 w-5" /><p className="mt-3 mb-0 text-sm font-extrabold">Export your record</p><p className="mt-1 mb-0 text-xs leading-5 text-[#475569]">Download profile, consent history, logs, appointments, and summaries as JSON.</p></a>
          </section>

          <section className="rounded-3xl border border-[#dbe4f0] bg-white p-5"><div className="flex items-center gap-2"><History className="h-5 w-5 text-[#1d4ed8]" /><h3 className="m-0 text-sm font-extrabold">Consent history</h3></div><div className="mt-4 space-y-3">{consents.map((record, index) => { const isLatest = !consents.slice(index + 1).some((later) => later.consent_type === record.consent_type); return <div key={record.id} className="flex items-start justify-between gap-4 rounded-xl bg-[#f8fafc] p-3"><span><span className="block text-xs font-bold text-[#0b192c]">{record.consent_type.replaceAll('_', ' ')}</span><span className="mt-0.5 block text-[11px] text-[#64748b]">{record.capture_method} · {new Date(record.captured_at).toLocaleString()}</span></span><span className="flex items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase ${record.action === 'granted' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{record.action}</span>{isLatest && record.action === 'granted' && record.consent_type !== 'outbound_ai_call' ? <button type="button" disabled={revoking === record.id} onClick={() => void revoke(record)} className="text-[10px] font-extrabold text-rose-600 underline decoration-rose-200 underline-offset-2 disabled:opacity-50">Revoke</button> : null}</span></div>; })}{consents.length === 0 ? <p className="text-xs text-[#64748b]">No consent records yet.</p> : null}</div></section>

          <section className="rounded-3xl border border-rose-200 bg-white p-5"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-rose-600" /><div><h3 className="m-0 text-sm font-extrabold">Privacy controls</h3><p className="mt-1 mb-4 text-xs leading-5 text-[#64748b]">Deletion is scoped to this caregiver and removes the onboarding profile and consent ledger with the rest of the family record.</p><PrivacyControls label="Delete this family record" /></div></div></section>
        </div>
      </aside>
    </div>
  );
}
