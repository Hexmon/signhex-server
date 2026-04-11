ALTER TABLE "device_certificates"
ADD COLUMN IF NOT EXISTS "public_key_pem" text;

ALTER TABLE "device_certificates"
ADD COLUMN IF NOT EXISTS "auth_version" varchar(32) DEFAULT 'legacy' NOT NULL;
