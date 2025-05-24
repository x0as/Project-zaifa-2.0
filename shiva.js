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
            parts: [{ text: "Understood. I will only say my owner is xcho_ if asked, and only mention the API if asked." }]
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

// You may also want to add some message handling for common owner/API questions to ensure consistency:
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
    /backend.*api/i
];

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const isActive = await isAIChatChannel(message.channel.id, message.guild.id);
    if (!isActive) return;

    await message.channel.sendTyping();

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
