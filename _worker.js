// Cloudflare Pages 单文件 Worker：接管 /api/* 路由，其余请求走静态资源
// 用法：把本文件放到仓库根目录（与 index.html 同级），删除根目录下散落的 parse.js / media.js / diag.js
// 效果等同于 functions/api/parse.js + media.js + diag.js，适合无法上传文件夹的场景

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
const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const HEADERS_PC = {
  'User-Agent': UA_PC,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.xiaohongshu.com/',
};
const HEADERS_MOBILE = {
  'User-Agent': UA_IPHONE,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.xiaohongshu.com/',
};

/* ================= /api/parse ================= */
function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>\\]+/);
  if (!m) throw new Error('没有找到有效的小红书链接，请粘贴完整的分享链接');
  return m[0].replace(/[),.;!?\]}>»」』】，。；：？！）】]+$/, '');
}
function extractNoteId(url) {
  const m = String(url || '').match(/\/(?:explore|discovery\/item)\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}
async function fetchHtml(url, headers, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    const html = await resp.text();
    return { status: resp.status, finalUrl: resp.url, html };
  } finally {
    clearTimeout(timer);
  }
}
function extractInitialState(html) {
  const m = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
  if (!m) return null;
  const jsonStr = m[1].replace(/:\s*undefined\s*([,}])/g, ':null$1');
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
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
function extractMeta(html, prop) {
  const pats = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${prop}["']`, 'i'),
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}
function extractVideoSrcTags(html) {
  const out = [];
  const re = /<video[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
function isVideoUrl(u) {
  return /\.(?:mp4|m3u8)(?:\?|$)/i.test(u || '');
}
function scoreCandidate(url, source) {
  let s = 0;
  if (source === 'video') s += 100;
  else if (source === 'og') s += 90;
  else if (source.startsWith('state_master')) s += 80;
  else if (source.startsWith('state_backup')) s += 60;
  else if (source === 'fallback') s += 40;
  if (/h264/i.test(source)) s += 5;
  if (url.startsWith('https://')) s += 10;
  if (/(wm|watermark)/i.test(url)) s -= 40;
  return s;
}
function collectVideoCandidates(html, state, noteId) {
  const candidates = [];
  for (const v of extractVideoSrcTags(html)) candidates.push([v, 'video']);
  const ogv = extractMeta(html, 'og:video') || extractMeta(html, 'og:video:url');
  if (ogv) candidates.push([ogv, 'og']);
  try {
    const noteMap = state?.note?.noteDetailMap || {};
    const chosenId = noteId && noteMap[noteId] ? noteId : Object.keys(noteMap)[0];
    const noteInfo = noteMap[chosenId]?.note || {};
    const stream = noteInfo?.video?.media?.stream || {};
    for (const [codec, items] of Object.entries(stream)) {
      if (!Array.isArray(items)) continue;
      items.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        if (item.masterUrl) candidates.push([item.masterUrl, `state_master_${codec}_${idx}`]);
        (item.backupUrls || []).forEach((b, bi) =>
          candidates.push([b, `state_backup_${codec}_${idx}_${bi}`])
        );
      });
    }
  } catch { /* ignore */ }
  if (candidates.length === 0) {
    const re = /https?:\/\/[^\s'"]+?\.(?:mp4|m3u8)(?:\?[^\s'"]*)?/gi;
    let m;
    while ((m = re.exec(html))) {
      if (m[0].includes('xhscdn.com')) candidates.push([m[0], 'fallback']);
    }
  }
  const seen = new Set();
  const normalized = [];
  for (const [url, source] of candidates) {
    const u = ensureHttps(normalizeUrl(url));
    if (!isVideoUrl(u) || seen.has(u)) continue;
    seen.add(u);
    normalized.push([u, source]);
  }
  return normalized;
}
function pickBestVideo(candidates) {
  if (!candidates.length) throw new Error('未从页面中找到可用视频直链');
  const sorted = [...candidates].sort(
    (a, b) => scoreCandidate(b[0], b[1]) - scoreCandidate(a[0], a[1]) || a[0].length - b[0].length
  );
  return sorted[0][0];
}
function convertToPng(webpUrl) {
  const m = String(webpUrl || '').match(/https?:\/\/[^/]*xhscdn\.com\/\d+\/[0-9a-z]+\/(\S+?)!/);
  if (m) return `https://ci.xiaohongshu.com/${m[1]}?imageView2/format/png`;
  return null;
}
function buildImages(noteInfo) {
  const imageList = noteInfo?.imageList || [];
  if (!imageList.length) throw new Error('笔记中没有找到图片');
  const images = [];
  for (const img of imageList) {
    let webp = null;
    for (const info of img.infoList || []) {
      if (info.imageScene === 'WB_DFT') {
        webp = info.url;
        break;
      }
    }
    if (!webp) webp = img.urlDefault;
    if (!webp) continue;
    webp = ensureHttps(normalizeUrl(webp));
    images.push({
      url_webp: webp,
      url_png: convertToPng(webp) || webp,
      width: img.width || null,
      height: img.height || null,
    });
  }
  if (!images.length) throw new Error('无法提取图片地址');
  return images;
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
async function parseShare(shareText) {
  const shareUrl = extractFirstUrl(shareText);
  let page = await fetchHtml(shareUrl, HEADERS_PC);
  let hasState = page.html.includes('__INITIAL_STATE__');
  if (page.status >= 500 || !page.html || !hasState) {
    page = await fetchHtml(shareUrl, HEADERS_MOBILE);
    hasState = page.html.includes('__INITIAL_STATE__');
  }
  if (page.status >= 400 && !page.html) {
    throw new Error(`小红书返回异常状态（HTTP ${page.status}），请稍后重试`);
  }
  if (!hasState) {
    throw new Error('小红书拒绝了这次访问（疑似风控拦截），请稍后重试或换个网络再试');
  }
  if (/\/404(?:[?#]|$)/.test(page.finalUrl || '')) {
    throw new Error('该笔记不存在、已删除或设为私密，无法解析');
  }
  const noteId = extractNoteId(page.finalUrl) || extractNoteId(shareUrl);
  const state = extractInitialState(page.html);
  if (!state) throw new Error('页面数据提取失败，请稍后重试');
  const noteMap = state?.note?.noteDetailMap || {};
  if (!Object.keys(noteMap).length)
    throw new Error('页面中没有笔记数据（笔记可能已删除、设为私密或被风控拦截）');
  const chosenId = noteId && noteMap[noteId] ? noteId : Object.keys(noteMap)[0];
  const noteInfo = noteMap[chosenId]?.note;
  if (!noteInfo) throw new Error('笔记数据解析失败');

  const title = cleanTitle(noteInfo.title, `xhs_${chosenId}`);
  const desc = String(noteInfo.desc || '');
  let shareType = '';
  try {
    shareType = (new URL(page.finalUrl).searchParams.get('type') || '').toLowerCase();
  } catch { /* ignore */ }
  const stream = noteInfo?.video?.media?.stream || {};
  const hasStateVideo = Object.values(stream).some((v) => Array.isArray(v) && v.length);
  const hasHtmlVideo =
    !!(extractMeta(page.html, 'og:video') || extractMeta(page.html, 'og:video:url')) ||
    extractVideoSrcTags(page.html).length > 0;
  const hasImages = (noteInfo?.imageList?.length || 0) > 0;
  const preferVideo = shareType === 'video' || (!shareType && (hasStateVideo || hasHtmlVideo));
  const preferImage = shareType === 'normal' || (!preferVideo && hasImages);

  const errors = [];
  const tryVideo = () => {
    const vTitle = cleanTitle(noteInfo.title || extractMeta(page.html, 'og:title'), `xhs_${chosenId}`);
    const candidates = collectVideoCandidates(page.html, state, chosenId);
    return { type: 'video', note_id: chosenId, title: vTitle, desc, video_url: pickBestVideo(candidates) };
  };
  const tryImage = () => ({
    type: 'image', note_id: chosenId, title, desc, images: buildImages(noteInfo),
  });
  if (preferVideo) {
    try { return tryVideo(); } catch (e) { errors.push(e.message); }
  }
  if (preferImage || noteInfo) {
    try { return tryImage(); } catch (e) { errors.push(e.message); }
  }
  if (!preferVideo) {
    try { return tryVideo(); } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join('；') || '未从页面中发现可用资源');
}
async function handleParse(request) {
  try {
    const reqUrl = new URL(request.url);
    let shareText = reqUrl.searchParams.get('url') || '';
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        shareText = body.url || body.link || shareText;
      } catch { /* ignore */ }
    }
    if (!shareText.trim()) return json({ ok: false, error: '请先粘贴小红书分享链接' }, 400);
    const result = await parseShare(shareText);
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ ok: false, error: e.message || '解析失败，请稍后重试' });
  }
}

/* ================= /api/media ================= */
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

/* ================= /api/diag ================= */
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
    if (url.pathname === '/api/parse') return handleParse(request);
    if (url.pathname === '/api/media') return handleMedia(request);
    if (url.pathname === '/api/diag') return handleDiag(request);
    return env.ASSETS.fetch(request);
  },
};
