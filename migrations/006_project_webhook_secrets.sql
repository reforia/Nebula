-- Add webhook_secret to project_links for inbound webhook verification
ALTER TABLE project_links ADD COLUMN webhook_secret TEXT;
