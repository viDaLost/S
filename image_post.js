// image_post.js — генерирует PNG-карточку (кириллица) и отправляет как фото БЕЗ подписи
// BOT_TOKEN — GitHub Secret; нужны: channels.json и шрифты в assets/fonts/

import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, registerFont } from 'canvas';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('No BOT_TOKEN'); process.exit(1); }

const ROOT = process.cwd();
const channels = JSON.parse(fs.readFileSync(path.join(ROOT, 'channels.json'), 'utf8'));

// Шрифты: Manrope (заголовок/время), PT Sans (подзаголовок)
registerFont(path.join(ROOT, 'assets/fonts/Manrope-Regular.ttf'), { family: 'Manrope', weight: '400' });
registerFont(path.join(ROOT, 'assets/fonts/Manrope-Bold.ttf'),    { family: 'Manrope', weight: '700' });
registerFont(path.join(ROOT, 'assets/fonts/PTSans-Regular.ttf'),  { family: 'PT Sans', weight: '400' });
registerFont(path.join(ROOT, 'assets/fonts/PTSans-Bold.ttf'),     { family: 'PT Sans', weight: '700' });

// Антидубль
const CACHE_FILE = path.join(ROOT, '.cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }

// ── Астрономия: вычисление времени заката (UTC)
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
  return fromJulian(Jset); // === закат в UTC (Date)
}

// ── Вспомогательные: работаем с ЛОКАЛЬНЫМ временем ЧЕРЕЗ Intl (без лишних Date-конвертаций)
function localParts(dateUTC, tz){
  // Возвращаем объект {year, month, day, hour, minute, second} в указанном TZ
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, hour12: false,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  }).formatToParts(dateUTC);
  const get = t => parts.find(p => p.type === t).value;
  return {
    year: +get('year'),
    month: +get('month'),
    day: +get('day'),
    hour: +get('hour'),
    minute: +get('minute'),
    second: +get('second')
  };
}
function hhmmMinus60FromUTC(dateUTC, tz){
  // Возьмём локальные ЧАС и МИНУТЫ для dateUTC, отнимем 60 минут, вернём строку HH:MM.
  const p = localParts(dateUTC, tz);
  let total = p.hour * 60 + p.minute - 60;
  total = (total % (24*60) + (24*60)) % (24*60); // нормализуем в 0..1439
  const hh = String(Math.floor(total/60)).padStart(2,'0');
  const mm = String(total % 60).padStart(2,'0');
  return `${hh}:${mm}`;
}

const DOW = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };
function shouldSendNow(tz, schedule, lastSentMs, nowUTC){
  const nowP = localParts(nowUTC, tz);
  const [dayStr, hm] = schedule.split(' ');
  const [th, tm] = hm.split(':').map(Number);
  const target = DOW[dayStr];
  const nowMin = nowP.hour*60 + nowP.minute + nowP.day*0; // только время; день сравним через getDay
  // Для стабильности используем прежнюю логику по дням:
  const localDate = new Date(`${nowP.year}-${String(nowP.month).padStart(2,'0')}-${String(nowP.day).padStart(2,'0')}T${String(nowP.hour).padStart(2,'0')}:${String(nowP.minute).padStart(2,'0')}:00`);
  const localDay = localDate.getDay(); // 0..6 в локали агента, но нам важен только порядок
  const schedMin = th*60 + tm;
  let diffMin = (localDay === target) ? (nowMin - schedMin) : ((localDay + 7 - target)%7)*1440 + (nowMin - schedMin);
  if (diffMin < 0) diffMin += 7*1440;
  const WINDOW = 15;
  const antiDup = !lastSentMs || (Date.now() - lastSentMs) > 12*60*60*1000;
  return diffMin < WINDOW && antiDup;
}

// ── Генерация изображения (тёплый бежевый фон, шоколадный текст)
function renderCard({ hhmm }){
  const W = 1080, H = 1350;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Тёплый бежевый градиент
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#F5EFE6'); // светлый бежевый
  g.addColorStop(1, '#EADCCF'); // чуть темнее
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // «карточка» чуть темнее бежевого
  const pad = 56, r = 36;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  roundRect(ctx, pad, pad, W-2*pad, H-2*pad, r); ctx.fill();

  // Цвета «шоколад»
  const choc = '#4A2E1A';        // тёмный шоколад для времени/заголовка
  const chocSoft = '#6B3F23';     // мягкий шоколад для подзаголовка

  // Заголовок
  ctx.fillStyle = choc;
  ctx.font = '700 64px "Manrope"';
  ctx.textAlign = 'center';
  ctx.fillText('Доброе утро', W/2, pad+130);

  // Подзаголовок
  ctx.font = '400 36px "PT Sans"';
  ctx.fillStyle = chocSoft;
  ctx.fillText('Встреча субботы (за час до заката)', W/2, pad+190);

  // Большое время
  ctx.font = '700 200px "Manrope"';
  ctx.fillStyle = choc;
  ctx.fillText(hhmm, W/2, H/2+40);

  // без нижней подписи
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

async function sendPhoto(chat_id, pngBuffer){
  const form = new FormData();
  const file = new Blob([pngBuffer], { type: 'image/png' });
  form.append('chat_id', chat_id);
  form.append('photo', file, 'meeting.png'); // без caption
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method:'POST', body: form });
  if (!res.ok) throw new Error(`sendPhoto ${res.status}`);
  return res.json();
}

(async ()=>{
  const nowUTC = new Date();
  for (const rule of channels){
    const uid = `${rule.chat_id}::${rule.tz}::${rule.schedule}`;
    const last = cache[uid] ? Number(cache[uid]) : 0;
    if (!shouldSendNow(rule.tz, rule.schedule, last, nowUTC)) continue;

    // Считаем закат субботы (UTC) и получаем локальное HH:MM минус 60 минут
    const localNowParts = localParts(nowUTC, rule.tz);
    const daysUntilSat = (6 - new Date(`${localNowParts.year}-${String(localNowParts.month).padStart(2,'0')}-${String(localNowParts.day).padStart(2,'0')}T00:00:00`).getDay() + 7) % 7;
    const saturdayUTC = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate()+daysUntilSat, 12, 0, 0));
    const sunsetUTC = getSunset(saturdayUTC, rule.lat, rule.lon);

    const hhmm = hhmmMinus60FromUTC(sunsetUTC, rule.tz);
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
