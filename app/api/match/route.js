import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TABLE = process.env.SUPABASE_TABLE || 'profiles db';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const SHORTLIST = 20;
const MAX_RESULTS = 12;

/* ---------- Geography: nearby-city graph (edit freely) ---------- */
const NEAR = {
  lahore: ['sheikhupura', 'gujranwala', 'kasur', 'muridke', 'okara', 'nankana sahib', 'kamoke', 'farooqabad'],
  sheikhupura: ['farooqabad', 'muridke', 'nankana sahib', 'hafizabad', 'jaranwala', 'gujranwala'],
  gujranwala: ['sialkot', 'gujrat', 'wazirabad', 'hafizabad', 'kamoke', 'muridke', 'kharian', 'mandi bahauddin'],
  sialkot: ['gujrat', 'daska', 'wazirabad', 'narowal'],
  gujrat: ['kharian', 'jhelum', 'lalamusa', 'mandi bahauddin', 'wazirabad'],
  kharian: ['jhelum', 'lalamusa'],
  jhelum: ['rawalpindi', 'dina', 'mangla'],
  rawalpindi: ['islamabad', 'taxila', 'wah cantt', 'attock', 'murree'],
  islamabad: ['taxila', 'wah cantt', 'murree'],
  faisalabad: ['jaranwala', 'chiniot', 'sargodha', 'toba tek singh', 'jhang', 'samundri'],
  jaranwala: ['nankana sahib', 'toba tek singh'],
  sargodha: ['bhalwal', 'chiniot', 'khushab'],
  sahiwal: ['okara', 'pakpattan', 'chichawatni'],
  okara: ['pakpattan', 'depalpur', 'kasur'],
  multan: ['khanewal', 'lodhran', 'vehari', 'muzaffargarh', 'shujabad', 'bahawalpur'],
  vehari: ['mailsi', 'burewala', 'lodhran'],
  mailsi: ['burewala', 'lodhran'],
  bahawalpur: ['bahawalnagar', 'rahim yar khan', 'lodhran'],
  'rahim yar khan': ['khanpur', 'sadiqabad', 'liaquatpur'],
  khanpur: ['sadiqabad', 'liaquatpur'],
  'dg khan': ['layyah', 'muzaffargarh', 'rajanpur', 'taunsa'],
  karachi: ['hyderabad', 'thatta', 'kotri'],
  hyderabad: ['kotri', 'jamshoro', 'tando allahyar'],
  peshawar: ['mardan', 'nowshera', 'charsadda', 'swabi'],
  quetta: ['pishin'],
};
const ADJ = {};
for (const [a, list] of Object.entries(NEAR))
  for (const b of list) ((ADJ[a] ||= new Set()).add(b), (ADJ[b] ||= new Set()).add(a));
const ALIAS = { pindi: 'rawalpindi', isb: 'islamabad', 'd g khan': 'dg khan', 'dera ghazi khan': 'dg khan' };

const canon = (s) => {
  const c = s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return ALIAS[c] || c;
};
const cityList = (s) => String(s || '').split(/[\/,&]|\bor\b/i).map(canon).filter(Boolean);
function geoTier(a, b) {
  const A = cityList(a), B = cityList(b);
  if (A.some((x) => B.includes(x))) return 'exact';
  if (A.some((x) => B.some((y) => ADJ[x]?.has(y)))) return 'nearby';
  return 'far';
}

/* ---------- Helpers ---------- */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const genderOf = (g) => (/^f/i.test(g || '') ? 'female' : /^m/i.test(g || '') ? 'male' : null);
const isNA = (v) => v == null || !String(v).trim() || /^(n\/?a|none|null|-)$/i.test(String(v).trim());
const val = (v) => (isNA(v) ? 'N/A' : String(v).trim());

function inRange(r, age) {
  if (isNA(r) || age == null) return null;
  const n = (String(r).match(/\d+/g) || []).map(Number);
  if (!n.length) return null;
  if (n.length >= 2) return age >= n[0] && age <= n[1];
  if (/max|below|under|upto|up to/i.test(r)) return age <= n[0];
  return Math.abs(age - n[0]) <= 2;
}
function sectOf(s) {
  s = String(s || '').toLowerCase();
  if (/shia|shi'a|jaafri|ithna/.test(s)) return 'shia';
  if (/hadee?s|salafi/.test(s)) return 'hadees';
  if (/deoband/.test(s)) return 'deobandi';
  if (/barel|brelvi|ahle sunnat|ahl-e-sunnat/.test(s)) return 'barelvi';
  if (/sunni/.test(s)) return 'sunni';
  return null;
}
function sectScore(a, b) {
  const x = sectOf(a), y = sectOf(b);
  if (!x || !y) return 0;
  if (x === y) return 6;
  if (x === 'shia' || y === 'shia') return -25;
  if ([x, y].includes('hadees') && !['sunni'].includes(x === 'hadees' ? y : x)) return -8;
  return 2;
}

// Hard rules live in code, not in the prompt, so the AI can never override them.
function ageBlocked(c, p) {
  const cg = genderOf(c.gender);
  const male = cg === 'male' ? num(c.age) : num(p.age);
  const female = cg === 'male' ? num(p.age) : num(c.age);
  return male != null && female != null && female > male;
}

function prescore(c, p, tier) {
  let s = tier === 'exact' ? 88 : tier === 'nearby' ? 70 : 45;
  s += sectScore(c.sect_maslak, p.sect_maslak);
  const a = inRange(p.req_age_range, num(c.age)), b = inRange(c.req_age_range, num(p.age));
  if (a === false) s -= 8;
  if (b === false) s -= 8;
  if (a && b) s += 4;
  if (!isNA(c.caste) && String(c.caste).toLowerCase() === String(p.caste || '').toLowerCase()) s += 3;
  if (num(p.age) == null || num(c.age) == null) s = Math.min(s, 75);
  return bound(s, tier);
}
const bound = (s, tier) =>
  tier === 'exact' ? clamp(s, 0, 100) : tier === 'nearby' ? clamp(s, 60, 80) : clamp(s, 0, 55);

function tierNote(tier, c, p) {
  if (tier === 'exact') return `Exact city match (${p.city})`;
  if (tier === 'nearby') return `Nearby city match (${c.city} ↔ ${p.city})`;
  return `Different city (${c.city} vs ${p.city})`;
}

/* ---------- WhatsApp template (exact wording, do not "fix" spellings) ---------- */
function formatProfile(p) {
  const income = String(p.profession_salary || '').match(/\(([^)]*\d[^)]*)\)|\d+\s?(?:k|lac|lakh)\+?/i);
  const size = String(p.house_details || '').match(/\d+(?:\s*(?:to|-)\s*\d+)?\s*(?:marla|kanal)s?/i);
  return [
    `${val(p.gender)}/${val(p.age)}/${val(p.city)}/${val(p.marital_status)}/${val(p.caste)}`,
    '',
    'https://www.nikahconnect.pro',
    '',
    '🔵 *Candidate Info* ',
    '',
    `👉>-Gender: ${val(p.gender)}`,
    `👉>-Marital status: ${val(p.marital_status)}`,
    '👉>-Date of birth: N/A',
    `👉>-Height: ${val(p.height)}`,
    `👉>-weight: ${val(p.weight)}`,
    '👉>-Complexion: N/A',
    `👉>-Education: ${val(p.education)}`,
    '👉>-College/University: N/A',
    '👉>-Religious education(optional): N/A',
    `👉>-Monthly Income: ${income ? (income[1] || income[0]).trim() : 'N/A'}`,
    `👉>-Source of income: ${val(p.profession_salary)}`,
    `👉>-Sect (Maslak) : ${val(p.sect_maslak)}`,
    `👉>-Caste : ${val(p.caste)}`,
    '👉>-Beard/Hijab: N/A',
    '👉>-Language: N/A',
    '👉>-Disability : N/A',
    '',
    '🔵 *Family Status* ',
    '',
    '👉>-Father’s Profession: N/A',
    '👉>-Mother profession: N/A',
    '',
    '🔵>- *Siblings Details:*  ',
    '',
    'Sisters: N/A',
    "Brother's: N/A",
    'Married siblings: N/A',
    '',
    '🔵 *Residence* ',
    '',
    `👉>-House owned or Rental: ${val(p.house_details)}`,
    `👉>-Home size: ${size ? size[0] : 'N/A'}`,
    '👉>-Other properties (optional): N/A',
    `👉>-Current City: ${val(p.city)}`,
    '👉>-Name of Area/Twon(Optional): N/A',
    '👉>-Nationality : N/A',
    '',
    '🔵 *Requirement* ',
    '',
    `👉>-Marital status: ${val(p.req_marital_status)}`,
    '👉>-Financial Status: N/A',
    `👉>-Age: ${val(p.req_age_range)}`,
    '👉>-Height: N/A',
    `👉>-Education : ${val(p.req_education)}`,
    `👉>-Sect : ${val(p.req_maslak)}`,
    `👉>-Cast: ${val(p.req_caste)}`,
    '👉>-House: N/A',
    `👉>-City: ${val(p.req_city)}`,
    '👉>-Country: N/A',
    `👉>-Other requirements(optional): ${val(p.other_requirements)}`,
    '',
    '🔵*Contact details*',
    '',
    `Family Contact number(compulsory): ${val(p.contact_number)}`,
    '👉>-Relation with candidate: N/A',
    '👉>-Self contact only for male(optional): N/A',
    '',
    '👉>- Anything else you want to tell about canidate (optional): N/A',
    '',
    '*#Nikah_Connect (Pakistan largest family based Rishta platform) Contact#03000825815*',
  ].join('\n');
}

/* ---------- Reads the standard Nikah Connect template without AI ---------- */
function parseBioData(text) {
  const t = String(text || '');
  const get = (src, label) => {
    const m = src.match(new RegExp(label + '[ \\t]*:[ \\t]*([^\\n\\r]*)', 'i'));
    const v = m ? m[1].replace(/[*_]/g, '').trim() : '';
    return isNA(v) ? null : v;
  };
  const ri = t.search(/Requirement[ \t]*\*?[ \t]*\r?\n/i);
  const cand = ri >= 0 ? t.slice(0, ri) : t;
  const req = ri >= 0 ? t.slice(ri) : '';
  const first = t.trim().split('\n')[0].split('/').map((x) => x.trim());

  let gender = get(cand, 'Gender');
  let age = null, city = get(cand, 'Current City');
  if (first.length >= 3 && /^\d{1,2}$/.test(first[1])) {
    gender = gender || first[0]; age = Number(first[1]); city = city || first[2];
  }
  const dob = get(cand, 'Date of birth');
  if (age == null && dob) {
    const m = dob.match(/(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{4})/) || dob.match(/()()((?:19|20)\d{2})/);
    if (m) {
      const now = new Date();
      age = now.getFullYear() - Number(m[3]);
      if (m[1] && (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[1])))) age -= 1;
    }
  }
  const src = get(cand, 'Source of income'), inc = get(cand, 'Monthly Income');
  const house = [get(cand, 'House owned or Rental'), get(cand, 'Home size')].filter(Boolean).join(' ');
  const other = [get(req, 'Other requirements\\(optional\\)'), get(req, 'Financial Status'), get(req, 'House')].filter(Boolean).join(' / ');
  return {
    gender, age, city,
    marital_status: get(cand, 'Marital status'), height: get(cand, 'Height'), weight: get(cand, 'weight'),
    education: get(cand, 'Education'), caste: get(cand, 'Caste'), sect_maslak: get(cand, 'Sect \\(Maslak\\)'),
    profession_salary: [src, inc].filter(Boolean).join(' - ') || null,
    house_details: house || null,
    req_marital_status: get(req, 'Marital status'), req_age_range: get(req, 'Age'), req_education: get(req, 'Education'),
    req_maslak: get(req, 'Sect'), req_caste: get(req, 'Cast'), req_city: get(req, 'City'),
    other_requirements: other || null,
  };
}

/* ---------- Handler ---------- */
const fail = (error, status = 500) => NextResponse.json({ error }, { status });

export async function POST(req) {
  try {
    const { prompt } = await req.json();
    if (!prompt || !prompt.trim()) return fail('Paste a candidate bio-data or type a profile ID such as NC-102.', 400);

    const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key, GEMINI_API_KEY: gk } = process.env;
    if (!url || !key || !gk) return fail('Server is missing Supabase or Gemini environment variables.');

    const sb = createClient(url, key);
    const { data: rows, error } = await sb.from(TABLE).select('*').limit(5000);
    if (error) return fail(`Database error: ${error.message}`);

    const genAI = new GoogleGenerativeAI(gk);
    const models = [MODEL, process.env.GEMINI_FALLBACK_MODEL].filter(Boolean).map((name) =>
      genAI.getGenerativeModel({ model: name, generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
    );
    // Retries when Gemini is busy (503/429) and tries the fallback model if one is set.
    const askJson = async (text) => {
      for (let i = 0; i < 3; i++) {
        for (const m of models) {
          try {
            return JSON.parse((await m.generateContent(text)).response.text());
          } catch (e) {
            if (!/503|429|overloaded|high demand/i.test(e.message)) throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      }
      throw new Error('Gemini is busy right now. Please try again in a minute.');
    };

    // 1) Resolve the candidate: existing profile ID, or extract from pasted text.
    let c;
    const idMatch = prompt.trim().length < 30 && prompt.match(/NC-\d+/i);
    if (idMatch) c = rows.find((r) => String(r.profile_id).toUpperCase() === idMatch[0].toUpperCase());
    if (!c) {
      const parsed = parseBioData(prompt); // no AI needed for the standard template
      if (genderOf(parsed.gender) && num(parsed.age) != null && !isNA(parsed.city)) c = parsed;
    }
    if (!c) {
      const today = new Date().toISOString().slice(0, 10);
      c = await askJson(
        `Extract the candidate from this Nikah Connect bio-data (Urdu/English mixed; some fields may be blank). Return JSON with keys:
gender ("Male" or "Female"),
age (number; if only Date of birth is given, calculate age as of ${today}),
city (Current City), marital_status, caste, sect_maslak, height, weight, education,
profession_salary (Source of income and Monthly Income), house_details,
req_marital_status, req_age_range, req_city, req_caste, req_maslak, req_education,
other_requirements (include Financial Status, House and other requirements).
Use null for blank fields. Return only JSON.

${prompt}`
      );
    }
    if (!genderOf(c.gender) || num(c.age) == null || isNA(c.city))
      return fail('Gender, age and city are required. Add them to the text or use an existing profile ID.', 422);

    // 2) Hard rules in code: opposite gender + male age >= female age.
    const want = genderOf(c.gender) === 'male' ? 'female' : 'male';
    const sameGender = rows.filter((p) => p.profile_id !== c.profile_id && genderOf(p.gender) === want);
    const eligible = sameGender.filter((p) => !ageBlocked(c, p));

    // 3) Deterministic pre-score + shortlist.
    const scored = eligible
      .map((p) => {
        const tier = geoTier(c.city, p.city);
        return { p, tier, pre: prescore(c, p, tier) };
      })
      .sort((a, b) => b.pre - a.pre)
      .slice(0, SHORTLIST);

    // 4) Gemini writes reasoning and refines scores; server re-applies tier bounds.
    let ai = {};
    try {
      const brief = (x) => ({
        gender: x.gender, age: x.age, city: x.city, marital_status: x.marital_status, caste: x.caste, sect: x.sect_maslak,
        height: x.height, education: x.education, income: x.profession_salary, house: x.house_details,
        wants: { marital: x.req_marital_status, age: x.req_age_range, city: x.req_city, caste: x.req_caste, sect: x.req_maslak, education: x.req_education, other: x.other_requirements },
      });
      const out = await askJson(
        `You are a Pakistani matchmaking expert. Compare the CANDIDATE with each PROFILE on sect/maslak, caste, height, education, income, marital status and both sides' stated requirements (including age ranges and city).
Rules: city tier is fixed ("exact", "nearby" -> score 60-80 and mention "Nearby city match", "far" -> max 55). Age and gender are already validated. Give a score 0-100 and 3-4 short, concrete reasons (mention mismatches honestly).
Return JSON array: [{"id":"NC-001","score":85,"reasons":["..."]}]

CANDIDATE: ${JSON.stringify(brief(c))}
PROFILES: ${JSON.stringify(scored.map(({ p, tier, pre }) => ({ id: p.profile_id, city_tier: tier, baseline: pre, ...brief(p) })))}`
      );
      for (const r of Array.isArray(out) ? out : []) ai[r.id] = r;
    } catch (e) {
      console.error('Gemini failed, using rule-based scores:', e.message);
    }

    const results = scored
      .map(({ p, tier, pre }) => {
        const a = ai[p.profile_id];
        const reasons = a?.reasons?.length ? a.reasons : [tierNote(tier, c, p)];
        if (tier === 'nearby' && !reasons.some((r) => /nearby city/i.test(r))) reasons.unshift(tierNote(tier, c, p));
        return {
          id: p.profile_id,
          score: bound(typeof a?.score === 'number' ? a.score : pre, tier),
          tier,
          reasons,
          text: formatProfile(p),
        };
      })
      .filter((r) => r.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);

    return NextResponse.json({
      candidate: { id: c.profile_id || null, gender: c.gender, age: num(c.age), city: c.city, marital_status: c.marital_status, caste: c.caste },
      stats: { scanned: sameGender.length, disqualified: sameGender.length - eligible.length },
      results,
    });
  } catch (e) {
    console.error(e);
    return fail(e.message || 'Unexpected server error.');
  }
}
