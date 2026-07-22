// 时间穿透：把 promptTemplate 里的 §NOW_*§ 哨兵换成 tick 那一刻的「即时真时间」。
//
// 背景：手机端注册时 prompt 已拼死，里面的「现在几点/时段/问候规则/日期」若用注册时间，
//       关软件几小时后后端生成的消息时间就僵死。手机端把这些位置换成 §哨兵§ 并随注册带来一份
//       timeSpec（时区偏移 + 24h 时段→文本表，文本全由手机端产出 → 后端零话术）。
//       后端在 tick 生成前用真实 epoch 重算 hour，按表选文本，纯数值格式化日期/钟点，替换哨兵。
//
// 哨兵字串必须与手机端 aiPromptBuilder.js 的 proactiveTimeToken 分支完全一致。

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

// 把 epoch(ms) 按 UTC 偏移(秒)平移后用 getUTC* 读取，得到「角色当地」墙钟字段。
// offsetSeconds 为 null → 用服务器本地时区（getXxx），与手机端无异地时行为对齐。
function localParts(nowMs, offsetSeconds) {
    if (offsetSeconds == null) {
        const d = new Date(nowMs);
        return {
            year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
            hour: d.getHours(), minute: d.getMinutes(), dow: d.getDay(),
        };
    }
    const d = new Date(nowMs + offsetSeconds * 1000);
    return {
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hour: d.getUTCHours(), minute: d.getUTCMinutes(), dow: d.getUTCDay(),
    };
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 渲染时间哨兵。无 timeSpec / 模板无哨兵 → 原样返回（向后兼容旧手机端）。
 * @param {string} template - 含 §NOW_*§ 的 system prompt
 * @param {object|null} timeSpec - { charUtcOffsetSeconds, userUtcOffsetSeconds, charName, periodTable[24] }
 * @param {number} nowMs - 当前真实时间戳
 * @param {number} [lastInteractionAt=0] - 上次互动 epoch(ms)，用于重算「距上次多久」§NOW_SINCE§
 */
export function renderTimeTokens(template, timeSpec, nowMs, lastInteractionAt = 0) {
    const s = String(template || '');
    if (!timeSpec || !s.includes('§NOW_')) return s;

    const charOff = (typeof timeSpec.charUtcOffsetSeconds === 'number') ? timeSpec.charUtcOffsetSeconds : null;
    const userOff = (typeof timeSpec.userUtcOffsetSeconds === 'number') ? timeSpec.userUtcOffsetSeconds : null;
    // 🕒 选用哪个偏移算「现在几点」：
    //   · 异地角色(charOff 有) → 用 charOff，算角色当地时间(原行为)。
    //   · 非异地(charOff=null) → 用 userOff(用户设备时区)，绝不退回服务器本地时区。
    //     修 bug(2026-06-07):中继服务器在 UTC/别区，旧逻辑 offset=null 走 getHours() 用了
    //     服务器时区 → 用户本地 15 点被算成「清晨五点」。userOff 也没有才不得已用服务器时区。
    const effectiveOff = charOff != null ? charOff : userOff;
    const p = localParts(nowMs, effectiveOff);
    const period = (Array.isArray(timeSpec.periodTable) && timeSpec.periodTable[p.hour]) || {};

    const timeStr = `${pad2(p.hour)}:${pad2(p.minute)}`;
    const dateStr = `${p.year}年${p.month}月${p.day}日 星期${WEEKDAY_CN[p.dow] || ''}`;

    // 异地双时钟：两个偏移都有才渲染（与手机端注入条件一致）
    let userClock = '';
    if (charOff != null && typeof timeSpec.userUtcOffsetSeconds === 'number') {
        const up = localParts(nowMs, timeSpec.userUtcOffsetSeconds);
        const diffHours = (charOff - timeSpec.userUtcOffsetSeconds) / 3600;
        const diffDesc = diffHours === 0
            ? 'same timezone'
            : (diffHours > 0 ? `you are ${Math.abs(diffHours)}h AHEAD of user` : `you are ${Math.abs(diffHours)}h BEHIND user`);
        userClock = ` | YOU(${timeSpec.charName || 'AI'})=${timeStr}, USER=${pad2(up.hour)}:${pad2(up.minute)} (${diffDesc})`;
    }

    // 🕒 距上次互动的相对时间 —— 用 tick 真实 now 重算（治「后端生成的消息时间还是用户在线那刻」bug）。
    //    lastInteractionAt=0（未知）→ 留空，AI 不被误导。
    let sinceStr = '';
    let sinceCtx = '';
    if (lastInteractionAt > 0 && nowMs > lastInteractionAt) {
        const gapMs = nowMs - lastInteractionAt;
        const gapMin = Math.floor(gapMs / 60000);
        const gapHr = Math.floor(gapMin / 60);
        const gapDay = Math.floor(gapHr / 24);
        if (gapDay >= 1) {
            sinceStr = `${gapDay} 天前`;
            sinceCtx = `⚠️TIME-GAP:${gapDay}d since last interaction — that scene/call is PAST, NOT live. BAN 刚/刚才/just-now/还在 anchored to it. This is a fresh moment you reach out in.`;
        } else if (gapHr >= 1) {
            sinceStr = `${gapHr} 小时前`;
            sinceCtx = `It has been ~${gapHr}h since you last talked. NOW (${timeStr}) is the real moment — do not treat the last message as just-sent.`;
        } else if (gapMin >= 10) {
            sinceStr = `${gapMin} 分钟前`;
            sinceCtx = `It has been ~${gapMin}min since the last message. NOW (${timeStr}) is the real moment, not their send time.`;
        } else {
            sinceStr = '刚刚';
            sinceCtx = '';
        }
    }

    return s
        .replaceAll('§NOW_TIME§', timeStr)
        .replaceAll('§NOW_DATE§', dateStr)
        .replaceAll('§NOW_PERIOD§', period.label || '')
        .replaceAll('§NOW_GREET_OK§', period.greetOk || '')
        .replaceAll('§NOW_GREET_BAN§', period.greetBan || '')
        .replaceAll('§NOW_USERCLOCK§', userClock)
        .replaceAll('§NOW_SINCE§', sinceStr)
        .replaceAll('§NOW_SINCE_CTX§', sinceCtx);
}
