/**
 * 福运小屋 · API（Cloudflare Workers + KV）
 *
 * 接口一览：
 *   GET    /api/state            读取全部站点数据（KV key: state）
 *   PUT    /api/state            保存全部站点数据（需 x-api-key 请求头）
 *   GET    /api/music/<id>       获取某首上传音乐的音频流（KV key: music:<id>）
 *   POST   /api/music            上传音乐 { id, name, date, type, data(base64) }（需 x-api-key）
 *   DELETE /api/music/<id>       删除单首上传音乐（需 x-api-key）
 *   DELETE /api/music            清空全部上传音乐（需 x-api-key）
 *
 * KV 命名空间 binding 名称为 KV，在 wrangler.toml 中配置。
 * 写接口均校验 x-api-key，密钥来自环境变量 API_KEY（wrangler.toml 的 vars）。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function ok(body) {
  return json({ ok: true, ...body });
}

function fail(error, status) {
  return json({ ok: false, error }, status || 400);
}

/** 写接口鉴权：未配置密钥或密钥未修改时拒绝写操作，防止误部署后数据被任意覆盖 */
function checkKey(request, env) {
  const key = env.API_KEY || '';
  if (!key || key === 'change-me-please') return false;
  return request.headers.get('x-api-key') === key;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getMusicIndex(env) {
  const cur = await env.KV.get('music_index', 'json');
  return Array.isArray(cur) ? cur : [];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 只处理 /api/* 路径
    if (!url.pathname.startsWith('/api/')) {
      return fail('not found', 404);
    }
    const path = url.pathname.replace(/^\/api\/?/, '');

    try {
      // ---------- 站点数据 ----------
      if (method === 'GET' && path === 'state') {
        const data = await env.KV.get('state', 'json');
        return ok({ data: data || null });
      }

      if (method === 'PUT' && path === 'state') {
        if (!checkKey(request, env)) return fail('unauthorized', 401);
        const body = await request.json();
        if (!body || typeof body !== 'object') return fail('bad body');
        await env.KV.put('state', JSON.stringify(body));
        return ok();
      }

      // ---------- 音乐 ----------
      // 读取音频流（返回音频二进制，供 <audio> 直接播放）
      if (method === 'GET' && path.startsWith('music/')) {
        const id = decodeURIComponent(path.slice('music/'.length));
        const idx = await getMusicIndex(env);
        const item = idx.find((m) => m.id === id);
        const b64 = await env.KV.get('music:' + id);
        if (!b64) return fail('not found', 404);
        return new Response(base64ToArrayBuffer(b64), {
          status: 200,
          headers: {
            ...CORS,
            'Content-Type': (item && item.type) || 'audio/mpeg',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      // 上传音乐
      if (method === 'POST' && path === 'music') {
        if (!checkKey(request, env)) return fail('unauthorized', 401);
        const body = await request.json();
        if (!body || !body.id || typeof body.data !== 'string') return fail('bad body');
        // KV 单值上限 25MB（base64 体积约为原文件 1.37 倍）
        if (body.data.length > 25 * 1024 * 1024) return fail('too large', 413);
        await env.KV.put('music:' + body.id, body.data);
        const idx = await getMusicIndex(env);
        const next = idx.filter((m) => m.id !== body.id);
        next.push({
          id: body.id,
          name: body.name || '未命名',
          date: body.date || '',
          type: body.type || 'audio/mpeg',
        });
        await env.KV.put('music_index', JSON.stringify(next));
        return ok();
      }

      // 删除单首音乐
      if (method === 'DELETE' && path.startsWith('music/')) {
        if (!checkKey(request, env)) return fail('unauthorized', 401);
        const id = decodeURIComponent(path.slice('music/'.length));
        await env.KV.delete('music:' + id);
        const idx = await getMusicIndex(env);
        await env.KV.put('music_index', JSON.stringify(idx.filter((m) => m.id !== id)));
        return ok();
      }

      // 清空全部音乐
      if (method === 'DELETE' && path === 'music') {
        if (!checkKey(request, env)) return fail('unauthorized', 401);
        const list = await env.KV.list({ prefix: 'music:' });
        await Promise.all(list.keys.map((k) => env.KV.delete(k.name)));
        await env.KV.put('music_index', JSON.stringify([]));
        return ok();
      }

      return fail('not found', 404);
    } catch (e) {
      return fail('server error', 500);
    }
  },
};
//（注：内容由AI生成）
