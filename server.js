require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { buildPrompt } = require("./prompt-template");
const { callLLM } = require("./llm-providers");
const { getUserRank } = require("./rank-engine");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "testbed")));

// Extract a JSON object from an LLM response that may contain surrounding
// prose, thinking, or markdown fences. Finds the outermost {...} block and
// parses it. Handles models like Gemma that emit reasoning before the answer.
function extractJSON(raw) {
  // Try direct parse after stripping markdown fences
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Scan every '{' in the response and try to extract a balanced JSON object
  // starting from it. Return the first one that parses AND contains a "story"
  // key (so we skip "thinking" blocks that happen to contain braces).
  let lastError = null;
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(raw.slice(start, i + 1));
            // Only accept objects that look like our expected payload
            if (obj && typeof obj === "object" && obj.story) return obj;
          } catch (e) {
            lastError = e;
          }
          break;
        }
      }
    }
  }
  throw new Error(lastError ? lastError.message : "No valid JSON object found in response");
}

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf-8");
  return JSON.parse(raw);
}

app.post("/api/generate", async (req, res) => {
  const { genre, gender, protagonist_name, location, grade_level, reader_level, provider } = req.body;

  if (!genre || !gender || !protagonist_name || !location || !grade_level || !reader_level) {
    return res.status(400).json({
      error: "Missing required parameters: genre, gender, protagonist_name, location, grade_level, reader_level",
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

  const prompt = buildPrompt({ genre, gender, protagonist_name, location, grade_level, reader_level });

  try {
    const raw = await callLLM(prompt, activeProvider, providerConfig);

    let parsed;
    try {
      parsed = extractJSON(raw);
    } catch (e) {
      return res.status(502).json({
        error: `LLM returned invalid JSON: ${e.message}`,
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

app.get("/api/rank/:userId", (req, res) => {
  try {
    const result = getUserRank(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
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
