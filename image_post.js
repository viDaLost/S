// image_post.js — генерирует PNG-карточку (кириллица), отправляет как фото БЕЗ подписи
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, registerFont } from 'canvas';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('No BOT_TOKEN'); process.exit(1); }

const ROOT = process.cwd();
const channels = JSON.parse(fs.readFileSync(path.join(ROOT, 'channels.json'), 'utf8'));

// ── Регистрируем хорошие кириллические шрифты:
// Manrope — для заголовков и времени, PT Sans — для вспомогательного текста
registerFont(path.join(ROOT, 'assets/fonts/Manrope-Regular.ttf'), { family: 'Manrope', weight: '400' });
registerFont(path.join(ROOT, 'assets/fonts/Manrope-Bold.ttf'),    { family: 'Manrope', weight: '700' });
registerFont(path.join(ROOT, 'assets/fonts/PTSans-Regular.ttf'),  { family: 'PT Sans', weight: '400' });
registerFont(path.join(ROOT, 'assets/fonts/PTSans-Bold.ttf'),     { family: 'PT Sans', weight: '700' });

// ── кэш антидублей
const CACHE_FILE = path.join(ROOT, '.cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }

// ── Математика для заката (минимальная реализация)
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

// ── TZ и расписание
const DOW = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };
function toZoned(dateUTC, tz){
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12:false,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'
  }).format(dateUTC);
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/);
  return new Date(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}`);
}
function fmtHHMM(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

function buildSaturdayMinus1(tz, lat, lon){
  const nowUTC = new Date();
  const local = toZoned(nowUTC, tz);
  const daysUntilSat = (6 - local.getDay() + 7) % 7; // 6 = Saturday
  const saturdayUTC = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate()+daysUntilSat, 12, 0, 0));
  const sunsetUTC = getSunset(saturdayUTC, lat, lon);
  const localSunset = toZoned(sunsetUTC, tz);
  const meetLocal = new Date(localSunset.getTime() - 60*60*1000);
  return { meetLocal, hhmm: fmtHHMM(meetLocal) };
}

function shouldSendNow(tz, schedule, lastSentMs, nowUTC){
  const local = toZoned(nowUTC, tz);
  const [dayStr, hm] = schedule.split(' ');
  const [hh, mm] = hm.split(':').map(Number);
  const target = DOW[dayStr];
  const nowMin = local.getDay()*1440 + local.getHours()*60 + local.getMinutes();
  const schedMin = target*1440 + hh*60 + mm;
  let diff = nowMin - schedMin; if (diff < 0) diff += 7*1440;
  const WINDOW = 15; // мин.
  const antiDup = !lastSentMs || (Date.now() - lastSentMs) > 12*60*60*1000; // 12 часов
  return diff < WINDOW && antiDup;
}

// ── Рендер PNG (1080x1350) с Manrope + PT Sans
function renderCard({ hhmm, tzText = 'Europe/Moscow', place = 'Ставропольский край' }){
  const W = 1080, H = 1350;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // фон — мягкий градиент
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0f172a'); // slate-900
  g.addColorStop(1, '#1e293b'); // slate-800
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // карточка
  const pad = 56, r = 36;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  roundRect(ctx, pad, pad, W-2*pad, H-2*pad, r); ctx.fill();

  // заголовок (Manrope Bold)
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = '700 64px "Manrope"';
  ctx.textAlign = 'center';
  ctx.fillText('Доброе утро', W/2, pad+130);

  // подзаголовок (PT Sans Regular)
  ctx.font = '400 36px "PT Sans"';
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fillText('Встреча субботы (за час до заката)', W/2, pad+190);

  // крупное время (Manrope Bold)
  ctx.font = '700 200px "Manrope"';
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillText(hhmm, W/2, H/2+40);

  // нижняя строка (PT Sans Regular)
  ctx.font = '400 36px "PT Sans"';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText(`${place} • ${tzText}`, W/2, H - pad - 60);

  return canvas.toBuffer('image/png');
}
function roundRect(ctx, x,y,w,h,r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

// ── отправка фото (БЕЗ caption)
async function sendPhoto(chat_id, pngBuffer){
  const form = new FormData();
  const file = new Blob([pngBuffer], { type: 'image/png' });
  form.append('chat_id', chat_id);
  form.append('photo', file, 'meeting.png'); // без подписи

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  if (!res.ok) throw new Error(`sendPhoto ${res.status}`);
  return res.json();
}

(async ()=>{
  const nowUTC = new Date();
  for (const rule of channels){
    const uid = `${rule.chat_id}::${rule.tz}::${rule.schedule}`;
    const last = cache[uid] ? Number(cache[uid]) : 0;
    if (!shouldSendNow(rule.tz, rule.schedule, last, nowUTC)) continue;

    const { hhmm } = buildSaturdayMinus1(rule.tz, rule.lat, rule.lon);
    const png = renderCard({
      hhmm,
      tzText: rule.tz || 'Europe/Moscow',
      place: rule.place || 'Ставропольский край'
    });

    try{
      await sendPhoto(rule.chat_id, png);
      console.log('Photo sent to', rule.chat_id, hhmm);
      cache[uid] = String(Date.now());
    }catch(e){
      console.error('Send error', rule.chat_id, e.message);
    }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
})();
