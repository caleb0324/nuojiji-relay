// Hono app —— 一份代码，Workers 和 Node 共用。
//
// 路由：
//   GET  /health                 健康检查（设置页测连接用）
//   POST /generate               提交生成（fire-and-forget，202）
//   GET  /outbox?inboxId=&since=  拉取已生成结果
//   POST /ack                    确认并删除
//   GET  /api/push/vapid-key     取 VAPID 公钥（复用 APP 现有订阅流程）
//   POST /api/push/subscribe     注册推送订阅
//   DELETE /api/push/unsubscribe 退订

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireSecret } from './util/auth.js';
import { createOutboxStore } from './store/outboxStore.js';
import { createSubStore, subKey } from './store/subStore.js';
import { createProactiveStore, PROACTIVE_WINDOW_CAP } from './store/proactiveStore.js';
import { createKvStore } from './store/kvStore.js';
import { runGeneration } from './ai/aiCaller.js';
import { dispatchPush } from './push/pushSender.js';
import { getVapidPublicKey } from './push/webPush.js';
import { makeMessageId, nowMs, extractPushBodies } from './util/ids.js';

const VERSION = '1.0.0';

export function createApp() {
    const app = new Hono();

    // 中继是用户自己的后端，APP 从套壳 (https://localhost / capacitor://localhost) 或
    // 网页 (https://*.pages.dev) 跨域请求 → 放开 CORS（鉴权靠 Bearer secret，不靠 origin）。
    app.use('*', cors({
        origin: (o) => o || '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
    }));

    // 每个请求懒初始化 store（Workers 每次 fetch 都新 env；Node 进程级缓存见下）
    const stores = { outbox: null, sub: null, proactive: null, kv: null };
    async function getStores(env) {
        if (env && env.OUTBOX) {
            // Workers：KV 绑定每次都现取，store 实例无状态可重建
            return {
                outbox: await createOutboxStore(env),
                sub: await createSubStore(env),
                proactive: await createProactiveStore(env),
                kv: await createKvStore(env),
            };
        }
        // Node：进程级单例
        if (!stores.outbox) stores.outbox = await createOutboxStore(env);
        if (!stores.sub) stores.sub = await createSubStore(env);
        if (!stores.proactive) stores.proactive = await createProactiveStore(env);
        if (!stores.kv) stores.kv = await createKvStore(env);
        return stores;
    }

    app.get('/health', async (c) => {
        const { outbox } = await getStores(c.env);
        return c.json({ ok: true, store: outbox.kind || 'unknown', version: VERSION });
    });

    // 🖼️ 角色头像公开读取（无鉴权）——iOS 通知扩展(独立进程,App 没运行)要能直接 GET 下载，
    //    附到 Communication Notification 显示在通知左侧。头像只是公开可见的角色头像，无敏感信息。
    //    存在 KV（OUTBOX namespace 的 av: 前缀），由 POST /avatar 写入。
    app.get('/avatar/:key', async (c) => {
        const key = c.req.param('key');
        if (!key || !/^[\w.-]{1,128}$/.test(key)) return c.json({ error: 'bad key' }, 400);
        const { kv } = await getStores(c.env);
        if (!kv) return c.json({ error: 'no store' }, 503);
        const rec = await kv.get(`av:${key}`, { type: 'json' }).catch(() => null);
        if (!rec || !rec.b64) return c.json({ error: 'not found' }, 404);
        try {
            const bin = Uint8Array.from(atob(rec.b64), (ch) => ch.charCodeAt(0));
            return new Response(bin, {
                status: 200,
                headers: {
                    'content-type': rec.mime || 'image/png',
                    'cache-control': 'public, max-age=86400',
                    'access-control-allow-origin': '*',
                },
            });
        } catch {
            return c.json({ error: 'decode failed' }, 500);
        }
    });

    // === 鉴权哨兵站（统一挪到路由逻辑之前） ===
    app.use('/avatar', requireSecret);
    app.use('/generate', requireSecret);
    app.use('/outbox', requireSecret);
    app.use('/ack', requireSecret);
    app.use('/api/push/subscribe', requireSecret);
    app.use('/api/push/unsubscribe', requireSecret);
    app.use('/api/push/diag', requireSecret);
    app.use('/proactive/*', requireSecret);

    app.post('/generate', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { requestId, inboxId, messages, settings, maxTokens, meta } = body || {};
        if (!requestId || !inboxId || !Array.isArray(messages) || !settings) {
            return c.json({ error: 'requestId / inboxId / messages / settings required' }, 400);
        }

        const { outbox, sub } = await getStores(c.env);

        if (await outbox.seenRequest(requestId)) {
            try {
                const existing = (await outbox.list(inboxId, 0)).find(it => it && String(it.requestId) === String(requestId));
                if (existing && !existing.error && existing.content) {
                    return c.json({ accepted: true, requestId, generated: true, replayed: true }, 202);
                }
            } catch { }
            return c.json({ duplicate: true, requestId }, 409);
        }
        await outbox.markRequest(requestId);

        const id = makeMessageId(requestId);
        let item;
        try {
            const content = await runGeneration(settings, messages, maxTokens);
            item = {
                id, requestId,
                charId: meta?.charId ?? null, roundId: meta?.roundId ?? null, userId: meta?.userId ?? null,
                content, error: null, createdAt: nowMs(),
            };
        } catch (e) {
            item = {
                id, requestId,
                charId: meta?.charId ?? null, roundId: meta?.roundId ?? null, userId: meta?.userId ?? null,
                content: null, error: String(e?.message || e), createdAt: nowMs(),
            };
        }
        await outbox.put(inboxId, item);

        // 🚀 企业微信机器人推送逻辑
        try {
            if (!item.error) {
                const wxurl = c.env.WECHAT_WEBHOOK_URL || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12415e03-8ac0-461a-9409-e2d8a02d8c78';
                const charName = meta?.charName || 'AI';
                const bodies = extractPushBodies(item.content);
                for (const body of bodies) {
                    await fetch(wxurl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            msgtype: 'text',
                            text: { content: `来自 ${charName} 的消息：\n${body}` }
                        })
                    }).catch(() => {});
                }
            }
        } catch (e) { console.warn('[WeChatPush] failed', e); }

        // 原生推送逻辑 (保持兼容)
        const pushWork = (async () => {
            try {
                if (item.error) return;
                const subs = await sub.list(inboxId);
                if (!subs.length) return;
                const title = meta?.charName || '糯叽机';
                const bodies = meta?.notifPrivacy ? extractPushBodies(item.content).map(() => '你有一条新消息') : extractPushBodies(item.content);
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                let i = 0;
                for (const body of bodies) {
                    if (i > 0) {
                        const delay = Math.min(4000, 600 + (body?.length || 0) * 120);
                        await sleep(delay);
                    }
                    const payload = {
                        title, body, charId: item.charId, userId: item.userId, kind: 'relay-outbox',
                        avatarUrl: meta?.avatarUrl || null,
                        senderName: title,
                        conversationId: `${item.userId}_${item.charId}`,
                        mutableContent: true,
                    };
                    for (const s of subs) {
                        const res = await dispatchPush(c.env, s, payload);
                        if (res?.gone) await sub.remove(inboxId, s);
                    }
                    i++;
                }
            } catch (e) { console.warn('[generate] push failed:', e?.message); }
        })();
        try {
            if (typeof c.executionCtx?.waitUntil === 'function') c.executionCtx.waitUntil(pushWork);
            else pushWork.catch(() => {});
        } catch { pushWork.catch(() => {}); }

        return c.json({ accepted: true, requestId, generated: !item.error }, 202);
    });

    app.get('/outbox', async (c) => {
        const inboxId = c.req.query('inboxId');
        const since = Number(c.req.query('since') || 0);
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { outbox } = await getStores(c.env);
        const items = await outbox.list(inboxId, since);
        return c.json({ items, now: nowMs() });
    });

    app.post('/ack', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, ids } = body || {};
        if (!inboxId || !Array.isArray(ids)) return c.json({ error: 'inboxId / ids required' }, 400);
        const { outbox } = await getStores(c.env);
        const acked = await outbox.ack(inboxId, ids);
        return c.json({ acked });
    });

    app.get('/api/push/vapid-key', async (c) => {
        const publicKey = await getVapidPublicKey(c.env);
        if (!publicKey) return c.json({ error: 'VAPID not configured' }, 503);
        return c.json({ publicKey });
    });

    app.post('/api/push/subscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, channel } = body || {};
        if (!inboxId || !subscription) return c.json({ error: 'inboxId / subscription required' }, 400);
        const entry = subscription.channel ? subscription : { channel: channel || 'web', sub: subscription };
        try {
            const { sub } = await getStores(c.env);
            await sub.add(inboxId, entry);
            const ch = entry.channel || 'web';
            if ((ch === 'apns' || ch === 'fcm') && typeof sub.pruneChannel === 'function') {
                await sub.pruneChannel(inboxId, ch, subKey(entry));
            }
        } catch (e) {
            return c.json({ error: 'subscribe failed', detail: String(e?.message || e), hasKV: !!(c.env && c.env.OUTBOX) }, 500);
        }
        return c.json({ ok: true });
    });

    app.post('/api/push/diag', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { body = {}; }
        const { inboxId, test } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { sub } = await getStores(c.env);
        const subs = await sub.list(inboxId);
        const mask = (s) => {
            const t = s?.token || s?.sub?.token || s?.sub?.endpoint || '';
            const tail = String(t).slice(-6);
            return { channel: s?.channel || 'web', idTail: tail ? `…${tail}` : null };
        };
        const channels = subs.map(mask);
        const result = { inboxId, count: subs.length, channels };
        try {
            const { proactive, kv } = await getStores(c.env);
            const recs = (proactive?.listByInbox ? await proactive.listByInbox(inboxId) : []) || [];
            result.avatars = [];
            for (const r of recs) {
                const url = r?.avatarUrl || null;
                let stored = null;
                if (url && kv) {
                    const m = String(url).match(/\/avatar\/([\w.-]+)$/);
                    if (m) {
                        const raw = await kv.get(`av:${m[1]}`).catch(() => null);
                        stored = raw ? `present(${raw.length}b)` : 'MISSING-in-KV';
                    } else stored = 'unparseable-url';
                }
                result.avatars.push({
                    charId: r?.charId ?? null, charName: r?.timeSpec?.charName ?? null,
                    avatarUrl: url, kvStatus: url ? stored : 'NO-avatarUrl-registered',
                });
            }
        } catch (e) { result.avatarsError = String(e?.message || e); }
        if (test && subs.length) {
            result.dispatch = subs.map((s) => ({
                channel: s?.channel || 'web', ok: null, gone: false,
                reason: '测试推送已停用',
            }));
        }
        return c.json(result);
    });

    app.post('/avatar', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { key, dataUrl } = body || {};
        if (!key || !/^[\w.-]{1,128}$/.test(key)) return c.json({ error: 'bad key' }, 400);
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return c.json({ error: 'dataUrl required' }, 400);
        const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return c.json({ error: 'bad dataUrl' }, 400);
        const mime = m[1], b64 = m[2];
        if (b64.length > 512 * 1024) return c.json({ error: 'avatar too large' }, 413);
        const { kv } = await getStores(c.env);
        if (!kv) return c.json({ error: 'no store' }, 503);
        try {
            await kv.put(`av:${key}`, JSON.stringify({ mime, b64 }), { expirationTtl: 60 * 60 * 24 * 60 });
        } catch (e) { return c.json({ error: 'put failed', detail: String(e?.message || e) }, 500); }
        return c.json({ ok: true, url: `/avatar/${key}` });
    });

    app.delete('/api/push/unsubscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, endpoint } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { sub } = await getStores(c.env);
        await sub.remove(inboxId, subscription || { endpoint });
        return c.json({ ok: true });
    });

    app.post('/proactive/register', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const {
            inboxId, userId, charId, promptTemplate, proactiveProfile, lifeState,
            intensity, proactiveBias, recentMessages, aiSettings, quietHours,
            charUtcOffsetSeconds, proactiveEnabledAt, lastInteractionAt, enabled,
            mode, interval, intervalUnit, probability, timeSpec, mcpContextServers, avatarUrl, notifPrivacy,
            mcpToolServers, mcpProactiveToolUse,
        } = body || {};
        if (!inboxId || userId == null || charId == null || !promptTemplate || !aiSettings) {
            return c.json({ error: 'inboxId / userId / charId / promptTemplate / aiSettings required' }, 400);
        }
        const { proactive } = await getStores(c.env);
        try {
        await proactive.upsert({
            inboxId, userId: String(userId), charId: String(charId),
            mode: mode === 'interval' ? 'interval' : 'impulse',
            interval: interval ?? 60, intervalUnit: intervalUnit || 'minutes', probability: probability || 'medium',
            promptTemplate, proactiveProfile: proactiveProfile || null, lifeState: lifeState || {},
            intensity: intensity || 'normal', proactiveBias: proactiveBias || 0,
            recentMessages: Array.isArray(recentMessages) ? recentMessages.slice(-PROACTIVE_WINDOW_CAP) : [],
            aiSettings, quietHours: quietHours || null,
            charUtcOffsetSeconds: charUtcOffsetSeconds ?? null,
            proactiveEnabledAt: proactiveEnabledAt || Date.now(),
            lastInteractionAt: lastInteractionAt || 0,
            enabled: enabled !== false,
            timeSpec: timeSpec || null,
            mcpContextServers: Array.isArray(mcpContextServers) ? mcpContextServers : [],
            mcpToolServers: Array.isArray(mcpToolServers) ? mcpToolServers : [],
            mcpProactiveToolUse: !!mcpProactiveToolUse,
            avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
            notifPrivacy: !!notifPrivacy,
        });
        } catch (e) {
            return c.json({ error: 'register failed', detail: String(e?.message || e), stack: String(e?.stack || '').split('\n').slice(0, 5).join(' | '), storeKind: proactive?.kind }, 500);
        }
        return c.json({ ok: true });
    });

    app.post('/proactive/privacy', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, notifPrivacy } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        const recs = (proactive?.listByInbox ? await proactive.listByInbox(inboxId) : []) || [];
        let updated = 0;
        for (const r of recs) {
            if (await proactive.patch(inboxId, String(r.userId), String(r.charId), { notifPrivacy: !!notifPrivacy })) updated++;
        }
        return c.json({ ok: true, updated });
    });

    app.post('/proactive/sync-messages', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId, recentMessages, lifeState, lastInteractionAt, promptTemplate, timeSpec } = body || {};
        if (!inboxId || userId == null || charId == null) return c.json({ error: 'inboxId / userId / charId required' }, 400);
        const { proactive } = await getStores(c.env);
        const patch = {};
        if (Array.isArray(recentMessages)) patch.recentMessages = recentMessages.slice(-PROACTIVE_WINDOW_CAP);
        if (lifeState) patch.lifeState = lifeState;
        if (typeof lastInteractionAt === 'number') patch.lastInteractionAt = lastInteractionAt;
        if (typeof promptTemplate === 'string' && promptTemplate) patch.promptTemplate = promptTemplate;
        if (timeSpec) patch.timeSpec = timeSpec;
        const ok = await proactive.patch(inboxId, String(userId), String(charId), patch);
        if (!ok) return c.json({ error: 'pair not registered' }, 404);
        return c.json({ ok: true });
    });

    app.post('/proactive/set-avatar', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId, avatarUrl } = body || {};
        if (!inboxId || userId == null || charId == null) return c.json({ error: 'inboxId / userId / charId required' }, 400);
        if (typeof avatarUrl !== 'string' || !avatarUrl) return c.json({ error: 'avatarUrl required' }, 400);
        const { proactive } = await getStores(c.env);
        const ok = await proactive.patch(inboxId, String(userId), String(charId), { avatarUrl });
        if (!ok) return c.json({ error: 'pair not registered' }, 404);
        return c.json({ ok: true });
    });

    app.get('/proactive/list', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        const recs = (proactive?.listByInbox ? await proactive.listByInbox(inboxId) : []) || [];
        return c.json({
            ok: true,
            pairs: recs.map(r => ({
                userId: String(r.userId), charId: String(r.charId),
                mode: r.mode, enabled: !!r.enabled,
                updatedAt: r.updatedAt || 0, lastFiredAt: r.lastFiredAt || 0,
            })),
        });
    });

    app.post('/proactive/unregister', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId } = body || {};
        if (!inboxId || userId == null || charId == null) return c.json({ error: 'inboxId / userId / charId required' }, 400);
        const { proactive } = await getStores(c.env);
        await proactive.remove(inboxId, String(userId), String(charId));
        return c.json({ ok: true });
    });

    app.post('/proactive/pause', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, paused, durationMs } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        if (paused === false) {
            await proactive.setPause(inboxId, 0);
            return c.json({ ok: true, paused: false });
        }
        const dur = Math.min(60 * 60 * 1000, Math.max(60 * 1000, Number(durationMs) || 10 * 60 * 1000));
        const until = nowMs() + dur;
        await proactive.setPause(inboxId, until);
        return c.json({ ok: true, paused: true, pausedUntil: until });
    });

    app.get('/proactive/status', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        const rows = await proactive.listByInbox(inboxId);
        return c.json({
            pairs: rows.map(r => ({
                userId: r.userId, charId: r.charId, enabled: r.enabled,
                windowSize: (r.recentMessages || []).length,
                lastFiredAt: r.lastFiredAt || 0, updatedAt: r.updatedAt,
            })),
        });
    });

    return app;
}
