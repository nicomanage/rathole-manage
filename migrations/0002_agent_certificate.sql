-- Live Let's Encrypt certificate state reported by the agent alongside its
-- status. NULL when Let's Encrypt is off or nothing has been reported yet.
ALTER TABLE agent_status ADD COLUMN certificate_json TEXT;
