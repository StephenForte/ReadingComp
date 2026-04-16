const Anthropic = require("@anthropic-ai/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

async function callClaude(prompt, config) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].text;
}

async function callOpenAI(prompt, config) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content;
}

async function callGemini(prompt, config) {
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: config.model,
    generationConfig: {
      maxOutputTokens: config.max_tokens,
      temperature: config.temperature,
    },
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

const providers = {
  claude: callClaude,
  openai: callOpenAI,
  gemini: callGemini,
};

async function callLLM(prompt, providerName, providerConfig) {
  const handler = providers[providerName];
  if (!handler) {
    throw new Error(`Unknown provider: ${providerName}. Valid: ${Object.keys(providers).join(", ")}`);
  }
  return handler(prompt, providerConfig);
}

module.exports = { callLLM };
