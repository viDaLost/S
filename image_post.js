// image_post.js — PNG с тёплым бежем и «шоколадным» текстом, БЕЗ подписи
// Требует: BOT_TOKEN (secret), channels.json, шрифты в assets/fonts/

import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, registerFont } from 'canvas';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('No BOT_TOKEN'); process.exit(1); }

const ROOT = process.cwd();
const channels = JSON.parse(fs.readFileSync(path.join(ROOT, 'channels.json'), 'utf8'));

// Шрифты (КИРИЛЛИЦА)
registerFont(path.join(ROOT, 'assets/fonts/Manrope-Regular.ttf'), { family: 'Manrope', weight: '400' });
registerFont(path.join(ROOT, 'assets/fonts/Manrope-Bold.ttf'),    { family: 'Manrope', weight: '700' });
registerFont(path.join(ROOT, 'assets/fonts/PTSans-Regular.ttf'),  { family: 'PT Sans', weight: '400' });
registerFont(path.join(ROOT, 'assets/fonts/PTSans-Bold.ttf'),     { family: 'PT Sans', weight: '700' });

// ──────────────────────────────────────────────────────────────────────────
// Астрономия: закат (UTC)
const PI = Math.PI, rad = PI/180;
function toJulian(date){ return date/86400000 - 0.5 + 2440587.5; }
function fromJulian(j){ return new Date((j + 0.5 - 2440587.5)*86400000); }
function solarMeanAnomaly(d){ return rad * (357.5291 + 0.98560028*d); }
function eclipticLongitude(M){
  const C = rad*(1.9148*Math.sin(M) + 0.02*Math.sin(2*M) + 0.0003*Math.sin(3*M));
  const P = rad*102.9372; return M + C + P + PI;
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
  return fromJulian(Jset); // sunset in UTC
}

// ──────────────────────────────────────────────────────────────────────────
// Работа строго в заданном TZ (без локали раннера)

// Короткое имя дня недели в TZ (англоязычное «Sun..Sat»)
const WEEK = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function weekdayIdxUTC(dateUTC, tz){
  const short = new Intl.DateTimeFormat('en-US',{ timeZone: tz, weekday:'short' }).format(dateUTC); // "Sat"
  return WEEK.indexOf(short);
}

// Ближайшая суббота (полдень UTC) относительно nowUTC с точки зрения TZ
function nextSaturdayNoonUTC(nowUTC, tz){
  let d = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate(), 12, 0, 0));
  while (weekdayIdxUTC(d, tz) !== 6) d = new Date(d.getTime() + 86400000);
  return d;
}

// HH:MM строки в TZ для любой UTC-даты
function hhmmInTZ(dateUTC, tz){
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(dateUTC);
  const h = parts.find(p=>p.type==='hour').value;
  const m = parts.find(p=>p.type==='minute').value;
  return `${h}:${m}`;
}

// Закат субботы − 60 мин → HH:MM в TZ
function sunsetMinus1HHMM(tz, lat, lon){
  const nowUTC = new Date();
  const saturdayUTC = nextSaturdayNoonUTC(nowUTC, tz);
  const sunsetUTC = getSunset(saturdayUTC, lat, lon);
  const minus1UTC  = new Date(sunsetUTC.getTime() - 60*60000); // вычитаем час В UTC
  return hhmmInTZ(minus1UTC, tz); // форматируем прямо в TZ
}

// ──────────────────────────────────────────────────────────────────────────
// Расписание: сравниваем ТОЛЬКО в TZ (окно 15 минут)
const DOW = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };
function shouldSendNow(tz, schedule, lastSentMs, nowUTC){
  const [dayStr, hm] = schedule.split(' ');
  const [th, tm] = hm.split(':').map(Number);
  const target = DOW[dayStr];

  const idx = weekdayIdxUTC(nowUTC, tz);
  const parts = new Intl.DateTimeFormat('ru-RU',{
    timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(nowUTC);
  const nowH = +parts.find(p=>p.type==='hour').value;
  const nowM = +parts.find(p=>p.type==='minute').value;

  const nowMin = idx*1440 + nowH*60 + nowM;
  const schedMin = target*1440 + th*60 + tm;

  let diff = nowMin - schedMin;
  if (diff < 0) diff += 7*1440;

  const WINDOW = 15; // мин.
  const antiDup = !lastSentMs || (Date.now() - lastSentMs) > 12*60*60*1000;
  return diff < WINDOW && antiDup;
}

// ──────────────────────────────────────────────────────────────────────────
// Рендер (тёплый бежевый фон, шоколадный текст), без нижней подписи
function renderCard({ hhmm }){
  const W = 1080, H = 1350;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Тёплый бежевый градиент
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#F5EFE6'); // светлый беж
  g.addColorStop(1, '#EADCCF'); // чуть темнее
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // Мягкая карточка
  const pad = 56, r = 36;
  ctx.fillStyle = 'rgba(255,255,255,0.60)';
  roundRect(ctx, pad, pad, W-2*pad, H-2*pad, r); ctx.fill();

  // Цвета «шоколад»
  const choc = '#4A2E1A';    // основной
  const chocSoft = '#6B3F23'; // дополнительный

  // Заголовок
  ctx.fillStyle = choc;
  ctx.font = '700 64px "Manrope"';
  ctx.textAlign = 'center';
  ctx.fillText('Доброе утро', W/2, pad+130);

  // Подзаголовок
  ctx.font = '400 36px "PT Sans"';
  ctx.fillStyle = chocSoft;
  ctx.fillText('Встреча субботы в:', W/2, pad+190);

  // Большое время
  ctx.font = '700 200px "Manrope"';
  ctx.fillStyle = choc;
  ctx.fillText(hhmm, W/2, H/2+40);

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

// Отправка фото БЕЗ caption
async function sendPhoto(chat_id, pngBuffer){
  const form = new FormData();
  const file = new Blob([pngBuffer], { type: 'image/png' });
  form.append('chat_id', chat_id);
  form.append('photo', file, 'meeting.png');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method:'POST', body: form });
  if (!res.ok) throw new Error(`sendPhoto ${res.status}`);
  return res.json();
}

// ──────────────────────────────────────────────────────────────────────────
// Антидубль
const CACHE_FILE = path.join(ROOT, '.cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }

(async ()=>{
  const nowUTC = new Date();
  for (const rule of channels){
    const tz = rule.tz || 'Europe/Moscow';
    const uid = `${rule.chat_id}::${tz}::${rule.schedule}`;
    const last = cache[uid] ? Number(cache[uid]) : 0;

    if (!shouldSendNow(tz, rule.schedule, last, nowUTC)) continue;

    const hhmm = sunsetMinus1HHMM(tz, rule.lat, rule.lon);
    const png = renderCard({ hhmm });

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
