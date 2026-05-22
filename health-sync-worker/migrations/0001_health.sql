CREATE TABLE IF NOT EXISTS health_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at TEXT DEFAULT CURRENT_TIMESTAMP,
  date TEXT NOT NULL,
  sleep_duration_minutes INTEGER,
  sleep_start TEXT,
  sleep_end TEXT,
  sleep_quality TEXT,
  cycle_day INTEGER,
  last_period_start TEXT,
  cycle_length_avg INTEGER DEFAULT 28,
  hrv REAL,
  resting_hr INTEGER,
  steps INTEGER,
  active_energy INTEGER,
  notes TEXT
);
