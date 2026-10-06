// 媒体代理：解决浏览器直接请求小红书 CDN 时的跨域（CORS）与防盗链问题
// 前端预览、抓取 blob 走这里；仅允许小红书官方域名，防止被当成开放代理滥用
const ALLOW_HOST = /(^|\.)(xhscdn\.com|xiaohongshu\.com)$/;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

export async function onRequest(context) {
  const u = new URL(context.request.url);
  const target = u.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) {
    return new Response('missing url', { status: 400 });
  }
  let host = '';
  try {
    host = new URL(target).hostname;
  } catch {
    return new Response('bad url', { status: 400 });
  }
  if (!ALLOW_HOST.test(host)) {
    return new Response('host not allowed', { status: 403 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.xiaohongshu.com/',
        Accept: '*/*',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) {
      return new Response(`upstream ${resp.status}`, { status: 502 });
    }
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=3600');
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    return new Response(resp.body, { status: 200, headers });
  } catch (e) {
    return new Response('proxy error', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
