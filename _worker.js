// Cloudflare Pages 单文件 Worker（TikHub 版）
// 小红书已封锁数据中心 IP 的匿名抓取，解析改走 TikHub API
// 需要环境变量 TIKHUB_TOKEN（去 user.tikhub.io 注册并创建 token，填到 Pages → Settings → Environment variables）
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

const TIKHUB_BASE = 'https://api.tikhub.io';
const EP_VIDEO = '/api/v1/xiaohongshu/app_v2/get_video_note_detail';
const EP_IMAGE = '/api/v1/xiaohongshu/app_v2/get_image_note_detail';

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

/* ================= TikHub ================= */
async function tikhubCall(endpoint, shareText, token) {
  const url = TIKHUB_BASE + endpoint + '?share_text=' + encodeURIComponent(shareText);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('TikHub 返回了非 JSON 数据（HTTP ' + resp.status + '）');
    }
    if (resp.status === 401 || resp.status === 403)
      throw new Error('TikHub Token 无效或未激活，请检查环境变量 TIKHUB_TOKEN');
    if (resp.status === 402)
      throw new Error('TikHub 余额不足，请前往 TikHub 后台充值后再试');
    if (resp.status === 429) throw new Error('TikHub 请求太频繁，请稍后重试');
    if (!resp.ok)
      throw new Error(
        'TikHub 请求失败（HTTP ' + resp.status + '）：' + (body.message_zh || body.message || '')
      );
    if (body.code && body.code !== 200)
      throw new Error('TikHub 接口报错：' + (body.message_zh || body.message || 'code=' + body.code));
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// 从 TikHub 返回中定位 note 对象（data.data[0].note_list[0]，带多种兜底）
function tikhubNote(body) {
  const d = body?.data;
  const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : null;
  const first = arr?.[0];
  const note = first?.note_list?.[0] || first?.note || first;
  if (!note || typeof note !== 'object') return null;
  if (!note.id && !note.title && !note.desc) return null;
  return note;
}

function pickImageUrl(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return null;
  return item.url || item.url_default || item.image_url || item.src || item.link || null;
}

function extractImages(note) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (typeof u !== 'string' || !u) return;
    const h = ensureHttps(normalizeUrl(u));
    if (!/^https?:\/\//i.test(h) || seen.has(h)) return;
    seen.add(h);
    out.push({ url_webp: h, url_png: convertToPng(h) || h, width: null, height: null });
  };
  for (const key of ['images_list', 'image_list', 'imageList', 'images']) {
    const list = note[key];
    if (Array.isArray(list)) for (const item of list) push(pickImageUrl(item));
  }
  if (!out.length) {
    // 兜底：深搜图片 CDN 链接
    for (const u of deepFindUrls(note)) {
      if (/xhscdn\.com/i.test(u) && !isVideoUrl(u) && !/(avatar|watermark)/i.test(u)) push(u);
    }
  }
  return out;
}

function extractVideoUrl(note) {
  const candidates = [];
  const push = (u) => {
    if (typeof u !== 'string' || !u) return;
    const h = ensureHttps(normalizeUrl(u));
    if (isVideoUrl(h) && !candidates.includes(h)) candidates.push(h);
  };
  // 结构化字段优先
  push(note.video_url);
  push(note.video?.url);
  push(note.video_info?.url);
  push(note.media?.video_url);
  push(note.video?.play_url);
  // 兜底：深搜 mp4 链接
  for (const u of deepFindUrls(note)) push(u);
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

// 免费判断图文/视频类型：只跟随短链跳转读 type 参数，不调计费接口
async function detectTypeHint(shareText) {
  try {
    let url = extractFirstUrl(shareText);
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA_PC, Referer: 'https://www.xiaohongshu.com/' },
      });
      const loc = r.headers.get('location');
      if (!loc || r.status < 300 || r.status >= 400) break;
      url = new URL(loc, url).href;
    }
    const t = (new URL(url).searchParams.get('type') || '').toLowerCase();
    if (t === 'video') return 'video';
    if (t === 'normal' || t === 'image') return 'image';
  } catch {
    /* ignore */
  }
  return null;
}

async function parseShareViaTikHub(shareText, token) {
  extractFirstUrl(shareText); // 先校验链接有效性，避免无效输入浪费计费调用
  const hint = await detectTypeHint(shareText);
  let first = EP_VIDEO,
    second = EP_IMAGE;
  if (hint === 'image') [first, second] = [second, first];

  const errors = [];
  for (const ep of [first, second]) {
    let body;
    try {
      body = await tikhubCall(ep, shareText, token);
    } catch (e) {
      // 鉴权/余额/限流问题直接抛，不再试另一个接口浪费计费
      if (/Token|余额|频繁/.test(e.message)) throw e;
      errors.push(e.message);
      continue;
    }
    const note = tikhubNote(body);
    if (!note) {
      errors.push('TikHub 未返回笔记数据（笔记可能已删除或设为私密）');
      continue;
    }
    const title = cleanTitle(note.title, 'xhs_' + (note.id || 'note'));
    const desc = String(note.desc || note.content || '');
    const noteId = String(note.id || note.note_id || '');
    if (ep === EP_VIDEO) {
      const vurl = extractVideoUrl(note);
      if (vurl) return { type: 'video', note_id: noteId, title, desc, video_url: vurl };
      errors.push('视频接口未返回视频地址，尝试图文接口');
    } else {
      const images = extractImages(note);
      if (images.length)
        return { type: 'image', note_id: noteId, title, desc, images };
      errors.push('图文接口未返回图片');
    }
  }
  throw new Error(errors.join('；') || '解析失败');
}

async function handleParse(request, env) {
  try {
    const token = env.TIKHUB_TOKEN || env.TIKHUB_API_KEY;
    if (!token) {
      return json(
        {
          ok: false,
          error:
            '未配置 TikHub Token：请去 user.tikhub.io 注册并创建 token，然后在 Cloudflare Pages → Settings → Environment variables 添加 TIKHUB_TOKEN（重新部署后生效）',
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
    const result = await parseShareViaTikHub(shareText, token);
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
