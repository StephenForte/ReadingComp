const { GoogleGenerativeAI } = require("@google/generative-ai");

// Handles both Gemini and Gemma models via Google's Generative Language API
async function callGoogle(prompt, config) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in .env");
  }
  const client = new GoogleGenerativeAI(apiKey);
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

async function callLMStudio(prompt, config) {
  const baseURL = (config.base_url || "http://localhost:1234").replace(/\/v1\/?$/, "");

  // Get the first loaded model from LM Studio
  const modelsRes = await fetch(`${baseURL}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`Could not fetch LM Studio models: ${modelsRes.status}`);
  }
  const modelsData = await modelsRes.json();
  if (!modelsData.data || modelsData.data.length === 0) {
    throw new Error("No models loaded in LM Studio. Please load a model first.");
  }
  const modelId = modelsData.data[0].id;
  console.log(`Using LM Studio model: ${modelId}`);

  const url = `${baseURL}/api/v1/chat`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      input: prompt,
      max_output_tokens: config.max_tokens,
      temperature: config.temperature,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM Studio returned ${response.status}: ${text}`);
  }

  const data = await response.json();

  if (data.output) {
    const message = data.output.find((o) => o.type === "message");
    if (message) return message.content;
    throw new Error("LM Studio response had no message in output");
  }

  if (data.choices) {
    return data.choices[0].message.content;
  }

  throw new Error("Unexpected LM Studio response format");
}

// Provider keys match the keys in config.json > providers
const providers = {
  "gemma-cloud": callGoogle,
  lmstudio: callLMStudio,
};

async function callLLM(prompt, providerName, providerConfig) {
  const handler = providers[providerName];
  if (!handler) {
    throw new Error(`Unknown provider: ${providerName}. Valid: ${Object.keys(providers).join(", ")}`);
  }
  return handler(prompt, providerConfig);
}

module.exports = { callLLM };
