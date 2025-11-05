CREATE TABLE IF NOT EXISTS "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid,
	"pairing_code" varchar(255) NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"used_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "emergencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"priority" varchar(20) DEFAULT 'HIGH' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"triggered_by" uuid,
	"triggered_at" timestamp DEFAULT now() NOT NULL,
	"cleared_by" uuid,
	"cleared_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
