// sunset.js — Node 18+
// Использование: node sunset.js
// Требует: process.env.BOT_TOKEN и файл channels.json в корне.

const fs = require('fs');
const path = require('path');
const https = require('https');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('No BOT_TOKEN'); process.exit(1); }

const channels = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'channels.json'), 'utf8'));
const CACHE_FILE = path.join(process.cwd(), '.cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }

// ── Математика солнца (минимум для заката)
const PI = Math.PI, rad = PI/180;
function toJulian(date){ return date/86400000 - 0.5 + 2440587.5; }
function fromJulian(j){ return new Date((j + 0.5 - 2440587.5)*86400000); }
function solarMeanAnomaly(d){ return rad * (357.5291 + 0.98560028*d); }
function eclipticLongitude(M){
  const C = rad*(1.9148*Math.sin(M) + 0.02*Math.sin(2*M) + 0.0003*Math.sin(3*M));
  const P = rad*102.9372;
  return M + C + P + PI;
}
function declination(L){ const e = rad*23.4397; return Math.asin(Math.sin(e)*Math.sin(L)); }
function julianCycle(d, lw){ return Math.round(d - 0.0009 - lw/(2*PI)); }
function approxTransit(Ht, lw, n){ return 0.0009 + (Ht + lw)/(2*PI) + n; }
function solarTransitJ(ds, M, L){ return 2451545 + ds + 0.0053*Math.sin(M) - 0.0069*Math.sin(2*L); }
function hourAngle(h, phi, d){ return Math.acos((Math.sin(h) - Math.sin(phi)*Math.sin(d))/(Math.cos(phi)*Math.cos(d))); }
function getSunset(dateUTC, lat, lon){
  const lw = -lon*rad, phi = lat*rad;
  const d = toJulian(dateUTC) - 2451545;
  const n = julianCycle(d, lw);
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const h0 = (-0.83)*rad;
  const H = hourAngle(h0, phi, dec);
  const ds = approxTransit(H, lw, n);
  const Jset = solarTransitJ(ds, M, L);
  return fromJulian(Jset); // UTC
}

// TZ утилиты
const DOW = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };
function toZoned(dateUTC, tz){
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  }).format(dateUTC); // "MM/DD/YYYY, HH:MM:SS"
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/);
  return new Date(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}`);
}
function fmtHHMM(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

function buildSaturdayMinus1(tz, lat, lon){
  const nowUTC = new Date();
  const local = toZoned(nowUTC, tz);
  const daysUntilSat = (6 - local.getDay() + 7) % 7; // 6=Saturday
  const saturdayUTC = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate()+daysUntilSat, 12, 0, 0));
  const sunsetUTC = getSunset(saturdayUTC, lat, lon);
  const localSunset = toZoned(sunsetUTC, tz);
  const meetLocal = new Date(localSunset.getTime() - 60*60*1000);
  return fmtHHMM(meetLocal);
}

function shouldSendNow(tz, schedule, lastSentMs, nowUTC){
  const local = toZoned(nowUTC, tz);
  const [dayStr, hm] = schedule.split(' ');
  const [hh, mm] = hm.split(':').map(Number);
  const target = DOW[dayStr];
  const nowMin = local.getDay()*1440 + local.getHours()*60 + local.getMinutes();
  const schedMin = target*1440 + hh*60 + mm;

  let diff = nowMin - schedMin;
  if (diff < 0) diff += 7*1440;              // сдвиг назад в прошлую неделю
  const WINDOW = 15;                         // окно 15 минут
  const antiDup = !lastSentMs || (Date.now() - lastSentMs) > 12*60*60*1000; // 12 часов
  return diff < WINDOW && antiDup;
}

function sendMessage(chat_id, text){
  const payload = JSON.stringify({ chat_id, text });
  const opts = {
    method: 'POST',
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
  };
  return new Promise((resolve, reject)=>{
    const req = https.request(opts, res=>{
      let data=''; res.on('data', d=> data+=d);
      res.on('end', ()=> resolve({status: res.statusCode, body: data}));
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

(async ()=>{
  const nowUTC = new Date();
  for (const rule of channels){
    const uid = `${rule.chat_id}::${rule.tz}::${rule.schedule}`;
    const last = cache[uid] ? Number(cache[uid]) : 0;
    if (!shouldSendNow(rule.tz, rule.schedule, last, nowUTC)) continue;

    const hhmm = buildSaturdayMinus1(rule.tz, rule.lat, rule.lon);
    const text = (rule.text || 'Доброе утро, встреча субботы в {HHMM}, удачи в подготовке!').replace('{HHMM}', hhmm);

    try{
      const res = await sendMessage(rule.chat_id, text);
      console.log('Sent to', rule.chat_id, res.status);
      cache[uid] = String(Date.now());
    }catch(e){
      console.error('Send error', rule.chat_id, e.message);
    }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
})();
