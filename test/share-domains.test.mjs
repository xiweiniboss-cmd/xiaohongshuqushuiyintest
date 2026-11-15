// 分享域名白名单：App 新的 xhslink.cn 短链要认，冒充域名要拒。运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../_worker.js', import.meta.url)), 'utf8');
const file = join(mkdtempSync(join(tmpdir(), 'xhs-')), 'w.mjs');
writeFileSync(file, src);
const mod = (await import(file)).default;

function memKV() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => void m.set(k, String(v)), delete: async (k) => void m.delete(k), list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }) };
}
const NOTE = '6a9d0eb2000000002a024480';
let calls = [];
globalThis.fetch = async (u, init = {}) => {
  const url = String(u && u.url ? u.url : u);
  calls.push(url);
  const h = new URL(url).hostname;
  if (h === 'xhslink.cn' || h === 'xhslink.com')
    return new Response('', { status: 302, headers: { location: `https://www.xiaohongshu.com/discovery/item/${NOTE}?xsec_source=app_share&xsec_token=TOKEN` } });
  return new Response('upstream broken', { status: 500 });
};
let n = 0;
async function parse(text) {
  calls = [];
  const env = { FEEDBACK_KV: memKV(), REDFOX_API_KEY: 'fake', ASSETS: { fetch: async () => new Response('asset') } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const req = new Request('https://xiaohongshuqushuiyin.pages.dev/api/parse?url=' + encodeURIComponent(text), { headers: { 'cf-connecting-ip': '198.51.100.' + (++n) } });
  const r = await mod.fetch(req, env, ctx);
  return { status: r.status, body: await r.text(), calls };
}
const REJECT = '只支持小红书链接';

for (const link of [
  'https://xhslink.cn/o/AxnRePgIokn',
  'http://xhslink.cn/o/46qXj6whIts',
  'http://xhslink.com/o/8xYzAb',
  `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=T`,
  `https://www.rednote.com/explore/${NOTE}?xsec_token=T`,
]) {
  test('接受 ' + link, async () => {
    const r = await parse('93 【小红薯的笔记 | 小红书】 😆 Xy9Zw8 😆 ' + link + ' 复制本条信息，打开【小红书】App查看精彩内容！');
    assert.ok(!r.body.includes(REJECT), r.status + ' ' + r.body.slice(0, 160));
  });
}

test('xhslink.cn 短链会被跟随到 xiaohongshu.com 笔记页', async () => {
  const r = await parse('https://xhslink.cn/o/AxnRePgIokn');
  assert.ok(r.calls.some((u) => u.startsWith('https://xhslink.cn/o/AxnRePgIokn')), r.calls.join('\n'));
});

for (const link of [
  'https://xhslink.cn.evil.example/o/x',
  'https://evilxhslink.cn/o/x',
  'https://xhslink.cn-evil.com/o/x',
  'https://xhslink.co/o/x',
  'https://evil.example/?u=https://xhslink.cn/o/x',
]) {
  test('拒绝冒充域名 ' + link, async () => {
    const r = await parse(link);
    assert.equal(r.status, 400, r.body.slice(0, 160));
    assert.ok(r.body.includes(REJECT), r.body.slice(0, 160));
    assert.ok(!r.calls.some((u) => /evil|xhslink\.co\//.test(u)), '不该去抓冒充域名：' + r.calls.join(','));
  });
}
