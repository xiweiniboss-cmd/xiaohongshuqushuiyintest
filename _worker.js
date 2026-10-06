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
    if (/^https?:\/\/[^\s"'<>\\]+$/i.test(obj)) out.push(obj);
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
  return item.url || item.url_default || item.image_url || item.src || item.link || null;
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
  for (const key of ['images_list', 'image_list', 'imageList', 'images', 'pic_list']) {
    const list = data[key];
    if (Array.isArray(list)) for (const item of list) push(pickImageUrl(item));
  }
  if (!out.length) {
    // 兜底：深搜图片 CDN 链接
    for (const u of deepFindUrls(data)) {
      if (/xhscdn\.com/i.test(u) && !isVideoUrl(u) && !/(avatar|watermark)/i.test(u)) push(u);
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

async function parseShareViaRedFox(shareText, apiKey) {
  const originalUrl = extractFirstUrl(shareText); // 先校验链接有效性，避免无效输入浪费计费调用
  const errors = [];

  // 路线一：通用无水印下载接口，短链/长链直传（RedFox 自己处理跳转，不经过我们被封的 IP）
  try {
    const data = await redfoxPost('/story/api/parseWork/parse', apiKey, { url: originalUrl });
    const title = cleanTitle(data.title || data.desc, 'xhs_note');
    const desc = String(data.desc || data.content || data.title || '');
    const vurl = extractVideoUrl(data);
    if (vurl) return { type: 'video', note_id: extractNoteId(originalUrl) || '', title, desc, video_url: vurl };
    const images = extractImages(data);
    if (images.length) return { type: 'image', note_id: extractNoteId(originalUrl) || '', title, desc, images };
    errors.push('下载接口未返回媒体地址');
  } catch (e) {
    // 鉴权/余额/限流问题直接抛，不再浪费计费调用
    if (/API Key|鉴权|余额|频繁/.test(e.message)) throw e;
    errors.push('下载接口：' + e.message);
  }

  // 路线二：跳转链里找 noteId → 笔记详情接口
  try {
    const { noteId } = await resolveNoteId(shareText);
    if (!noteId) {
      errors.push('未能从链接中识别笔记 ID');
    } else {
      const data = await redfoxPost('/story/api/xhsUser/queryWorkDetail', apiKey, { workId: noteId });
      const title = cleanTitle(data.title || data.desc, 'xhs_' + noteId);
      const desc = String(data.desc || data.content || data.title || '');
      const vurl = extractVideoUrl(data);
      if (vurl) return { type: 'video', note_id: noteId, title, desc, video_url: vurl };
      const images = extractImages(data);
      if (images.length) return { type: 'image', note_id: noteId, title, desc, images };
      errors.push('笔记详情未返回媒体地址');
    }
  } catch (e) {
    if (/API Key|鉴权|余额|频繁/.test(e.message)) throw e;
    errors.push('笔记详情：' + e.message);
  }

  throw new Error(errors.join('；') || '解析失败（笔记可能已删除或设为私密）');
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
    const result = await parseShareViaRedFox(shareText, apiKey);
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ ok: false, error: e.message || '解析失败，请稍后重试' });
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

/* ================= 路由 ================= */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/parse') return handleParse(request, env);
    if (url.pathname === '/api/media') return handleMedia(request);
    if (url.pathname === '/api/diag') return handleDiag(request);
    return env.ASSETS.fetch(request);
  },
};
