/**
 * Rank Engine — calculates a user's current GradeLevel and ReaderLevel based
 * on their quiz history.
 *
 * Public API:
 *   getUserRank(userId, opts?) -> { gradeLevel, readerLevel, reason }
 *
 *   opts.currentGrade        — override the "current rank" inferred from history
 *   opts.currentReaderLevel  — override the "current rank" inferred from history
 *   opts.source              — pick a named source from config.data_sources
 *                              (defaults to config.active_data_source)
 *
 * Configuration:
 *   - Data sources: config.json (data_sources, active_data_source)
 *   - Tunable thresholds: rank-config.md (parameters in a yaml-style code block)
 *
 * Rules (with defaults; all overridable in rank-config.md):
 *   - GradeLevel range: 3..8
 *   - ReaderLevel range: 1..4 (sub-rank within a GradeLevel)
 *   - Reaching ReaderLevel > max promotes to next GradeLevel, ReaderLevel = min
 *   - Dropping below ReaderLevel min demotes to previous GradeLevel, ReaderLevel = max
 *   - User must have `promote_window` quizzes at current rank to be eligible
 *   - Promotion: avg score across last `promote_window` same-rank quizzes >= promote_threshold
 *   - Relegation: last `relegate_window` same-rank quizzes ALL <= relegate_threshold
 *   - Quizzes with ReadTime <= min_read_time_seconds are excluded entirely
 *   - Boundaries (G_min R_min, G_max R_max) stay put
 *
 * The module is read-only: it returns the calculated rank but does not
 * write to the data source. The caller is responsible for persisting changes.
 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  grade_min: 3,
  grade_max: 8,
  reader_min: 1,
  reader_max: 4,
  promote_window: 5,
  relegate_window: 2,
  promote_threshold: 0.85,
  relegate_threshold: 0.20,
  min_read_time_seconds: 75,
};

function loadAppConfig(configPath) {
  const raw = fs.readFileSync(configPath || path.join(__dirname, "config.json"), "utf-8");
  return JSON.parse(raw);
}

// Pull tunable parameters out of rank-config.md. We look for the first
// fenced code block (```...```) and parse simple `key: value` lines from it.
// Comments (#) and blank lines are ignored. Anything not in DEFAULTS is
// silently dropped to keep the surface area small.
function loadRankConfig(mdPath) {
  const filePath = mdPath || path.join(__dirname, "rank-config.md");
  if (!fs.existsSync(filePath)) return { ...DEFAULTS };

  const text = fs.readFileSync(filePath, "utf-8");
  const fenceMatch = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (!fenceMatch) return { ...DEFAULTS };

  const result = { ...DEFAULTS };
  const lines = fenceMatch[1].split(/\r?\n/);
  for (const line of lines) {
    // Strip trailing comments and trim
    const stripped = line.replace(/#.*$/, "").trim();
    if (!stripped) continue;
    const m = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    if (!(key in DEFAULTS)) continue;
    const num = Number(m[2]);
    if (Number.isFinite(num)) result[key] = num;
  }
  return result;
}

// Minimal CSV parser — handles the studentdata.csv format. Doesn't try to
// support quoted fields with embedded commas since the schema is simple.
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = values[i]));
    return row;
  });
}

async function loadQuizRecords(dataSource) {
  if (dataSource.type === "csv") {
    const csvPath = path.resolve(__dirname, dataSource.path);
    const text = fs.readFileSync(csvPath, "utf-8");
    return parseCSV(text);
  }
  if (dataSource.type === "airtable") {
    return loadFromAirtable(dataSource);
  }
  throw new Error(`Unsupported data source type: ${dataSource.type}`);
}

// Fetch all rows from an Airtable table, paginating through `offset`.
// Field names in Airtable must match the CSV column names (UserID,
// QuizDateTime, StartGradeLevel, StartReaderLevel, QuizGradeLevel,
// QuizReaderLevel, ReadTime, Q1..Q5).
async function loadFromAirtable(dataSource) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    throw new Error("AIRTABLE_API_KEY is not set in .env");
  }
  if (!dataSource.base_id || !dataSource.table_id) {
    throw new Error("Airtable data source needs base_id and table_id in config.json");
  }

  const baseUrl = `https://api.airtable.com/v0/${dataSource.base_id}/${dataSource.table_id}`;
  const records = [];
  let offset;

  do {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Airtable returned ${res.status}: ${text}`);
    }
    const data = await res.json();

    for (const rec of data.records) {
      // Airtable returns numbers as numbers, datetimes as ISO strings. The
      // rest of the engine treats values as strings parsed via parseInt and
      // localeCompare on QuizDateTime, so coerce everything to strings here
      // for a uniform shape with the CSV path.
      const f = rec.fields;
      records.push({
        UserID: f.UserID != null ? String(f.UserID) : "",
        QuizDateTime: f.QuizDateTime || "",
        StartGradeLevel: f.StartGradeLevel != null ? String(f.StartGradeLevel) : "",
        StartReaderLevel: f.StartReaderLevel != null ? String(f.StartReaderLevel) : "",
        QuizGradeLevel: f.QuizGradeLevel != null ? String(f.QuizGradeLevel) : "",
        QuizReaderLevel: f.QuizReaderLevel != null ? String(f.QuizReaderLevel) : "",
        ReadTime: f.ReadTime != null ? String(f.ReadTime) : "",
        Q1: f.Q1 != null ? String(f.Q1) : "",
        Q2: f.Q2 != null ? String(f.Q2) : "",
        Q3: f.Q3 != null ? String(f.Q3) : "",
        Q4: f.Q4 != null ? String(f.Q4) : "",
        Q5: f.Q5 != null ? String(f.Q5) : "",
      });
    }
    offset = data.offset;
  } while (offset);

  return records;
}

// Score a single quiz row as a fraction 0..1 across Q1..Q5.
function quizScore(row) {
  const correct = ["Q1", "Q2", "Q3", "Q4", "Q5"]
    .map((k) => parseInt(row[k], 10))
    .filter((n) => n === 1).length;
  return correct / 5;
}

// Sort records oldest -> newest by QuizDateTime
function sortByDate(records) {
  return [...records].sort((a, b) => a.QuizDateTime.localeCompare(b.QuizDateTime));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Total ordering on (grade, reader). Higher = harder.
// Uses *100 separator so reader (1..4) never collides with grade.
function rankValue(grade, reader) {
  return grade * 100 + reader;
}

function promote(grade, reader, cfg) {
  if (reader < cfg.reader_max) return { gradeLevel: grade, readerLevel: reader + 1 };
  if (grade < cfg.grade_max) return { gradeLevel: grade + 1, readerLevel: cfg.reader_min };
  return { gradeLevel: grade, readerLevel: reader };
}

function relegate(grade, reader, cfg) {
  if (reader > cfg.reader_min) return { gradeLevel: grade, readerLevel: reader - 1 };
  if (grade > cfg.grade_min) return { gradeLevel: grade - 1, readerLevel: cfg.reader_max };
  return { gradeLevel: grade, readerLevel: reader };
}

/**
 * Determine the user's current rank from their quiz history.
 *
 * @param {string|number} userId
 * @param {object} [opts]
 * @param {number} [opts.currentGrade]       override "current grade" inferred from history
 * @param {number} [opts.currentReaderLevel] override "current reader level" inferred from history
 * @param {string} [opts.source]             which entry in config.data_sources to use
 * @param {string} [opts.configPath]         override path to config.json
 * @param {string} [opts.rankConfigPath]     override path to rank-config.md
 * @returns {Promise<{ gradeLevel: number, readerLevel: number, reason: string }>}
 */
async function getUserRank(userId, opts = {}) {
  const appConfig = loadAppConfig(opts.configPath);
  const cfg = loadRankConfig(opts.rankConfigPath);

  // Pick the data source: explicit opts.source > config.active_data_source
  // > legacy single-source config (config.data_source).
  const sourceName = opts.source || appConfig.active_data_source;
  let dataSource;
  if (appConfig.data_sources && sourceName) {
    dataSource = appConfig.data_sources[sourceName];
    if (!dataSource) {
      throw new Error(
        `Unknown data source "${sourceName}". Valid: ${Object.keys(appConfig.data_sources).join(", ")}`
      );
    }
  } else if (appConfig.data_source) {
    dataSource = appConfig.data_source;
  } else {
    throw new Error("No data source configured in config.json");
  }

  const allRecords = await loadQuizRecords(dataSource);
  const userIdStr = String(userId);

  // Filter: only this user's records, sorted chronologically, with quizzes
  // that have a ReadTime <= threshold removed (likely didn't actually read).
  const userRecords = sortByDate(
    allRecords.filter((r) => r.UserID === userIdStr)
  ).filter((r) => {
    if (!cfg.min_read_time_seconds) return true;
    const rt = parseInt(r.ReadTime, 10);
    return Number.isFinite(rt) ? rt > cfg.min_read_time_seconds : true;
  });

  if (userRecords.length === 0 && opts.currentGrade == null) {
    throw new Error(`No quiz records found for user ${userId}`);
  }

  // Current rank: caller-supplied overrides win; otherwise use the
  // StartGradeLevel/StartReaderLevel from the user's most recent record.
  let currentGrade, currentReader;
  if (opts.currentGrade != null && opts.currentReaderLevel != null) {
    currentGrade = clamp(parseInt(opts.currentGrade, 10), cfg.grade_min, cfg.grade_max);
    currentReader = clamp(parseInt(opts.currentReaderLevel, 10), cfg.reader_min, cfg.reader_max);
  } else {
    const latest = userRecords[userRecords.length - 1];
    currentGrade = clamp(parseInt(latest.StartGradeLevel, 10), cfg.grade_min, cfg.grade_max);
    currentReader = clamp(parseInt(latest.StartReaderLevel, 10), cfg.reader_min, cfg.reader_max);
  }

  // Records at the user's current rank (chronological)
  const sameRank = userRecords.filter(
    (r) =>
      parseInt(r.StartGradeLevel, 10) === currentGrade &&
      parseInt(r.StartReaderLevel, 10) === currentReader
  );

  // Check relegation first (uses last relegate_window at same rank)
  const lastN = sameRank.slice(-cfg.relegate_window);
  if (
    lastN.length === cfg.relegate_window &&
    lastN.every((r) => quizScore(r) <= cfg.relegate_threshold)
  ) {
    const next = relegate(currentGrade, currentReader, cfg);
    const moved = next.gradeLevel !== currentGrade || next.readerLevel !== currentReader;
    return {
      gradeLevel: next.gradeLevel,
      readerLevel: next.readerLevel,
      reason: moved
        ? `relegated from G${currentGrade}R${currentReader} (last ${cfg.relegate_window} quizzes <= ${cfg.relegate_threshold * 100}%)`
        : `at floor G${cfg.grade_min}R${cfg.reader_min}, cannot relegate further`,
    };
  }

  // Decide which window to use for the promotion average.
  //
  // Default rule: use the last `promote_window` records AT THE CURRENT RANK.
  //               Requires at least `promote_window` same-rank records.
  //
  // Fairness exception: if the user doesn't have enough same-rank records BUT
  // their current rank is <= every one of the previous (promote_window - 1)
  // records' ranks, use the last `promote_window` records overall instead.
  // This prevents penalising a student who recently dropped and now has to
  // re-accumulate quizzes at the lower rank before being eligible to promote.
  let avgWindow = null;
  let windowSource = null;

  if (sameRank.length >= cfg.promote_window) {
    avgWindow = sameRank.slice(-cfg.promote_window);
    windowSource = "same-rank";
  } else {
    const overallWindow = userRecords.slice(-cfg.promote_window);
    if (overallWindow.length === cfg.promote_window) {
      const previousRows = overallWindow.slice(0, -1); // exclude the latest
      const currentValue = rankValue(currentGrade, currentReader);
      const allHigherOrEqual = previousRows.every((r) => {
        const g = parseInt(r.StartGradeLevel, 10);
        const rd = parseInt(r.StartReaderLevel, 10);
        return rankValue(g, rd) >= currentValue;
      });
      if (allHigherOrEqual) {
        avgWindow = overallWindow;
        windowSource = "fairness-exception";
      }
    }
  }

  if (!avgWindow) {
    return {
      gradeLevel: currentGrade,
      readerLevel: currentReader,
      reason: `holding (${sameRank.length}/${cfg.promote_window} valid quizzes at G${currentGrade}R${currentReader}; fairness exception not met)`,
    };
  }

  const avg = avgWindow.reduce((sum, r) => sum + quizScore(r), 0) / avgWindow.length;
  if (avg >= cfg.promote_threshold) {
    const next = promote(currentGrade, currentReader, cfg);
    const moved = next.gradeLevel !== currentGrade || next.readerLevel !== currentReader;
    return {
      gradeLevel: next.gradeLevel,
      readerLevel: next.readerLevel,
      reason: moved
        ? `promoted from G${currentGrade}R${currentReader} (avg ${(avg * 100).toFixed(1)}% over last ${cfg.promote_window} ${windowSource})`
        : `at ceiling G${cfg.grade_max}R${cfg.reader_max}, cannot promote further`,
    };
  }

  return {
    gradeLevel: currentGrade,
    readerLevel: currentReader,
    reason: `holding at G${currentGrade}R${currentReader} (avg ${(avg * 100).toFixed(1)}% over last ${cfg.promote_window} ${windowSource})`,
  };
}

module.exports = { getUserRank };
