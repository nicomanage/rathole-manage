-- Last error the agent wants shown next to its process state (a failed start,
-- or an HTTP proxy that failed while rathole itself kept running). NULL when
-- the last start came up cleanly.
ALTER TABLE agent_status ADD COLUMN error_text TEXT;
