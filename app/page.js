'use client';
import { useEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, HeartHandshake, ClipboardPaste, Loader2, AlertCircle, Users, MapPin } from 'lucide-react';

const badge = (s) =>
  s > 80 ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/40'
  : s >= 60 ? 'bg-amber-400/15 text-amber-300 ring-amber-400/40'
  : 'bg-slate-500/15 text-slate-300 ring-slate-500/40';

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const el = Object.assign(document.createElement('textarea'), { value: t });
    document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove();
  }
}

function Card({ r }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await copyText(r.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <article className="flex flex-col rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-xl shadow-black/30">
      <header className="flex items-center justify-between">
        <h3 className="font-[family-name:var(--font-mono)] text-lg font-semibold text-slate-100">{r.id}</h3>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ring-1 ${badge(r.score)}`}>{r.score}% match</span>
      </header>
      <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
        <MapPin size={12} />
        {r.tier === 'exact' ? 'Same city' : r.tier === 'nearby' ? 'Nearby city' : 'Different city'}
      </p>
      <ul className="mt-4 space-y-1.5 text-sm text-slate-300">
        {r.reasons.map((x, i) => (
          <li key={i} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-indigo-400" />{x}</li>
        ))}
      </ul>
      <pre className="mt-4 max-h-64 overflow-auto rounded-xl border border-white/10 bg-black/50 p-3 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed whitespace-pre-wrap text-emerald-100/90">
        {r.text}
      </pre>
      <button
        onClick={onCopy}
        className={`mt-4 rounded-xl px-4 py-2.5 text-sm font-medium transition active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-indigo-400 ${
          copied ? 'bg-emerald-500 text-slate-950' : 'bg-white/5 text-slate-100 ring-1 ring-white/15 hover:bg-white/10'
        }`}
      >
        {copied ? '✓ Copied!' : '📋 Copy Profile for WhatsApp'}
      </button>
    </article>
  );
}

export default function Home() {
  const [open, setOpen] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const ta = useRef(null);

  useEffect(() => {
    if (!ta.current) return;
    ta.current.style.height = 'auto';
    ta.current.style.height = Math.min(ta.current.scrollHeight, 320) + 'px';
  }, [prompt]);

  const paste = async () => {
    try { setPrompt(await navigator.clipboard.readText()); }
    catch { setError('Clipboard access was blocked. Paste with Ctrl+V instead.'); }
  };

  const run = async () => {
    setLoading(true); setError(''); setData(null);
    try {
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed');
      setData(json);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="flex min-h-screen">
      <aside className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-white/10 bg-slate-950 p-3 transition-[width] duration-200 md:flex ${open ? 'w-64' : 'w-16'}`}>
        <div className="flex items-center gap-3 px-2 py-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-400 text-slate-950"><HeartHandshake size={20} /></span>
          {open && (
            <div className="leading-tight">
              <p className="font-semibold">Nikah Connect</p>
              <p className="text-xs text-slate-400">www.nikahconnect.pro</p>
            </div>
          )}
        </div>
        <nav className="mt-6 flex-1">
          <a className="flex items-center gap-3 rounded-lg bg-indigo-500/15 px-3 py-2 text-sm text-indigo-200" href="#">
            <Users size={18} className="shrink-0" />{open && 'AI Matchmaker'}
          </a>
        </nav>
        <button onClick={() => setOpen(!open)} aria-label="Toggle sidebar" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-white/5">
          {open ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}{open && 'Collapse'}
        </button>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-10 md:px-10">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Find the right rishta in seconds</h1>
          <p className="mt-2 text-slate-400">Paste a candidate’s bio-data or enter a profile ID like NC-102. Matches follow gender, age and city rules automatically.</p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-slate-900/80 p-3 shadow-2xl shadow-indigo-950/40 ring-1 ring-indigo-400/10 focus-within:ring-indigo-400/40">
            <textarea
              ref={ta}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Paste bio-data here, or type a profile ID…"
              className="w-full resize-none bg-transparent p-2 text-sm text-slate-100 outline-none placeholder:text-slate-500"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button onClick={paste} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5">
                <ClipboardPaste size={16} /> Paste
              </button>
              <div className="relative">
                {!loading && <span className="absolute inset-0 -z-0 rounded-xl bg-indigo-500/50 blur-lg animate-pulse motion-reduce:animate-none" />}
                <button
                  onClick={run}
                  disabled={loading || !prompt.trim()}
                  className="relative flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-emerald-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
                >
                  {loading ? <><Loader2 size={16} className="animate-spin" /> Matching…</> : '⚡ Run AI Matchmaker Engine'}
                </button>
              </div>
            </div>
          </div>

          {error && (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />{error}
            </p>
          )}
        </div>

        {data && (
          <section className="mx-auto mt-10 max-w-6xl">
            <p className="text-sm text-slate-400">
              Candidate: {data.candidate.gender}, {data.candidate.age}, {data.candidate.city}. Checked {data.stats.scanned} opposite-gender profiles; {data.stats.disqualified} removed by the age rule.
            </p>
            {data.results.length === 0 ? (
              <p className="mt-6 text-slate-300">No suitable matches found. Try a bio-data with more detail, or check back after new profiles are added.</p>
            ) : (
              <div className="mt-4 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {data.results.map((r) => <Card key={r.id} r={r} />)}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
