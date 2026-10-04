import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TABLE = process.env.SUPABASE_TABLE || 'profiles db';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_RESULTS = 12;

/* ---------- Geography: nearby-city graph ---------- */
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
  const c = String(s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
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

function ageBlocked(c, p) {
  const cg = genderOf(c.Gender || c.gender);
  const male = cg === 'male' ? num(c.Age || c.age) : num(p.Age || p.age);
  const female = cg === 'male' ? num(p.Age || p.age) : num(c.Age || c.age);
  return male != null && female != null && female > male;
}

function prescore(c, p, tier) {
  let s = tier === 'exact' ? 88 : tier === 'nearby' ? 70 : 45;
  s += sectScore(c.Maslak || c.maslak, p.Maslak || p.maslak);
  const a = inRange(p.Req_Age || p.req_age_range, num(c.Age || c.age)), b = inRange(c.Req_Age || c.req_age_range, num(p.Age || p.age));
  if (a === false) s -= 8;
  if (b === false) s -= 8;
  if (a && b) s += 4;
  if (!isNA(c.Caste || c.caste) && String(c.Caste || c.caste).toLowerCase() === String(p.Caste || p.caste || '').toLowerCase()) s += 3;
  if (num(p.Age || p.age) == null || num(c.Age || c.age) == null) s = Math.min(s, 75);
  return bound(s, tier);
}
const bound = (s, tier) =>
  tier === 'exact' ? clamp(s, 0, 100) : tier === 'nearby' ? clamp(s, 60, 80) : clamp(s, 0, 55);

function tierNote(tier, c, p) {
  const cCity = c.City || c.city || '';
  const pCity = p.City || p.city || '';
  if (tier === 'exact') return `Exact city match (${pCity})`;
  if (tier === 'nearby') return `Nearby city match (${cCity} ↔ ${pCity})`;
  return `Different city (${cCity} vs ${pCity})`;
}

/* ---------- WhatsApp template formatting ---------- */
function formatProfile(p) {
  const income = String(p.Salary || p.salary || '').match(/\(([^)]*\d[^)]*)\)|\d+\s?(?:k|lac|lakh)\+?/i);
  const size = String(p.House_Details || p.house_details || '').match(/\d+(?:\s*(?:to|-)\s*\d+)?\s*(?:marla|kanal)s?/i);
  const pId = p.Profile_ID || p.profile_id || 'NC-XXX';
  const pGender = p.Gender || p.gender || 'N/A';
  const pAge = p.Age || p.age || 'N/A';
  const pCity = p.City || p.city || 'N/A';
  const pMarital = p.Marital_Status || p.marital_status || 'N/A';
  const pCaste = p.Caste || p.caste || 'N/A';
  
  return [
    `${pGender}/${pAge}/${pCity}/${pMarital}/${pCaste} [${pId}]`,
    '',
    'https://www.nikahconnect.pro',
    '',
    '🔵 *Candidate Info* ',
    '',
    `👉>-Gender: ${pGender}`,
    `👉>-Marital status: ${pMarital}`,
    '👉>-Date of birth: N/A',
    `👉>-Height: N/A`,
    `👉>-weight: N/A`,
    '👉>-Complexion: N/A',
    `👉>-Education: ${val(p.Education || p.education)}`,
    '👉>-College/University: N/A',
    '👉>-Religious education(optional): N/A',
    `👉>-Monthly Income: ${income ? (income[1] || income[0]).trim() : val(p.Salary || p.salary)}`,
    `👉>-Source of income: ${val(p.Profession || p.profession)}`,
    `👉>-Sect (Maslak) : ${val(p.Maslak || p.maslak)}`,
    `👉>-Caste : ${pCaste}`,
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
    `👉>-House owned or Rental: ${val(p.House_Details || p.house_details)}`,
    `👉>-Home size: ${size ? size[0] : 'N/A'}`,
    '👉>-Other properties (optional): N/A',
    `👉>-Current City: ${pCity}`,
    '👉>-Name of Area/Twon(Optional): N/A',
    '👉>-Nationality : Pakistani',
    '',
    '🔵 *Requirement* ',
    '',
    `👉>-Marital status: ${val(p.Req_Marital_Status || p.req_marital_status)}`,
    '👉>-Financial Status: N/A',
    `👉>-Age: ${val(p.Req_Age || p.req_age)}`,
    `👉>-Height: ${val(p.Req_Height || p.req_height)}`,
    `👉>-Education : ${val(p.Req_Education || p.req_education)}`,
    `👉>-Sect : ${val(p.Req_Maslak || p.req_maslak)}`,
    `👉>-Cast: ${val(p.Req_Caste || p.req_caste)}`,
    `👉>-House: ${val(p.Req_House_Details || p.req_house_details)}`,
    `👉>-City: ${val(p.Req_City || p.req_city)}`,
    '👉>-Country: Pakistan',
    `👉>-Other requirements(optional): ${val(p.Other_Requirements || p.other_requirements)}`,
    '',
    '🔵*Contact details*',
    '',
    `Family Contact number(compulsory): ${val(p.Contact_Number || p.contact_number)}`,
    '👉>-Relation with candidate: N/A',
    '👉>-Self contact only for male(optional): N/A',
    '',
    '👉>- Anything else you want to tell about canidate (optional): N/A',
    '',
    '*#Nikah_Connect (Pakistan largest family based Rishta platform) Contact#03000825815*',
  ].join('\n');
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
    
    // بغير کسی لمیٹ کے ڈیٹا بیس سے تمام پروفائلز (1900+) حاصل کرنے کا طریقہ
    let rows = [];
    let rangeStart = 0;
    const batchSize = 1000;
    while (true) {
      const { data: batch, error } = await sb.from(TABLE).select('*').range(rangeStart, rangeStart + batchSize - 1);
      if (error) return fail(`Database error: ${error.message}`);
      if (!batch || batch.length === 0) break;
      rows = rows.concat(batch);
      if (batch.length < batchSize) break;
      rangeStart += batchSize;
    }

    const model = new GoogleGenerativeAI(gk).getGenerativeModel({
      model: MODEL,
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    });
    const askJson = async (text) => JSON.parse((await model.generateContent(text)).response.text());

    // 1) Resolve candidate profile
    let c;
    const idMatch = prompt.match(/NC-\d+/i);
    if (idMatch) {
      c = rows.find((r) => String(r.Profile_ID || r.profile_id).toUpperCase() === idMatch[0].toUpperCase());
    }
    if (!c) {
      const today = new Date().toISOString().slice(0, 10);
      c = await askJson(
        `Extract candidate info from this Nikah Connect bio-data. Return JSON with keys:
gender ("Male" or "Female"),
age (number; calculate age as of ${today} if DOB is given),
city, marital_status, caste, sect_maslak, height, weight, education,
profession_salary, house_details,
req_marital_status, req_age_range, req_city, req_caste, req_maslak, req_education,
other_requirements.
Use null for blank fields. Return only JSON.

${prompt}`
      );
    }
    
    const candidateGender = genderOf(c.Gender || c.gender);
    const candidateAge = num(c.Age || c.age);
    const candidateCity = c.City || c.city;

    if (!candidateGender || candidateAge == null || isNA(candidateCity))
      return fail('Gender, age and city are required. Add them to the text or use an existing profile ID.', 422);

    // 2) Filter opposite gender & age rules across ALL profiles
    const want = candidateGender === 'male' ? 'female' : 'male';
    const sameGender = rows.filter((p) => {
      const pId = p.Profile_ID || p.profile_id;
      const cId = c.Profile_ID || c.profile_id;
      return pId !== cId && genderOf(p.Gender || p.gender) === want;
    });
    const eligible = sameGender.filter((p) => !ageBlocked(c, p));

    // 3) Pre-score ALL eligible profiles and sort them to find the best pool for AI
    const scoredAll = eligible
      .map((p) => {
        const pCity = p.City || p.city || '';
        const tier = geoTier(candidateCity, pCity);
        return { p, tier, pre: prescore(c, p, tier) };
      })
      .sort((a, b) => b.pre - a.pre);

    // AI کے پاس مزید بہتر پروفائلز بھیجنے کے لیے ٹاپ 40 شارٹ لسٹ کیے گئے ہیں
    const shortlistForAI = scoredAll.slice(0, 40);

    // 4) AI Refinement
    let ai = {};
    try {
      const brief = (x) => ({
        gender: x.Gender || x.gender, age: x.Age || x.age, city: x.City || x.city, 
        marital_status: x.Marital_Status || x.marital_status, caste: x.Caste || x.caste, sect: x.Maslak || x.maslak,
        education: x.Education || x.education, income: x.Salary || x.salary, house: x.House_Details || x.house_details,
        wants: { marital: x.Req_Marital_Status || x.req_marital_status, age: x.Req_Age || x.req_age, city: x.Req_City || x.req_city, caste: x.Req_Caste || x.req_caste, sect: x.Req_Maslak || x.req_maslak, education: x.Req_Education || x.req_education, other: x.Other_Requirements || x.other_requirements },
      });
      const out = await askJson(
        `You are a Pakistani matchmaking expert. Compare the CANDIDATE with each PROFILE on sect, caste, education, income, marital status and requirements. Give score 0-100 and 3-4 short concrete reasons.
Return JSON array: [{"id":"NC-001","score":85,"reasons":["..."]}]

CANDIDATE: ${JSON.stringify(brief(c))}
PROFILES: ${JSON.stringify(shortlistForAI.map(({ p, tier, pre }) => ({ id: p.Profile_ID || p.profile_id, city_tier: tier, baseline: pre, ...brief(p) })))}`
      );
      for (const r of Array.isArray(out) ? out : []) ai[r.id] = r;
    } catch (e) {
      console.error('Gemini reasoning failed, using baseline scores:', e.message);
    }

    // 5) Deduplicate and format final results from the entire evaluated pool
    const seenIds = new Set();
    const results = scoredAll
      .map(({ p, tier, pre }) => {
        const pId = p.Profile_ID || p.profile_id;
        const a = ai[pId];
        const reasons = a?.reasons?.length ? a.reasons : [tierNote(tier, c, p)];
        if (tier === 'nearby' && !reasons.some((r) => /nearby city/i.test(r))) reasons.unshift(tierNote(tier, c, p));
        return {
          id: pId,
          score: bound(typeof a?.score === 'number' ? a.score : pre, tier),
          tier,
          reasons,
          text: formatProfile(p),
        };
      })
      .filter((r) => {
        if (r.score < 30) return false;
        if (seenIds.has(r.id)) return false; // ڈپلیکیٹ پروفائلز کو فلٹر کرنا
        seenIds.add(r.id);
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);

    return NextResponse.json({
      candidate: { id: c.Profile_ID || c.profile_id || null, gender: candidateGender, age: candidateAge, city: candidateCity, marital_status: c.Marital_Status || c.marital_status, caste: c.Caste || c.caste },
      stats: { scanned: sameGender.length, disqualified: sameGender.length - eligible.length },
      results,
    });
  } catch (e) {
    console.error(e);
    return fail(e.message || 'Unexpected server error.');
  }
}
