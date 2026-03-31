-- Add error_message column to usage_events for error audit log

ALTER TABLE usage_events ADD COLUMN error_message TEXT;
