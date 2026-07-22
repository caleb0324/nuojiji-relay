// Cron tick：遍历已启用的 pair，重算 impulse，命中则实时调 AI 生成主动消息 → outbox + 推送。
// worker.js 的 scheduled 和 server.js 的 node-cron 都调 runProactiveTick(env)。

import { createProactiveStore, BACKEND_FIRE_COOLDOWN_MS, BACKEND_FAIL_COOLDOWN_MS, PROACTIVE_WINDOW_CAP } from '../store/proactiveStore.js';
import { createOutboxStore } from '../store/outboxStore.js';
import { createSubStore } from '../store/subStore.js';
import { shouldFire, shouldFireInterval } from './impulseEngine.js';
import { runGeneration } from '../ai/aiCaller.js';
import { dispatchPush } from '../push/pushSender.js';
import { nowMs, extractPushBodies } from '../util/ids.js';
import { renderTimeTokens } from '../util/timeTokens.js';
import { buildMemoryContext } from './mcpContext.js';
import { runProactiveToolLoop } from './proactiveToolPrefetch.js';

// 把滑窗消息渲染成转录文本（喂进 promptTemplate 的 {{RECENT_MESSAGES}}）
function renderTranscript(recentMessages) {
    if (!Array.isArray(recentMessages) || recentMessages.length === 0) return '(no recent messages)';
    return recentMessages.map((m) => {
        const who = (m.sender === 'me' || m.role === 'user') ? 'User' : 'Char';
        const text = m.text || m.content || '';
        return `${who}: ${text}`;
    }).join('\n');
}

// 占位替换：后端唯一接触 prompt 的地方，只做字符串替换，无任何话术。
function fillTemplate(template, { transcript, reason, memory }) {
    return String(template || '')
        .replaceAll('{{RECENT_MESSAGES}}', transcript)
        .replaceAll('{{IMPULSE_REASON}}', reason || '')
        .replaceAll('{{MEMORY_CONTEXT}}', memory || '');
}

// 单轮 tick 的墙钟预算：Workers scheduled 有 CPU/时长上限，串行遍历所有 pair 同步调 AI
//   （每个最长 180s）必然超时被杀 → 排后面的 pair 永不触发。给一个保守预算，超了就停，
//   靠轮转游标下轮接着处理（pairsCursor）。Cloudflare 免费版 CPU 上限较紧，取 25s。
const TICK_WALL_BUDGET_MS = 25_000;

export async function runProactiveTick(env) {
    const proactive = await createProactiveStore(env);
    const outbox = await createOutboxStore(env);
    const sub = await createSubStore(env);
    const now = nowMs();
    const tickStart = Date.now();

    // 🔒 重入锁：Workers scheduled 无重入守卫，tick 超 60s 时下一轮 cron 会并发 → 同一 pair 双发双扣费。
    //    抢不到锁（已有 tick 在跑）就直接退出本轮。锁带 TTL，tick 崩溃也会自动释放。
    //    ⚠️ TTL 必须 ≥ 单 pair 最长耗时：tool-loop(≤25s 预算) + runGeneration(≤180s) + 余量 → 取 300s。
    //    旧值 120s < 180s 生成 → 锁会在生成中途过期 → 下轮 cron 抢到锁并发 → 双发隐患复活。
    //    （CAS claimFireIfStale 仍兜底防同一对双发，长锁是第二道防线 + 防多 pair 重叠空耗。）
    const TICK_LOCK_TTL_MS = 300_000;
    let lockHeld = false;
    try { lockHeld = await proactive.acquireTickLock?.(TICK_LOCK_TTL_MS); } catch { lockHeld = true; /* 不支持锁的实现照旧跑 */ }
    if (lockHeld === false) {
        return { pairs: 0, fired: 0, skipped: 'locked' };
    }

    try {

    const allPairs = await proactive.listEnabled();
    // 🔄 轮转游标：从上轮停下的位置接着处理，保证规模化时每个 pair 最终都轮到（防永远只处理前缀）。
    let startIdx = 0;
    try {
        const cur = await proactive.getTickCursor?.();
        if (typeof cur === 'number' && cur > 0) startIdx = cur % Math.max(1, allPairs.length);
    } catch { /* 不支持游标：从 0 开始 */ }
    const pairs = startIdx > 0 ? [...allPairs.slice(startIdx), ...allPairs.slice(0, startIdx)] : allPairs;
    let fired = 0;
    let processed = 0;

    // inbox 级暂停缓存：用户走线下剧情时手机端调 /proactive/pause，该 inbox 整个跳过本轮生成。
    // 同一 inbox 多对只查一次。
    const pauseCache = new Map();
    async function isInboxPaused(inboxId) {
        if (pauseCache.has(inboxId)) return pauseCache.get(inboxId);
        let paused = false;
        try { paused = (await proactive.getPausedUntil(inboxId)) > now; } catch { paused = false; }
        pauseCache.set(inboxId, paused);
        return paused;
    }

    for (const rec of pairs) {
        // ⏱️ 墙钟预算：超了就停，剩余 pair 留到下轮（游标已记到 processed 位置）。
        if (Date.now() - tickStart > TICK_WALL_BUDGET_MS) {
            console.warn(`[proactive] tick 墙钟预算用尽，本轮处理 ${processed}/${pairs.length}，剩余下轮继续`);
            break;
        }
        processed++;
        try {
            // 走线下剧情中：跳过该 inbox 的所有主动生成（用户在前台沉浸剧情，不该被线上消息打断）
            if (await isInboxPaused(rec.inboxId)) continue;

            // 后端冷却（快照早跳过，省掉后面 verdict/记忆/工具的开销）：用 listEnabled 拍的快照先粗筛。
            //    ⚠️ 这只是早跳过，不是权威判定——快照可能过期（两轮重叠 cron 都拍到旧值），
            //    权威判定在生成前用 claimFireIfStale 做 CAS（见下）。
            if (rec.lastFiredAt && (now - rec.lastFiredAt) < BACKEND_FIRE_COOLDOWN_MS) continue;

            // 两种触发档：'impulse'(真人模式) / 'interval'(普通后台主动，计时+概率高中低)
            let verdict;
            if (rec.mode === 'interval') {
                verdict = shouldFireInterval({
                    now, lastFiredAt: rec.lastFiredAt || 0,
                    interval: rec.interval, intervalUnit: rec.intervalUnit, probability: rec.probability,
                });
            } else {
                verdict = shouldFire({
                    profile: rec.proactiveProfile,
                    lifeState: rec.lifeState,
                    now,
                    lastInteractionAt: rec.lastInteractionAt || 0,
                    scheduleCtx: null, // 设备专属，后端无
                    intensity: rec.intensity || 'normal',
                    unansweredStreak: (rec.lifeState && rec.lifeState.unansweredStreak) || 0,
                    proactiveEnabledAt: rec.proactiveEnabledAt || 0,
                    proactiveBias: rec.proactiveBias || 0,
                    userActiveAt: 0, // 设备专属信号，后端默认 0
                    charUtcOffsetSeconds: rec.charUtcOffsetSeconds ?? null,
                    // 🕒 用户设备时区(秒)：非异地时用它算小时，绝不退回服务器时区。
                    userUtcOffsetSeconds: (typeof rec.timeSpec?.userUtcOffsetSeconds === 'number')
                        ? rec.timeSpec.userUtcOffsetSeconds : null,
                });
            }

            if (!verdict.fire) continue;

            // 🔒 权威条件抢占（CAS）：在【生成之前】新读一次 lastFiredAt，仍在冷却外才抢。
            //    防三种重复:①旧码生成后才写→慢生成期间下轮重发(claimFire 生成前写已解决)
            //    ②sync-messages 整条 patch 覆盖抢槽(拆独立 pf: key 已解决)
            //    ③两轮重叠 cron 各拍 tick 开头快照都过冷却闸→同一对双发(本 CAS 解决:第二轮新读到
            //      第一轮刚抢的值→claimFireIfStale 返回 false→跳过)。
            //    写独立 key，不走 patch(整条 blob)，否则会被 sync 覆盖。
            const claimed = await proactive.claimFireIfStale(
                rec.inboxId, rec.userId, rec.charId, now, BACKEND_FIRE_COOLDOWN_MS
            );
            if (!claimed) continue; // 别的 tick 刚抢了这一对 → 跳过，绝不双发

            // 命中 → 实时生成。messages 只有一条 system（手机端拼好的完整 prompt + 填充滑窗）
            let transcript = renderTranscript(rec.recentMessages);
            // 🧠 直连第三方记忆 MCP 检索（关软件也能用最新记忆）；失败/无配置 → 空串不阻断生成。
            let memory = '';
            try {
                memory = await buildMemoryContext(
                    rec.mcpContextServers,
                    rec.recentMessages,
                    { userId: rec.userId, characterId: rec.charId }
                );
            } catch (e) {
                console.warn('[proactive] memory context failed:', e?.message);
            }
            // 🛠️ 主动用工具（action-mode MCP tool-loop）：用户开了 mcpProactiveToolUse 时，角色主动开口前
            //    先决策是否调工具（搜热搜/新闻等），把素材拼进转录。受 tick 墙钟预算约束（deadline 到点即停），
            //    失败静默降级不挡生成。与手机端 prefetchMcpToolResults(proactiveMode) 同语义。
            if (rec.mcpProactiveToolUse && Array.isArray(rec.mcpToolServers) && rec.mcpToolServers.length) {
                try {
                    const enrichment = await runProactiveToolLoop(
                        rec.mcpToolServers, rec.recentMessages, rec.aiSettings,
                        { userId: rec.userId, characterId: rec.charId, deadline: tickStart + TICK_WALL_BUDGET_MS }
                    );
                    if (enrichment) transcript = transcript + enrichment;
                } catch (e) {
                    console.warn('[proactive] tool loop failed:', e?.message);
                }
            }
            // 先填即时真时间哨兵（§NOW_*§），再填滑窗/理由/记忆占位符。
            const timedTemplate = renderTimeTokens(rec.promptTemplate, rec.timeSpec, now, rec.lastInteractionAt || 0);
            const systemContent = fillTemplate(timedTemplate, { transcript, reason: verdict.reason, memory });
            // ⚠️ 必须追加一条 user 占位（与 APP 本地路径 useAIRespond.js 的「请开始回复。」对齐）：
            //    只有 system 一条时，OpenAI/Claude 能跑，但走 gemini 反代（OpenAI→Gemini 转译）时
            //    system 会被塞进 systemInstruction、不进 contents，导致 contents 为空 → 代理报
            //    「contents is required」500。补一条 user 让 contents 非空，四种 apiType 行为一致。
            const messages = [
                { role: 'system', content: systemContent },
                { role: 'user', content: '请开始回复。' },
            ];

            let content = null, error = null;
            try {
                content = await runGeneration(rec.aiSettings, messages, rec.aiSettings?.maxTokens || null);
            } catch (e) {
                error = String(e?.message || e);
            }

            // 生成失败：设「短冷却」而非回退到原值或白占满 20min。
            //    把 lastFiredAt 设成 now-(20min-5min) → 冷却闸算出来还剩 5min 就放行。
            //    既不会 API 持续报错时每分钟 cron 重试烧钱，又不让用户等满 20min 才收到下一条。
            //    失败不入 outbox（手机端对 error item 一律丢弃）、不发推送、不推进 lifeState/streak。
            if (error) {
                const failMark = now - (BACKEND_FIRE_COOLDOWN_MS - BACKEND_FAIL_COOLDOWN_MS);
                await proactive.claimFire(rec.inboxId, rec.userId, rec.charId, failMark);
                console.warn('[proactive] generation failed, short cooldown 5min:', error);
                continue;
            }

            const requestId = `proactive_${rec.userId}_${rec.charId}_${now}`;
            const item = {
                id: `relay_${requestId}`, requestId,
                charId: rec.charId, userId: rec.userId,
                roundId: requestId, content, error, createdAt: nowMs(),
                proactive: true,
            };
            await outbox.put(rec.inboxId, item);

            // 🔑 把 char 自己刚发的消息追加进后端滑窗，否则 user 一直不回复时，下次 tick 用的
            //    还是同一份旧上下文 → AI 看不到自己发过什么 → 反复说类似的话 = 重复消息。
            //    手机端排水后会异步 sync 覆盖这份（带完整字段），这里只是保证「自己发的」立刻进上下文。
            //    用 extractPushBodies 拆成每个气泡一条（与推送/手机端入库口径一致，过滤隐藏类型）。
            let nextWindow = Array.isArray(rec.recentMessages) ? rec.recentMessages : [];
            if (content) {
                const selfBubbles = extractPushBodies(content)
                    .filter(b => b && b !== '有新消息' && b !== '有新消息，点开查看')
                    .map(text => ({ sender: 'char', text }));
                if (selfBubbles.length) {
                    nextWindow = [...nextWindow, ...selfBubbles].slice(-PROACTIVE_WINDOW_CAP);
                }
            }

            // 简单更新后端 lifeState（完整 evolve 仍在手机端，下次 sync 覆盖）
            // lastFiredAt 已在生成前抢占落库，这里不再重复设。
            const ls = rec.lifeState || {};
            // 📈 自增「连续未回复」：后端自己发了一条而 user 没回（user 回了的话手机端 sync 会把
            //    streak 清 0 并覆盖整份 lifeState）。streak 是真人模式防轰炸的核心闸门
            //    （>=streakHardCap 硬跳过 + 每级降低 impulse 分），后端不自增 → 闸门永远失效 →
            //    user 一直不回时反复主动 = 重复消息。仅 impulse 模式自增（interval 模式不看 streak）。
            const prevStreak = (ls.unansweredStreak || 0);
            const nextStreak = (rec.mode === 'interval') ? prevStreak : prevStreak + 1;
            await proactive.patch(rec.inboxId, rec.userId, rec.charId, {
                lifeState: { ...ls, lastImpulseAt: now, lastProactiveSentAt: now, unansweredStreak: nextStreak },
                recentMessages: nextWindow,
                // 🕒 自己刚发完 → lastInteractionAt 也推进到现在，否则「距上次多久」一直从旧时间算，
                //    下次 tick 会以为隔了很久（其实自己刚发过）→ 误触发频繁主动 / since 文本失真。
                lastInteractionAt: now,
            });

            // 发推送叫醒——像微信那样【逐条气泡分开弹 + 带消息内容 + 角色名标题】，
            // 与 /generate 路径一致（extractPushBodies 把 AI 的 JSON-Lines 拆成每个气泡一条文本）。
            // ⚠️ 生成失败（502 等）不发推送：手机端排水对 error item 一律丢弃不写气泡，
            //    若仍弹通知 → 用户点进聊天却没有消息 = 假通知。失败静默，等下次 tick 重试。
            if (!error) try {
                const subs = await sub.list(rec.inboxId);
                if (subs.length) {
                    const title = rec.timeSpec?.charName || '糯叽机';
                    // 🔒 通知隐私模式：正文换「你有一条新消息」，标题(角色名)/头像保留。仍逐气泡发以保持节奏一致。
                    // H5：封顶推送条数。气泡数 × 订阅数 = 子请求数，超 Workers 上限(50/1000)后 fetch 抛错
                    //   被吞 → 静默丢推送。封顶最多 8 条气泡（消息正文不受影响，已全在 outbox），防超限。
                    const rawBodies = rec.notifPrivacy
                        ? extractPushBodies(content).map(() => '你有一条新消息')
                        : extractPushBodies(content);
                    const bodies = rawBodies.slice(0, 8);
                    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                    let i = 0;
                    for (const body of bodies) {
                        // 逐条之间加真人节奏延迟（按字数估打字时长），第一条立即发。封顶防 Worker 超时。
                        if (i > 0) {
                            const delay = Math.min(4000, 600 + (body?.length || 0) * 120);
                            await sleep(delay);
                        }
                        const payload = {
                            title, body, charId: rec.charId, userId: rec.userId, kind: 'relay-outbox',
                            // 🖼️ iOS 通知扩展用：头像 URL + 发信人名 + 会话 id → Communication Notification 左侧头像
                            avatarUrl: rec.avatarUrl || null,
                            senderName: title,
                            conversationId: `${rec.userId}_${rec.charId}`,
                            mutableContent: true,
                        };
                        for (const s of subs) {
                            const res = await dispatchPush(env, s, payload);
                            if (res?.gone) await sub.remove(rec.inboxId, s);
                        }
                        i++;
                    }
                }
            } catch (e) { console.warn('[proactive] push failed:', e?.message); }

            fired++;
        } catch (e) {
            console.warn('[proactive] pair tick failed:', e?.message);
        }
    }

    // 🔄 保存轮转游标到「本轮处理到的绝对位置」，下轮从这接着扫（防总处理前缀、后面 pair 饿死）。
    try {
        const nextCursor = allPairs.length ? (startIdx + processed) % allPairs.length : 0;
        await proactive.setTickCursor?.(nextCursor);
    } catch { /* 不支持游标：忽略 */ }

    return { pairs: pairs.length, processed, fired };

    } finally {
        // 释放重入锁（即使中途抛错也释放，避免锁残留挡住后续 tick；TTL 是二重保险）。
        try { await proactive.releaseTickLock?.(); } catch { /* ignore */ }
    }
}