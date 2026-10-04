import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TABLE = process.env.SUPABASE_TABLE || 'profiles db';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash'; // used ONLY to read pasted text that does not follow the template
const MAIN_MAX = 40;      // best matches returned (the page shows 10 at a time)
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
function sectKinds(s) {
  s = String(s || '').toLowerCase();
  const k = new Set();
  if (/shia|shi'a|jaafri|ithna|imami/.test(s)) k.add('shia');
  if (/hadee?s|salafi/.test(s)) k.add('hadees');
  if (/deoband/.test(s)) k.add('deobandi');
  if (/barel|brelvi|ridakhani/.test(s)) k.add('barelvi');
  if (/sunn?i\b|ahl[ae]?[\s-]*e?[\s-]*sunn?(at|ah|ath)\b/.test(s)) k.add('sunni'); // Sunni / Suni / Ahle Sunnat (wal Jamaat) = general Sunni
  return k;
}
function sectScore(a, b) {
  const x = sectKinds(a), y = sectKinds(b);
  if (!x.size || !y.size) return 0;
  if ([...x].some((k) => y.has(k))) return 6;
  if (x.has('shia') || y.has('shia')) return -25;
  if (x.has('hadees') || y.has('hadees')) return -8;
  if ((x.has('barelvi') && y.has('deobandi')) || (x.has('deobandi') && y.has('barelvi'))) return -4;
  return 2;
}
// Does `sect` satisfy the wanted sect text? General "Sunni" fits any Sunni school.
function sectFit(req, sect) {
  const R = sectKinds(req), C = sectKinds(sect);
  if (!R.size || !C.size) return null;
  if ([...C].some((k) => R.has(k))) return true;
  const sub = (S) => [...S].some((k) => k === 'barelvi' || k === 'deobandi');
  if ((R.has('sunni') && sub(C)) || (C.has('sunni') && sub(R))) return true;
  return false;
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
const CASTE_ALIAS = [
  [/raj+poo?t|rangh?ar/g, 'rajput'], [/\bj[ua]t+\b/g, 'jutt'], [/\bmemom\b/g, 'memon'], [/\bmehar\b/g, 'mahar'],
  [/\bkamboj\b|\bkambo\b/g, 'kamboh'], [/sh[ae]i?kh/g, 'sheikh'], [/ara[ye]en|arayen/g, 'arain'], [/guj+ar\b/g, 'gujjar'],
  [/mug+h?al|mogul|mughul/g, 'mughal'], [/\bs[ae]y+ed\b|\bsaiyed\b/g, 'syed'], [/qur[ae]i?shi/g, 'qureshi'],
  [/chau?dh?a?ry|chaudhri|choudhry/g, 'chaudhry'],
];
// A specific caste/tribe also satisfies its general group (e.g. Khattak -> Pathan). Edit freely.
const CASTE_GROUPS = {
  pathan: 'khattak yousafzai afridi shinwari mohmand bangash tareen kakar achakzai kakazai niazi gandapur utmankhail banuchi barozai umarzai mandokhail jadoon swati kasi orakzai durrani wazir mehsud',
  baloch: 'rind mengal bizenjo bugti marri leghari',
  syed: 'naqvi kazmi bukhari rizvi zaidi gilani gardezi',
  rajput: 'chauhan ranny janjua rathore bhatti minhas',
  kashmiri: 'butt meer wani lone',
};
const GROUP_OF = {};
for (const [g, list] of Object.entries(CASTE_GROUPS)) for (const c of list.split(' ')) GROUP_OF[c] = g;
const CASTE_STOP = new Set(['preferred', 'preference', 'apart', 'from', 'all', 'only', 'issue', 'non', 'noble', 'except', 'other', 'than', 'compatible', 'urdu', 'speaking', 'khel', 'nai', 'punjabi', 'reverted', 'muslim', 'shahi', 'qutub', 'the', 'and', 'any', 'good', 'caste', 'not', 'indian', 'migrated']);
const normCaste = (v) => {
  let x = String(v || '').toLowerCase();
  for (const [re, t] of CASTE_ALIAS) x = x.replace(re, t);
  return x.replace(/[^a-z]+/g, ' ').trim();
};
const casteTokens = (v) => {
  const all = normCaste(v).split(' ').filter((t) => t.length > 2);
  const t = all.filter((x) => !CASTE_STOP.has(x));
  return t.length ? t : all;
};
const casteWithGroups = (v) => { const t = casteTokens(v); return [...new Set([...t, ...t.map((x) => GROUP_OF[x]).filter(Boolean)])]; };
const sameCaste = (a, b) => !isNA(a) && !isNA(b) && casteTokens(a).some((t) => casteTokens(b).includes(t));
const hasWord = (text, w) => new RegExp(`\\b${w}\\b`).test(text);
const casteOK = (req, caste) => {
  if (isNA(req) || isNA(caste)) return null;
  const r = normCaste(req);
  const ex = r.match(/apart from|except|excluding|other than|siwaye/);
  if (ex) return casteTokens(caste).some((t) => hasWord(r.slice(r.indexOf(ex[0]) + ex[0].length), t)) ? false : null;
  if (anyWord.test(req)) return null;
  if (casteWithGroups(caste).some((t) => hasWord(r, t))) return true;
  // the profile states only a broad group (e.g. "Pathan") while the requirement names one tribe: unknown, not a mismatch
  const broad = casteTokens(caste).filter((t) => CASTE_GROUPS[t]);
  if (broad.some((g) => CASTE_GROUPS[g].split(' ').some((m) => hasWord(r, m)))) return null;
  return false;
};
// Words already reviewed in the data. /api/match lists any NEW caste word or sect spelling so it can be added to the groups above.
const KNOWN_CASTE = new Set(["abbasi", "achakzai", "afridi", "ansari", "any", "arain", "awan", "bajwa", "baloch", "balti", "bangash", "banuchi", "barozai", "bhutto", "bihari", "bizenjo", "butt", "channer", "chaudhry", "chauhan", "compatible", "daadpotra", "daha", "dar", "deobandi", "dogar", "except", "farooqi", "gandapur", "gardezi", "gharshin", "ghuman", "gilani", "good", "gopang", "gujarati", "gujjar", "hashmi", "hiraj", "hunzai", "jadoon", "janjua", "jutt", "kakar", "kakazai", "kamboh", "kashmiri", "kasi", "kazmi", "khan", "khattak", "khel", "khokhar", "kiani", "kolachi", "mahar", "malik", "mandokhail", "mayo", "meer", "memon", "mengal", "mirza", "mohmand", "mughal", "muslim", "nanda", "naqvi", "niazi", "own", "pathan", "pechuho", "phulpoto", "qureshi", "raja", "rajput", "rana", "ranjha", "ranny", "rao", "rathore", "reverted", "rind", "satti", "sheikh", "shia", "shinwari", "sial", "soomro", "speaking", "sunni", "swati", "syed", "tareen", "umarzai", "urdu", "utmankhail", "virk", "warraich", "yousafzai"]);
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

  for (const [req, sect, who] of [[c.req_maslak, p.sect_maslak, 'candidate'], [p.req_maslak, c.sect_maslak, 'profile']]) {
    if (sectFit(req, sect) === false) { s -= 10; reasons.push(`✗ Sect ${sect} is not what the ${who} wants (${req})`); }
  }

  for (const [req, who, theirs] of [[c.req_caste, p, 'candidate'], [p.req_caste, c, 'profile']]) {
    const ok = casteOK(req, who.caste);
    if (ok === true) { s += 4; reasons.push(`✓ Caste ${who.caste} matches the ${theirs}'s requirement (${req})`); }
    if (ok === false) { s -= 10; reasons.push(`✗ Caste ${who.caste} is not in the ${theirs}'s requirement (${req})`); }
  }
  if (!isNA(c.caste) && !isNA(p.caste) && casteTokens(c.caste).some((t) => casteTokens(p.caste).includes(t))) { s += 3; reasons.push(`✓ Same caste (${p.caste})`); }

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

  // own house wanted (Req_House_Details) vs the other side's house
  const wantsOwn = (x) => /\bown(ed)?\b|apna|zati/i.test(pick(x, /^req.*house/) || '');
  const rentOnly = (h) => /rent|kiraya|kiray/i.test(h || '') && !/\bown/i.test(h || '');
  const ownOnly = (h) => /\bown/i.test(h || '') && !/rent|kiraya|kiray/i.test(h || '');
  let houseChip = 'unknown';
  for (const [needer, owner, who] of [[c, p, 'candidate'], [p, c, 'profile']]) {
    if (!wantsOwn(needer) || isNA(owner.house_details)) continue;
    if (rentOnly(owner.house_details)) { s -= 6; houseChip = 'bad'; reasons.push(`✗ The ${who} wants an own house, but the other side's house is "${owner.house_details}"`); }
    else if (ownOnly(owner.house_details)) { s += 2; if (houseChip !== 'bad') houseChip = 'ok'; reasons.push(`✓ Own house, as the ${who} wants`); }
  }
  // a job the other side's free-text wish mentions (e.g. "engineer preferred")
  const WORK = ['doctor', 'engineer', 'teacher', 'lecturer', 'professor', 'govt', 'government', 'business', 'banker', 'army', 'software', 'pilot', 'lawyer', 'advocate', 'accountant', 'pharmacist', 'architect'];
  for (const [wish, other, who] of [[c.other_requirements, p.profession_salary, 'candidate'], [p.other_requirements, c.profession_salary, 'profile']]) {
    const w = String(wish || '').toLowerCase(), o = String(other || '').toLowerCase();
    const hitWork = WORK.find((k) => w.includes(k) && o.includes(k));
    if (hitWork) { s += 3; reasons.push(`✓ Work matches what the ${who} mentions (${hitWork})`); }
  }

  let score = bound(s, tier);
  if (ac.status === 'unknown') score = Math.min(score, 70);
  const group = option || score < 60 ? 'option' : 'best';
  const verdict = group === 'option' ? 'Fallback' : score >= 85 ? 'Strong' : score >= 70 ? 'Good' : 'Fair';

  const cr = casteOK(c.req_caste, p.caste), pr = casteOK(p.req_caste, c.caste);
  const sf1 = sectFit(c.req_maslak, p.sect_maslak), sf2 = sectFit(p.req_maslak, c.sect_maslak);
  const needC = reqLevel(c.req_education), needP = reqLevel(p.req_education);
  const eduBad = (needC != null && lp != null && lp < needC) || (needP != null && lc != null && lc < needP);
  const mBad = (singleOnly(c.req_marital_status) && priorMarriage(p.marital_status)) || (singleOnly(p.req_marital_status) && priorMarriage(c.marital_status));
  const chips = {
    age: ac.status === 'unknown' ? 'unknown' : fitP === false || fitC === false ? 'bad' : ac.status === 'exception' ? 'warn' : 'ok',
    city: tier === 'exact' ? 'ok' : tier === 'nearby' ? 'warn' : 'bad',
    sect: sf1 === false || sf2 === false || sc <= -4 ? 'bad' : sc >= 4 || sf1 === true || sf2 === true ? 'ok' : 'unknown',
    caste: cr === false || pr === false ? 'bad' : cr === true || pr === true || sameCaste(c.caste, p.caste) ? 'ok' : 'unknown',
    edu: eduBad ? 'bad' : lc != null && lp != null ? 'ok' : 'unknown',
    marital: mBad ? 'bad' : isNA(c.marital_status) || isNA(p.marital_status) ? 'unknown' : priorMarriage(c.marital_status) === priorMarriage(p.marital_status) ? 'ok' : 'warn',
    house: houseChip,
  };
  // problems first, so they are never cut off or missed
  const ordered = [...reasons.filter((x) => x[0] !== '✓'), ...reasons.filter((x) => x[0] === '✓')].slice(0, 10);
  return { p, tier, score, reasons: ordered, chips, verdict, group };
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
    `👉>-Date of birth: ${pick(p, /^(dob|dateofbirth|birth)/) || (num(p.age) != null ? `N/A (Age: ${num(p.age)} years)` : 'N/A')}`,
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
/* Splits the pasted profile into the candidate part and the requirement part (heading may carry emoji or stars). */
function splitProfile(t) {
  let off = 0;
  for (const line of t.split('\n')) {
    const words = line.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    const heading = /(requirement|expectation|looking for)/i.test(line) && !/^\W*other/i.test(line) &&
      !/:[ \t]*[A-Za-z0-9]/.test(line) && words.length <= 6;
    if (heading) return { cand: t.slice(0, off), req: t.slice(off) };
    off += line.length + 1;
  }
  return { cand: t, req: '' };
}

/* The candidate's age is read ONLY from the candidate part: date of birth, the first line, an "Age:" line, or "34 years".
   It is never taken from the requirement part, and a range such as "30 - 38" is never accepted as an age. */
function readAge(text) {
  const t = String(text || '');
  const { cand } = splitProfile(t);
  const now = new Date();
  const ok = (n) => (n >= 15 && n <= 80 ? n : null);
  const fromDob = (y, mo, d) => {
    let a = now.getFullYear() - y;
    if (mo && (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < (d || 1)))) a -= 1;
    return ok(a);
  };
  const dobLine = (cand.match(/(?:date\s*of\s*birth|\bd\.?o\.?b\.?|birth\s*date)[ \t]*:[ \t]*([^\n\r]*)/i) || [])[1];
  if (dobLine && !isNA(dobLine)) {
    let m = dobLine.match(/(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{4})/);
    if (m) { const a = fromDob(+m[3], +m[2], +m[1]); if (a) return { age: a, source: 'date of birth' }; }
    m = dobLine.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (m) { const a = fromDob(+m[1], +m[2], +m[3]); if (a) return { age: a, source: 'date of birth' }; }
    m = dobLine.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*([A-Za-z]{3,9})\.?,?\s*((?:19|20)\d{2})/);
    const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    if (m && MON.indexOf(m[2].slice(0, 3).toLowerCase()) >= 0) { const a = fromDob(+m[3], MON.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]); if (a) return { age: a, source: 'date of birth' }; }
    m = dobLine.match(/\b((?:19|20)\d{2})\b/);
    if (m) { const a = fromDob(+m[1]); if (a) return { age: a, source: 'birth year' }; }
  }
  const first = t.trim().split('\n')[0].split('/').map((x) => x.trim());
  if (first.length >= 3 && /^\d{2}$/.test(first[1]) && ok(Number(first[1]))) return { age: Number(first[1]), source: 'first line' };
  const am = cand.match(/(?:^|\n)[^\n\w]*age[ \t]*(?:\([^)]*\))?[ \t]*:[ \t]*(\d{2})(?![ \t]*(?:-|–|—|to\b)[ \t]*\d)/i);
  if (am && ok(Number(am[1]))) return { age: Number(am[1]), source: 'Age line' };
  const ym = cand.match(/\b(\d{2})[ \t]*(?:years?|yrs?|saal|sal)\b/i);
  if (ym && ok(Number(ym[1]))) return { age: Number(ym[1]), source: 'years in text' };
  return null;
}

function parseBioData(text) {
  const t = String(text || '');
  const get = (src, ...labels) => {
    for (const label of labels) {
      const m = src.match(new RegExp('(?:^|[^A-Za-z])' + label + '[ \\t]*:[ \\t]*([^\\n\\r]*)', 'i'));
      const v = m ? m[1].replace(/[*_]/g, '').trim() : '';
      if (!isNA(v)) return v;
    }
    return null;
  };
  const { cand, req } = splitProfile(t);
  const first = t.trim().split('\n')[0].split('/').map((x) => x.trim());
  let gender = get(cand, 'Gender');
  let city = get(cand, 'Current City', 'City');
  if (first.length >= 3 && /^\d{1,2}$/.test(first[1])) { gender = gender || first[0]; city = city || first[2]; }
  const ra = readAge(t);
  const age = ra ? ra.age : null;
  const src = get(cand, 'Source of income', 'Profession', 'Occupation'), inc = get(cand, 'Monthly Income');
  const house = [get(cand, 'House owned or Rental', 'House'), get(cand, 'Home size')].filter(Boolean).join(' ');
  const other = [get(req, 'Other requirements?[ \\t]*(?:\\(optional\\))?'), get(req, 'Financial Status'), get(req, 'House'), get(req, 'Profession')].filter(Boolean).join(' / ');
  return {
    age_source: ra ? ra.source : null,
    contact_number: get(t, 'Family Contact[^:\\n]*'),
    gender, age, city,
    marital_status: get(cand, 'Marital status'), height: get(cand, 'Height'), weight: get(cand, 'weight'),
    education: get(cand, 'Education'), caste: get(cand, 'Caste', 'Cast'),
    sect_maslak: get(cand, 'Sect[ \\t]*\\(Maslak\\)', 'Maslak', 'Sect'),
    profession_salary: [src, inc].filter(Boolean).join(' - ') || null,
    house_details: house || null,
    req_marital_status: get(req, 'Marital status'), req_age_range: get(req, 'Age'), req_height: get(req, 'Height'),
    req_education: get(req, 'Education'), req_maslak: get(req, 'Sect', 'Maslak'), req_caste: get(req, 'Caste', 'Cast'),
    req_city: get(req, 'City[ \\t]*/[ \\t]*Country', 'City'),
    req_house_details: get(req, 'House'),
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

/* Duplicates: the same person is sometimes stored twice under different IDs (often one copy is more complete).
   Two records are the same person only if gender, contact number, age (+-1), city and caste all agree; a shared phone alone is NOT enough. */
const phoneSet = (v) => new Set((String(v || '').replace(/[\s\-().]/g, '').match(/\d{10,13}/g) || []).map((n) => n.slice(-10)));
const phonesOverlap = (a, b) => { const A = phoneSet(a); for (const x of phoneSet(b)) if (A.has(x)) return true; return false; };
const filled = (r) => Object.values(r).filter((v) => !isNA(v)).length;
function samePerson(a, b) {
  if (!genderOf(a.gender) || genderOf(a.gender) !== genderOf(b.gender)) return false;
  if (!phonesOverlap(a.contact_number, b.contact_number)) return false;
  const x = num(a.age), y = num(b.age);
  if (x != null && y != null && Math.abs(x - y) > 1) return false;
  if (!isNA(a.city) && !isNA(b.city) && geoTier(a.city, b.city) !== 'exact') return false;
  if (!isNA(a.caste) && !isNA(b.caste) && !sameCaste(a.caste, b.caste)) return false;
  return true;
}
const fingerprint = (r) => {
  const f = [r.gender, r.age, r.city, r.caste, r.education, r.profession_salary, r.marital_status, r.sect_maslak, r.house_details]
    .map((v) => (isNA(v) ? '' : String(v).toLowerCase().replace(/[^a-z0-9]/g, '')));
  return f[0] && f[1] && f.filter(Boolean).length >= 7 ? f.join('|') : null; // 7+ of 9 key details identical
};
function mergeDuplicates(rows) {
  const parent = rows.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(b)] = find(a); };
  const byPhone = new Map(), byPrint = new Map();
  rows.forEach((r, i) => {
    phoneSet(r.contact_number).forEach((p) => { if (!byPhone.has(p)) byPhone.set(p, []); byPhone.get(p).push(i); });
    const k = fingerprint(r);
    if (k) { if (!byPrint.has(k)) byPrint.set(k, []); byPrint.get(k).push(i); }
  });
  for (const idx of byPhone.values())
    for (let i = 0; i < idx.length; i++) for (let j = i + 1; j < idx.length; j++)
      if (samePerson(rows[idx[i]], rows[idx[j]])) union(idx[i], idx[j]);
  for (const idx of byPrint.values()) for (let i = 1; i < idx.length; i++) union(idx[0], idx[i]);
  const groups = new Map();
  rows.forEach((r, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  return [...groups.values()].map((g) => {
    if (g.length === 1) return g[0];
    const sorted = g.slice().sort((a, b) => filled(b) - filled(a));
    const merged = { ...sorted[0] };
    for (const r of sorted.slice(1)) for (const [k, v] of Object.entries(r)) if (isNA(merged[k]) && !isNA(v)) merged[k] = v;
    merged.also_ids = sorted.slice(1).map((r) => r.profile_id);
    const rest = sorted.slice(1);
    merged.also_note = rest.every((r) => phonesOverlap(sorted[0].contact_number, r.contact_number)) ? 'same contact number'
      : rest.some((r) => !phoneSet(r.contact_number).size) || !phoneSet(sorted[0].contact_number).size ? 'identical details' : 'identical details, different contact number';
    return merged;
  });
}

/* AI second opinion (optional, on demand). It cannot change scores or order. Every note must quote text that really exists in the data. */
const NOTE_KEYS = ['gender', 'age', 'city', 'marital_status', 'caste', 'sect_maslak', 'education', 'profession_salary', 'house_details', 'req_marital_status', 'req_age_range', 'req_city', 'req_caste', 'req_maslak', 'req_education', 'other_requirements'];
const noteFacts = (x) => {
  const o = {};
  for (const k of NOTE_KEYS) if (!isNA(x[k])) o[k] = String(x[k]).slice(0, 300);
  const rh = pick(x, /^req.*house/); if (rh) o.req_house_details = rh.slice(0, 200);
  const sal = pick(x, /^(salary|monthlyincome|income)$/); if (sal) o.salary = sal.slice(0, 100);
  return o;
};
async function aiNote(gk, cand, prof) {
  const facts = { candidate: noteFacts(cand), profile: noteFacts(prof) };
  const flat = JSON.stringify(facts).toLowerCase();
  const model = new GoogleGenerativeAI(gk).getGenerativeModel({ model: MODEL, generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
  const ask = `You assist a Pakistani matchmaker. Use ONLY the facts below. List up to 4 short notes (max 20 words each) about things a human should double-check before proposing this match, especially the free-text fields (other_requirements, profession_salary, house_details, req_*). Do not mention age, gender or city rules. Do not invent anything. Every note needs "evidence": 1 or 2 exact quotes copied from the facts. If nothing is worth flagging return {"notes":[]}. Return JSON only: {"notes":[{"text":"...","evidence":["..."]}]}\n\nFACTS: ${JSON.stringify(facts)}`;
  const out = await Promise.race([model.generateContent(ask), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))]);
  const parsed = JSON.parse(out.response.text());
  return (Array.isArray(parsed.notes) ? parsed.notes : [])
    .filter((n) => n && typeof n.text === 'string' && Array.isArray(n.evidence) && n.evidence.length && n.evidence.every((e) => typeof e === 'string' && e.trim().length >= 3 && flat.includes(e.trim().toLowerCase())))
    .slice(0, 4)
    .map((n) => ({ text: n.text.slice(0, 200), evidence: n.evidence.slice(0, 2) }));
}

/* ---------- Handler ---------- */
const fail = (error, status = 500) => NextResponse.json({ error }, { status });

const tally = (vals, fn) => {
  const m = {};
  for (const v of vals) for (const x of fn(v)) m[x] = (m[x] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 40);
};

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
      new_caste_words: tally(rows.flatMap((r) => [r.caste, r.req_caste]), (v) => casteTokens(v).filter((t) => !KNOWN_CASTE.has(t) && !CASTE_GROUPS[t])),
      unrecognised_sect_values: tally(rows.flatMap((r) => [r.sect_maslak, r.req_maslak]), (v) => (!isNA(v) && !sectKinds(v).size && !/^(islam|muslim|any)$/i.test(String(v).trim()) ? [String(v).trim()] : [])),
      duplicate_profiles_merged: rows.length - mergeDuplicates(rows).length,
      duplicate_examples: mergeDuplicates(rows).filter((r) => r.also_ids).slice(0, 30).map((r) => ({ ids: [r.profile_id, ...r.also_ids], reason: r.also_note })),
      rows_without_numeric_age: rows.filter((r) => num(r.age) == null).length,
      distinct_gender_values: [...new Set(raw.map((r) => String(r[mapping.gender] ?? '')))].slice(0, 10),
    });
  } catch (e) {
    return fail(e.message || 'Unexpected server error.');
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { prompt, action, overrides: ov } = body;
    if (action === 'parse') {
      // quick read of the pasted text (no database, no AI) so the staff can check the detected details before searching
      const pc = parseBioData(prompt || '');
      const g = genderOf(pc.gender);
      return NextResponse.json({ candidate: { gender: g ? (g === 'male' ? 'Male' : 'Female') : null, age: pc.age ?? null, age_source: pc.age_source, city: pc.city, req_age_range: pc.req_age_range } });
    }
    if (action !== 'note' && (!prompt || !prompt.trim())) return fail('Paste a candidate bio-data or type a profile ID such as NC-102.', 400);

    const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key, GEMINI_API_KEY: gk } = process.env;
    if (!url || !key) return fail('Server is missing Supabase environment variables.');

    // A server-only service key (if set) keeps the table private; otherwise the anon key + a SELECT policy is used.
    const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || key);
    const all = await fetchAll(sb);
    if (all.error) return fail(`Database error: ${all.error.message}`);
    const allRows = uniqRows(all.data.map(normRow));
    const rows = mergeDuplicates(allRows);

    if (action === 'note') {
      if (!gk) return fail('The AI key is not set on the server.', 503);
      const prof = rows.find((r) => String(r.profile_id) === String(body.id) || (r.also_ids || []).includes(body.id));
      if (!prof) return fail('Profile not found.', 404);
      try { return NextResponse.json({ notes: await aiNote(gk, body.candidate || {}, prof) }); }
      catch (e) { console.error('AI note failed:', e.message); return fail('The AI is busy right now. Please try again in a minute.', 503); }
    }

    // 1) Candidate: profile ID, or the pasted template read by code. Gemini is only a fallback for unusual formats.
    let c;
    const idMatch = prompt.trim().length < 30 && prompt.match(/NC-\d+/i);
    if (idMatch) c = allRows.find((r) => idNum(r.profile_id) === idNum(idMatch[0]));
    if (!c) {
      const parsed = parseBioData(prompt);
      if (genderOf(parsed.gender) && num(parsed.age) != null && !isNA(parsed.city)) c = parsed;
    }
    // Gemini is only a fallback for gender/city, and only when the age is already readable (the age never comes from the AI).
    if (!c && gk && readAge(prompt)) {
      try {
        const genAI = new GoogleGenerativeAI(gk);
        const models = [MODEL, process.env.GEMINI_FALLBACK_MODEL].filter(Boolean).map((name) =>
          genAI.getGenerativeModel({ model: name, generationConfig: { responseMimeType: 'application/json', temperature: 0 } })
        );
        const today = new Date().toISOString().slice(0, 10);
        const ask = `Extract the candidate from this Nikah Connect bio-data. Copy only what is written; never guess. Return JSON with keys: gender ("Male" or "Female"), age (number; if only Date of birth is given, calculate age as of ${today}), city, marital_status, caste, sect_maslak, height, weight, education, profession_salary, house_details, req_marital_status, req_age_range, req_city, req_caste, req_maslak, req_education, other_requirements. Use null for blank fields. Return only JSON.\n\n${prompt}`;
        for (let i = 0; i < 1 && !c; i++) {
          for (const m of models) {
            try {
              const out = await Promise.race([m.generateContent(ask), new Promise((_, rej) => setTimeout(() => rej(new Error('503 timeout')), 6000))]);
              c = JSON.parse(out.response.text()); break;
            }
            catch (e) { if (!/503|429|overloaded|high demand/i.test(e.message)) throw e; }
          }
          if (!c) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        }
      } catch (e) { console.error('Gemini extraction failed:', e.message); }
    }
    if (!c && ov) c = parseBioData(prompt);
    if (c && !c.profile_id) {
      const ra = readAge(prompt); // the age always comes from code, never from the AI
      c.age = ra ? ra.age : null; c.age_source = ra ? ra.source : null;
    } else if (c) c.age_source = 'database';
    if (c && !c.profile_id && ov) { // values the staff confirmed or corrected in the "Detected details" box
      if (genderOf(ov.gender)) c.gender = genderOf(ov.gender) === 'male' ? 'Male' : 'Female';
      const oa = num(ov.age);
      if (oa != null && oa >= 15 && oa <= 80 && oa !== num(c.age)) { c.age = oa; c.age_source = 'edited by you'; }
      if (!isNA(ov.city)) c.city = String(ov.city).trim().slice(0, 60);
      if (ov.req_age_range != null) c.req_age_range = String(ov.req_age_range).trim().slice(0, 40) || null;
    }
    if (!c || !genderOf(c.gender) || num(c.age) == null || isNA(c.city))
      return fail('Could not find the Gender, age and city of the candidate. Age is read only from the date of birth or an "Age: 34" line in the candidate part. Add it (for example a first line like Female/34/Lahore) or use a profile ID such as NC-102.', 422);

    // 2) Hard rules: opposite gender only; male age >= female age (see ageCheck).
    const want = genderOf(c.gender) === 'male' ? 'female' : 'male';
    const unknownGender = rows.filter((p) => !genderOf(p.gender)).length;
    const opposite = rows.filter((p) => p.profile_id !== c.profile_id && !(p.also_ids || []).includes(c.profile_id) && genderOf(p.gender) === want);
    const evaluated = opposite.map((p) => evaluate(c, p)).filter(Boolean);

    const byScore = (a, b) => b.score - a.score;
    const bestAll = evaluated.filter((e) => e.group === 'best').sort(byScore);
    const best = bestAll.slice(0, MAIN_MAX);
    // Lower-match options are added only when the requirement-based matches are few.
    const optionsAll = evaluated.filter((e) => e.group === 'option' && e.score >= 30).sort(byScore);
    const options = best.length < MIN_MAIN ? optionsAll.slice(0, SUGG_MAX) : [];

    const results = [...best, ...options].map(({ p, tier, score, reasons, group, chips, verdict }) => ({
      id: p.profile_id,
      score,
      tier,
      group,
      chips,
      verdict,
      also_ids: p.also_ids || [],
      also_note: p.also_note || '',
      reasons: phonesOverlap(c.contact_number, p.contact_number) ? [...reasons, '! Same contact number as the candidate (same family or same agent)'] : reasons,
      info: { age: p.age, height: p.height, city: p.city, education: p.education, work: p.profession_salary, marital: p.marital_status, caste: p.caste, gender: p.gender },
      text: formatProfile(p),
    }));

    return NextResponse.json({
      candidate: { id: c.profile_id || null, gender: c.gender, age: num(c.age), age_source: c.age_source || null, city: c.city, marital_status: c.marital_status, caste: c.caste },
      candidate_data: noteFacts(c),
      showing: want,
      stats: {
        total_raw: allRows.length,
        merged: allRows.length - rows.length,
        total: rows.length,
        scanned: opposite.length,
        evaluated: evaluated.length,
        best_total: bestAll.length,
        options_total: optionsAll.length,
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
