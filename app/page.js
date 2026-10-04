'use client';
import { useEffect, useRef, useState } from 'react';
import { Home as HomeIcon, Users, Sparkles, ShieldCheck, Lock, HeartHandshake, Target, MapPin, GraduationCap, Briefcase, Loader2, AlertCircle, FileText, Ruler } from 'lucide-react';

const SAMPLE = `Female/26/Lahore/Single/Jutt

🔵 *Candidate Info*
👉>-Gender: Female
👉>-Marital status: Single
👉>-Date of birth: 12/03/2000
👉>-Height: 5'4
👉>-Education: Masters
👉>-Source of income: Software Engineer
👉>-Sect (Maslak) : Sunni
👉>-Caste : Jutt
👉>-Current City: Lahore

🔵 *Requirement*
👉>-Marital status: Single
👉>-Age: 28-32
👉>-Education : Masters
👉>-Sect : Sunni
👉>-Cast: Any
👉>-City: Lahore`;

const ringColor = (s) => (s > 80 ? '#1f7a4d' : s >= 60 ? '#c58a12' : '#9a8f8f');

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const el = Object.assign(document.createElement('textarea'), { value: t });
    document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove();
  }
}

function Ring({ score }) {
  const r = 22, c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center">
      <svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={`${score}% match`}>
        <circle cx="28" cy="28" r={r} fill="none" stroke="#efe6e0" strokeWidth="5" />
        <circle cx="28" cy="28" r={r} fill="none" stroke={ringColor(score)} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 28 28)" />
        <text x="28" y="33" textAnchor="middle" fontSize="14" fontWeight="700" fill={ringColor(score)}>{score}%</text>
      </svg>
      <span className="text-[11px] text-stone-500">Match</span>
    </div>
  );
}

const CHIP = { ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200', warn: 'bg-amber-50 text-amber-800 ring-amber-200', bad: 'bg-rose-50 text-rose-800 ring-rose-200', unknown: 'bg-stone-100 text-stone-500 ring-stone-200' };
const MARK = { ok: '✓', warn: '!', bad: '✗', unknown: '?' };
const CHIP_LABEL = { age: 'Age', city: 'City', sect: 'Sect', caste: 'Caste', edu: 'Education', marital: 'Marital', house: 'House' };
const VERDICT = { Strong: 'bg-emerald-100 text-emerald-800', Good: 'bg-teal-100 text-teal-800', Fair: 'bg-amber-100 text-amber-800', Fallback: 'bg-stone-200 text-stone-700' };

function Result({ r, cand }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const askAI = async () => {
    setNoteLoading(true); setNote(null);
    try {
      const res = await fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'note', id: r.id, candidate: cand }) });
      const raw = await res.text();
      let j; try { j = JSON.parse(raw); } catch { j = { error: 'No reply from the AI. Please try again.' }; }
      setNote(j);
    } catch { setNote({ error: 'Network problem. Please try again.' }); }
    finally { setNoteLoading(false); }
  };
  const i = r.info || {};
  const onCopy = async () => { await copyText(r.text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const facts = [
    [MapPin, i.city], [Ruler, i.height], [GraduationCap, i.education], [Briefcase, i.work],
  ].filter(([, v]) => v && !/^(n\/?a|none)$/i.test(String(v).trim()));
  return (
    <article className="rounded-2xl border border-maroon/10 bg-paper p-4 shadow-sm">
      <div className="flex gap-3">
        <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-blush font-[family-name:var(--font-serif)] text-lg font-semibold text-maroon">
          {String(r.id).replace(/\D/g, '') || 'NC'}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-[family-name:var(--font-mono)] text-base font-semibold text-ink">{r.id}{r.verdict && <span className={`ml-2 rounded-full px-2 py-0.5 align-middle text-[11px] font-medium ${VERDICT[r.verdict] || ''}`}>{r.verdict}</span>}</h3>
          <p className="text-sm text-stone-600">
            {[i.gender, i.age && `${i.age} Years`, i.marital, i.caste].filter((x) => x && !/^(n\/?a|none)$/i.test(String(x).trim())).join(' · ')}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-stone-600">
            {facts.map(([Icon, v], k) => (
              <li key={k} className="flex items-center gap-1.5 truncate"><Icon size={12} className="shrink-0 text-maroon/70" />{v}</li>
            ))}
          </ul>
        </div>
        <Ring score={r.score} />
      </div>

      {r.chips && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Object.entries(r.chips).map(([k, v]) => <span key={k} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${CHIP[v]}`}>{MARK[v]} {CHIP_LABEL[k] || k}</span>)}
        </div>
      )}
      {r.also_ids?.length > 0 && <p className="mt-2 text-xs text-stone-500">Same profile also stored as {r.also_ids.join(', ')} (details combined)</p>}
      <ul className="mt-3 space-y-1 border-t border-maroon/10 pt-3 text-[13px] text-stone-700">
        {r.reasons.map((x, k) => {
          const mark = x[0], text = '✓✗!'.includes(mark) ? x.slice(2) : x;
          const dot = mark === '✓' ? 'bg-emerald-600' : mark === '✗' ? 'bg-rose-500' : 'bg-amber-500';
          return <li key={k} className="flex gap-2"><span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot}`} />{text}</li>;
        })}
      </ul>

      {note && (
        <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-[13px] text-stone-800">
          <p className="text-xs font-semibold text-indigo-800">AI note (please verify manually)</p>
          {note.error ? <p className="mt-1 text-rose-700">{note.error}</p>
            : note.notes?.length ? <ul className="mt-1 space-y-1.5">{note.notes.map((n, k) => <li key={k}>{n.text}<span className="block text-[11px] text-stone-500">From data: {n.evidence.join(' | ')}</span></li>)}</ul>
            : <p className="mt-1">Nothing extra to flag in the free-text fields.</p>}
        </div>
      )}

      {open && (
        <pre className="mt-3 max-h-60 overflow-auto rounded-xl border border-maroon/10 bg-blush/70 p-3 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed whitespace-pre-wrap text-maroon-deep">
          {r.text}
        </pre>
      )}

      <button onClick={askAI} disabled={noteLoading} className="mt-3 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm font-medium text-indigo-800 transition hover:bg-indigo-50 disabled:opacity-60">
        {noteLoading ? 'Asking the AI…' : '🤖 AI second opinion'}
      </button>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button onClick={() => setOpen(!open)} className="rounded-xl border border-maroon/25 bg-white px-3 py-2 text-sm font-medium text-maroon transition hover:bg-blush">
          {open ? 'Hide Profile' : 'View Profile'}
        </button>
        <button onClick={onCopy} className={`rounded-xl px-3 py-2 text-sm font-medium transition active:scale-[0.98] ${copied ? 'bg-emerald-700 text-white' : 'bg-maroon text-white hover:bg-maroon-deep'}`}>
          {copied ? '✓ Copied!' : '📋 Copy Profile for WhatsApp'}
        </button>
      </div>
    </article>
  );
}

const TRUST = [
  [ShieldCheck, 'Verified Profiles', 'Safe & Trusted'],
  [Sparkles, 'Smart Matching', 'AI Powered'],
  [Lock, 'Privacy First', 'Your Data is Safe'],
  [Users, 'Family Oriented', 'Halal & Respectful'],
];

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [det, setDet] = useState(null);
  const ta = useRef(null);
  const results = useRef(null);

  useEffect(() => {
    if (!ta.current) return;
    ta.current.style.height = 'auto';
    ta.current.style.height = Math.min(Math.max(ta.current.scrollHeight, 160), 420) + 'px';
  }, [prompt]);

  useEffect(() => {
    const t = prompt.trim();
    if (t.length < 60 || /^NC-\d+$/i.test(t)) { setDet(null); return; }
    const h = setTimeout(async () => {
      try {
        const res = await fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: t, action: 'parse' }) });
        const j = await res.json();
        if (j.candidate) setDet({ gender: j.candidate.gender || '', age: j.candidate.age ?? '', city: j.candidate.city || '', req_age_range: j.candidate.req_age_range || '', source: j.candidate.age_source || '' });
      } catch { /* the search still works without this box */ }
    }, 700);
    return () => clearTimeout(h);
  }, [prompt]);
  const upd = (k, v) => setDet((d) => ({ ...d, [k]: v, ...(k === 'age' ? { source: 'edited by you' } : {}) }));
  const detMissing = det && !(det.gender && Number(det.age) > 0 && String(det.city).trim());

  const run = async () => {
    setLoading(true); setError(''); setData(null);
    results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, overrides: det ? { gender: det.gender, age: det.age, city: det.city, req_age_range: det.req_age_range } : undefined }),
      });
      const raw = await res.text();
      let json;
      try { json = JSON.parse(raw); }
      catch { throw new Error(res.ok ? 'The server sent an empty reply. Please press the button again.' : `The server did not answer properly (code ${res.status}). Please try again in a minute.`); }
      if (!res.ok) throw new Error(json.error || 'Request failed');
      setData(json);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const serif = 'font-[family-name:var(--font-serif)]';

  return (
    <div id="top" className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-maroon/10 bg-blush p-5 lg:flex">
        <div className="text-center">
          <span className={`${serif} text-3xl font-semibold italic text-maroon`}>Nikah Connect</span>
          <p className="mt-1 text-[10px] tracking-[0.15em] text-stone-500">TRUSTED BY FAMILIES FOR NIKAH</p>
        </div>
        <nav className="mt-8 space-y-1 text-sm">
          {[[HomeIcon, 'Home', '#top', true], [Users, 'Find Matches', '#matcher'], [Target, 'Matching Results', '#results']].map(([Icon, label, href, on]) => (
            <a key={label} href={href} className={`flex items-center gap-3 rounded-xl px-4 py-3 transition ${on ? 'bg-maroon text-white' : 'text-stone-700 hover:bg-white/70'}`}>
              <Icon size={18} />{label}
            </a>
          ))}
        </nav>
        <p className={`${serif} mt-auto text-center text-sm italic leading-relaxed text-stone-500`}>
          Nikah is not just a union of two hearts, but a union of two families in the path of Allah.
        </p>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="border-b border-maroon/10 bg-blush px-4 py-3 text-center lg:hidden">
          <span className={`${serif} text-2xl font-semibold italic text-maroon`}>Nikah Connect</span>
        </div>
        <p className={`${serif} hidden py-5 text-center text-lg italic text-gold lg:block`}>“Halal Rishton Se Behtar Koi Rasta Nahi”</p>

        <div className="mx-auto grid max-w-7xl gap-6 px-4 pb-16 pt-4 lg:px-8 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="space-y-6">
            <section className="rounded-3xl bg-gradient-to-br from-[#fbf2eb] to-[#f3e2d9] p-6 md:p-8">
              <span className="inline-flex items-center gap-2 rounded-full bg-gold-soft px-3 py-1 text-xs font-semibold text-gold">
                <Sparkles size={14} /> AI POWERED MATCHMAKER
              </span>
              <h1 className={`${serif} mt-4 text-4xl font-semibold leading-tight text-maroon md:text-5xl`}>Find Your Perfect<br />Life Partner</h1>
              <p className="mt-3 max-w-md text-stone-600">Share the profile details and let our AI matchmaker find the most compatible matches for you.</p>
              <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
                {TRUST.map(([Icon, t, s]) => (
                  <div key={t} className="flex items-center gap-2">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white/70 text-maroon"><Icon size={18} /></span>
                    <div className="leading-tight"><p className="text-xs font-semibold text-ink">{t}</p><p className="text-[11px] text-stone-500">{s}</p></div>
                  </div>
                ))}
              </div>
            </section>

            <section id="matcher" className="scroll-mt-4 rounded-3xl border border-maroon/10 bg-paper p-5 shadow-sm md:p-7">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className={`${serif} flex items-center gap-2 text-xl font-semibold text-ink`}><FileText size={20} className="text-maroon" />1. Paste Client Profile</h2>
                  <p className="mt-1 text-sm text-stone-500">Copy and paste the profile details, or type a profile ID such as NC-102.</p>
                </div>
                <button onClick={() => { setPrompt(SAMPLE); setError(''); }} className="shrink-0 rounded-lg border border-maroon/20 px-3 py-1.5 text-xs font-medium text-maroon hover:bg-blush">Use Sample</button>
              </div>
              <textarea
                ref={ta} value={prompt} maxLength={5000} onChange={(e) => setPrompt(e.target.value)}
                placeholder={'Paste the full Nikah Connect bio-data here…\n\nExample: Gender, age, city, sect, caste, education and requirements.'}
                className="mt-4 w-full resize-none rounded-2xl border border-maroon/15 bg-white p-4 text-sm text-ink outline-none placeholder:text-stone-400 focus:border-maroon/50 focus:ring-4 focus:ring-maroon/10"
              />
              <p className="mt-1 text-right text-xs text-stone-400">{prompt.length}/5000</p>
              {det && (
                <div className="mt-3 rounded-2xl bg-blush p-3">
                  <p className="text-xs font-semibold text-maroon">Detected details: please check before searching (you can edit them)</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <label className="text-xs text-stone-600">Gender
                      <select value={det.gender} onChange={(e) => upd('gender', e.target.value)} className="mt-1 w-full rounded-lg border border-maroon/20 bg-white px-2 py-1.5 text-sm text-ink">
                        <option value="">?</option><option>Male</option><option>Female</option>
                      </select>
                    </label>
                    <label className="text-xs text-stone-600">Age
                      <input type="number" min="15" max="80" value={det.age} onChange={(e) => upd('age', e.target.value)} className="mt-1 w-full rounded-lg border border-maroon/20 bg-white px-2 py-1.5 text-sm text-ink" />
                    </label>
                    <label className="text-xs text-stone-600">City
                      <input value={det.city} onChange={(e) => upd('city', e.target.value)} className="mt-1 w-full rounded-lg border border-maroon/20 bg-white px-2 py-1.5 text-sm text-ink" />
                    </label>
                    <label className="text-xs text-stone-600">Wanted age
                      <input value={det.req_age_range} onChange={(e) => upd('req_age_range', e.target.value)} placeholder="e.g. 28-32" className="mt-1 w-full rounded-lg border border-maroon/20 bg-white px-2 py-1.5 text-sm text-ink" />
                    </label>
                  </div>
                  {det.source && <p className="mt-1 text-[11px] text-stone-500">Age read from: {det.source}</p>}
                  {detMissing && <p className="mt-1 text-[11px] font-medium text-rose-700">Please fill gender, age and city before searching.</p>}
                </div>
              )}

              <div className="relative mt-4">
                {!loading && <span className="absolute inset-0 rounded-2xl bg-maroon/40 blur-lg animate-pulse motion-reduce:animate-none" />}
                <button
                  onClick={run} disabled={loading || !prompt.trim() || !!detMissing}
                  className="relative flex w-full items-center justify-center gap-2 rounded-2xl bg-maroon py-4 text-base font-semibold text-white transition hover:bg-maroon-deep active:scale-[0.99] disabled:opacity-50"
                >
                  {loading ? <><Loader2 size={18} className="animate-spin" /> Finding matches…</> : '⚡ Run AI Matchmaker Engine'}
                </button>
              </div>
            </section>
          </div>

          <section id="results" ref={results} className="scroll-mt-4 self-start rounded-3xl border border-maroon/10 bg-paper p-5 shadow-sm xl:sticky xl:top-4">
            <h2 className={`${serif} flex items-center gap-2 text-xl font-semibold text-ink`}><Target size={20} className="text-maroon" />Matching Results</h2>
            <p className="mt-1 text-sm text-stone-500">Top compatible matches based on your criteria</p>

            {error && (
              <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />{error}
              </p>
            )}
            {loading && <p className="mt-6 flex items-center gap-2 text-sm text-stone-600"><Loader2 size={16} className="animate-spin" />Checking profiles against the matching rules…</p>}
            {!loading && !data && !error && (
              <div className="mt-6 rounded-2xl bg-blush p-5 text-center text-sm text-stone-600">
                <HeartHandshake className="mx-auto mb-2 text-maroon" />
                Paste a profile on the left and press the button. Matches will appear here.
              </div>
            )}
            {data && (
              <>
                <p className="mt-3 text-xs text-stone-500">
                  Candidate: {data.candidate.gender}, {data.candidate.age} years{data.candidate.age_source ? ` (age read from ${data.candidate.age_source})` : ''}, {data.candidate.city}. Showing {data.showing} profiles only. Checked {data.stats.scanned}; {data.stats.disqualified} removed by the age rule{data.stats.unknownGender ? `; ${data.stats.unknownGender} profiles skipped because gender is missing in the database` : ''}.
                </p>
                {data.results.length === 0 ? (
                  <p className="mt-6 text-sm text-stone-700">
                    {data.stats.total === 0
                      ? 'The database returned 0 profiles. Check the table name and that read access (RLS policy or service key) is set up in Supabase.'
                      : data.stats.scanned === 0
                      ? `No opposite-gender profiles were found among ${data.stats.total} rows. Check the Gender column values. Columns seen: ${(data.stats.columns || []).join(', ')}`
                      : 'No suitable matches found. Try a bio-data with more detail, or check back after new profiles are added.'}
                  </p>
                ) : (
                  <div className="mt-4 space-y-4 xl:max-h-[calc(100vh-11rem)] xl:overflow-y-auto xl:pr-1">
                    {data.results.some((r) => r.group === 'best') ? (
                      <p className="text-sm font-semibold text-emerald-800">Best matches</p>
                    ) : (
                      <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">No profile fits the stated requirement fully. These are the closest options, with lower match percentages.</p>
                    )}
                    {data.results.filter((r) => r.group === 'best').map((r) => <Result key={r.id} r={r} cand={data.candidate_data} />)}
                    {data.results.some((r) => r.group === 'option') && data.results.some((r) => r.group === 'best') && (
                      <p className="pt-2 text-sm font-semibold text-amber-800">Other options (outside the stated requirement, lower match)</p>
                    )}
                    {data.results.filter((r) => r.group === 'option').map((r) => <Result key={r.id} r={r} cand={data.candidate_data} />)}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
