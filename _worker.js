// Cloudflare Pages 单文件 Worker（RedFoxHub 版）
// 小红书已封锁数据中心 IP 的匿名抓取，解析改走 RedFoxHub API
// 需要环境变量 REDFOX_API_KEY（去 redfox.hk 注册，控制台「API密钥」创建，填到 Pages → Settings → Environment variables）
// 人机验证：TURNSTILE_SITE_KEY（公开）+ TURNSTILE_SECRET_KEY（保密），各站共用同一套；配了 secret 才校验解析和反馈
// 部署：本文件放仓库根目录（与 index.html 同级）

/* ================= 公共 ================= */
// 附件类型白名单：浏览器传上来的 type 可被伪造，image/svg+xml 这类能带脚本的类型一律拒收
const SAFE_ATTACH_TYPE = /^(image\/(png|jpe?g|pjpeg|gif|webp|heic|heif|avif|bmp)|video\/[a-z0-9.+-]+)$/i;

/* ================= 安全辅助（Round 2）：IP 归一 / CORS 白名单 / 管理员 Cookie 登录 / 跳转逐跳校验 ================= */
// 限流用的 IP 键：IPv4 原样；IPv6 归一到 /64（同一用户通常独占一个 /64，换后 64 位就能拿新配额）
function ipLimitKey(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  let s = ip.split('%')[0];
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4 && /^::(ffff:)?[\d.]+$/.test(s)) return v4[1]; // IPv4-mapped，按 IPv4 算
  if (v4) s = s.slice(0, -v4[1].length) + '0:0';
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  let parts = head;
  if (halves.length > 1) {
    const tail = halves[1] ? halves[1].split(':') : [];
    parts = head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  }
  parts = parts.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16));
  while (parts.length < 4) parts.push('0');
  return parts.join(':') + '::/64';
}
// ================= 原子频控（D1 rate_counter，和微博站共用同一张表） =================
// 冷却 60 秒 + 每 IP（IPv6 按 /64）每天（北京时间）20 次。解析之前用一条 UPSERT 原子地「判断 + 占坑」：
//   并发一批请求只有第一个能占到坑；失败的解析也算一次（不能拿坏链接无限刷上游接口）。
// D1 出错 / 超过 2 秒：直接拒绝（503「服务繁忙，请稍后再试」），不再退回 KV。
// 缺少 PARSE_DB 同样拒绝；本地测试需提供 D1，预览不再回退 KV。
const RL_COOLDOWN_SECS = 60;
const RL_DAILY_LIMIT = 20;
const RL_TIMEOUT_MS = 2000;
function rlDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function rlWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
const RL_BUSY = { ok: false, status: 503, msg: '服务繁忙，请稍后再试' };
function rlDeny(now, last, used, limit = RL_DAILY_LIMIT, cooldownSecs = RL_COOLDOWN_SECS) {
  if (cooldownSecs > 0 && last && now - last < cooldownSecs * 1000) {
    const wait = Math.ceil((cooldownSecs * 1000 - (now - last)) / 1000);
    return { ok: false, status: 429, msg: '解析太频繁，请 ' + wait + ' 秒后再试' };
  }
  if (used >= limit) return { ok: false, status: 429, msg: '今日解析次数已用完（' + limit + ' 次），明天再来吧' };
  return null;
}
async function rateTake(env, site, rawIp, limit = RL_DAILY_LIMIT, cooldownSecs = RL_COOLDOWN_SECS) {
  const ip = ipLimitKey(rawIp);
  if (!ip) return RL_BUSY;
  const now = Date.now();
  const k = site + ':' + ip + ':' + rlDate();
  const db = env && env.PARSE_DB;
  if (db && typeof db.prepare === 'function') {
    try {
      const got = await rlWithTimeout(db.prepare(
        'INSERT INTO rate_counter (k, n, last, exp) VALUES (?, 1, ?, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1, last = excluded.last ' +
        'WHERE rate_counter.last <= ? AND rate_counter.n < ? RETURNING n'
      ).bind(k, now, now + 2 * 86400000, now - cooldownSecs * 1000, limit).first(), RL_TIMEOUT_MS);
      if (got) return { ok: true };
      const cur = await rlWithTimeout(db.prepare('SELECT n, last FROM rate_counter WHERE k = ?').bind(k).first(), RL_TIMEOUT_MS);
      return rlDeny(now, Number(cur && cur.last) || 0, Number(cur && cur.n) || 0, limit, cooldownSecs) || { ok: false, status: 429, msg: '解析太频繁，请稍后再试' };
    } catch (e) { return RL_BUSY; } // D1 挂了 / 超时：拒绝，不退回 KV
  }
  return RL_BUSY; // Missing D1 is a configuration failure, including public previews.
}
async function rateUsed(env, site, rawIp) {
  const ip = ipLimitKey(rawIp);
  if (!ip) return null;
  const db = env && env.PARSE_DB;
  if (db && typeof db.prepare === 'function') {
    try {
      const cur = await rlWithTimeout(db.prepare('SELECT n FROM rate_counter WHERE k = ?').bind(site + ':' + ip + ':' + rlDate()).first(), RL_TIMEOUT_MS);
      return Number(cur && cur.n) || 0;
    } catch {}
  }
  return null; // Unknown quota must not look like a fresh allowance.
}
// 人机验证 fail-closed：没配 TURNSTILE_SECRET_KEY 就拒绝解析，除非明确设了 TURNSTILE_DISABLED=1
function turnstileDisabled(env) {
  return /^(1|true|yes|on)$/i.test(String((env && env.TURNSTILE_DISABLED) || '').trim());
}
// ================= 原子频控 end =================

function clientIpKey(request) {
  return ipLimitKey(request.headers.get('cf-connecting-ip') || '');
}

// CORS：只给本站来源回显 Origin（同源、站点 pages.dev 域名及其预览子域、环境变量 ALLOWED_ORIGINS 里的自定义域名）
const SITE_ORIGINS = ["https://xiaohongshuqushuiyin.pages.dev"];
function originAllowed(origin, request, env) {
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (origin === new URL(request.url).origin) return true;
  const extra = String((env && env.ALLOWED_ORIGINS) || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (SITE_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  return o.protocol === 'https:' && SITE_ORIGINS.some((s) => o.hostname.endsWith('.' + new URL(s).hostname));
}
function applyCors(request, env, resp) {
  if (!resp || !new URL(request.url).pathname.startsWith('/api/')) return resp;
  const origin = request.headers.get('Origin') || '';
  const r = new Response(resp.body, resp);
  r.headers.delete('Access-Control-Allow-Origin');
  if (originAllowed(origin, request, env)) r.headers.set('Access-Control-Allow-Origin', origin);
  r.headers.append('Vary', 'Origin');
  return r;
}

// 代理抓取：手动跟随跳转（最多 maxHops 次），每一跳都只允许 https + 白名单域名，否则返回 null
async function fetchAllowedHops(url, init, isAllowed, maxHops = 5) {
  let cur = String(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    let u;
    try { u = new URL(cur); } catch { return null; }
    if (u.protocol !== 'https:' || !isAllowed(u.hostname)) return null;
    const resp = await fetch(u.toString(), { ...init, redirect: 'manual' });
    const loc = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && loc) {
      try { if (resp.body) await resp.body.cancel(); } catch {}
      try { cur = new URL(loc, u).toString(); } catch { return null; }
      continue;
    }
    return resp;
  }
  return null;
}

// 管理员登录：POST /api/admin/login 校验 FEEDBACK_ADMIN_KEY 后下发 HttpOnly Cookie（HMAC 签名，12 小时有效）；
// 管理接口不再接受地址栏 ?key=，也不接受 Authorization: Bearer（没有任何调用方，且绕过了输错锁定），只认登录后下发的 Cookie。
const ADMIN_COOKIE = 'jx_admin';
const ADMIN_SESSION_SECS = 12 * 3600;
const ADMIN_FAIL_MAX = 10; // 同一 IP（IPv6 /64）15 分钟内最多输错 10 次
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
async function adminSig(secret, exp) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('jx-admin|' + exp)));
  let s = '';
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function adminCookieValue(request) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === ADMIN_COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}
async function isAdmin(request, env) {
  const secret = String((env && env.FEEDBACK_ADMIN_KEY) || '');
  if (!secret) return false;
  const m = adminCookieValue(request).match(/^(\d{9,11})\.([A-Za-z0-9_-]{20,})$/);
  if (!m || Number(m[1]) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(m[2], await adminSig(secret, m[1]));
}
async function adminSetCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECS;
  return ADMIN_COOKIE + '=' + exp + '.' + (await adminSig(String(env.FEEDBACK_ADMIN_KEY), exp)) +
    '; Path=/; Max-Age=' + ADMIN_SESSION_SECS + '; HttpOnly; Secure; SameSite=Strict';
}
function adminClearCookie() {
  return ADMIN_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}
// 校验登录密码（带失败次数限制）：返回 { ok } 或 { ok:false, status, error }
async function adminCheckPassword(request, env, key) {
  const secret = String((env && env.FEEDBACK_ADMIN_KEY) || '');
  if (!secret) return { ok: false, status: 500, error: '未配置管理密码 FEEDBACK_ADMIN_KEY' };
  const kv = env.FEEDBACK_KV;
  const ipk = clientIpKey(request);
  // 失败计数按站点分开：一个站被锁不影响其他站（所有站共用一个 KV）
  const fk = 'admfail_' + new URL(request.url).hostname + '_' + ipk;
  let fails = 0;
  if (kv && ipk) {
    try { fails = Number((await kv.get(fk)) || 0); } catch {}
    if (fails >= ADMIN_FAIL_MAX) return { ok: false, status: 429, error: '密码错误次数过多，请 15 分钟后再试' };
  }
  if (!safeEqual(String(key || ''), secret)) {
    if (kv && ipk) { try { await kv.put(fk, String(fails + 1), { expirationTtl: 900 }); } catch {} }
    return { ok: false, status: 403, error: '密码错误' };
  }
  return { ok: true };
}
// 同源判断：有 Sec-Fetch-Site 就必须是 same-origin；有 Origin 就必须等于本站（脚本 / curl 两个头都没有时放行，靠 JSON 限制挡表单）
function adminSameOrigin(request) {
  const sfs = request.headers.get('Sec-Fetch-Site');
  if (sfs && sfs !== 'same-origin') return false;
  const o = request.headers.get('Origin');
  if (o && o !== new URL(request.url).origin) return false;
  return true;
}
function adminJson(data, status, cookie) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (cookie) h.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}
async function handleAdminLogin(request, env) {
  if (request.method !== 'POST') return adminJson({ ok: false, error: '方法不支持' }, 405);
  // 只收 JSON（跨站表单发不了 application/json），并拒绝跨站来源：防止别的网页替管理员乱输密码把 IP 锁住
  const ct = request.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) return adminJson({ ok: false, error: '请求格式错误' }, 415);
  if (!adminSameOrigin(request)) return adminJson({ ok: false, error: '禁止跨站登录' }, 403);
  let key = '';
  try { key = String(((await request.json()) || {}).key || ''); } catch {}
  const r = await adminCheckPassword(request, env, key);
  if (!r.ok) return adminJson({ ok: false, error: r.error }, r.status);
  return adminJson({ ok: true }, 200, await adminSetCookie(env));
}
function handleAdminLogout(request) {
  if (request.method !== 'POST') return adminJson({ ok: false, error: '方法不支持' }, 405);
  return adminJson({ ok: true }, 200, adminClearCookie());
}
const ADMIN_PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const ADMIN_LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理登录</title>
<style>body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#0f0f13;color:#f1f1f3;display:flex;min-height:100vh;align-items:center;justify-content:center}
form{background:#1a1a21;border-radius:16px;padding:24px 20px;width:min(320px,90vw)}h1{font-size:18px;margin:0 0 14px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2a2a34;background:#0f0f13;color:#f1f1f3;font-size:15px}
button{margin-top:12px;width:100%;padding:12px;border:none;border-radius:10px;background:#FE2C55;color:#fff;font-size:15px}
#err{color:#ff8ba0;font-size:13px;min-height:18px;margin-top:8px}</style></head>
<body><form id="f"><h1>管理后台登录</h1><input type="password" id="k" autocomplete="current-password" placeholder="管理密码" required>
<button type="submit">登录</button><div id="err"></div></form>
<script>
(function(){
  var q = new URLSearchParams(location.search).get('err');
  var M = { wrong: '密码错误', locked: '密码错误次数过多，请 15 分钟后再试', nokey: '本站未配置管理密码', cross: '请直接打开本站后台再登录' };
  if (q) document.getElementById('err').textContent = M[q] || '登录失败';
})();
document.getElementById('f').onsubmit = async function(e){
  e.preventDefault();
  var err = document.getElementById('err'); err.textContent = '';
  try {
    var r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: document.getElementById('k').value }), credentials: 'same-origin' });
    var j = await r.json();
    if (j.ok) location.replace(location.pathname); else err.textContent = j.error || '登录失败';
  } catch (x) { err.textContent = '网络错误'; }
};
<\/script></body></html>`;
// /admin、/dashboard：已登录给页面；未登录给登录页。旧书签 ?key=密码 仍可用一次：校验通过换成 Cookie 并跳转去掉地址栏里的密码
async function serveAdminPage(request, env, html) {
  const url = new URL(request.url);
  const legacy = url.searchParams.get('key');
  if (legacy !== null) {
    // 跨站带过来的 ?key= 不校验（不计失败次数），防止别的网页替管理员乱试把 IP 锁住
    let err = '';
    let cookie = '';
    if ((request.headers.get('Sec-Fetch-Site') || '') === 'cross-site') err = 'cross';
    else {
      const r = await adminCheckPassword(request, env, legacy);
      if (r.ok) cookie = await adminSetCookie(env);
      else err = r.status === 429 ? 'locked' : r.status === 500 ? 'nokey' : 'wrong';
    }
    const h = new Headers({ Location: url.pathname + (err ? '?err=' + err : ''), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (cookie) h.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers: h });
  }
  if (!(await isAdmin(request, env))) return new Response(ADMIN_LOGIN_HTML, { status: 401, headers: ADMIN_PAGE_HEADERS });
  return new Response(html, { headers: ADMIN_PAGE_HEADERS });
}
/* ================= 安全辅助结束 ================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const REDFOX_BASE = 'https://redfox.hk';

// Cloudflare Turnstile 人机验证：配了 TURNSTILE_SECRET_KEY 才校验（不配 = 跳过，向后兼容）
async function verifyTurnstile(token, secret, ip) {
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
    });
    const j = await resp.json();
    return j && j.success === true;
  } catch {
    return false;
  }
}
async function turnstileGate(env, token, ip) {
  const secret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) return turnstileDisabled(env) ? null : json({ ok: false, error: '人机验证未配置，暂停解析' }, 503);
  if (!token) return json({ ok: false, error: '请先完成人机验证' }, 400);
  if (!(await verifyTurnstile(token, secret, ip))) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  return null;
}

// 域名判断：host 等于某个域名，或以「.域名」结尾
function hostMatches(host, list) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  return list.some((d) => host === d || host.endsWith('.' + d));
}
// 页面/短链域名（只用于识别输入和跟随跳转，不用于下载代理）。xhslink.cn 是 App 现在复制出来的新短链域名
const XHS_PAGE_HOSTS = ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'rednote.com'];
const XHS_MEDIA_HOSTS = ['xhscdn.com', 'xiaohongshu.com'];

// 没写 https:// 的裸链接（如 xhslink.cn/o/abc）：取文字里第一个像域名的片段补上 https://，
// 之后照样走 hostMatches 白名单校验，冒充域名（xhslink.cn.evil.example、evilxhslink.cn）还是会被拒。
// 链接只收 RFC3986 子集字符，遇到空白、汉字、全角标点就停，避免「xhslink.cn/o/abc打开」把「打开」吃进网址
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'*+,;=%]";
function findBareUrl(text) {
  const m = String(text || '').match(new RegExp('(?:^|[^\\w.@/=:-])((?:[a-z0-9-]+\\.)+[a-z]{2,})(?![\\w.-])([/?#]' + URL_CHARS + '*)?', 'i'));
  return m ? 'https://' + m[1] + (m[2] || '') : null;
}
function extractFirstUrl(text) {
  const hit = String(text || '').match(new RegExp('https?://' + URL_CHARS + '+', 'i'));
  const raw = hit ? hit[0] : findBareUrl(text);
  if (!raw) throw new Error('没有找到有效的小红书链接，请粘贴完整的分享链接');
  const u = raw.replace(/[),.;!?\]}>»」』】，。；：？！）】]+$/, '');
  let h = '';
  try { h = new URL(u).hostname; } catch {}
  if (!hostMatches(h, XHS_PAGE_HOSTS)) throw new Error('只支持小红书链接（xiaohongshu.com / xhslink.cn / xhslink.com）');
  return u;
}
function normalizeUrl(u) {
  return String(u || '')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}
function ensureHttps(u) {
  return u.startsWith('http://') ? 'https://' + u.slice(7) : u;
}
function cleanTitle(t, fallback) {
  return (
    String(t || fallback || 'xhs')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || fallback || 'xhs'
  );
}
function isVideoUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (/\.(?:mp4|m3u8)$/i.test(url.pathname)) return true;
    // 小红书的视频 CDN 也会返回不带文件扩展名的 spectrum / stream 地址。
    return /^sns-video-[a-z0-9-]+\.xhscdn\.com$/i.test(url.hostname) &&
      /^\/(?:spectrum|stream)\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}
// WebP CDN 链接 -> ci.xiaohongshu.com 无损 PNG
function convertToPng(webpUrl) {
  const m = String(webpUrl || '').match(/https?:\/\/[^/]*xhscdn\.com\/\d+\/[0-9a-z]+\/(\S+?)!/);
  if (m) return `https://ci.xiaohongshu.com/${m[1]}?imageView2/format/png`;
  return null;
}
// 递归收集对象中所有 URL 字符串（防御式提取，应对返回结构变化）
function deepFindUrls(obj, out = [], seenObjs = new Set()) {
  if (!obj || out.length > 200) return out;
  if (typeof obj === 'string') {
    let s = obj.trim();
    if (/^\/\//.test(s)) s = 'https:' + s; // 协议相对 URL
    if (/^https?:\/\/[^\s"'<>\\]+$/i.test(s)) out.push(s);
    return out;
  }
  if (typeof obj !== 'object' || seenObjs.has(obj)) return out;
  seenObjs.add(obj);
  const arr = Array.isArray(obj) ? obj : Object.values(obj);
  for (const v of arr) deepFindUrls(v, out, seenObjs);
  return out;
}

/* ================= RedFoxHub ================= */
// 鉴权：请求头 REDFOX_API_KEY；成功码 code=2000；data 为业务数据
async function redfoxPost(path, apiKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(REDFOX_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        REDFOX_API_KEY: apiKey,
        'User-Agent': UA_PC,
        Accept: 'application/json',
      },
      body: JSON.stringify({ ...body, source: 'xhs-dl-pages' }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error('RedFoxHub 返回了非 JSON 数据（HTTP ' + resp.status + '）');
    }
    if (resp.status === 401)
      throw new Error('RedFoxHub API Key 无效，请检查环境变量 REDFOX_API_KEY 是否正确');
    if (resp.status === 429) throw new Error('请求太频繁，请稍后重试');
    const code = j.code;
    const msg = String(j.msg || j.message || '');
    if (code && code !== 2000) {
      if (code === 401 || code === 4001)
        throw new Error('RedFoxHub 鉴权失败：' + msg);
      if (/余额|balance|insufficient|欠费/i.test(msg))
        throw new Error('RedFoxHub 余额不足，请前往 redfox.hk 控制台充值后再试');
      throw new Error('RedFoxHub：' + (msg || 'code=' + code));
    }
    if (!resp.ok) throw new Error('RedFoxHub 请求失败（HTTP ' + resp.status + '）' + (msg ? '：' + msg : ''));
    return j.data !== undefined ? j.data : j;
  } finally {
    clearTimeout(timer);
  }
}

// 预览封面（allfeedback「解析记录」卡片 + 前端历史记录）：上游给了封面字段就用，没有返回空串
function pickCover(data) {
  if (!data || typeof data !== 'object') return '';
  for (const k of ['cover', 'coverUrl', 'cover_url', 'image_cover', 'thumbnail']) {
    const u = pickImageUrl(data[k]);
    if (typeof u === 'string' && u) {
      const h = ensureHttps(normalizeUrl(u));
      if (/^https:\/\//i.test(h)) return h;
    }
  }
  return '';
}
function pickImageUrl(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return null;
  if (Array.isArray(item.url_list) && item.url_list.length) return pickImageUrl(item.url_list[0]);
  if (Array.isArray(item.urls) && item.urls.length) return pickImageUrl(item.urls[0]);
  return (
    item.url ||
    item.url_default ||
    item.image_url ||
    item.download_url ||
    item.downloadUrl ||
    item.origin_url ||
    item.src ||
    item.link ||
    null
  );
}

function extractImages(data) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (typeof u !== 'string' || !u) return;
    const h = ensureHttps(normalizeUrl(u));
    if (!/^https?:\/\//i.test(h) || isVideoUrl(h) || seen.has(h)) return;
    seen.add(h);
    out.push({ url_webp: h, url_png: convertToPng(h) || h, width: null, height: null });
  };
  for (const key of [
    'images_list',
    'image_list',
    'imageList',
    'images',
    'pic_list',
    'resources',
    'resource',
    'medias',
    'media_list',
  ]) {
    const list = data[key];
    if (Array.isArray(list)) for (const item of list) push(pickImageUrl(item));
  }
  if (!out.length) {
    // 兜底：深搜图片 CDN 链接
    for (const u of deepFindUrls(data)) {
      if (
        !isVideoUrl(u) &&
        !/(avatar|watermark)/i.test(u) &&
        (/xhscdn\.com/i.test(u) ||
          /sns-webpic|sns-img/i.test(u) ||
          /xiaohongshu\.com\/[^"'\s]*\.(jpe?g|png|webp|gif)/i.test(u) ||
          /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u))
      )
        push(u);
    }
  }
  return out;
}

function extractVideoUrl(data) {
  const candidates = [];
  const push = (u) => {
    if (typeof u !== 'string' || !u) return;
    const h = ensureHttps(normalizeUrl(u));
    if (isVideoUrl(h) && !candidates.includes(h)) candidates.push(h);
  };
  // 结构化字段优先
  push(data.video_url);
  push(data.videoUrl);
  push(data.download_url);
  push(data.downloadUrl);
  push(data.url);
  push(data.video?.url);
  push(data.video_info?.url);
  push(data.media?.video_url);
  push(data.video?.play_url);
  // 兜底：深搜 mp4 链接
  for (const u of deepFindUrls(data)) push(u);
  if (!candidates.length) return null;
  // 打分：https 优先，含 wm/watermark 的降权
  const scored = candidates.map((u) => {
    let s = 0;
    if (u.startsWith('https://')) s += 10;
    if (/(wm|watermark)/i.test(u)) s -= 40;
    return [u, s];
  });
  scored.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  return scored[0][0];
}

// 从笔记 URL 提取 24 位 noteId（路径优先，宽松匹配兜底）
function extractNoteId(url) {
  const s = String(url || '');
  let m = s.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i);
  if (m) return m[1];
  m = s.match(/(^|[^0-9a-f])([0-9a-f]{24})([^0-9a-f]|$)/i);
  return m ? m[2] : null;
}

// 跟随跳转，并在每一跳里找 noteId（找到就停，不走到登录页）
async function resolveNoteId(shareText) {
  let url = extractFirstUrl(shareText);
  let noteId = extractNoteId(url);
  for (let i = 0; i < 5 && !noteId; i++) {
    let r;
    try {
      r = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA_PC, Referer: 'https://www.xiaohongshu.com/' },
      });
    } catch {
      break;
    }
    const loc = r.headers.get('location');
    if (!loc || r.status < 300 || r.status >= 400) break;
    const next = new URL(loc, url);
    if (!hostMatches(next.hostname, XHS_PAGE_HOSTS)) break; // 跳出小红书域名就停，不再跟
    url = next.href;
    noteId = extractNoteId(url);
  }
  return { noteId, noteUrl: url };
}

async function parseShareViaRedFox(shareText, apiKey, debug) {
  const originalUrl = extractFirstUrl(shareText); // 先校验链接有效性，避免无效输入浪费计费调用
  const errors = [];
  const dbg = [];
  const shortU = (u) => {
    try {
      const x = new URL(u);
      return x.hostname + x.pathname.slice(0, 44);
    } catch {
      return String(u).slice(0, 60);
    }
  };
  const tryDownload = async (label, url) => {
    let data;
    try {
      data = await redfoxPost('/story/api/parseWork/videoDownload/xhs', apiKey, { url });
    } catch (e) {
      if (debug) dbg.push({ url: shortU(url), fail: String(e.message).slice(0, 140) });
      throw e;
    }
    if (debug) {
      // debug：只输出结构（键名/类型/域名），不输出完整媒体地址
      const shape = (v, d) => {
        if (d > 2) return typeof v;
        if (Array.isArray(v))
          return { arr: v.length, first: v.length ? shape(v[0], d + 1) : null };
        if (v && typeof v === 'object') {
          const o = {};
          for (const k of Object.keys(v).slice(0, 12)) o[k] = shape(v[k], d + 1);
          return o;
        }
        if (typeof v === 'string') {
          if (/^https?:\/\//i.test(v)) {
            try {
              return 'url:' + new URL(v).hostname;
            } catch {
              return 'url:?';
            }
          }
          return `str(${v.length})`;
        }
        return typeof v;
      };
      dbg.push({ url: shortU(url), ok2000: true, shape: shape(data, 0) });
    }
    const title = cleanTitle(data.title || data.desc, 'xhs_note');
    const desc = String(data.desc || data.content || data.title || '');
    const vurl = extractVideoUrl(data);
    if (vurl)
      return { type: 'video', note_id: extractNoteId(url) || '', title, desc, cover: pickCover(data), video_url: vurl };
    const images = extractImages(data);
    if (images.length)
      return { type: 'image', note_id: extractNoteId(url) || '', title, desc, cover: pickCover(data), images };
    throw new Error(label + '未返回媒体地址');
  };
  const isBillable = (e) => /API Key|鉴权|余额|频繁/.test(e.message);

  // 先免费拿 noteId 和完整跳转 URL（只看跳转第一跳，不走到登录页；完整 URL 自带 xsec_token）
  let noteId = extractNoteId(originalUrl);
  let fullUrl = noteId ? originalUrl : null;
  if (!noteId) {
    try {
      const r = await resolveNoteId(shareText);
      noteId = r.noteId;
      fullUrl = r.noteUrl;
    } catch {
      /* ignore */
    }
  }

  // 路线一：小红书专用下载接口。优先带 xsec_token 的完整链接（RedFox 要求的格式），
  // 其次原始短链（RedFox 自己解析跳转），最后无 token 的标准链接
  const urls = [];
  // 把第一跳 URL 里的 xsec_token 提出来，拼成 RedFox 示例中的标准格式
  // https://www.xiaohongshu.com/explore/{id}?xsec_token=xxx&xsec_source=pc_feed
  if (fullUrl && noteId) {
    try {
      const token = new URL(fullUrl).searchParams.get('xsec_token');
      if (token) {
        urls.push(
          `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_feed`
        );
      }
    } catch {
      /* ignore */
    }
  }
  if (fullUrl && !urls.includes(fullUrl)) urls.push(fullUrl);
  if (!urls.includes(originalUrl)) urls.push(originalUrl);
  if (noteId) {
    const canon = `https://www.xiaohongshu.com/explore/${noteId}`;
    if (!urls.includes(canon)) urls.push(canon);
  }
  for (const u of urls) {
    try {
      return await tryDownload('', u);
    } catch (e) {
      if (isBillable(e)) throw e; // 鉴权/余额/限流直接抛，不再浪费调用
      errors.push('下载接口：' + e.message);
    }
  }

  // 路线二：笔记详情接口（优质库）
  if (noteId) {
    try {
      const data = await redfoxPost('/story/api/xhsUser/queryWorkDetail', apiKey, { workId: noteId });
      const title = cleanTitle(data.title || data.desc, 'xhs_' + noteId);
      const desc = String(data.desc || data.content || data.title || '');
      const vurl = extractVideoUrl(data);
      if (vurl) return { type: 'video', note_id: noteId, title, desc, cover: pickCover(data), video_url: vurl };
      const images = extractImages(data);
      if (images.length) return { type: 'image', note_id: noteId, title, desc, cover: pickCover(data), images };
      errors.push('笔记详情未返回媒体地址');
    } catch (e) {
      if (isBillable(e)) throw e;
      errors.push('笔记详情：' + e.message);
    }
  } else {
    errors.push('未能从链接中识别笔记 ID');
  }

  throw Object.assign(
    new Error(errors.join('；') || '解析失败（笔记可能已删除或设为私密）'),
    debug ? { debug: dbg } : {}
  );
}

async function handleParse(request, env) {
  try {
    const apiKey = (env.REDFOX_API_KEY || '').trim();
    if (!apiKey) {
      return json(
        {
          ok: false,
          error:
            '未配置 RedFoxHub API Key：请去 redfox.hk 注册并在控制台「API密钥」创建一个 key，然后在 Cloudflare Pages → Settings → Environment variables 添加 REDFOX_API_KEY（重新部署后生效）',
        },
        500
      );
    }
    const reqUrl = new URL(request.url);
    let shareText = reqUrl.searchParams.get('url') || '';
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        shareText = body.url || body.link || shareText;
      } catch {
        /* ignore */
      }
    }
    if (!shareText.trim()) return json({ ok: false, error: '请先粘贴小红书分享链接' }, 400);
    // 链接不是小红书域名：直接 400，不调计费接口
    try { extractFirstUrl(shareText); } catch (e) { return json({ ok: false, error: e.message }, 400); }
    // debug 输出上游数据结构，只给带管理口令的请求
    const debug = reqUrl.searchParams.get('debug') === '1' && (await isAdmin(request, env));
    const parseIp = request.headers.get('cf-connecting-ip') || '';
    // 解析接口人机验证（配了 TURNSTILE_SECRET_KEY 才生效）
    const tsDeny = await turnstileGate(env, reqUrl.searchParams.get('turnstile') || '', parseIp);
    if (tsDeny) return tsDeny;
  // 频控：冷却 60 秒 + 每 IP 每天 20 次。解析前原子占坑（D1），并发打不穿，失败也算一次
  const deviceId = new URL(request.url).searchParams.get('deviceId') || '';
  const rl = await rateTake(env, 'xhs', parseIp);
  if (!rl.ok) return json({ ok: false, error: rl.msg }, rl.status);

    plPass(request); // 人机验证 + 冷却 + 每日次数都过了：这次解析才记进 D1 parse_log
    const result = await parseShareViaRedFox(shareText, apiKey, debug);
    // 预览卡片（allfeedback「解析记录」）：封面（没有就用第一张图）/ 标题（文件名兜底 xhs_… 时改用正文）/ 类型
    {
      const imgs = Array.isArray(result.images) ? result.images : [];
      const img0 = imgs[0] && (imgs[0].url_webp || imgs[0].url_png);
      plMeta(request, {
        cover: result.cover || img0 || '',
        title: /^xhs(_note|_[0-9a-f]{24})?$/i.test(result.title || '') ? result.desc : result.title,
        media: result.type === 'image' ? (imgs.length > 1 ? 'images' : 'image') : 'video',
      });
    }
    // 本站解析次数统计（仅成功计数）
    if (env.FEEDBACK_KV) {
      try {
        const cur = Number((await env.FEEDBACK_KV.get('stats_parse_xhs')) || 0);
        await env.FEEDBACK_KV.put('stats_parse_xhs', String(cur + 1));
      } catch {}
    }
    // 解析者归属地分布（按站点+国家聚合）
    if (env.FEEDBACK_KV) {
      try {
        const cf = request.cf || {};
        const cc = String(cf.country || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX';
        const gk = 'geoparse_xhs_' + cc;
        const gc = Number((await env.FEEDBACK_KV.get(gk)) || 0);
        await env.FEEDBACK_KV.put(gk, String(gc + 1));
      } catch {}
    }
    // 最近解析记录（每站保留最近 20 条）
    if (env.FEEDBACK_KV) {
      try {
        const cf2 = request.cf || {};
        const hk = 'parsehist_xhs';
        let hist = [];
        try { hist = JSON.parse((await env.FEEDBACK_KV.get(hk)) || '[]'); } catch {}
        if (!Array.isArray(hist)) hist = [];
        hist.unshift({
          t: Date.now(),
          ip: parseIp,
          dev: deviceId || '',
          cc: String(cf2.country || 'XX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX',
          region: cf2.region || '',
          city: cf2.city || '',
        });
        await env.FEEDBACK_KV.put(hk, JSON.stringify(hist.slice(0, 20)));
      } catch {}
    }
    return json({ ok: true, ...result });
  } catch (e) {
    const out = { ok: false, error: e.message || '解析失败，请稍后重试' };
    if (e.debug) out.debug = e.debug;
    return json(out);
  }
}

/* ================= /api/media（代理下载，未变） ================= */
async function handleMedia(request) {
  const u = new URL(request.url);
  const target = u.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) return new Response('missing url', { status: 400 });
  let host = '';
  try {
    host = new URL(target).hostname;
  } catch {
    return new Response('bad url', { status: 400 });
  }
  if (!/^https?:$/.test(new URL(target).protocol) || !hostMatches(host, XHS_MEDIA_HOSTS)) return new Response('host not allowed', { status: 403 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    // 手动跟随跳转，每一跳都重新校验域名（以前 redirect:'follow' 只校验第一跳）
    let cur = target;
    let resp = null;
    for (let i = 0; i < 4; i++) {
      resp = await fetch(cur, {
        headers: { 'User-Agent': UA_PC, Referer: 'https://www.xiaohongshu.com/', Accept: '*/*', ...(request.headers.get('range') ? { Range: request.headers.get('range') } : {}) },
        redirect: 'manual',
        signal: ctrl.signal,
      });
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const next = new URL(loc, cur);
        if (!/^https?:$/.test(next.protocol) || !hostMatches(next.hostname, XHS_MEDIA_HOSTS))
          return new Response('host not allowed', { status: 403 });
        cur = next.toString();
        continue;
      }
      break;
    }
    if (!resp || !(resp.ok || resp.status === 206) || !resp.body) return new Response(`upstream ${resp ? resp.status : 0}`, { status: 502 });
    // 只转发必要的响应头（不再原样转发 set-cookie 等）
    const headers = new Headers();
    for (const k of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'last-modified', 'etag'])
      if (resp.headers.get(k)) headers.set(k, resp.headers.get(k));
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(resp.body, { status: resp.status === 206 ? 206 : 200, headers });
  } catch {
    return new Response('proxy error', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

/* ================= /api/diag（未变） ================= */
async function handleDiag(request, env) {
  const u = new URL(request.url);
  // 只给管理员用，并且只抓小红书自家域名（以前任何人可以让它抓任意网址）
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '无权访问' }, 403);
  const target = u.searchParams.get('url') || 'https://www.xiaohongshu.com/';
  let th = '';
  try {
    const t = new URL(target);
    if (t.protocol !== 'https:') throw new Error();
    th = t.hostname;
  } catch {
    return json({ ok: false, error: '链接无效' }, 400);
  }
  if (!hostMatches(th, XHS_PAGE_HOSTS)) return json({ ok: false, error: '只能诊断小红书域名' }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': UA_PC,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.xiaohongshu.com/',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await resp.text();
    return json({
      ok: true,
      status: resp.status,
      finalUrl: resp.url,
      htmlLen: text.length,
      hasInitialState: text.includes('__INITIAL_STATE__'),
      hint: text.includes('__INITIAL_STATE__')
        ? '页面数据正常，解析链路可用'
        : '未拿到页面数据，可能被小红书风控拦截',
    });
  } catch (e) {
    return json({ ok: false, error: String(e) });
  } finally {
    clearTimeout(timer);
  }
}

/* ================= 反馈系统（KV 存储 + 管理后台） ================= */
// 需要：Pages → Settings → Bindings 添加 KV 命名空间，变量名 FEEDBACK_KV；
// 环境变量 FEEDBACK_ADMIN_KEY 设为你的管理密码。
// 提交：POST /api/feedback {message, contact?, page?}
// 查看：GET /admin?key=你的管理密码

// 反馈字段长度：message 只算用户自己写的；问题类型 kind、当前输入 link 单独存
const FB_MSG_MAX = 2000;
const FB_LEGACY_MAX = 3000; // 兼容旧前端把类型和链接拼进 message
const FB_KIND_MAX = 20;
const FB_LINK_MAX = 800;
const FB_FILE_MAX = 20 * 1024 * 1024;
// page 只收 http/https 地址，其他（javascript: 等）直接丢掉
function fbSafePage(p) {
  p = String(p || '').trim().slice(0, 200);
  try {
    const u = new URL(p);
    return u.protocol === 'https:' || u.protocol === 'http:' ? p : '';
  } catch {
    return '';
  }
}
async function handleFeedbackSubmit(request, env) {
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '反馈功能暂未启用' }, 500);
  const ct = request.headers.get('content-type') || '';
  let message = '',
    contact = '',
    page = '',
    kind = '',
    link = '',
    tsToken = '',
    files = [];
  const pick = (get) => {
    message = String(get('message') || '').trim();
    contact = String(get('contact') || '').trim().slice(0, 120);
    page = String(get('page') || '');
    kind = String(get('kind') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, FB_KIND_MAX);
    link = String(get('link') || '').trim().slice(0, FB_LINK_MAX);
  };
  if (ct.includes('multipart/form-data')) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    pick((k) => form.get(k));
    tsToken = String(form.get('cf-turnstile-response') || '');
    files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size > 0);
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    if (!body || typeof body !== 'object') return json({ ok: false, error: '请求格式错误' }, 400);
    pick((k) => body[k]);
    tsToken = String(body['cf-turnstile-response'] || body.tsToken || '');
  }
  page = fbSafePage(page);
  if (!message && kind) message = '（未写具体描述）';
  if (!message) return json({ ok: false, error: '请填写反馈内容' }, 400);
  // 2000 字只算用户自己写的内容；旧前端会把问题类型和链接拼进 message，没带 kind/link 时放宽到 3000
  const msgMax = kind || link ? FB_MSG_MAX : FB_LEGACY_MAX;
  if (message.length > msgMax) return json({ ok: false, error: '内容太长，请精简到 2000 字以内' }, 400);
  // 附件先全部校验（数量 / 类型 / 大小），一个不合格就整单拒绝，不会先传一半
  if (files.length > 3) return json({ ok: false, error: '最多上传 3 个附件' }, 400);
  for (const f of files) {
    if (!SAFE_ATTACH_TYPE.test(f.type || '')) return json({ ok: false, error: '只支持图片和视频附件' }, 400);
    if (f.size > FB_FILE_MAX) return json({ ok: false, error: '单个附件不能超过 20MB' }, 400);
  }

  const tsSecret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (tsSecret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    const tsOk = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip') || '');
    if (!tsOk) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  const COOLDOWN_SECS = 600;
  const clientIp = request.headers.get('cf-connecting-ip') || '';
  const coolKey = clientIp ? 'cool_xhs_' + ipLimitKey(clientIp) : '';
  if (coolKey) {
    let lastTs = null;
    try { lastTs = await env.FEEDBACK_KV.get(coolKey); } catch {} // KV 读失败不挡用户
    if (lastTs) {
      const remain = COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
      if (remain > 0)
        return json(
          { ok: false, error: `提交太频繁，请 ${Math.max(1, Math.ceil(remain / 60))} 分钟后再试` },
          429
        );
    }
  }

  const id = 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const attachments = [];
  const uploaded = [];
  // 任何一步存储失败：把这次已经传上去的附件删掉，返回 JSON 错误（不再抛异常变成 Cloudflare 错误页）
  const cleanup = async () => {
    for (const k of uploaded) {
      try { await env.FEEDBACK_BUCKET.delete(k); } catch {}
    }
  };
  const storageFail = () => json({ ok: false, code: 'STORAGE_FAILED', error: '存储失败，请稍后重试' }, 500);
  if (files.length) {
    if (!env.FEEDBACK_BUCKET) return json({ ok: false, error: '附件功能暂未启用' }, 500);
    try {
      for (const f of files) {
        const type = f.type || '';
        const ext =
          (String(f.name || '').split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) ||
          'bin';
        const key = `fb/${id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await env.FEEDBACK_BUCKET.put(key, f.stream(), {
          httpMetadata: { contentType: type },
        });
        uploaded.push(key);
        attachments.push({ key, type, name: String(f.name || '').slice(0, 80), size: f.size });
      }
    } catch {
      await cleanup();
      return storageFail();
    }
  }

  const record = {
    id,
    message: message.slice(0, msgMax),
    kind,
    link,
    contact,
    page,
    attachments,
    ua: (request.headers.get('user-agent') || '').slice(0, 200),
    ip: clientIp,
    geo: {
      country: (request.cf && request.cf.country) || '',
      region: (request.cf && request.cf.region) || '',
      city: (request.cf && request.cf.city) || '',
    },
    time: new Date().toISOString(),
  };
  try {
    await env.FEEDBACK_KV.put(id, JSON.stringify(record));
  } catch {
    await cleanup();
    return storageFail();
  }
  if (coolKey) {
    try {
      await env.FEEDBACK_KV.put(coolKey, String(Date.now()), { expirationTtl: COOLDOWN_SECS });
    } catch {}
  }
  return json({ ok: true });
}


async function handleFeedbackList(request, env) {
  const url = new URL(request.url);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const items = [];
  for (const prefix of ['fb_', 'feedback_']) {
    const listed = await env.FEEDBACK_KV.list({ prefix });
    for (const k of listed.keys) {
      try {
        const v = await env.FEEDBACK_KV.get(k.name);
        if (!v) continue;
        const it = JSON.parse(v);
        // 快手站旧版记录：key 是 feedback_<id>，时间字段叫 ts，没有 page
        if (prefix === 'feedback_') {
          if (!it.time && it.ts) it.time = new Date(Number(it.ts)).toISOString();
          if (!it.page || !/^https?:/.test(String(it.page))) it.page = 'https://kuaishoujiexi.pages.dev/';
          it.id = String(it.id || k.name.slice('feedback_'.length));
        }
        items.push(it);
      } catch {}
    }
  }
  items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return json({ ok: true, count: items.length, items });
}

async function handleFeedbackDelete(request, env) {
  const url = new URL(request.url);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const id = url.searchParams.get('id') || '';
  if (!/^fb_[a-z0-9_]+$/i.test(id)) return json({ ok: false, error: '参数错误' }, 400);
  // 先读记录，把附件从 R2 一并删掉
  try {
    const v = (await env.FEEDBACK_KV.get(id)) || (await env.FEEDBACK_KV.get('feedback_' + id));
    if (v) {
      const rec = JSON.parse(v);
      if (env.FEEDBACK_BUCKET && Array.isArray(rec.attachments)) {
        for (const a of rec.attachments) {
          try {
            await env.FEEDBACK_BUCKET.delete(a.key);
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  await env.FEEDBACK_KV.delete(id);
  await env.FEEDBACK_KV.delete('feedback_' + id); // 快手旧版记录
  return json({ ok: true });
}

// 管理后台查看附件（key 鉴权）：/api/fb-file/<key>?key=管理密码
async function handleFeedbackFile(request, env) {
  const url = new URL(request.url);
  if (!(await isAdmin(request, env))) return new Response('无权访问', { status: 403 });
  if (!env.FEEDBACK_BUCKET) return new Response('未绑定存储', { status: 500 });
  const m = url.pathname.match(/^\/api\/fb-file\/(.+)$/);
  const key = m ? decodeURIComponent(m[1]) : '';
  if (!key.startsWith('fb/') || key.includes('..')) return new Response('参数错误', { status: 400 });
  const obj = await env.FEEDBACK_BUCKET.get(key);
  if (!obj) return new Response('文件不存在', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // 附件是用户上传的：禁止嗅探、沙箱化；旧数据里不在白名单的类型（如 SVG）一律按附件下载，不在本站域名下渲染
  if (!SAFE_ATTACH_TYPE.test(headers.get('content-type') || '')) {
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>反馈管理</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f7f7f8;color:#222}
.wrap{max-width:640px;margin:0 auto;padding:16px 14px 60px}
h1{font-size:20px;margin:8px 0 4px}h1 span{font-size:13px;color:#888;font-weight:400}
.fb{background:#fff;border-radius:12px;padding:12px 14px;margin-top:12px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.fb .meta{font-size:12px;color:#999;margin-bottom:6px}
.fb .site{font-size:11px;color:#ff2442;font-weight:600}
.fb .msg{font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.fb button{margin-top:8px;background:#f0f0f2;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#c00}
.empty{text-align:center;color:#aaa;margin-top:40px;font-size:14px}
</style></head>
<body><div class="wrap">
<h1>用户反馈 <span id="count"></span></h1>
<div style="margin:6px 0 4px"><a href="/dashboard" id="dashLink" style="font-size:13px;color:#FE2C55">📊 数据总览</a></div>
 <a href="#" id="logoutLink" style="font-size:13px;color:#999;margin-left:10px">退出登录</a>
<script>document.getElementById('logoutLink').onclick = function(e){ e.preventDefault(); fetch('/api/admin/logout', { method: 'POST' }).then(function(){ location.reload(); }); };</script>
<div id="list">加载中…</div>
</div><script>
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const COUNTRY_ZH = {CN:'中国',US:'美国',JP:'日本',KR:'韩国',HK:'香港',TW:'台湾',MO:'澳门',SG:'新加坡',GB:'英国',DE:'德国',FR:'法国',IT:'意大利',ES:'西班牙',CA:'加拿大',AU:'澳大利亚',NZ:'新西兰',RU:'俄罗斯',IN:'印度',BR:'巴西',MX:'墨西哥',AR:'阿根廷',KR:'韩国',TH:'泰国',MY:'马来西亚',ID:'印度尼西亚',PH:'菲律宾',VN:'越南',TR:'土耳其',AE:'阿联酋',SA:'沙特',EG:'埃及',ZA:'南非',NL:'荷兰',SE:'瑞典',NO:'挪威',FI:'芬兰',DK:'丹麦',PL:'波兰',UA:'乌克兰',CH:'瑞士',AT:'奥地利',BE:'比利时',IE:'爱尔兰',PT:'葡萄牙',GR:'希腊',CZ:'捷克',HU:'匈牙利',RO:'罗马尼亚',IL:'以色列',KZ:'哈萨克斯坦'};
function geoName(it){
  const g = it.geo || {};
  if(!g.country && !g.region && !g.city) return '';
  const c = COUNTRY_ZH[g.country] || g.country || '';
  return [c, g.region, g.city].filter(Boolean).join('·');
}
const siteName = (p) => {
  try {
    const h = new URL(p).hostname.toLowerCase();
    if (h.includes('tiktok')) return 'TikTok站';
    if (h.includes('xiaohongshu')) return '小红书站';
    if (h.includes('douyin')) return '抖音站';
    if (h.includes('youtube')) return 'YouTube站';
    if (h.includes('bilibili')) return 'B站站';
    if (h.includes('kuaishou')) return '快手站';
    if (h.includes('weibo')) return '微博站';
    if (h.includes('deepseek')) return 'DeepSeek站';
    return h;
  } catch { return ''; }
};
async function load() {
  const box = document.getElementById('list');
  try {
    const r = await fetch('/api/feedback/list');
    const j = await r.json();
    if (!j.ok) { box.innerHTML = '<div class="empty">加载失败：' + esc(j.error) + '</div>'; return; }
    document.getElementById('count').textContent = '共 ' + j.count + ' 条';
    if (!j.items.length) { box.innerHTML = '<div class="empty">暂无反馈</div>'; return; }
    box.innerHTML = '';
    for (const it of j.items) {
      const d = document.createElement('div');
      d.className = 'fb';
      const t = new Date(it.time).toLocaleString('zh-CN', { hour12: false });
      d.innerHTML = '<div class="meta"><span class="site">[' + esc(siteName(it.page)) + ']</span> ' + esc(t) + (it.contact ? ' · ' + esc(it.contact) : '') + (it.ip ? ' · IP: ' + esc(it.ip) : '') + (geoName(it) ? ' (' + esc(geoName(it)) + ')' : '') + '</div>' +
        (it.kind ? '<div class="kind" style="font-size:12px;color:#ff8a00;margin-bottom:4px">【' + esc(it.kind) + '】</div>' : '') +
        '<div class="msg">' + esc(it.message) + '</div>' +
        (it.link ? '<div class="link" style="font-size:12px;color:#888;margin-top:6px;white-space:pre-wrap;word-break:break-all">当前输入：' + esc(it.link) + '</div>' : '');
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 复制文本';
      copyBtn.style.cssText = 'margin-top:8px;background:#f0f0f2;border:none;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;cursor:pointer';
      copyBtn.onclick = function(){
        const txt = it.message || '';
        const done = function(){ copyBtn.textContent = '✅ 已复制'; setTimeout(function(){ copyBtn.textContent = '📋 复制文本'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(function(){ alert('复制失败'); });
        } else { alert('当前浏览器不支持一键复制'); }
      };
      d.appendChild(copyBtn);
      if (it.attachments && it.attachments.length) {
        const att = document.createElement('div');
        for (const a of it.attachments) {
          const src = '/api/fb-file/' + encodeURIComponent(a.key);
          const fname = esc(String(a.name || 'attachment'));
          if (String(a.type || '').startsWith('image/')) {
            att.innerHTML += '<img src="' + src + '" style="max-width:100%;border-radius:8px;margin-top:8px;display:block" loading="lazy">';
          } else {
            att.innerHTML += '<video src="' + src + '" controls playsinline style="max-width:100%;border-radius:8px;margin-top:8px;display:block"></video>';
          }
          att.innerHTML += '<a href="' + src + '" download="' + fname + '" style="display:inline-block;margin-top:6px;background:#f0f0f2;border-radius:8px;padding:8px 16px;font-size:13px;color:#333;text-decoration:none">⬇ 下载</a>';
        }
        d.appendChild(att);
      }
      const btn = document.createElement('button');
      btn.textContent = '删除';
      btn.onclick = async () => {
        if (!confirm('删除这条反馈？')) return;
        let r = null, j = null;
        try { r = await fetch('/api/feedback?id=' + encodeURIComponent(it.id), { method: 'DELETE' }); j = await r.json().catch(() => null); } catch (e) {}
        if (r && (r.status === 401 || r.status === 403)) { alert('登录已过期，请重新登录'); location.href = '/admin'; return; }
        if (!r || !r.ok || !j || !j.ok) { alert('删除失败：' + ((j && j.error) || (r ? 'HTTP ' + r.status : '网络错误'))); return; }
        load();
      };
      d.appendChild(btn);
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = '<div class="empty">网络错误</div>'; }
}
load();
<\/script></body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>数据总览</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#0f0f13;color:#f1f1f3}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:10px 0 4px}h1 span{font-size:13px;color:#9a9aa3;font-weight:400}
.sub{font-size:13px;color:#9a9aa3;margin-bottom:16px}
h2{font-size:16px;margin:24px 0 12px;color:#f1f1f3}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:#1a1a21;border-radius:16px;padding:20px 16px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.35)}
.card .name{font-size:14px;color:#9a9aa3;margin-bottom:8px}
.card .num{font-size:36px;font-weight:800}
.card .unit{font-size:12px;color:#9a9aa3;margin-top:4px}
.total{margin-top:12px;background:linear-gradient(135deg,#FE2C55,#ff6b4a);border-radius:16px;padding:18px;text-align:center}
.total .num{font-size:32px;font-weight:800}
.total .label{font-size:13px;opacity:.85;margin-top:4px}
.panel{background:#1a1a21;border-radius:16px;padding:18px 16px;margin-top:12px;box-shadow:0 4px 20px rgba(0,0,0,.35)}
.pie-wrap{display:flex;align-items:center;gap:18px;justify-content:center;flex-wrap:wrap}
#pie{width:150px;height:150px;border-radius:50%;flex-shrink:0}
#geoPie{width:150px;height:150px;border-radius:50%;flex-shrink:0}
.legend{font-size:13px;line-height:2}
.legend .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.bar-row{margin-bottom:12px}
.bar-row .blabel{font-size:13px;margin-bottom:5px;display:flex;justify-content:space-between}
.bar-track{background:#2a2a34;border-radius:8px;height:22px;overflow:hidden}
.bar-fill{height:100%;border-radius:8px;transition:width .5s;min-width:2px}
.refresh{margin-top:16px;text-align:center}
.refresh button{background:#2a2a34;border:none;border-radius:12px;padding:12px 32px;font-size:14px;color:#f1f1f3;cursor:pointer}
.err{text-align:center;color:#ff8ba0;margin-top:20px;font-size:14px}
.links{margin-top:16px;text-align:center;font-size:13px}
.links a{color:#9a9aa3;margin:0 8px}
</style></head>
<body><div class="wrap">
<h1>📊 数据总览 <span id="time"></span></h1>
<div class="sub">各站解析次数统计（仅成功计数）</div>
<div class="grid" id="grid"><div class="err">加载中…</div></div>
<div class="total" id="total" style="display:none"><div class="num" id="totalNum">0</div><div class="label">累计解析</div></div>

<h2>🥧 占比</h2>
<div class="panel"><div class="pie-wrap">
<div id="pie"></div>
<div class="legend" id="pieLegend"></div>
</div></div>

<h2>📊 柱状对比</h2>
<div class="panel" id="barChart"></div>

<h2>🌍 解析者地区分布</h2>
<div class="panel"><div class="pie-wrap">
<div id="geoPie"></div>
<div class="legend" id="geoLegend"></div>
</div></div>
<div class="panel" id="geoBars" style="margin-top:12px"></div>

<h2>🕐 最近解析者</h2>
<div class="panel" id="histList"><div style="color:#9a9aa3;font-size:13px;text-align:center">加载中…</div></div>

<div class="refresh"><button onclick="load()">🔄 刷新</button></div>
<div class="links"><a href="/admin" id="adminLink">💬 反馈管理</a></div>
</div><script>
const COLORS = ['#FE2C55','#25F4EE','#FFC107','#9C27B0','#FF7A1A','#4CAF50'];
const COUNTRY_ZH = {CN:'中国',US:'美国',JP:'日本',KR:'韩国',HK:'香港',TW:'台湾',MO:'澳门',SG:'新加坡',GB:'英国',DE:'德国',FR:'法国',IT:'意大利',ES:'西班牙',CA:'加拿大',AU:'澳大利亚',NZ:'新西兰',RU:'俄罗斯',IN:'印度',BR:'巴西',MX:'墨西哥',TH:'泰国',MY:'马来西亚',ID:'印度尼西亚',PH:'菲律宾',VN:'越南',TR:'土耳其',AE:'阿联酋',XX:'未知'};
async function load(){
  const grid = document.getElementById('grid');
  try{
    const r = await fetch('/api/stats-all');
    const j = await r.json();
    if(!j.ok){ grid.innerHTML = '<div class="err">加载失败：' + (j.error || '未知错误') + '</div>'; return; }
    const sites = j.sites;
    grid.innerHTML = '';
    let sum = 0;
    sites.forEach(function(s, i){
      sum += s.count;
      const d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<div class="name">' + s.name + '</div><div class="num" style="color:' + COLORS[i % COLORS.length] + '">' + s.count + '</div><div class="unit">次解析</div>';
      grid.appendChild(d);
    });
    document.getElementById('totalNum').textContent = sum;
    document.getElementById('total').style.display = 'block';
    document.getElementById('time').textContent = new Date().toLocaleString('zh-CN', {hour12:false});
    renderPie(sites, sum);
    renderBars(sites);
    loadGeo();
    loadHistory();
  }catch(e){ grid.innerHTML = '<div class="err">网络错误</div>'; }
}
function escH(s){ return String(s || '').replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
async function loadHistory(){
  const box = document.getElementById('histList');
  try{
    const r = await fetch('/api/parse-history');
    const j = await r.json();
    if(!j.ok || !j.items || !j.items.length){ box.innerHTML = '<div style="color:#9a9aa3;font-size:13px;text-align:center">暂无数据（新解析才会记录）</div>'; return; }
    box.innerHTML = '';
    j.items.slice(0, 20).forEach(function(h){
      const geo = [COUNTRY_ZH[h.cc] || h.cc || '', h.region || '', h.city || ''].filter(Boolean).join('·');
      const time = new Date(h.t).toLocaleString('zh-CN', {hour12:false});
      const row = document.createElement('div');
      row.style.cssText = 'padding:10px 0;border-bottom:1px solid #2a2a34;line-height:1.8';
      const dev = h.dev ? escH(String(h.dev)) : '';
      row.innerHTML = '<div style="font-size:14px"><b>' + escH(h.ip || '未知IP') + '</b>' + (geo ? ' <span style="color:#9a9aa3;font-size:13px">(' + escH(geo) + ')</span>' : '') + '</div>' +
        '<div style="color:#9a9aa3;font-size:12px">' + escH(h.site) + ' · ' + escH(time) + '</div>' +
        (dev ? '<div style="color:#7a7a85;font-size:11px;word-break:break-all">设备ID: ' + dev + '</div>' : '');
      box.appendChild(row);
    });
  }catch(e){ box.innerHTML = '<div style="color:#9a9aa3;font-size:13px;text-align:center">加载失败</div>'; }
}
async function loadGeo(){
  try{
    const r = await fetch('/api/geo-stats');
    const j = await r.json();
    if(!j.ok) return;
    const byCountry = j.byCountry || {};
    const entries = Object.keys(byCountry).map(function(cc){ return {cc:cc, n:byCountry[cc]}; })
      .sort(function(a,b){ return b.n - a.n; });
    const sum = entries.reduce(function(a,e){ return a + e.n; }, 0);
    renderGeoPie(entries, sum);
    renderGeoBars(entries);
  }catch(e){}
}
function geoZh(cc){ return COUNTRY_ZH[cc] || cc; }
const GEO_COLORS = ['#FE2C55','#25F4EE','#FFC107','#9C27B0','#4CAF50','#FF9800','#03A9F4','#E91E63','#8BC34A','#FF5722'];
function renderGeoPie(entries, sum){
  const pie = document.getElementById('geoPie');
  const legend = document.getElementById('geoLegend');
  if(!sum){ pie.style.background = '#2a2a34'; legend.innerHTML = '<div style="color:#9a9aa3">暂无数据（新解析才会统计）</div>'; return; }
  let acc = 0, parts = [], html = '';
  entries.slice(0, 10).forEach(function(e, i){
    const pct = e.n / sum * 100;
    parts.push(GEO_COLORS[i % GEO_COLORS.length] + ' ' + acc + '% ' + (acc + pct) + '%');
    acc += pct;
    html += '<div><span class="dot" style="background:' + GEO_COLORS[i % GEO_COLORS.length] + '"></span>' + geoZh(e.cc) + ' ' + e.n + '次 (' + pct.toFixed(1) + '%)</div>';
  });
  pie.style.background = 'conic-gradient(' + parts.join(',') + ')';
  legend.innerHTML = html;
}
function renderGeoBars(entries){
  const box = document.getElementById('geoBars');
  if(!entries.length){ box.innerHTML = '<div style="color:#9a9aa3;font-size:13px;text-align:center">暂无数据</div>'; return; }
  const max = entries[0].n;
  box.innerHTML = '';
  entries.slice(0, 15).forEach(function(e, i){
    const w = Math.max(2, e.n / max * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = '<div class="blabel"><span>' + geoZh(e.cc) + '</span><span>' + e.n + '次</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + GEO_COLORS[i % GEO_COLORS.length] + '"></div></div>';
    box.appendChild(row);
  });
}
function renderPie(sites, sum){
  const pie = document.getElementById('pie');
  const legend = document.getElementById('pieLegend');
  if(!sum){ pie.style.background = '#2a2a34'; legend.innerHTML = '<div style="color:#9a9aa3">暂无数据</div>'; return; }
  let acc = 0, parts = [], html = '';
  sites.forEach(function(s, i){
    const pct = s.count / sum * 100;
    parts.push(COLORS[i % COLORS.length] + ' ' + acc + '% ' + (acc + pct) + '%');
    acc += pct;
    html += '<div><span class="dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' + s.name + ' ' + s.count + '次 (' + pct.toFixed(1) + '%)</div>';
  });
  pie.style.background = 'conic-gradient(' + parts.join(',') + ')';
  legend.innerHTML = html;
}
function renderBars(sites){
  const box = document.getElementById('barChart');
  const max = Math.max.apply(null, sites.map(function(s){ return s.count; }).concat([1]));
  box.innerHTML = '';
  sites.forEach(function(s, i){
    const w = Math.max(2, s.count / max * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = '<div class="blabel"><span>' + s.name + '</span><span>' + s.count + '次</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + COLORS[i % COLORS.length] + '"></div></div>';
    box.appendChild(row);
  });
}
load();
<\/script></body></html>`;



async function handleParseHistory(request, env) {
  const url = new URL(request.url);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '无权访问' }, 403);
  const siteNames = { tiktok: 'TikTok站', xhs: '小红书站', douyin: '抖音站', youtube: 'YouTube站', bilibili: 'B站站', kuaishou: '快手站' };
  const all = [];
  if (env.FEEDBACK_KV) {
    for (const site of Object.keys(siteNames)) {
      try {
        const raw = await env.FEEDBACK_KV.get('parsehist_' + site);
        const hist = raw ? JSON.parse(raw) : [];
        if (Array.isArray(hist)) for (const h of hist) all.push({ site: siteNames[site], ...h });
      } catch {}
    }
  }
  all.sort((a, b) => (b.t || 0) - (a.t || 0));
  return json({ ok: true, items: all.slice(0, 50) });
}

/* ================= 解析者归属地分布 ================= */
async function handleGeoStats(request, env) {
  const url = new URL(request.url);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '无权访问' }, 403);
  const byCountry = {};
  const bySite = { tiktok: {}, xhs: {}, douyin: {}, youtube: {}, bilibili: {}, kuaishou: {} };
  if (env.FEEDBACK_KV) {
    try {
      const listed = await env.FEEDBACK_KV.list({ prefix: 'geoparse_' });
      for (const k of listed.keys) {
        const m = k.name.match(/^geoparse_(tiktok|xhs|douyin|youtube|bilibili|kuaishou)_([A-Z]{2})$/);
        if (!m) continue;
        const n = Number((await env.FEEDBACK_KV.get(k.name)) || 0);
        if (!n) continue;
        const site = m[1], cc = m[2];
        byCountry[cc] = (byCountry[cc] || 0) + n;
        bySite[site][cc] = (bySite[site][cc] || 0) + n;
      }
    } catch {}
  }
  return json({ ok: true, byCountry, bySite });
}


/* ================= 每日解析配额 ================= */
async function handleParseQuota(request, env) {
  const DAILY_LIMIT = RL_DAILY_LIMIT;
  const used = await rateUsed(env, 'xhs', request.headers.get('cf-connecting-ip') || '');
  if (used === null) return json({ok:false,error:RL_BUSY.msg},503);
  return json({ ok: true, limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) });
}

/* ================= 数据总览 ================= */
async function handleStatsAll(request, env) {
  const url = new URL(request.url);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '无权访问' }, 403);
  const sites = [
    { key: 'stats_parse_tiktok', name: 'TikTok站' },
    { key: 'stats_parse_xhs', name: '小红书站' },
    { key: 'stats_parse_douyin', name: '抖音站' },
    { key: 'stats_parse_youtube', name: 'YouTube站' },
    { key: 'stats_parse_bilibili', name: 'B站站' },
    { key: 'stats_parse_kuaishou', name: '快手站' },
  ];
  const result = [];
  for (const s of sites) {
    let n = 0;
    if (env.FEEDBACK_KV) {
      try { n = Number((await env.FEEDBACK_KV.get(s.key)) || 0); } catch {}
    }
    result.push({ name: s.name, count: n });
  }
  return json({ ok: true, sites: result });
}

/* ================= 路由 ================= */
// ==== parse-log v3 BEGIN ====
// 解析记录 + 拉黑 + 预览信息（各解析站共用同一份代码：allfeedback/shared/parse-log.js 是原件，改动后用 shared/pf-sync.mjs 同步）
// 存储：D1 数据库 parse_log（绑定名 PARSE_DB），表 parse_log / blocklist，建表语句见 allfeedback/shared/parse_log.sql。
// - 每次解析记一行：时间、站点、链接（去掉令牌类参数）、成功与否、状态码、失败原因（里面的链接也去令牌）、IP、归属地（request.cf）、
//   设备 ID、设备指纹、UA。失败行（ok=0）同时就是 allfeedback「解析失败」的数据来源，所以接了本模块的站不再需要 pf-recorder。
// - 只在「人机验证 + 频控都通过之后」才记：站点在 handleParse 里过了这两关时调用 plPass(request)，没调用的请求一律不记
//   （没过人机验证的刷接口请求不会写 D1，不会把每天的免费写入额度刷光）。
// - 只记「有效链接」：站点传入的 valid(input) 返回 false（空输入 / 不是本站链接 / 链接格式不对）就不记。
// - 设备 ID：前端首次访问在 localStorage 生成的随机 UUID，放在请求头 X-Device-Id；格式不对就当没有。
// - 设备指纹：前端用 canvas 渲染、屏幕尺寸/色深、时区、语言、CPU 核数、平台、UA 算 SHA-256 取前 32 位十六进制，
//   放在请求头 X-Device-Fp；尽力而为，格式不对就当没有。同型号同浏览器的设备常常算出同一个指纹。
// - 拉黑：最先查 blocklist（IP / IPv6 /64 / 设备 ID / 指纹）；命中返回 403「访问受限」，不调上游。
//   名单在每个 isolate 里缓存 60 秒；过期后先用旧名单放行/拦截，同时在后台（waitUntil）刷新，不让用户干等。
//   只有刚启动、手里还没有名单时才等一次（最多 1.5 秒）。D1 没绑定 / 查询出错 / 超时一律放行（fail open）。
//   被拉黑的请求按命中的名单项每分钟最多记一行（换设备头也不会多写）。
// - 下载 / 媒体代理用 pl.guard(...) 包一层：只查黑名单，不记。
// - 写入全部在 waitUntil 里、最多等 10 秒、出错吞掉，不影响解析响应。保留 30 天：由微博 Worker 的每日定时任务分批删除。
// - 预览卡片（v3）：解析成功处调用 plMeta(request, { cover, title, media })，成功行一起存 cover / title / media 三列：
//   cover 只收 https 图片链接（// 开头补 https:，http: 升成 https:），超过 500 字丢弃；title 去控制字符、合并空白、≤120 字；
//   media 只收 video / image / images / mix / audio / live。三列由 shared/migrations/2026-11-19-preview.sql 加上；
//   迁移前写入会报「没有这一列」，此时退回旧列再写一次（本 isolate 10 分钟内直接写旧列），记录不会丢。
// - 开关：PARSE_LOG_OFF=1 时不写记录（黑名单照常检查）。
// - 预览部署（<分支或哈希>.<项目>.pages.dev）不提供解析：直接 403。确实要测，给预览环境加 PARSE_ON_PREVIEW=1。
const PL_BLOCK_TTL_MS = 60000;
const PL_BLOCK_RETRY_MS = 10000;
const PL_BLOCK_TIMEOUT_MS = 1500;
const PL_WRITE_TIMEOUT_MS = 10000;
const PL_RETENTION_MS = 30 * 86400 * 1000;
const PL_BLOCK_MSG = '访问受限';
const PL_FP_RE = /^[0-9a-f]{32}$/;
const PL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PL_KEEP_PARAMS = new Set(['v', 'p', 'id', 'vid', 'bvid', 'aid', 'aweme_id', 'modal_id', 'item_id', 'photoid', 'list', 'index']);
const PL_URL_RE = /https?:\/\/[^\s"'<>\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/gi;
const PL_PASSED = new WeakSet();
const PL_META = new WeakMap();
const PL_MEDIA = new Set(['video', 'image', 'images', 'mix', 'audio', 'live']);
const PL_NOCOL_RETRY_MS = 600000;
const PL_COLS = 'ts, site, url, ok, status, reason, ip, country, region, city, device_id, fp, ua';

// 站点在人机验证 + 频控都通过后调用：之后这次解析才会被记录
function plPass(request) {
  try { if (request && typeof request === 'object') PL_PASSED.add(request); } catch {}
}
// 去掉控制字符、零宽 / 方向控制符，合并空白
function plText(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}
// 预览信息白名单：{ cover, title, media }，不合格的字段给空串
function plCleanMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  let cover = typeof m.cover === 'string' ? plText(m.cover) : '';
  if (/^\/\//.test(cover)) cover = 'https:' + cover;
  else if (/^http:\/\//i.test(cover)) cover = 'https://' + cover.slice(7);
  if (cover) {
    try {
      const u = new URL(cover);
      cover = u.protocol === 'https:' && !u.username && !u.password && u.hostname ? u.toString() : '';
    } catch { cover = ''; }
  }
  if (cover.length > 500) cover = '';
  const title = Array.from(typeof m.title === 'string' || typeof m.title === 'number' ? plText(m.title) : '').slice(0, 120).join('');
  const media = String(m.media == null ? '' : m.media).trim().toLowerCase();
  return { cover, title, media: PL_MEDIA.has(media) ? media : '' };
}
// 站点在解析成功、拿到结果后调用：这次成功记录会带上封面 / 标题 / 类型。出错一律吞掉，不影响解析
function plMeta(request, meta) {
  try {
    if (!request || typeof request !== 'object') return;
    const m = plCleanMeta(meta);
    if (m.cover || m.title || m.media) PL_META.set(request, m);
  } catch {}
}
function plDevice(request) {
  const v = String(request.headers.get('x-device-id') || '').trim().toLowerCase();
  return PL_UUID_RE.test(v) ? v : '';
}
function plFp(request) {
  const v = String(request.headers.get('x-device-fp') || '').trim().toLowerCase();
  return PL_FP_RE.test(v) ? v : '';
}
function plIp(request) {
  return String(request.headers.get('cf-connecting-ip') || '').trim().toLowerCase().slice(0, 64);
}
// IPv6 按 /64 归一（同一用户的 IPv6 后半段经常变）；IPv4 原样
function plIp64(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  let s = ip.split('%')[0];
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4 && /^::(ffff:)?[\d.]+$/.test(s)) return v4[1];
  if (v4) s = s.slice(0, -v4[1].length) + '0:0';
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  let parts = head;
  if (halves.length > 1) {
    const tail = halves[1] ? halves[1].split(':') : [];
    parts = head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  }
  parts = parts.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16));
  while (parts.length < 4) parts.push('0');
  return parts.join(':') + '::/64';
}
function plCleanOne(raw) {
  raw = String(raw || '').replace(/[),.;!?\]}>»」』】，。；：？！）、]+$/, '');
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.username = '';
  u.password = '';
  u.hash = '';
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (PL_KEEP_PARAMS.has(k.toLowerCase()) && v.length <= 64) keep.append(k, v);
  const qs = keep.toString();
  u.search = qs ? '?' + qs : '';
  return u.toString().slice(0, 300);
}
function plCleanUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? plCleanOne(m[0]) : '';
}
// 失败原因里出现的链接也去掉令牌（上游报错经常把请求地址连同令牌一起带出来）
function plScrub(text, max) {
  const s = String(text == null ? '' : text).replace(PL_URL_RE, (m) => {
    const tail = (m.match(/[),.;!?\]}>»」』】，。；：？！）、]+$/) || [''])[0];
    return (plCleanOne(m) || '[链接]') + tail;
  });
  return s.replace(/\s+/g, ' ').trim().slice(0, max || 160);
}
async function plInput(request) {
  const u = new URL(request.url);
  let s = u.searchParams.get('url') || u.searchParams.get('text') || '';
  if (!s && request.method === 'POST' && Number(request.headers.get('content-length') || 0) <= 65536) {
    try {
      const b = await request.clone().json();
      if (b && typeof b === 'object') s = String(b.url || b.link || b.text || '');
    } catch {}
  }
  return String(s).slice(0, 2000);
}
function plFlag(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}
function plIsPreview(request, env) {
  if (env && plFlag(env.PARSE_ON_PREVIEW)) return false;
  let h = '';
  try { h = new URL(request.url).hostname.toLowerCase(); } catch { return false; }
  return /\.pages\.dev$/.test(h) && h.split('.').length > 3;
}
function plJson(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function plPreviewResponse() {
  const msg = '预览环境不提供解析，请到正式站使用';
  return plJson({ ok: false, code: -1, error: msg, msg }, 403);
}
function plWithTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
function createParseLog(site, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const valid = typeof opts.valid === 'function' ? opts.valid : null;
  const cache = { set: null, at: 0, pending: null };
  let noMetaAt = -Infinity; // 上次发现 parse_log 还没有 cover/title/media 列的时间（迁移前）
  const blockLogged = new Map(); // 命中的名单项 → 上次记录时间（每分钟最多记一行）

  function refresh(db) {
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      try {
        const r = await plWithTimeout(db.prepare('SELECT type, value FROM blocklist LIMIT 5000').all(), PL_BLOCK_TIMEOUT_MS);
        const set = new Set();
        for (const x of (r && r.results) || []) set.add(String(x.type) + ':' + String(x.value));
        cache.set = set;
        cache.at = now();
      } catch {
        // 读失败：放行，10 秒后再试；有旧名单就继续用旧的
        if (!cache.set) cache.set = new Set();
        cache.at = now() - PL_BLOCK_TTL_MS + PL_BLOCK_RETRY_MS;
      }
    })().finally(() => { cache.pending = null; });
    return cache.pending;
  }
  // 命中返回名单项（如 'ip:1.2.3.4'），没命中返回 ''
  async function blockedBy(env, ctx, ip, device, fp) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function') return '';
    if (!cache.set) await refresh(db); // 刚启动：等一次（最多 1.5 秒）
    else if (now() - cache.at >= PL_BLOCK_TTL_MS && !cache.pending) {
      const job = refresh(db); // 过期：先用旧名单，后台刷新
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    }
    const s = cache.set;
    if (!s || !s.size) return '';
    if (ip && s.has('ip:' + ip)) return 'ip:' + ip;
    if (ip && ip.includes(':') && s.has('ip:' + plIp64(ip))) return 'ip:' + plIp64(ip);
    if (device && s.has('device:' + device)) return 'device:' + device;
    if (fp && s.has('fp:' + fp)) return 'fp:' + fp;
    return '';
  }
  async function isBlocked(env, ip, device, fp, ctx) {
    try { return !!(await blockedBy(env, ctx, ip, device, fp)); } catch { return false; }
  }
  function write(env, ctx, row) {
    const db = env && env.PARSE_DB;
    if (!db || typeof db.prepare !== 'function' || plFlag(env.PARSE_LOG_OFF)) return null;
    const job = (async () => {
      try {
        const vals = [row.ts, site, row.url, row.ok ? 1 : 0, row.status, row.reason, row.ip, row.country, row.region, row.city, row.device, row.fp, row.ua];
        const meta = row.meta;
        const legacy = () => plWithTimeout(
          db.prepare('INSERT INTO parse_log (' + PL_COLS + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(...vals).run(), PL_WRITE_TIMEOUT_MS);
        if (!meta || !(meta.cover || meta.title || meta.media) || now() - noMetaAt < PL_NOCOL_RETRY_MS) { await legacy(); return; }
        try {
          await plWithTimeout(
            db.prepare('INSERT INTO parse_log (' + PL_COLS + ', cover, title, media) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .bind(...vals, meta.cover, meta.title, meta.media).run(),
            PL_WRITE_TIMEOUT_MS);
        } catch (e) {
          // 迁移前没有这三列：退回旧列再写一次（只在明确是「缺列」时重试，超时等别的错误不重试，避免重复写）
          if (!/no column named|no such column|has no column/i.test(String((e && e.message) || e))) throw e;
          noMetaAt = now();
          await legacy();
        }
      } catch {}
    })();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
    return job;
  }
  function baseRow(request, input) {
    const cf = request.cf || {};
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    return {
      ts: now(), url: plCleanUrl(input), ip: plIp(request), device: plDevice(request), fp: plFp(request),
      country: s(cf.country, 8).toUpperCase().replace(/[^A-Z]/g, ''), region: s(cf.region, 60), city: s(cf.city, 60),
      ua: s(request.headers.get('user-agent'), 200),
    };
  }
  const blockedResponse = () => plJson({ ok: false, code: -1, error: PL_BLOCK_MSG, msg: PL_BLOCK_MSG }, 403);
  async function check(request, env, ctx) {
    let hit = '';
    try { hit = await blockedBy(env, ctx, plIp(request), plDevice(request), plFp(request)); } catch { hit = ''; }
    return hit;
  }
  // 下载 / 媒体代理：只查黑名单，不记
  async function guard(request, env, ctx, run) {
    if (await check(request, env, ctx)) return blockedResponse();
    return run();
  }
  // 用法：return pl.wrap(request, env, ctx, () => handleParse(request, env));  handleParse 里过了人机验证和频控后调 plPass(request)，
  // 解析成功拿到结果后调 plMeta(request, { cover, title, media })
  async function wrap(request, env, ctx, run) {
    if (plIsPreview(request, env)) return plPreviewResponse();
    let input = '';
    try { input = await plInput(request); } catch {}
    const hit = await check(request, env, ctx);
    if (hit) {
      try {
        const t = now();
        if (!(t - (blockLogged.get(hit) || 0) < 60000)) {
          if (blockLogged.size > 500) blockLogged.clear();
          blockLogged.set(hit, t);
          write(env, ctx, { ...baseRow(request, input), ok: false, status: 403, reason: '已拉黑，拒绝解析' });
        }
      } catch {}
      return blockedResponse();
    }
    // 无效链接（空 / 不是本站 / 格式不对）：照常交给站点处理（它会 400），但不记
    let record = !!(env && env.PARSE_DB) && !plFlag(env && env.PARSE_LOG_OFF);
    if (record && valid) { try { record = !!valid(input); } catch { record = false; } }
    if (!record) return run();
    let resp;
    try {
      resp = await run();
    } catch (e) {
      try { if (PL_PASSED.has(request)) write(env, ctx, { ...baseRow(request, input), ok: false, status: 500, reason: plScrub((e && e.message) || e) }); } catch {}
      throw e;
    }
    try {
      if (resp && PL_PASSED.has(request)) {
        const row = baseRow(request, input);
        const status = resp.status;
        const isJson = (resp.headers.get('content-type') || '').toLowerCase().includes('json');
        const clone = isJson ? resp.clone() : null;
        const job = (async () => {
          let body = null;
          if (clone) { try { body = await clone.json(); } catch {} }
          // 失败：非 2xx，或 ok:false，或 code 不是 0 / 200（TikTok 成功 code=0，微博成功 code=200）；
          // 微博 code=200 但 msg='empty'（没有图片 / 视频）也算失败（v3 起并入原件，以前只在微博站的副本里）
          const empty = !!(body && body.code === 200 && body.msg === 'empty');
          const failed = empty || status >= 300 || !!(body && (body.ok === false || (typeof body.code === 'number' && body.code !== 0 && body.code !== 200)));
          const msg = empty ? '没有解析到图片或视频' : failed ? plScrub((body && (body.error || body.msg || body.message)) || ('HTTP ' + status)) : '';
          const meta = failed ? null : PL_META.get(request) || null;
          await write(env, ctx, { ...row, ok: !failed, status, reason: msg, meta });
        })().catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch {}
    return resp;
  }
  return { wrap, guard, isBlocked, write, _cache: cache };
}
// ==== parse-log v3 END ====
// 只记有效链接：和 handleParse 开头的本地校验同一套判断（空 / 不是本站链接 → 站点自己 400，不记）
const pl = createParseLog('xiaohongshu', { valid: (t) => { if (!String(t).trim()) return false; try { extractFirstUrl(t); return true; } catch { return false; } } });

const app = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse') return pl.wrap(request, env, ctx, () => handleParse(request, env));
    if (url.pathname === '/api/media') return pl.guard(request, env, ctx, () => handleMedia(request));
    if (url.pathname === '/api/diag') return handleDiag(request, env);
    // Turnstile 公开 site key 下发（没配就返回空，前端据此跳过）
    if (url.pathname === '/api/turnstile-key')
      return json({ ok: true, siteKey: (env.TURNSTILE_SITE_KEY || '').trim(), required: !!(env.TURNSTILE_SECRET_KEY || '').trim() });
    if (url.pathname === '/api/feedback') {
      if (request.method === 'POST') return handleFeedbackSubmit(request, env);
      if (request.method === 'DELETE') return handleFeedbackDelete(request, env);
      return json({ ok: false, error: '方法不支持' }, 405);
    }
    if (url.pathname === '/api/feedback/list') return handleFeedbackList(request, env);
    // 本站解析次数
    if (url.pathname === '/api/stats') {
      if (!env.FEEDBACK_KV) return json({ ok: true, bound: false, parseCount: null, error: '未绑定 KV' });
      let n = null;
      try {
        n = Number((await env.FEEDBACK_KV.get('stats_parse_xhs')) || 0);
      } catch {}
      return json({ ok: true, bound: true, parseCount: n });
    }
    if (url.pathname.startsWith('/api/fb-file/')) return handleFeedbackFile(request, env);
    if (url.pathname === '/api/stats-all') return handleStatsAll(request, env);
    if (url.pathname === '/api/parse-quota') return handleParseQuota(request, env);
    if (url.pathname === '/api/geo-stats') return handleGeoStats(request, env);
    if (url.pathname === '/api/parse-history') return handleParseHistory(request, env);
    if (url.pathname === '/dashboard') return serveAdminPage(request, env, DASHBOARD_HTML);
    if (url.pathname === '/api/admin/login') return handleAdminLogin(request, env);
    if (url.pathname === '/api/admin/logout') return handleAdminLogout(request);
    if (url.pathname === '/admin') return serveAdminPage(request, env, ADMIN_HTML);
    return env.ASSETS.fetch(request);
  },
};

// 所有 /api/* 响应统一走 CORS 白名单（不再是 Access-Control-Allow-Origin: *）
export default {
  async fetch(request, env, ctx) {
    return applyCors(request, env, await app.fetch(request, env, ctx));
  },
};
