# Rank Engine Configuration

These values control the promotion/relegation logic in `rank-engine.js`.
Edit the values inside the fenced code block below and they will be picked
up the next time the rank engine runs. Lines outside the code block are
ignored — feel free to add notes around it.

## Tunable Parameters

```yaml
# Range of valid grade levels (inclusive)
grade_min: 3
grade_max: 8

# Range of valid reader levels within a grade (inclusive)
reader_min: 1
reader_max: 4

# Number of recent quizzes (at the same rank) used to compute the
# promotion average. Also acts as the gate: a user must have at least
# this many quizzes at their current rank before any promotion is
# considered.
promote_window: 5

# Number of most recent quizzes (at the same rank) used to check
# relegation.
relegate_window: 2

# A user is promoted if the average score across `promote_window`
# quizzes is at or above this fraction (0..1).
promote_threshold: 0.85

# A user is relegated if EVERY quiz in the last `relegate_window`
# quizzes scores at or below this fraction (0..1).
relegate_threshold: 0.20

# Quizzes with a ReadTime at or below this many seconds are excluded
# from the calculation (the student likely didn't actually read).
# Set to 0 to disable this filter.
min_read_time_seconds: 75
```

## Notes

- `promote_window` doubles as the "must have N quizzes at same rank" gate.
  If a user has fewer than this many quizzes at their current rank,
  the engine returns the current rank unchanged — UNLESS the fairness
  exception (below) applies.
- **Fairness exception:** if the user's current rank is less than or equal
  to the rank of every one of the previous (promote_window − 1) records,
  the engine will use the last `promote_window` records overall (regardless
  of rank) for the promotion average. This avoids penalising a student who
  recently dropped from a higher rank and would otherwise be forced to
  re-accumulate quizzes at the new lower rank before becoming eligible.
- A quiz is "at the same rank" if its `StartGradeLevel` and
  `StartReaderLevel` match the user's current rank (taken from the most
  recent record).
- Quizzes filtered out by `min_read_time_seconds` are removed *before*
  the same-rank window is sliced, so they don't count toward the gate
  either.
