-- Reply/quote feature: link a message to the message it's replying to.
ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL;
