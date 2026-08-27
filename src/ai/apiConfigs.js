// AI 提供商配置 —— 从糯叽机 APP 的 src/utils/aiApiService.js 端口过来。
// ⚠️ 与 nuojiji APP 的 aiApiService.js (API_TYPES / API_CONFIGS / extractContent) 保持同步。
//    APP 那边改了响应解析格式，这里也要跟着改，否则服务端生成的内容解不出来。

export const API_TYPES = {
    OPENAI: 'openai',
    GEMINI: 'gemini',
    CLAUDE: 'claude',
    CUSTOM: 'custom',
};

export const ANTHROPIC_API_VERSION = '2023-06-01';

// 各家「非流式」响应里怎么取正文。服务端永远 stream:false，只需 extractContent。
export const API_CONFIGS = {
    [API_TYPES.OPENAI]: {
        name: 'OpenAI',
        defaultModel: 'gpt-3.5-turbo',
        extractContent: (data) => data.choices?.[0]?.message?.content ?? null,
        extractStreamDelta: (data) => data.choices?.[0]?.delta?.content ?? null,
    },
    [API_TYPES.GEMINI]: {
        name: 'Google Gemini',
        defaultModel: 'gemini-pro',
        extractContent: (data) => {
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
            return null;
        },
        extractStreamDelta: (data) => {
            if (data.choices?.[0]?.delta?.content) return data.choices[0].delta.content;
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
            return null;
        },
    },
    [API_TYPES.CLAUDE]: {
        name: 'Anthropic Claude',
        defaultModel: 'claude-3-sonnet',
        extractContent: (data) => {
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
            if (data.content?.[0]?.text) return data.content[0].text;
            return null;
        },
        extractStreamDelta: (data) => {
            if (data.choices?.[0]?.delta?.content) return data.choices[0].delta.content;
            if (data.delta?.text) return data.delta.text;
            return null;
        },
    },
    [API_TYPES.CUSTOM]: {
        name: '自定义API',
        defaultModel: 'custom-model',
        extractContent: (data) => {
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
            if (data.content?.[0]?.text) return data.content[0].text;
            if (data.text) return data.text;
            if (typeof data === 'string') return data;
            return null;
        },
        extractStreamDelta: (data) => {
            if (data.choices?.[0]?.delta?.content) return data.choices[0].delta.content;
            if (data.delta?.content) return data.delta.content;
            if (data.content) return data.content;
            return null;
        },
    },
};

export function getApiConfig(apiType) {
    return API_CONFIGS[apiType] || API_CONFIGS[API_TYPES.OPENAI];
}
