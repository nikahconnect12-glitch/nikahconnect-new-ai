import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TABLE = process.env.SUPABASE_TABLE || 'profiles db';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash'; // used ONLY to read pasted text that does not follow the template
const MAIN_MAX = 12;      // best matches shown
const SUGG_MAX = 6;       // lower-match options shown below, only when best matches are few
const MIN_MAIN = 5;       // fewer best matches than this -> lower-match options are added
const MAX_AGE_GAP = 3;    // a female is NEVER more than 3 years older than the male

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
const genderOf = (g) => (/^\s*f/i.test(g || '') ? 'female' : /^\s*m/i.test(g || '') ? 'male' : null);
const isNA = (v) => v == null || !String(v).trim() || /^(n\/?a|none|null|nil|-)$/i.test(String(v).trim());
const val = (v) => (isNA(v) ? 'N/A' : String(v).trim());
const nk = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// Maps whatever the database columns are called onto the names this app uses.
const CANON = {
  profile_id: /^(profileid|id)$/, gender: /^gender/, age: /^age$/, city: /^(city|currentcity)$/,
  marital_status: /^marital/, height: /^height/, weight: /^weight/, education: /^education/,
  caste: /^cast/, sect_maslak: /^(sect|maslak)/,
  profession_salary: /^(professionsalary|profession|occupation|sourceofincome)/,
  house_details: /^(housedetails|houseownedorrental|house)$/,
  contact_number: /^(contactnumber|familycontact|phone|whatsapp)/,
  req_marital_status: /^req.*marital/, req_age_range: /^req.*age/, req_height: /^req.*height/,
  req_education: /^req.*education/, req_maslak: /^req.*(sect|maslak)/, req_caste: /^req.*cast/,
  req_city: /^req.*city/, other_requirements: /^(otherrequirements|reqother)/,
};
function normRow(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) o[k.toLowerCase()] = v;
  const keys = Object.keys(r);
  for (const [canon, re] of Object.entries(CANON)) {
    if (!isNA(o[canon])) continue;
    const k = keys.find((x) => re.test(nk(x)) && !isNA(r[x]));
    if (k) o[canon] = r[k];
  }
  if (typeof o.age === 'string') o.age = o.age.replace(/\.0+$/, '');
  return o;
}
const pick = (p, re) => {
  for (const k of Object.keys(p)) if (re.test(nk(k)) && !isNA(p[k])) return String(p[k]).trim();
  return null;
};
const idNum = (v) => Number(String(v || '').replace(/\D/g, ''));

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
  if (/sunn?i/.test(s)) return 'sunni';
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
function eduLevel(s) {
  s = String(s || '').toLowerCase();
  if (isNA(s)) return null;
  if (/ph\.?d|doctorate/.test(s)) return 6;
  if (/m\.?\s?phil/.test(s)) return 5;
  if (/mbbs|bds|pharm|\bdpt\b|doctor|\bllb\b/.test(s)) return 4;
  if (/master|\bm\.?a\b|\bm\.?sc|\bmba\b|\bmcs\b|\bm\.?\s?com|\bms\b|\bm\.?s\b|16 year|\bmit\b/.test(s)) return 4;
  if (/bachelor|\bbs|\bbcs|\bbba\b|\bb\.?sc|\bb\.?com|\bba\b|\bb\.?a\b|\bbe\b|\bb\.?e\b|\bb\.?tech|graduat|14 year|honou?rs|engineer|\bacca\b|\bca\b/.test(s)) return 3;
  if (/inter|\bf\.?sc|\bf\.?a\b|hssc|a[- ]?level|\bdae\b|12/.test(s)) return 2;
  if (/matric|ssc|o[- ]?level|middle|primary|\b10\b/.test(s)) return 1;
  return null;
}
const inches = (s) => {
  const m = String(s || '').match(/(\d)\s*(?:'|’|ft|feet|\.)\s*(\d{1,2})?/i);
  return m ? Number(m[1]) * 12 + Number(m[2] || 0) : null;
};
const anyWord = /\b(any|all|no bar|koi bhi|open)\b/i;
const normCaste = (v) => String(v || '').toLowerCase()
  .replace(/raj+poo?t/g, 'rajput').replace(/\bj[ua]t+\b/g, 'jutt').replace(/sh[ae]i?kh/g, 'sheikh')
  .replace(/ara[ye]en|arayen/g, 'arain').replace(/guj+ar/g, 'gujjar').replace(/mug+h?al|mogul/g, 'mughal')
  .replace(/\bs[ae]y+ed\b|\bsyed\b|\bsaiyed\b/g, 'syed').replace(/qur[ae]i?shi/g, 'qureshi').replace(/\s+/g, ' ').trim();
const casteOK = (req, caste) => {
  if (isNA(req) || isNA(caste)) return null;
  const a0 = normCaste(req), b0 = normCaste(caste);
  if (/apart from|except|excluding|other than|siwaye/.test(a0)) return a0.split(/apart from|except|excluding|other than|siwaye/)[1].includes(b0) ? false : null;
  if (anyWord.test(req)) return null;
  return a0.includes(b0) || b0.includes(a0);
};
const singleOnly = (req) => /single|unmarried|never|kuwar|kunwar/i.test(req || '') && !/divorc|widow|any|all|khula|2nd|second/i.test(req || '');
const priorMarriage = (m) => /divorc|widow|khula|2nd|second|separat|married|shadi/i.test(m || '') && !/^(single|unmarried|never)/i.test(String(m).trim());
const AGE_OK = /(any age|age (is )?(no bar|not (a )?(matter|issue|problem)|doesn'?t matter|no issue)|no age (bar|limit|issue)|(younger|older|elder|small|smaller|big|bigger) (is |also |bhi )?(ok|fine|acceptable|allowed|theek|chal\w*)|(chota|choti|bara|bari|chhota|chhoti) (bhi )?(chal|theek|ok|manzoor))/i;

/* Age rule: male >= female. Only an explicit requirement can allow an older female, and never by more than MAX_AGE_GAP years. */
function ageCheck(c, p) {
  const cm = genderOf(c.gender) === 'male';
  const male = num(cm ? c.age : p.age), female = num(cm ? p.age : c.age);
  if (male == null || female == null) return { status: 'unknown' };
  if (female <= male) return { status: 'ok', male, female, gap: male - female };
  const gap = female - male;
  const text = `${c.req_age_range || ''} ${c.other_requirements || ''} ${p.req_age_range || ''} ${p.other_requirements || ''}`;
  if (AGE_OK.test(text) && gap <= MAX_AGE_GAP) return { status: 'exception', male, female, gap };
  return { status: 'blocked' };
}

const bound = (s, tier) => (tier === 'exact' ? clamp(s, 0, 100) : tier === 'nearby' ? clamp(s, 0, 80) : clamp(s, 0, 55));
function tierNote(tier, c, p) {
  if (tier === 'exact') return `✓ Exact city match (${p.city})`;
  if (tier === 'nearby') return `✓ Nearby city match (${c.city} ↔ ${p.city})`;
  return `✗ Different city (${c.city} vs ${p.city})`;
}

/* Everything below is computed from the stored data only. No AI text is shown to the user. */
function evaluate(c, p) {
  const ac = ageCheck(c, p);
  if (ac.status === 'blocked') return null;
  const tier = geoTier(c.city, p.city);
  let s = tier === 'exact' ? 80 : tier === 'nearby' ? 66 : 40;
  let option = tier === 'far';
  const reasons = [tierNote(tier, c, p)];

  if (ac.status === 'unknown') {
    option = true; s = Math.min(s, 70);
    reasons.push('! Age is missing for one side, so the age rule could not be verified');
  } else if (ac.status === 'exception') {
    option = true; s -= 8;
    reasons.push(`! Exception: female is ${ac.gap} year(s) older, allowed by a stated requirement`);
  } else {
    reasons.push(`✓ Age rule met (male ${ac.male}, female ${ac.female})`);
    if (ac.gap > 10) { s -= 8; reasons.push(`! Large age gap (${ac.gap} years)`); }
  }
  const fitP = inRange(c.req_age_range, num(p.age)); // does this profile fit the candidate's wanted age?
  const fitC = inRange(p.req_age_range, num(c.age)); // does the candidate fit this profile's wanted age?
  if (fitP === true) { s += 5; reasons.push(`✓ Age ${p.age} is within the candidate's required range (${c.req_age_range})`); }
  if (fitP === false) { s -= 12; option = true; reasons.push(`✗ Age ${p.age} is outside the candidate's required range (${c.req_age_range})`); }
  if (fitC === true) { s += 5; reasons.push(`✓ Candidate's age fits this profile's requirement (${p.req_age_range})`); }
  if (fitC === false) { s -= 12; option = true; reasons.push(`✗ Candidate's age is outside this profile's requirement (${p.req_age_range})`); }

  const hit = (req, city) => !isNA(req) && !isNA(city) && cityList(req).some((x) => cityList(city).some((y) => x === y || x.includes(y) || y.includes(x)));
  if (hit(c.req_city, p.city)) { s += 3; reasons.push(`✓ ${p.city} is in the candidate's wanted cities (${c.req_city})`); }
  if (hit(p.req_city, c.city)) { s += 3; reasons.push(`✓ ${c.city} is in this profile's wanted cities (${p.req_city})`); }

  const sc = sectScore(c.sect_maslak, p.sect_maslak);
  s += sc;
  if (sc >= 6) reasons.push(`✓ Same sect (${p.sect_maslak})`);
  else if (sc <= -8) reasons.push(`✗ Sect differs (${c.sect_maslak} vs ${p.sect_maslak})`);

  for (const [req, who, theirs] of [[c.req_caste, p, 'candidate'], [p.req_caste, c, 'profile']]) {
    const ok = casteOK(req, who.caste);
    if (ok === true) { s += 4; reasons.push(`✓ Caste ${who.caste} matches the ${theirs}'s requirement (${req})`); }
    if (ok === false) { s -= 10; reasons.push(`✗ Caste ${who.caste} is not in the ${theirs}'s requirement (${req})`); }
  }
  if (!isNA(c.caste) && normCaste(c.caste) === normCaste(p.caste)) { s += 3; reasons.push(`✓ Same caste (${p.caste})`); }

  const lc = eduLevel(c.education), lp = eduLevel(p.education);
  if (lc != null && lp != null) {
    const d = Math.abs(lc - lp);
    if (d <= 1) { s += 3; reasons.push(`✓ Similar education (${c.education} / ${p.education})`); }
    else if (d >= 3) { s -= 5; reasons.push(`✗ Education levels are far apart (${c.education} / ${p.education})`); }
  }
  const reqLevel = (r) => { const l = String(r || '').split(/\/|,|\bor\b/i).map(eduLevel).filter((x) => x != null); return l.length ? Math.min(...l) : null; };
  for (const [req, level, edu, who] of [[c.req_education, lp, p.education, 'candidate'], [p.req_education, lc, c.education, 'profile']]) {
    const need = reqLevel(req);
    if (need != null && level != null && level < need) { s -= 8; reasons.push(`✗ Education ${edu} is below the ${who}'s requirement (${req})`); }
  }

  for (const [req, other, who] of [[c.req_marital_status, p.marital_status, 'candidate'], [p.req_marital_status, c.marital_status, 'profile']]) {
    if (singleOnly(req) && priorMarriage(other)) { s -= 12; reasons.push(`✗ ${who} asks for single, but the other side is ${other}`); }
  }
  if (!isNA(c.marital_status) && String(c.marital_status).trim().toLowerCase() === String(p.marital_status || '').trim().toLowerCase())
    reasons.push(`✓ Same marital status (${p.marital_status})`);

  const rh = inches(c.req_height), ph = inches(p.height);
  if (rh && ph) {
    if (ph >= rh) { s += 2; reasons.push(`✓ Height ${p.height} meets the requirement (${c.req_height})`); }
    else { s -= 4; reasons.push(`✗ Height ${p.height} is below the requirement (${c.req_height})`); }
  }

  let score = bound(s, tier);
  if (ac.status === 'unknown') score = Math.min(score, 70);
  return { p, tier, score, reasons: reasons.slice(0, 8), group: option || score < 60 ? 'option' : 'best' };
}

/* ---------- WhatsApp template (exact wording, do not "fix" spellings) ---------- */
function formatProfile(p) {
  const income = pick(p, /^(monthlyincome|income|salary)$/) ||
    (String(p.profession_salary || '').match(/\(([^)]*\d[^)]*)\)|\d+\s?(?:k|lac|lakh)\+?/i) || [])[1] ||
    (String(p.profession_salary || '').match(/\d+\s?(?:k|lac|lakh)\+?/i) || [])[0];
  const source = pick(p, /^(sourceofincome|occupation|job)$/) || p.profession_salary;
  const size = pick(p, /^(homesize|housesize)/) || (String(p.house_details || '').match(/\d+(?:\s*(?:to|-)\s*\d+)?\s*(?:marla|kanal)s?/i) || [])[0];
  return [
    `${val(p.gender)}/${val(p.age)}/${val(p.city)}/${val(p.marital_status)}/${val(p.caste)}`,
    '',
    'https://www.nikahconnect.pro',
    '',
    '🔵 *Candidate Info* ',
    '',
    `👉>-Gender: ${val(p.gender)}`,
    `👉>-Marital status: ${val(p.marital_status)}`,
    `👉>-Date of birth: ${val(pick(p, /^(dob|dateofbirth|birth)/))}`,
    `👉>-Height: ${val(p.height)}`,
    `👉>-weight: ${val(p.weight)}`,
    `👉>-Complexion: ${val(pick(p, /^(complexion|colou?r|skin)/))}`,
    `👉>-Education: ${val(p.education)}`,
    `👉>-College/University: ${val(pick(p, /^(college|university|institute)/))}`,
    `👉>-Religious education(optional): ${val(pick(p, /^(religiouseducation|islamiceducation|deeni)/))}`,
    `👉>-Monthly Income: ${val(income)}`,
    `👉>-Source of income: ${val(source)}`,
    `👉>-Sect (Maslak) : ${val(p.sect_maslak)}`,
    `👉>-Caste : ${val(p.caste)}`,
    `👉>-Beard/Hijab: ${val(pick(p, /^(beard|hijab)/))}`,
    `👉>-Language: ${val(pick(p, /^language/))}`,
    `👉>-Disability : ${val(pick(p, /^disab/))}`,
    '',
    '🔵 *Family Status* ',
    '',
    `👉>-Father’s Profession: ${val(pick(p, /^father/))}`,
    `👉>-Mother profession: ${val(pick(p, /^mother/))}`,
    '',
    '🔵>- *Siblings Details:*  ',
    '',
    `Sisters: ${val(pick(p, /^sisters?$/))}`,
    `Brother's: ${val(pick(p, /^brothers?$/))}`,
    `Married siblings: ${val(pick(p, /^married/))}`,
    '',
    '🔵 *Residence* ',
    '',
    `👉>-House owned or Rental: ${val(p.house_details)}`,
    `👉>-Home size: ${val(size)}`,
    `👉>-Other properties (optional): ${val(pick(p, /^(otherproperties|properties)/))}`,
    `👉>-Current City: ${val(p.city)}`,
    `👉>-Name of Area/Twon(Optional): ${val(pick(p, /^(area|town|nameofarea)/))}`,
    `👉>-Nationality : ${val(pick(p, /^nationality/))}`,
    '',
    '🔵 *Requirement* ',
    '',
    `👉>-Marital status: ${val(p.req_marital_status)}`,
    `👉>-Financial Status: ${val(pick(p, /^req.*(financ|income)/))}`,
    `👉>-Age: ${val(p.req_age_range)}`,
    `👉>-Height: ${val(p.req_height)}`,
    `👉>-Education : ${val(p.req_education)}`,
    `👉>-Sect : ${val(p.req_maslak)}`,
    `👉>-Cast: ${val(p.req_caste)}`,
    `👉>-House: ${val(pick(p, /^req.*house/))}`,
    `👉>-City: ${val(p.req_city)}`,
    `👉>-Country: ${val(pick(p, /^req.*country/))}`,
    `👉>-Other requirements(optional): ${val(p.other_requirements)}`,
    '',
    '🔵*Contact details*',
    '',
    `Family Contact number(compulsory): ${val(p.contact_number)}`,
    `👉>-Relation with candidate: ${val(pick(p, /^relation/))}`,
    `👉>-Self contact only for male(optional): ${val(pick(p, /^selfcontact/))}`,
    '',
    `👉>- Anything else you want to tell about canidate (optional): ${val(pick(p, /^(anything|additional|remarks|notes?)/))}`,
    '',
    '*#Nikah_Connect (Pakistan largest family based Rishta platform) Contact#03000825815*',
  ].join('\n');
}

/* ---------- Reads the standard Nikah Connect template without AI ---------- */
function parseBioData(text) {
  const t = String(text || '');
  const get = (src, ...labels) => {
    for (const label of labels) {
      const m = src.match(new RegExp(label + '[ \\t]*:[ \\t]*([^\\n\\r]*)', 'i'));
      const v = m ? m[1].replace(/[*_]/g, '').trim() : '';
      if (!isNA(v)) return v;
    }
    return null;
  };
  // The "Requirement" heading may carry emoji or stars around it; everything after it is the requirement part.
  const ri = t.search(/Requirements?[^\n\w]*\n/i);
  const cand = ri >= 0 ? t.slice(0, ri) : t;
  const req = ri >= 0 ? t.slice(ri) : '';
  const first = t.trim().split('\n')[0].split('/').map((x) => x.trim());

  let gender = get(cand, 'Gender');
  let age = num(get(cand, 'Age')), city = get(cand, 'Current City', 'City');
  if (first.length >= 3 && /^\d{1,2}$/.test(first[1])) {
    gender = gender || first[0]; age = age ?? Number(first[1]); city = city || first[2];
  }
  const dob = get(cand, 'Date of birth', 'DOB');
  if (age == null && dob) {
    const m = dob.match(/(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{4})/) || dob.match(/()()((?:19|20)\d{2})/);
    if (m) {
      const now = new Date();
      age = now.getFullYear() - Number(m[3]);
      if (m[1] && (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[1])))) age -= 1;
    }
  }
  const src = get(cand, 'Source of income', 'Profession', 'Occupation'), inc = get(cand, 'Monthly Income');
  const house = [get(cand, 'House owned or Rental', 'House'), get(cand, 'Home size')].filter(Boolean).join(' ');
  const other = [get(req, 'Other requirements?[ \\t]*(?:\\(optional\\))?'), get(req, 'Financial Status'), get(req, 'House'), get(req, 'Profession')].filter(Boolean).join(' / ');
  return {
    gender, age, city,
    marital_status: get(cand, 'Marital status'), height: get(cand, 'Height'), weight: get(cand, 'weight'),
    education: get(cand, 'Education'), caste: get(cand, 'Caste', 'Cast'),
    sect_maslak: get(cand, 'Sect[ \\t]*\\(Maslak\\)', 'Maslak', 'Sect'),
    profession_salary: [src, inc].filter(Boolean).join(' - ') || null,
    house_details: house || null,
    req_marital_status: get(req, 'Marital status'), req_age_range: get(req, 'Age'), req_height: get(req, 'Height'),
    req_education: get(req, 'Education'), req_maslak: get(req, 'Sect', 'Maslak'), req_caste: get(req, 'Caste', 'Cast'),
    req_city: get(req, 'City[ \\t]*/[ \\t]*Country', 'City'),
    other_requirements: other || null,
  };
}

/* Supabase returns at most 1000 rows per request, so read the table page by page. */
async function fetchAll(sb) {
  const probe = await sb.from(TABLE).select('*').limit(1);
  if (probe.error) return { error: probe.error };
  if (!probe.data?.length) return { data: [] };
  const idKey = Object.keys(probe.data[0]).find((k) => /^(profileid|id)$/.test(nk(k)));
  const all = [];
  for (let from = 0; from < 50000; from += 1000) {
    let q = sb.from(TABLE).select('*');
    if (idKey) q = q.order(idKey);
    const { data, error } = await q.range(from, from + 999);
    if (error) return { error };
    all.push(...data);
    if (data.length < 1000) break;
  }
  return { data: all };
}
const uniqRows = (rows) => {
  const seen = new Set();
  return rows.filter((r) => {
    const k = String(r.profile_id ?? '').trim();
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/* ---------- Handler ---------- */
const fail = (error, status = 500) => NextResponse.json({ error }, { status });

/* Open /api/match in the browser to verify the table, column mapping and data quality (no personal data is returned). */
export async function GET() {
  try {
    const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key } = process.env;
    if (!url || !key) return fail('Missing Supabase environment variables.');
    const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || key);
    const all = await fetchAll(sb);
    if (all.error) return fail(`Database error: ${all.error.message}`);
    const raw = all.data;
    if (!raw?.length) return NextResponse.json({ table: TABLE, rows: 0, problem: 'Table returned 0 rows (wrong table name, empty table, or no read access).' });
    const keys = Object.keys(raw[0]);
    const mapping = {};
    for (const [canon, re] of Object.entries(CANON))
      mapping[canon] = keys.find((k) => k.toLowerCase() === canon) || keys.find((k) => re.test(nk(k))) || 'NOT FOUND';
    const rows = uniqRows(raw.map(normRow));
    return NextResponse.json({
      table: TABLE,
      rows: rows.length,
      columns_in_table: keys,
      mapping,
      not_found: Object.entries(mapping).filter(([, v]) => v === 'NOT FOUND').map(([k]) => k),
      gender_counts: {
        male: rows.filter((r) => genderOf(r.gender) === 'male').length,
        female: rows.filter((r) => genderOf(r.gender) === 'female').length,
        missing_or_unreadable: rows.filter((r) => !genderOf(r.gender)).length,
      },
      rows_without_numeric_age: rows.filter((r) => num(r.age) == null).length,
      distinct_gender_values: [...new Set(raw.map((r) => String(r[mapping.gender] ?? '')))].slice(0, 10),
    });
  } catch (e) {
    return fail(e.message || 'Unexpected server error.');
  }
}

export async function POST(req) {
  try {
    const { prompt } = await req.json();
    if (!prompt || !prompt.trim()) return fail('Paste a candidate bio-data or type a profile ID such as NC-102.', 400);

    const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key, GEMINI_API_KEY: gk } = process.env;
    if (!url || !key) return fail('Server is missing Supabase environment variables.');

    // A server-only service key (if set) keeps the table private; otherwise the anon key + a SELECT policy is used.
    const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || key);
    const all = await fetchAll(sb);
    if (all.error) return fail(`Database error: ${all.error.message}`);
    const rows = uniqRows(all.data.map(normRow));

    // 1) Candidate: profile ID, or the pasted template read by code. Gemini is only a fallback for unusual formats.
    let c;
    const idMatch = prompt.trim().length < 30 && prompt.match(/NC-\d+/i);
    if (idMatch) c = rows.find((r) => idNum(r.profile_id) === idNum(idMatch[0]));
    if (!c) {
      const parsed = parseBioData(prompt);
      if (genderOf(parsed.gender) && num(parsed.age) != null && !isNA(parsed.city)) c = parsed;
    }
    if (!c && gk) {
      try {
        const genAI = new GoogleGenerativeAI(gk);
        const models = [MODEL, process.env.GEMINI_FALLBACK_MODEL].filter(Boolean).map((name) =>
          genAI.getGenerativeModel({ model: name, generationConfig: { responseMimeType: 'application/json', temperature: 0 } })
        );
        const today = new Date().toISOString().slice(0, 10);
        const ask = `Extract the candidate from this Nikah Connect bio-data. Copy only what is written; never guess. Return JSON with keys: gender ("Male" or "Female"), age (number; if only Date of birth is given, calculate age as of ${today}), city, marital_status, caste, sect_maslak, height, weight, education, profession_salary, house_details, req_marital_status, req_age_range, req_city, req_caste, req_maslak, req_education, other_requirements. Use null for blank fields. Return only JSON.\n\n${prompt}`;
        for (let i = 0; i < 3 && !c; i++) {
          for (const m of models) {
            try { c = JSON.parse((await m.generateContent(ask)).response.text()); break; }
            catch (e) { if (!/503|429|overloaded|high demand/i.test(e.message)) throw e; }
          }
          if (!c) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
        }
      } catch (e) { console.error('Gemini extraction failed:', e.message); }
    }
    if (!c || !genderOf(c.gender) || num(c.age) == null || isNA(c.city))
      return fail('Could not read Gender, age and city from this text. Please fill them in (use the standard template or a profile ID such as NC-102).', 422);

    // 2) Hard rules: opposite gender only; male age >= female age (see ageCheck).
    const want = genderOf(c.gender) === 'male' ? 'female' : 'male';
    const unknownGender = rows.filter((p) => !genderOf(p.gender)).length;
    const opposite = rows.filter((p) => p.profile_id !== c.profile_id && genderOf(p.gender) === want);
    const evaluated = opposite.map((p) => evaluate(c, p)).filter(Boolean);

    const byScore = (a, b) => b.score - a.score;
    const best = evaluated.filter((e) => e.group === 'best').sort(byScore).slice(0, MAIN_MAX);
    // Lower-match options are added only when the requirement-based matches are few.
    const options = best.length < MIN_MAIN
      ? evaluated.filter((e) => e.group === 'option' && e.score >= 30).sort(byScore).slice(0, SUGG_MAX)
      : [];

    const results = [...best, ...options].map(({ p, tier, score, reasons, group }) => ({
      id: p.profile_id,
      score,
      tier,
      group,
      reasons,
      info: { age: p.age, height: p.height, city: p.city, education: p.education, work: p.profession_salary, marital: p.marital_status, caste: p.caste, gender: p.gender },
      text: formatProfile(p),
    }));

    return NextResponse.json({
      candidate: { id: c.profile_id || null, gender: c.gender, age: num(c.age), city: c.city, marital_status: c.marital_status, caste: c.caste },
      showing: want,
      stats: {
        total: rows.length,
        scanned: opposite.length,
        disqualified: opposite.length - evaluated.length,
        unknownGender,
        columns: rows.length && !opposite.length ? Object.keys(rows[0]) : undefined,
      },
      results,
    });
  } catch (e) {
    console.error(e);
    return fail(e.message || 'Unexpected server error.');
  }
}
