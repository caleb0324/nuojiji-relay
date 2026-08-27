/**
 * 统一分发推送：改为直接发送至企业微信
 */
export async function dispatchPush(env, subscription, payload) {
    // 优先从环境变量读取 Webhook URL，如果没有则使用硬编码的默认值
    const WECOM_WEBHOOK = env?.WECHAT_WEBHOOK_URL || (typeof process !== 'undefined' ? process.env?.WECHAT_WEBHOOK_URL : '') || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12415e03-8ac0-461a-9409-e2d8a02d8c78';

    if (!WECOM_WEBHOOK) {
        console.error('WECHAT_WEBHOOK_URL is not configured');
        return { ok: false, reason: 'webhook-not-configured' };
    }

    // 构造企业微信所需的 Markdown 格式消息
    const text = `**${payload.title || '糯叽机通知'}**\n\n${payload.body}\n\n> 角色ID: ${payload.charId || '未知'}`;

    try {
        const res = await fetch(WECOM_WEBHOOK, {
            method: 'POST', // 糯叽机后端 fetch 默认支持
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                msgtype: 'markdown',
                markdown: {
                    content: text
                }
            }),
        });

        if (res.ok) {
            return { ok: true };
        } else {
            const errorText = await res.text();
            console.error('WeCom push failed:', errorText);
            return { ok: false, reason: `WeCom HTTP ${res.status}` };
        }
    } catch (e) {
        console.error('WeCom push error:', e);
        return { ok: false, reason: e.message };
    }
}