const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { buildPrompt } = require("./prompt-template");
const { callLLM } = require("./llm-providers");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "testbed")));

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf-8");
  return JSON.parse(raw);
}

app.post("/api/generate", async (req, res) => {
  const { genre, gender, location, grade_level, reader_level, provider } = req.body;

  if (!genre || !gender || !location || !grade_level || !reader_level) {
    return res.status(400).json({
      error: "Missing required parameters: genre, gender, location, grade_level, reader_level",
    });
  }

  const config = loadConfig();
  const activeProvider = provider || config.active_provider;
  const providerConfig = config.providers[activeProvider];

  if (!providerConfig) {
    return res.status(400).json({
      error: `Unknown provider: ${activeProvider}. Valid: ${Object.keys(config.providers).join(", ")}`,
    });
  }

  const prompt = buildPrompt({ genre, gender, location, grade_level, reader_level });

  try {
    const raw = await callLLM(prompt, activeProvider, providerConfig);

    let parsed;
    try {
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({
        error: "LLM returned invalid JSON",
        raw_response: raw,
      });
    }

    return res.json(parsed);
  } catch (err) {
    console.error("LLM call failed:", err.message);
    return res.status(502).json({
      error: `LLM call failed: ${err.message}`,
    });
  }
});

app.get("/api/config", (req, res) => {
  const config = loadConfig();
  res.json({
    active_provider: config.active_provider,
    providers: Object.keys(config.providers),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Reading Comp API running on http://localhost:${PORT}`);
  console.log(`Testbed available at http://localhost:${PORT}/`);
});
