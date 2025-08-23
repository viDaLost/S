// image_post.js — PNG (тёплый беж, шоколадный текст), БЕЗ подписи
// Надёжная конвертация времени для Europe/Moscow (UTC+3) без Intl.

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

// ── Астрономия: закат (UTC)
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

// ── Жёсткая карта смещений (минуты) — пока нужна только Москва
const FIXED_OFFSETS_MIN = {
  'Europe/Moscow': 180, // UTC+3, круглый год
};

// HH:MM для UTC-даты в TZ с фиксированным смещением
function hhmmFixedTZ(dateUTC, tz){
  const offset = FIXED_OFFSETS_MIN[tz];
  if (offset == null) {
    // запасной вариант: если когда-то появится другой TZ — покажем UTC
    const hh = String(dateUTC.getUTCHours()).padStart(2,'0');
    const mm = String(dateUTC.getUTCMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }
  const ms = dateUTC.getTime() + offset*60*1000;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2,'0');   // используем UTC-поля после сдвига
  const mm = String(d.getUTCMinutes()).padStart(2,'0'); // чтобы не зависеть от локали раннера
  return `${hh}:${mm}`;
}

// Закат субботы − 60 минут → HH:MM в Europe/Moscow
function sunsetMinus1HHMM_MSK(lat, lon){
  const nowUTC = new Date();

  // найдём ближайшую субботу с точки зрения Москвы: просто берём нынешний день UTC
  // и прибавляем нужное число дней до субботы. Из-за фикс. UTC+3 этого достаточно.
  const dowUTC = nowUTC.getUTCDay();         // 0..6
  const daysUntilSat = (6 - dowUTC + 7) % 7; // суббота относительно UTC
  const saturdayUTC = new Date(Date.UTC(
    nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate() + daysUntilSat, 12, 0, 0
  ));

  const sunsetUTC = getSunset(saturdayUTC, lat, lon);
  const minus1UTC = new Date(sunsetUTC.getTime() - 60*60000);
  return hhmmFixedTZ(minus1UTC, 'Europe/Moscow');
}

// ── Расписание: окно 15 минут (в Москве)
const DOW = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };
function shouldSendNow_MSK(schedule, lastSentMs){
  const now = new Date(); // работаем от UTC, но сравнение будем делать в "виртуальной Москве"
  const offsetMin = FIXED_OFFSETS_MIN['Europe/Moscow'];
  const ms = now.getTime() + offsetMin*60*1000;
  const d = new Date(ms);
  const localDay = d.getUTCDay();
  const hh = d.getUTCHours(), mm = d.getUTCMinutes();

  const [dayStr, hm] = schedule.split(' ');
  const [th, tm] = hm.split(':').map(Number);
  const target = DOW[dayStr];

  const nowMin = localDay*1440 + hh*60 + mm;
  const schedMin = target*1440 + th*60 + tm;
  let diff = nowMin - schedMin;
  if (diff < 0) diff += 7*1440;

  const WINDOW = 15;
  const antiDup = !lastSentMs || (Date.now() - lastSentMs) > 12*60*60*1000;
  return diff < WINDOW && antiDup;
}

// ── Рендер (тёплый беж, шоколад), без нижней подписи
function renderCard({ hhmm }){
  const W = 1080, H = 1350;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // тёплый бежевый градиент
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#F5EFE6');
  g.addColorStop(1, '#EADCCF');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // мягкая карточка
  const pad = 56, r = 36;
  ctx.fillStyle = 'rgba(255,255,255,0.60)';
  roundRect(ctx, pad, pad, W-2*pad, H-2*pad, r); ctx.fill();

  const choc = '#4A2E1A';
  const chocSoft = '#6B3F23';

  ctx.fillStyle = choc;
  ctx.font = '700 64px "Manrope"';
  ctx.textAlign = 'center';
  ctx.fillText('Доброе утро', W/2, pad+130);

  ctx.font = '400 36px "PT Sans"';
  ctx.fillStyle = chocSoft;
  ctx.fillText('Встреча субботы (за час до заката)', W/2, pad+190);

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

// отправка фото БЕЗ caption
async function sendPhoto(chat_id, pngBuffer){
  const form = new FormData();
  const file = new Blob([pngBuffer], { type: 'image/png' });
  form.append('chat_id', chat_id);
  form.append('photo', file, 'meeting.png');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method:'POST', body: form });
  if (!res.ok) throw new Error(`sendPhoto ${res.status}`);
  return res.json();
}

// ── Антидубль (кэш)
const CACHE_FILE = path.join(ROOT, '.cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }

(async ()=>{
  const nowUTC = new Date();
  for (const rule of channels){
    // мы поддерживаем пока только Europe/Moscow (ваш случай)
    const tz = (rule.tz || 'Europe/Moscow');

    const uid = `${rule.chat_id}::${tz}::${rule.schedule}`;
    const last = cache[uid] ? Number(cache[uid]) : 0;

    // сравнение времени — тоже в MSK
    if (tz !== 'Europe/Moscow' || !shouldSendNow_MSK(rule.schedule, last)) continue;

    const hhmm = sunsetMinus1HHMM_MSK(rule.lat, rule.lon);
    const png = renderCard({ hhmm });

    try {
      await sendPhoto(rule.chat_id, png);
      console.log('Photo sent to', rule.chat_id, hhmm);
      cache[uid] = String(Date.now());
    } catch(e) {
      console.error('Send error', rule.chat_id, e.message);
    }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
})();
