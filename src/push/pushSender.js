// 企业微信 Webhook 推送实现
const WECOM_WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12415e03-8ac0-461a-9409-e2d8a02d8c78';

/**
 * 统一分发推送：改为直接发送至企业微信
 */
export async function dispatchPush(env, subscription, payload) {
    // 构造企业微信所需的 Markdown 格式消息
    const text = `**${payload.title || '糯叽机通知'}**\n\n${payload.body}\n\n> 角色ID: ${payload.charId || '未知'}`;

    try {
        const res = await fetch(WECOM_WEBHOOK, {
            method: 'POST',
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