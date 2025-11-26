ALTER TABLE "webhook_subscriptions" ALTER COLUMN "name" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ALTER COLUMN "event_types" SET DATA TYPE text[];