// Cloudflare Pages 单文件 Worker（RedFoxHub 版）
// 小红书已封锁数据中心 IP 的匿名抓取，解析改走 RedFoxHub API
// 需要环境变量 REDFOX_API_KEY（去 redfox.hk 注册，控制台「API密钥」创建，填到 Pages → Settings → Environment variables）
// 部署：本文件放仓库根目录（与 index.html 同级）

/* ================= 公共 ================= */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const REDFOX_BASE = 'https://redfox.hk';

function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>\\]+/);
  if (!m) throw new Error('没有找到有效的小红书链接，请粘贴完整的分享链接');
  return m[0].replace(/[),.;!?\]}>»」』】，。；：？！）】]+$/, '');
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
  return /\.(?:mp4|m3u8)(?:\?|$)/i.test(u || '');
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
    if (!/^https?:\/\//i.test(h) || seen.has(h)) return;
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
    url = new URL(loc, url).href;
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
      return { type: 'video', note_id: extractNoteId(url) || '', title, desc, video_url: vurl };
    const images = extractImages(data);
    if (images.length)
      return { type: 'image', note_id: extractNoteId(url) || '', title, desc, images };
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
      if (vurl) return { type: 'video', note_id: noteId, title, desc, video_url: vurl };
      const images = extractImages(data);
      if (images.length) return { type: 'image', note_id: noteId, title, desc, images };
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
    const debug = reqUrl.searchParams.get('debug') === '1';
    // 解析接口人机验证（配了 TURNSTILE_SECRET_KEY 才生效）
    const tsSecret = (env.TURNSTILE_SECRET_KEY || '').trim();
    if (tsSecret) {
      const tsToken = reqUrl.searchParams.get('turnstile') || '';
      if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
      const tsOk = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip'));
      if (!tsOk) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
    }
    // 解析冷却：同一 IP 60 秒内只能解析一次（防刷 API 烧积分）
    const PARSE_COOLDOWN_SECS = 60;
    const parseIp = request.headers.get('cf-connecting-ip') || '';
    if (parseIp && env.FEEDBACK_KV) {
      const lastTs = await env.FEEDBACK_KV.get('pcool_' + parseIp);
      if (lastTs) {
        const remain = PARSE_COOLDOWN_SECS - Math.floor((Date.now() - Number(lastTs)) / 1000);
        if (remain > 0)
          return json({ ok: false, error: `解析太频繁，请 ${remain} 秒后再试` }, 429);
      }
    }

    // 每日解析限额：同一设备每天最多 20 次（防换 IP 刷 API 烧积分），按北京时间算天
    const DAILY_LIMIT = 20;
    const bjDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const parseUrl = new URL(request.url);
  const deviceId = parseUrl.searchParams.get('deviceId') || '';
  const quotaId = deviceId || parseIp;
  const quotaKey = 'dlimit_' + quotaId + '_' + bjDate;
    let usedToday = 0;
    if (parseIp && env.FEEDBACK_KV) {
      try { usedToday = Number((await env.FEEDBACK_KV.get(quotaKey)) || 0); } catch {}
      if (usedToday >= DAILY_LIMIT)
        return json({ ok: false, error: '今日解析次数已用完（20 次），明天再来吧' }, 429);
    }
    const result = await parseShareViaRedFox(shareText, apiKey, debug);
    if (parseIp && env.FEEDBACK_KV)
      await env.FEEDBACK_KV.put('pcool_' + parseIp, String(Date.now()), {
        expirationTtl: PARSE_COOLDOWN_SECS,
      });
    // 本站解析次数统计（仅成功计数）
    if (env.FEEDBACK_KV) {
      try {
        const cur = Number((await env.FEEDBACK_KV.get('stats_parse_xhs')) || 0);
        await env.FEEDBACK_KV.put('stats_parse_xhs', String(cur + 1));
      } catch {}
    }
    // 每日限额计数（仅成功计数，48小时过期）
    if (parseIp && env.FEEDBACK_KV) {
      try {
        await env.FEEDBACK_KV.put(quotaKey, String(usedToday + 1), { expirationTtl: 172800 });
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
const ALLOW_HOST = /(^|\.)(xhscdn\.com|xiaohongshu\.com)$/;
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
  if (!ALLOW_HOST.test(host)) return new Response('host not allowed', { status: 403 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(target, {
      headers: { 'User-Agent': UA_PC, Referer: 'https://www.xiaohongshu.com/', Accept: '*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) return new Response(`upstream ${resp.status}`, { status: 502 });
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=3600');
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    return new Response(resp.body, { status: 200, headers });
  } catch {
    return new Response('proxy error', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

/* ================= /api/diag（未变） ================= */
async function handleDiag(request) {
  const u = new URL(request.url);
  const target = u.searchParams.get('url') || 'https://www.xiaohongshu.com/';
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

// Cloudflare Turnstile 人机验证：secret 配了才校验，不配则跳过（向后兼容）
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

async function handleFeedbackSubmit(request, env) {
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '反馈功能暂未启用' }, 500);
  const ct = request.headers.get('content-type') || '';
  let message = '',
    contact = '',
    page = '',
    tsToken = '',
    files = [];
  if (ct.includes('multipart/form-data')) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    message = String(form.get('message') || '').trim();
    contact = String(form.get('contact') || '').trim().slice(0, 120);
    page = String(form.get('page') || '').slice(0, 200);
    tsToken = String(form.get('cf-turnstile-response') || '');
    files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size > 0);
  } else {
    // 兼容 JSON 提交（无附件）
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }
    message = String(body.message || '').trim();
    contact = String(body.contact || '').trim().slice(0, 120);
    page = String(body.page || '').slice(0, 200);
    tsToken = String(body['cf-turnstile-response'] || '');
  }
  if (!message) return json({ ok: false, error: '请填写反馈内容' }, 400);
  if (message.length > 2000) return json({ ok: false, error: '内容太长，请精简到 2000 字以内' }, 400);
  if (files.length > 3) return json({ ok: false, error: '最多上传 3 个附件' }, 400);

  // 人机验证（配了 TURNSTILE_SECRET_KEY 才生效）
  const tsSecret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (tsSecret) {
    if (!tsToken) return json({ ok: false, error: '请先完成人机验证' }, 400);
    const ok = await verifyTurnstile(tsToken, tsSecret, request.headers.get('cf-connecting-ip'));
    if (!ok) return json({ ok: false, error: '人机验证未通过，请重试' }, 403);
  }

  // 提交冷却：同一 IP 10 分钟内只能提交一次（KV 自动过期）
  const COOLDOWN_SECS = 600;
  const clientIp = request.headers.get('cf-connecting-ip') || '';
  if (clientIp) {
    const lastTs = await env.FEEDBACK_KV.get('cool_' + clientIp);
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
  if (files.length) {
    if (!env.FEEDBACK_BUCKET) return json({ ok: false, error: '附件功能暂未启用' }, 500);
    for (const f of files) {
      const type = f.type || '';
      if (!/^(image|video)\//.test(type))
        return json({ ok: false, error: '只支持图片和视频附件' }, 400);
      if (f.size > 20 * 1024 * 1024)
        return json({ ok: false, error: '单个附件不能超过 20MB' }, 400);
      const ext =
        (String(f.name || '').split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) ||
        'bin';
      const key = `fb/${id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await env.FEEDBACK_BUCKET.put(key, f.stream(), {
        httpMetadata: { contentType: type },
      });
      attachments.push({ key, type, name: String(f.name || '').slice(0, 80), size: f.size });
    }
  }

  const record = {
    id,
    message: message.slice(0, 2000),
    contact,
    page,
    attachments,
    ua: (request.headers.get('user-agent') || '').slice(0, 200),
    ip: request.headers.get('cf-connecting-ip') || '',
    geo: {
      country: (request.cf && request.cf.country) || '',
      region: (request.cf && request.cf.region) || '',
      city: (request.cf && request.cf.city) || '',
    },
    time: new Date().toISOString(),
  };
  await env.FEEDBACK_KV.put(id, JSON.stringify(record));
  // 写入冷却时间戳（10 分钟后自动过期；键前缀 cool_ 不与 fb_ 反馈键冲突）
  if (clientIp)
    await env.FEEDBACK_KV.put('cool_' + clientIp, String(Date.now()), {
      expirationTtl: COOLDOWN_SECS,
    });
  return json({ ok: true });
}

function checkAdminKey(url, env) {
  const key = env.FEEDBACK_ADMIN_KEY || '';
  return !!key && url.searchParams.get('key') === key;
}

async function handleFeedbackList(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const listed = await env.FEEDBACK_KV.list({ prefix: 'fb_' });
  const items = [];
  for (const k of listed.keys) {
    try {
      const v = await env.FEEDBACK_KV.get(k.name);
      if (v) items.push(JSON.parse(v));
    } catch {
      /* ignore */
    }
  }
  items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return json({ ok: true, count: items.length, items });
}

async function handleFeedbackDelete(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  if (!env.FEEDBACK_KV) return json({ ok: false, error: '未绑定 KV' }, 500);
  const id = url.searchParams.get('id') || '';
  if (!/^fb_[a-z0-9_]+$/i.test(id)) return json({ ok: false, error: '参数错误' }, 400);
  // 先读记录，把附件从 R2 一并删掉
  try {
    const v = await env.FEEDBACK_KV.get(id);
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
  return json({ ok: true });
}

// 管理后台查看附件（key 鉴权）：/api/fb-file/<key>?key=管理密码
async function handleFeedbackFile(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return new Response('无权访问', { status: 403 });
  if (!env.FEEDBACK_BUCKET) return new Response('未绑定存储', { status: 500 });
  const m = url.pathname.match(/^\/api\/fb-file\/(.+)$/);
  const key = m ? decodeURIComponent(m[1]) : '';
  if (!key.startsWith('fb/') || key.includes('..')) return new Response('参数错误', { status: 400 });
  const obj = await env.FEEDBACK_BUCKET.get(key);
  if (!obj) return new Response('文件不存在', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
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
<div style="margin:6px 0 4px"><a href="/dashboard?key=" id="dashLink" style="font-size:13px;color:#FE2C55">📊 数据总览</a></div>
<script>document.getElementById('dashLink').href = '/dashboard?key=' + encodeURIComponent(new URLSearchParams(location.search).get('key') || '');</script>
<div id="list">加载中…</div>
</div><script>
const key = new URLSearchParams(location.search).get('key') || '';
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
    const h = new URL(p).hostname;
    if (h.includes('tiktok')) return 'TikTok站';
    if (h.includes('xiaohongshu')) return '小红书站';
    if (h.includes('douyin')) return '抖音站';
    if (h.includes('youtube')) return 'YouTube站';
    if (h.includes('bilibili')) return 'B站站';
    if (h.includes('DeepSeek')) return 'DeepSeek站';
    return h;
  } catch { return ''; }
};
async function load() {
  const box = document.getElementById('list');
  try {
    const r = await fetch('/api/feedback/list?key=' + encodeURIComponent(key));
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
        '<div class="msg">' + esc(it.message) + '</div>';
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
          const src = '/api/fb-file/' + encodeURIComponent(a.key) + '?key=' + encodeURIComponent(key);
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
        await fetch('/api/feedback?id=' + encodeURIComponent(it.id) + '&key=' + encodeURIComponent(key), { method: 'DELETE' });
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
<div class="sub">五站解析次数统计（仅成功计数）</div>
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
<div class="links"><a href="/admin?key=" id="adminLink">💬 反馈管理</a></div>
</div><script>
const key = new URLSearchParams(location.search).get('key') || '';
document.getElementById('adminLink').href = '/admin?key=' + encodeURIComponent(key);
const COLORS = ['#FE2C55','#25F4EE','#FFC107','#9C27B0'];
const COUNTRY_ZH = {CN:'中国',US:'美国',JP:'日本',KR:'韩国',HK:'香港',TW:'台湾',MO:'澳门',SG:'新加坡',GB:'英国',DE:'德国',FR:'法国',IT:'意大利',ES:'西班牙',CA:'加拿大',AU:'澳大利亚',NZ:'新西兰',RU:'俄罗斯',IN:'印度',BR:'巴西',MX:'墨西哥',TH:'泰国',MY:'马来西亚',ID:'印度尼西亚',PH:'菲律宾',VN:'越南',TR:'土耳其',AE:'阿联酋',XX:'未知'};
async function load(){
  const grid = document.getElementById('grid');
  try{
    const r = await fetch('/api/stats-all?key=' + encodeURIComponent(key));
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
    const r = await fetch('/api/parse-history?key=' + encodeURIComponent(key));
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
    const r = await fetch('/api/geo-stats?key=' + encodeURIComponent(key));
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
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  const siteNames = { tiktok: 'TikTok站', xhs: '小红书站', douyin: '抖音站', youtube: 'YouTube站', bilibili: 'B站站' };
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
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  const byCountry = {};
  const bySite = { tiktok: {}, xhs: {}, douyin: {}, youtube: {}, bilibili: {} };
  if (env.FEEDBACK_KV) {
    try {
      const listed = await env.FEEDBACK_KV.list({ prefix: 'geoparse_' });
      for (const k of listed.keys) {
        const m = k.name.match(/^geoparse_(tiktok|xhs|douyin|youtube|bilibili)_([A-Z]{2})$/);
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
  const DAILY_LIMIT = 20;
  const url = new URL(request.url);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const deviceId = url.searchParams.get('deviceId') || '';
  const quotaId = deviceId || ip;
  const bjDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  let used = 0;
  if (quotaId && env.FEEDBACK_KV) {
    try { used = Number((await env.FEEDBACK_KV.get('dlimit_' + quotaId + '_' + bjDate)) || 0); } catch {}
  }
  return json({ ok: true, limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) });
}

/* ================= 数据总览 ================= */
async function handleStatsAll(request, env) {
  const url = new URL(request.url);
  if (!checkAdminKey(url, env)) return json({ ok: false, error: '无权访问' }, 403);
  const sites = [
    { key: 'stats_parse_tiktok', name: 'TikTok站' },
    { key: 'stats_parse_xhs', name: '小红书站' },
    { key: 'stats_parse_douyin', name: '抖音站' },
    { key: 'stats_parse_youtube', name: 'YouTube站' },
    { key: 'stats_parse_bilibili', name: 'B站站' },
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse') return handleParse(request, env);
    if (url.pathname === '/api/media') return handleMedia(request);
    if (url.pathname === '/api/diag') return handleDiag(request);
    if (url.pathname === '/api/feedback') {
      if (request.method === 'POST') return handleFeedbackSubmit(request, env);
      if (request.method === 'DELETE') return handleFeedbackDelete(request, env);
      return json({ ok: false, error: '方法不支持' }, 405);
    }
    if (url.pathname === '/api/feedback/list') return handleFeedbackList(request, env);
    // Turnstile 公开 site key 下发（site key 本就是公开的，前端渲染验证组件用）
    if (url.pathname === '/api/turnstile-key')
      return json({ ok: true, siteKey: (env.TURNSTILE_SITE_KEY || '').trim() });
    // 本站解析次数
    if (url.pathname === '/api/stats') {
      let n = 0;
      if (env.FEEDBACK_KV) {
        try {
          n = Number((await env.FEEDBACK_KV.get('stats_parse_xhs')) || 0);
        } catch {}
      }
      return json({ ok: true, parseCount: n });
    }
    if (url.pathname.startsWith('/api/fb-file/')) return handleFeedbackFile(request, env);
    if (url.pathname === '/api/stats-all') return handleStatsAll(request, env);
    if (url.pathname === '/api/parse-quota') return handleParseQuota(request, env);
    if (url.pathname === '/api/geo-stats') return handleGeoStats(request, env);
    if (url.pathname === '/api/parse-history') return handleParseHistory(request, env);
    if (url.pathname === '/dashboard') {
      if (!checkAdminKey(url, env))
        return new Response('无权访问：在地址后加上 ?key=你的管理密码，例如 /dashboard?key=xxx', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname === '/admin') {
      if (!checkAdminKey(url, env))
        return new Response('无权访问：在地址后加上 ?key=你的管理密码，例如 /admin?key=xxx', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
