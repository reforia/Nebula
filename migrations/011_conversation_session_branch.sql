-- Track which branch a conversation's CC session was initialized with.
-- When the resolved branch changes (deliverable completed, agent moves on),
-- the executor resets the session so CC CLI starts fresh in the new CWD.
ALTER TABLE conversations ADD COLUMN session_branch TEXT DEFAULT NULL;
