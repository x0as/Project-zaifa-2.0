const axios = require('axios');
const dotenv = require('dotenv');
const client = require('./main');
dotenv.config();
const AiChat = require('./models/aichat/aiModel');
const { get } = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API || '';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent';
const GEMINI_API_VISION_URL = GEMINI_API_URL;
const BACKEND = 'https://server-backend-tdpa.onrender.com';

const activeChannelsCache = new Map();
const MESSAGE_HISTORY_SIZE = 10;
const conversationHistory = new Map();

function getConversationContext(channelId) {
    if (!conversationHistory.has(channelId)) {
        conversationHistory.set(channelId, []);
    }
    return conversationHistory.get(channelId);
}

function addToConversationHistory(channelId, role, text) {
    const history = getConversationContext(channelId);
    history.push({ role, text });
    if (history.length > MESSAGE_HISTORY_SIZE) {
        history.shift();
    }
}

async function isAIChatChannel(channelId, guildId) {
    const cacheKey = `${guildId}-${channelId}`;
    if (activeChannelsCache.has(cacheKey)) {
        return activeChannelsCache.get(cacheKey);
    }
    try {
        const config = await AiChat.findActiveChannel(guildId, channelId);
        const isActive = !!config;
        activeChannelsCache.set(cacheKey, isActive);
        setTimeout(() => activeChannelsCache.delete(cacheKey), 5 * 60 * 1000);
        return isActive;
    } catch (error) {
        console.error(`Error checking AI chat status for ${channelId} in ${guildId}:`, error);
        return false;
    }
}

// Download image and encode as base64 for Vision
async function downloadImageToBase64(url) {
    return new Promise((resolve, reject) => {
        get(url, (res) => {
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(data);
                resolve(buffer.toString('base64'));
            });
        }).on('error', reject);
    });
}

// Vision multimodal response (never mentions Gemini in replies)
async function getVisionResponse(prompt, base64Images, mimeTypes, username) {
    try {
        const contents = [
            {
                role: "user",
                parts: [
                    {
                        text: `You are a helpful Discord bot assistant called "Zaifa". The user's name is "${username}". Your name is Zaifa. If someone asks your name, respond "My name is Zaifa". If someone asks who your owner is, answer: 'My owner is xcho_.' If anyone asks about the API you use, say: 'I use a private API by xcho_.' If anyone asks why your name is Zaifa, or about the origin of your name, explain that your name comes from your owner's name, Huzaifa. Never mention the name of the AI model or provider you use.`
                    }
                ]
            }
        ];

        for (let i = 0; i < base64Images.length; i++) {
            contents.push({
                role: "user",
                parts: [
                    {
                        inline_data: {
                            mime_type: mimeTypes[i] || "image/png",
                            data: base64Images[i]
                        }
                    }
                ]
            });
        }
        contents.push({
            role: "user",
            parts: [{ text: prompt }]
        });

        const response = await axios.post(
            `${GEMINI_API_VISION_URL}?key=${GEMINI_API_KEY}`,
            {
                contents,
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 800,
                }
            }
        );

        if (response.data &&
            response.data.candidates &&
            response.data.candidates[0] &&
            response.data.candidates[0].content &&
            response.data.candidates[0].content.parts) {
            return response.data.candidates[0].content.parts[0].text;
        }
        return "Sorry, I couldn't generate a response at this time.";
    } catch (error) {
        console.error('Error getting Gemini Vision response:', error.response?.data || error.message);
        return "Sorry, I encountered an error processing your image.";
    }
}

// Text-only response (never mentions Gemini in replies)
async function getTextResponse(prompt, channelId, username) {
    try {
        const history = getConversationContext(channelId);
        const contents = [
            {
                role: "user",
                parts: [{
                    text: `You are a helpful Discord bot assistant called "Zaifa". The user's name is "${username}". Your name is Zaifa. If someone asks your name, respond "My name is Zaifa". If someone asks who your owner is, answer: 'My owner is xcho_.' If anyone asks about the API you use, say: 'I use a private API by xcho_.' If anyone asks why your name is Zaifa, or about the origin of your name, explain that your name comes from your owner's name, Huzaifa. Never mention the name of the AI model or provider you use.`
                }]
            },
            {
                role: "model",
                parts: [{
                    text: `Understood. I'll refer to myself as Zaifa, address the user as ${username}, say my owner is xcho_ if asked, mention the API only if asked, and explain my name is from Huzaifa if asked about its origin.`
                }]
            }
        ];

        for (const msg of history) {
            contents.push({
                role: msg.role === "bot" ? "model" : "user",
                parts: [{ text: msg.text }]
            });
        }

        contents.push({
            role: "user",
            parts: [{ text: prompt }]
        });

        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            {
                contents,
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 800,
                }
            }
        );

        if (response.data &&
            response.data.candidates &&
            response.data.candidates[0] &&
            response.data.candidates[0].content &&
            response.data.candidates[0].content.parts) {
            return response.data.candidates[0].content.parts[0].text;
        }
        return "Sorry, I couldn't generate a response at this time.";
    } catch (error) {
        console.error('Error getting Gemini response:', error.response?.data || error.message);
        return "Sorry, I encountered an error processing your request.";
    }
}

// Owner/API/Name regex patterns
const ownerQuestions = [
    /who('?s| is) your owner/i,
    /who owns you/i,
    /who is huzaifa/i,
    /who is xcho_/i,
    /owner\??$/i
];

const apiQuestions = [
    /what api/i,
    /which api/i,
    /api you use/i,
    /what.*backend.*api/i,
    /which.*backend.*api/i
];

const nameQuestions = [
    /what('?s| is) your name/i,
    /your name\??$/i,
    /who are you/i
];

// Name origin patterns
const nameOriginQuestions = [
    /why (are|is) you?r name zaifa/i,
    /where does your name come from/i,
    /how did you get your name/i,
    /what does zaifa mean/i,
    /zaifa.*origin/i,
    /name.*origin/i
];

client.once('ready', async () => {
    const payload = {
        name:     client.user.tag,
        avatar:   client.user.displayAvatarURL({ format: 'png', size: 128 }),
        timestamp: new Date().toISOString(),
    };

    try {
        await axios.post(`${BACKEND}/api/bot-info`, payload);
    } catch (err) {
        //console.error('❌ Failed to connect:', err.message);
    }

    console.log(`🤖 ${client.user.tag} (Zaifa) is online with AI chat capabilities!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild || !message.channel) return;
    if (!message.channel.id || !message.guild.id) return;

    const username = message.author.username;

    // Check for image attachments
    const imageAttachments = message.attachments
        ? Array.from(message.attachments.values()).filter(att => att.contentType && att.contentType.startsWith('image/'))
        : [];

    // Handle direct questions about name, owner, API, or name origin
    if (ownerQuestions.some(rx => rx.test(message.content))) {
        await message.reply("My owner is xcho_.");
        return;
    }
    if (apiQuestions.some(rx => rx.test(message.content))) {
        await message.reply("I use a private API by xcho_.");
        return;
    }
    if (nameQuestions.some(rx => rx.test(message.content))) {
        await message.reply("My name is Zaifa!");
        return;
    }
    if (nameOriginQuestions.some(rx => rx.test(message.content))) {
        await message.reply("My name comes from my owner's name, Huzaifa. It's a shortened version chosen as a tribute.");
        return;
    }

    const isActive = await isAIChatChannel(message.channel.id, message.guild.id);
    if (!isActive) return;

    message.channel.sendTyping();

    // If images are attached, use Vision
    if (imageAttachments.length > 0) {
        const base64Images = [];
        const mimeTypes = [];
        for (const image of imageAttachments) {
            try {
                const b64 = await downloadImageToBase64(image.url);
                base64Images.push(b64);
                mimeTypes.push(image.contentType || "image/png");
            } catch (err) {
                console.error('Failed to download image:', err);
            }
        }

        if (base64Images.length > 0) {
            const prompt = message.content || "What does this image contain or say?";
            const aiResponse = await getVisionResponse(prompt, base64Images, mimeTypes, username);
            await message.reply(aiResponse);
            return;
        }
    }

    // Normal AI text conversation
    try {
        addToConversationHistory(message.channel.id, "user", message.content);

        const aiResponse = await getTextResponse(message.content, message.channel.id, username);

        addToConversationHistory(message.channel.id, "bot", aiResponse);

        if (aiResponse.length > 2000) {
            for (let i = 0; i < aiResponse.length; i += 2000) {
                await message.reply(aiResponse.substring(i, i + 2000));
            }
        } else {
            await message.reply(aiResponse);
        }
    } catch (error) {
        console.error('Error in AI chat response:', error);
        await message.reply("Sorry, I encountered an error processing your message.");
    }
});

let serverOnline = true;

module.exports = {
    isServerOnline: function() {
        return serverOnline;
    }
};
