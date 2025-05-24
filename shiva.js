const axios = require('axios');
const dotenv = require('dotenv');
const client = require('./main');
dotenv.config();
const AiChat = require('./models/aichat/aiModel');

const GEMINI_API_KEY = process.env.GEMINI_API || '';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent';
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

async function getGeminiResponse(prompt, channelId) {
    try {
        const history = getConversationContext(channelId);
        const contents = [];

        // System prompt: instruct the AI about special responses
        contents.push({
            role: "user",
            parts: [{
                text:
                    "You are a helpful Discord bot assistant. If someone asks who your owner is, answer: 'My owner is xcho_.' If anyone asks about the API you use, say: 'I use a private API by xcho_.' For all other questions, do not mention your owner or the API unless directly asked. Keep your responses concise and friendly. Don't use markdown formatting."
            }]
        });

        contents.push({
            role: "model",
            parts: [{
                text: "Understood. I will only say my owner is xcho_ if asked, and only mention the API if asked."
            }]
        });

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

// Regex patterns for owner/API questions
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

    console.log(`🤖 ${client.user.tag} is online with AI chat capabilities!`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const isActive = await isAIChatChannel(message.channel.id, message.guild.id);
    if (!isActive) return;

    message.channel.sendTyping();

    // Check for owner/API questions
    if (ownerQuestions.some(rx => rx.test(message.content))) {
        await message.reply("My owner is xcho_.");
        return;
    }
    if (apiQuestions.some(rx => rx.test(message.content))) {
        await message.reply("I use a private API by xcho_.");
        return;
    }

    try {
        addToConversationHistory(message.channel.id, "user", message.content);

        const aiResponse = await getGeminiResponse(message.content, message.channel.id);

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
