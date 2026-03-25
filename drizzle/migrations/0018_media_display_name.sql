ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "display_name" varchar(255);
--> statement-breakpoint
UPDATE "media"
SET "display_name" = COALESCE(
  NULLIF(
    trim(
      regexp_replace(
        regexp_replace(
          regexp_replace("name", '\.[^.]+$', ''),
          '[_-]+',
          ' ',
          'g'
        ),
        '\s+',
        ' ',
        'g'
      )
    ),
    ''
  ),
  "name"
)
WHERE "display_name" IS NULL OR trim("display_name") = '';
