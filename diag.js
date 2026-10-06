// 诊断接口：检查 Cloudflare 出口访问小红书是否被风控拦截
// 用法：/api/diag  或  /api/diag?url=<某条小红书分享链接>
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

export async function onRequest(context) {
  const u = new URL(context.request.url);
  const target = u.searchParams.get('url') || 'https://www.xiaohongshu.com/';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.xiaohongshu.com/',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await resp.text();
    return new Response(
      JSON.stringify({
        ok: true,
        status: resp.status,
        finalUrl: resp.url,
        htmlLen: text.length,
        hasInitialState: text.includes('__INITIAL_STATE__'),
        hint: text.includes('__INITIAL_STATE__')
          ? '页面数据正常，解析链路可用'
          : '未拿到页面数据，可能被小红书风控拦截',
      }),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } finally {
    clearTimeout(timer);
  }
}
