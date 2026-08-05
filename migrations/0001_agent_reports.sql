CREATE TABLE IF NOT EXISTS agent_credentials (
  instance_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_status (
  instance_id TEXT PRIMARY KEY,
  reported_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  process_state TEXT NOT NULL CHECK (process_state IN ('running', 'stopped', 'errored', 'unknown')),
  metrics_json TEXT,
  service_status_json TEXT,
  traffic_json TEXT
);

CREATE TABLE IF NOT EXISTS agent_monthly_traffic (
  instance_id TEXT NOT NULL,
  month TEXT NOT NULL,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id, month)
);

-- The agent counters are cumulative for one process lifetime. Fold only their
-- delta into the current month, treating a counter drop as an agent restart.
CREATE TRIGGER IF NOT EXISTS agent_status_insert_traffic
AFTER INSERT ON agent_status
WHEN NEW.traffic_json IS NOT NULL
BEGIN
  INSERT INTO agent_monthly_traffic (instance_id, month, bytes_in, bytes_out)
  SELECT
    NEW.instance_id,
    strftime('%Y-%m', NEW.received_at / 1000, 'unixepoch'),
    COALESCE(SUM(CAST(json_extract(value, '$.bytesIn') AS INTEGER)), 0),
    COALESCE(SUM(CAST(json_extract(value, '$.bytesOut') AS INTEGER)), 0)
  FROM json_each(NEW.traffic_json)
  WHERE true
  ON CONFLICT(instance_id, month) DO UPDATE SET
    bytes_in = bytes_in + excluded.bytes_in,
    bytes_out = bytes_out + excluded.bytes_out;
END;

CREATE TRIGGER IF NOT EXISTS agent_status_update_traffic
AFTER UPDATE OF reported_at, traffic_json ON agent_status
WHEN NEW.reported_at > OLD.reported_at AND NEW.traffic_json IS NOT NULL
BEGIN
  INSERT INTO agent_monthly_traffic (instance_id, month, bytes_in, bytes_out)
  SELECT
    NEW.instance_id,
    strftime('%Y-%m', NEW.received_at / 1000, 'unixepoch'),
    COALESCE(SUM(
      CASE
        WHEN previous.key IS NOT NULL
          AND CAST(json_extract(current.value, '$.bytesIn') AS INTEGER)
              >= CAST(json_extract(previous.value, '$.bytesIn') AS INTEGER)
        THEN CAST(json_extract(current.value, '$.bytesIn') AS INTEGER)
             - CAST(json_extract(previous.value, '$.bytesIn') AS INTEGER)
        ELSE CAST(json_extract(current.value, '$.bytesIn') AS INTEGER)
      END
    ), 0),
    COALESCE(SUM(
      CASE
        WHEN previous.key IS NOT NULL
          AND CAST(json_extract(current.value, '$.bytesOut') AS INTEGER)
              >= CAST(json_extract(previous.value, '$.bytesOut') AS INTEGER)
        THEN CAST(json_extract(current.value, '$.bytesOut') AS INTEGER)
             - CAST(json_extract(previous.value, '$.bytesOut') AS INTEGER)
        ELSE CAST(json_extract(current.value, '$.bytesOut') AS INTEGER)
      END
    ), 0)
  FROM json_each(NEW.traffic_json) AS current
  LEFT JOIN json_each(COALESCE(OLD.traffic_json, '{}')) AS previous
    ON previous.key = current.key
  WHERE true
  ON CONFLICT(instance_id, month) DO UPDATE SET
    bytes_in = bytes_in + excluded.bytes_in,
    bytes_out = bytes_out + excluded.bytes_out;
END;
