CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"path" text,
	"text" text,
	"bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid NOT NULL,
	"sink_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_ref" text,
	"error" text,
	"attempted_at" timestamp with time zone,
	CONSTRAINT "deliveries_digest_sink_uq" UNIQUE("digest_id","sink_id")
);
--> statement-breakpoint
CREATE TABLE "digest_items" (
	"digest_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	CONSTRAINT "digest_items_digest_id_item_id_pk" PRIMARY KEY("digest_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"job_key" text NOT NULL,
	"renderer_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rendered_at" timestamp with time zone,
	CONSTRAINT "digests_job_key_unique" UNIQUE("job_key")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"body" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_source_external_uq" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"term" text NOT NULL,
	"mode" text DEFAULT 'include' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_settings" (
	"plugin_id" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plugin_settings_plugin_id_kind_pk" PRIMARY KEY("plugin_id","kind")
);
--> statement-breakpoint
CREATE TABLE "render_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"renderer_id" text NOT NULL,
	"digest_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"default_schedule" text DEFAULT '0 7 * * *' NOT NULL,
	"default_curation_mode" text DEFAULT 'manual' NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sinks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" text NOT NULL,
	"label" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" text NOT NULL,
	"label" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor" jsonb,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_sinks" (
	"topic_id" uuid NOT NULL,
	"sink_id" uuid NOT NULL,
	CONSTRAINT "topic_sinks_topic_id_sink_id_pk" PRIMARY KEY("topic_id","sink_id")
);
--> statement-breakpoint
CREATE TABLE "topic_sources" (
	"topic_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "topic_sources_topic_id_source_id_pk" PRIMARY KEY("topic_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" text,
	"curation_mode" text DEFAULT 'manual' NOT NULL,
	"renderer_id" text DEFAULT 'llm-text' NOT NULL,
	"renderer_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sink_id_sinks_id_fk" FOREIGN KEY ("sink_id") REFERENCES "public"."sinks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_log" ADD CONSTRAINT "render_log_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_sinks" ADD CONSTRAINT "topic_sinks_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_sinks" ADD CONSTRAINT "topic_sinks_sink_id_sinks_id_fk" FOREIGN KEY ("sink_id") REFERENCES "public"."sinks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_sources" ADD CONSTRAINT "topic_sources_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_sources" ADD CONSTRAINT "topic_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digests_topic_status_idx" ON "digests" USING btree ("topic_id","status");--> statement-breakpoint
CREATE INDEX "items_published_idx" ON "items" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "keywords_topic_idx" ON "keywords" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "render_log_renderer_created_idx" ON "render_log" USING btree ("renderer_id","created_at");