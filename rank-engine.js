/**
 * Rank Engine — calculates a user's current GradeLevel and ReaderLevel based
 * on their quiz history.
 *
 * Public API:
 *   getUserRank(userId, opts?) -> { gradeLevel, readerLevel, reason }
 *
 * Configuration:
 *   - Data source path: config.json (data_source.path)
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

function loadQuizRecords(dataSource) {
  if (dataSource.type !== "csv") {
    throw new Error(`Unsupported data source type: ${dataSource.type}`);
  }
  const csvPath = path.resolve(__dirname, dataSource.path);
  const text = fs.readFileSync(csvPath, "utf-8");
  return parseCSV(text);
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
 * @param {string} [opts.configPath]      override path to config.json
 * @param {string} [opts.rankConfigPath]  override path to rank-config.md
 * @returns {{ gradeLevel: number, readerLevel: number, reason: string }}
 */
function getUserRank(userId, opts = {}) {
  const appConfig = loadAppConfig(opts.configPath);
  const cfg = loadRankConfig(opts.rankConfigPath);
  const allRecords = loadQuizRecords(appConfig.data_source);
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

  if (userRecords.length === 0) {
    throw new Error(`No quiz records found for user ${userId}`);
  }

  // Current rank = StartGradeLevel/StartReaderLevel from the most recent record
  const latest = userRecords[userRecords.length - 1];
  const currentGrade = clamp(parseInt(latest.StartGradeLevel, 10), cfg.grade_min, cfg.grade_max);
  const currentReader = clamp(parseInt(latest.StartReaderLevel, 10), cfg.reader_min, cfg.reader_max);

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
