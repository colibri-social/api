UPDATE "actor_activity" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"kind" = regexp_replace("kind", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"title" = regexp_replace("title", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subtitle" = regexp_replace("subtitle", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"detail" = regexp_replace("detail", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"image_url" = regexp_replace("image_url", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"link_uri" = regexp_replace("link_uri", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"source" = regexp_replace("source", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "kind" LIKE '%at://%/space/%'
	OR "title" LIKE '%at://%/space/%'
	OR "subtitle" LIKE '%at://%/space/%'
	OR "detail" LIKE '%at://%/space/%'
	OR "image_url" LIKE '%at://%/space/%'
	OR "link_uri" LIKE '%at://%/space/%'
	OR "source" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "actor_settings" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"notification_level" = regexp_replace("notification_level", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community_order" = regexp_replace("community_order"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"gif_favorites" = regexp_replace("gif_favorites"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"client_preferences" = regexp_replace("client_preferences"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"composer_state" = regexp_replace("composer_state"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"did" LIKE '%at://%/space/%'
	OR "notification_level" LIKE '%at://%/space/%'
	OR "community_order"::text LIKE '%at://%/space/%'
	OR "gif_favorites"::text LIKE '%at://%/space/%'
	OR "client_preferences"::text LIKE '%at://%/space/%'
	OR "composer_state"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "applications" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"invitation" = regexp_replace("invitation", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "did" LIKE '%at://%/space/%'
	OR "invitation" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "blocks" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject" = regexp_replace("subject", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "subject" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "bridge_backfills" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"registration" = regexp_replace("registration", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"channel" = regexp_replace("channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"state" = regexp_replace("state", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"from" = regexp_replace("from", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"until" = regexp_replace("until", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"reached" = regexp_replace("reached", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "registration" LIKE '%at://%/space/%'
	OR "channel" LIKE '%at://%/space/%'
	OR "state" LIKE '%at://%/space/%'
	OR "from" LIKE '%at://%/space/%'
	OR "until" LIKE '%at://%/space/%'
	OR "reached" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "bridge_pairings" SET
	"code" = regexp_replace("code", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"bridge" = regexp_replace("bridge", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"platform" = regexp_replace("platform", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"remote_space" = regexp_replace("remote_space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"remote_space_name" = regexp_replace("remote_space_name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"code" LIKE '%at://%/space/%'
	OR "bridge" LIKE '%at://%/space/%'
	OR "platform" LIKE '%at://%/space/%'
	OR "remote_space" LIKE '%at://%/space/%'
	OR "remote_space_name" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "bridge_registrations" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"bridge" = regexp_replace("bridge", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"platform" = regexp_replace("platform", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"remote_space" = regexp_replace("remote_space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"remote_space_name" = regexp_replace("remote_space_name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"links" = regexp_replace("links"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"channels" = regexp_replace("channels"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"created_by" = regexp_replace("created_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "id" LIKE '%at://%/space/%'
	OR "bridge" LIKE '%at://%/space/%'
	OR "platform" LIKE '%at://%/space/%'
	OR "remote_space" LIKE '%at://%/space/%'
	OR "remote_space_name" LIKE '%at://%/space/%'
	OR "links"::text LIKE '%at://%/space/%'
	OR "channels"::text LIKE '%at://%/space/%'
	OR "created_by" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "bridge_remote_rooms" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"registration" = regexp_replace("registration", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"remote_room" = regexp_replace("remote_room", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"name" = regexp_replace("name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"kind" = regexp_replace("kind", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"parent" = regexp_replace("parent", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "registration" LIKE '%at://%/space/%'
	OR "remote_room" LIKE '%at://%/space/%'
	OR "name" LIKE '%at://%/space/%'
	OR "kind" LIKE '%at://%/space/%'
	OR "parent" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "categories" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"name" = regexp_replace("name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"channel_order" = regexp_replace("channel_order"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"allowed_roles" = regexp_replace("allowed_roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"allowed_members" = regexp_replace("allowed_members"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"visible_to_roles" = regexp_replace("visible_to_roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"visible_to_members" = regexp_replace("visible_to_members"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"permission_overrides" = regexp_replace("permission_overrides"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"community" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "name" LIKE '%at://%/space/%'
	OR "channel_order"::text LIKE '%at://%/space/%'
	OR "allowed_roles"::text LIKE '%at://%/space/%'
	OR "allowed_members"::text LIKE '%at://%/space/%'
	OR "visible_to_roles"::text LIKE '%at://%/space/%'
	OR "visible_to_members"::text LIKE '%at://%/space/%'
	OR "permission_overrides"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "channels" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"space_type" = regexp_replace("space_type", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"skey" = regexp_replace("skey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"name" = regexp_replace("name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"description" = regexp_replace("description", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"category" = regexp_replace("category", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"allowed_roles" = regexp_replace("allowed_roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"allowed_members" = regexp_replace("allowed_members"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"visible_to_roles" = regexp_replace("visible_to_roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"visible_to_members" = regexp_replace("visible_to_members"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"migrated_from" = regexp_replace("migrated_from", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"permission_overrides" = regexp_replace("permission_overrides"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"space" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "space_type" LIKE '%at://%/space/%'
	OR "skey" LIKE '%at://%/space/%'
	OR "name" LIKE '%at://%/space/%'
	OR "description" LIKE '%at://%/space/%'
	OR "category" LIKE '%at://%/space/%'
	OR "allowed_roles"::text LIKE '%at://%/space/%'
	OR "allowed_members"::text LIKE '%at://%/space/%'
	OR "visible_to_roles"::text LIKE '%at://%/space/%'
	OR "visible_to_members"::text LIKE '%at://%/space/%'
	OR "migrated_from" LIKE '%at://%/space/%'
	OR "permission_overrides"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "cluster_config" SET
	"key" = regexp_replace("key", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"key" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "cluster_state" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"main_node_id" = regexp_replace("main_node_id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"write_mode" = regexp_replace("write_mode", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"id" LIKE '%at://%/space/%'
	OR "main_node_id" LIKE '%at://%/space/%'
	OR "write_mode" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "communities" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"handle" = regexp_replace("handle", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"name" = regexp_replace("name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"description" = regexp_replace("description", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"managing_app" = regexp_replace("managing_app", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"picture_cid" = regexp_replace("picture_cid", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"banner_cid" = regexp_replace("banner_cid", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"custom_emoji" = regexp_replace("custom_emoji", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"labelers" = regexp_replace("labelers"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"migrated_from" = regexp_replace("migrated_from", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"profile_space" = regexp_replace("profile_space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"config_space" = regexp_replace("config_space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"members_space" = regexp_replace("members_space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"moderation_space" = regexp_replace("moderation_space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "handle" LIKE '%at://%/space/%'
	OR "name" LIKE '%at://%/space/%'
	OR "description" LIKE '%at://%/space/%'
	OR "managing_app" LIKE '%at://%/space/%'
	OR "picture_cid" LIKE '%at://%/space/%'
	OR "banner_cid" LIKE '%at://%/space/%'
	OR "custom_emoji" LIKE '%at://%/space/%'
	OR "labelers"::text LIKE '%at://%/space/%'
	OR "migrated_from" LIKE '%at://%/space/%'
	OR "profile_space" LIKE '%at://%/space/%'
	OR "config_space" LIKE '%at://%/space/%'
	OR "members_space" LIKE '%at://%/space/%'
	OR "moderation_space" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "community_credentials" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"identifier" = regexp_replace("identifier", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"source" = regexp_replace("source", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"connected_by" = regexp_replace("connected_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"handed_over_by" = regexp_replace("handed_over_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "identifier" LIKE '%at://%/space/%'
	OR "source" LIKE '%at://%/space/%'
	OR "connected_by" LIKE '%at://%/space/%'
	OR "handed_over_by" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "community_migrations" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"target" = regexp_replace("target", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"requested_by" = regexp_replace("requested_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"state" = regexp_replace("state", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"step" = regexp_replace("step", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"completed_steps" = regexp_replace("completed_steps"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"report" = regexp_replace("report"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"error" = regexp_replace("error", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "target" LIKE '%at://%/space/%'
	OR "requested_by" LIKE '%at://%/space/%'
	OR "state" LIKE '%at://%/space/%'
	OR "step" LIKE '%at://%/space/%'
	OR "completed_steps"::text LIKE '%at://%/space/%'
	OR "report"::text LIKE '%at://%/space/%'
	OR "error" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "emoji_backfills" SET
	"owner" = regexp_replace("owner", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"owner" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "emoji_follows" SET
	"follower" = regexp_replace("follower", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject" = regexp_replace("subject", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject_owner" = regexp_replace("subject_owner", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"follower" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "subject" LIKE '%at://%/space/%'
	OR "subject_owner" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "emoji_items" SET
	"owner" = regexp_replace("owner", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"collection" = regexp_replace("collection", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"provider" = regexp_replace("provider", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"uri" = regexp_replace("uri", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"name" = regexp_replace("name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"value" = regexp_replace("value"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"owner" LIKE '%at://%/space/%'
	OR "collection" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "provider" LIKE '%at://%/space/%'
	OR "uri" LIKE '%at://%/space/%'
	OR "name" LIKE '%at://%/space/%'
	OR "value"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "emoji_pack_items" SET
	"owner" = regexp_replace("owner", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"collection" = regexp_replace("collection", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"provider" = regexp_replace("provider", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"pack" = regexp_replace("pack", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject" = regexp_replace("subject", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"owner" LIKE '%at://%/space/%'
	OR "collection" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "provider" LIKE '%at://%/space/%'
	OR "pack" LIKE '%at://%/space/%'
	OR "subject" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "emoji_packs" SET
	"owner" = regexp_replace("owner", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"collection" = regexp_replace("collection", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"provider" = regexp_replace("provider", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"uri" = regexp_replace("uri", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"value" = regexp_replace("value"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"owner" LIKE '%at://%/space/%'
	OR "collection" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "provider" LIKE '%at://%/space/%'
	OR "uri" LIKE '%at://%/space/%'
	OR "value"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "event_payloads" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"payload" = regexp_replace("payload"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"id" LIKE '%at://%/space/%'
	OR "payload"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "host_authorizations" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"actor" = regexp_replace("actor", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"intent" = regexp_replace("intent", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"identifier" = regexp_replace("identifier", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"input" = regexp_replace("input"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"status" = regexp_replace("status", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"failure" = regexp_replace("failure", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"result" = regexp_replace("result", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"id" LIKE '%at://%/space/%'
	OR "actor" LIKE '%at://%/space/%'
	OR "intent" LIKE '%at://%/space/%'
	OR "identifier" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "input"::text LIKE '%at://%/space/%'
	OR "status" LIKE '%at://%/space/%'
	OR "failure" LIKE '%at://%/space/%'
	OR "result" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "host_oauth_sessions" SET
	"sub" = regexp_replace("sub", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"sub" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "host_oauth_states" SET
	"key" = regexp_replace("key", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"key" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "identity_cache" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"handle" = regexp_replace("handle", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"pds" = regexp_replace("pds", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"signing_key" = regexp_replace("signing_key", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "handle" LIKE '%at://%/space/%'
	OR "pds" LIKE '%at://%/space/%'
	OR "signing_key" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "invitations" SET
	"code" = regexp_replace("code", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"created_by" = regexp_replace("created_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"code" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "created_by" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "labels" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"src" = regexp_replace("src", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject_did" = regexp_replace("subject_did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject_collection" = regexp_replace("subject_collection", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject_rkey" = regexp_replace("subject_rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"val" = regexp_replace("val", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"scope" = regexp_replace("scope"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"reason" = regexp_replace("reason", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"destination" = regexp_replace("destination", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"batch" = regexp_replace("batch", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"space" LIKE '%at://%/space/%'
	OR "src" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "subject_did" LIKE '%at://%/space/%'
	OR "subject_collection" LIKE '%at://%/space/%'
	OR "subject_rkey" LIKE '%at://%/space/%'
	OR "val" LIKE '%at://%/space/%'
	OR "scope"::text LIKE '%at://%/space/%'
	OR "reason" LIKE '%at://%/space/%'
	OR "destination" LIKE '%at://%/space/%'
	OR "batch" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "left_threads" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "space" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "legacy_records" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"collection" = regexp_replace("collection", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"value" = regexp_replace("value"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"did" LIKE '%at://%/space/%'
	OR "collection" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "value"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "link_previews" SET
	"url" = regexp_replace("url", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"embed" = regexp_replace("embed"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"url" LIKE '%at://%/space/%'
	OR "embed"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "members" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"roles" = regexp_replace("roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"nickname" = regexp_replace("nickname", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "did" LIKE '%at://%/space/%'
	OR "roles"::text LIKE '%at://%/space/%'
	OR "nickname" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "messages" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"author" = regexp_replace("author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"text" = regexp_replace("text", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"facets" = regexp_replace("facets"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"parent_author" = regexp_replace("parent_author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"parent_rkey" = regexp_replace("parent_rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"attachments" = regexp_replace("attachments"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"forward" = regexp_replace("forward"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"suppressed_embeds" = regexp_replace("suppressed_embeds"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"bridged" = regexp_replace("bridged"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"space" LIKE '%at://%/space/%'
	OR "author" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "text" LIKE '%at://%/space/%'
	OR "facets"::text LIKE '%at://%/space/%'
	OR "parent_author" LIKE '%at://%/space/%'
	OR "parent_rkey" LIKE '%at://%/space/%'
	OR "attachments"::text LIKE '%at://%/space/%'
	OR "forward"::text LIKE '%at://%/space/%'
	OR "suppressed_embeds"::text LIKE '%at://%/space/%'
	OR "bridged"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "moderation_log" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"action" = regexp_replace("action", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject" = regexp_replace("subject", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"reason" = regexp_replace("reason", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"created_by" = regexp_replace("created_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "action" LIKE '%at://%/space/%'
	OR "subject" LIKE '%at://%/space/%'
	OR "reason" LIKE '%at://%/space/%'
	OR "created_by" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "mutes" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"subject" = regexp_replace("subject", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "subject" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "node_join_tokens" SET
	"node_id" = regexp_replace("node_id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"region" = regexp_replace("region", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"roles" = regexp_replace("roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"location" = regexp_replace("location", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"node_id" LIKE '%at://%/space/%'
	OR "region" LIKE '%at://%/space/%'
	OR "roles"::text LIKE '%at://%/space/%'
	OR "location" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "nodes" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"region" = regexp_replace("region", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"roles" = regexp_replace("roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"location" = regexp_replace("location", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"public_url" = regexp_replace("public_url", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"tailnet_url" = regexp_replace("tailnet_url", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"announced_ip" = regexp_replace("announced_ip", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"state" = regexp_replace("state", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"version" = regexp_replace("version", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"drain_deadline" = regexp_replace("drain_deadline", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"database_hosts" = regexp_replace("database_hosts"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"id" LIKE '%at://%/space/%'
	OR "region" LIKE '%at://%/space/%'
	OR "roles"::text LIKE '%at://%/space/%'
	OR "location" LIKE '%at://%/space/%'
	OR "public_url" LIKE '%at://%/space/%'
	OR "tailnet_url" LIKE '%at://%/space/%'
	OR "announced_ip" LIKE '%at://%/space/%'
	OR "state" LIKE '%at://%/space/%'
	OR "version" LIKE '%at://%/space/%'
	OR "drain_deadline" LIKE '%at://%/space/%'
	OR "database_hosts"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "notification_clears" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "notifications" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"recipient" = regexp_replace("recipient", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"kind" = regexp_replace("kind", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"author" = regexp_replace("author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"message_author" = regexp_replace("message_author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"message_rkey" = regexp_replace("message_rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"mention_role" = regexp_replace("mention_role", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"id" LIKE '%at://%/space/%'
	OR "recipient" LIKE '%at://%/space/%'
	OR "kind" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "space" LIKE '%at://%/space/%'
	OR "author" LIKE '%at://%/space/%'
	OR "message_author" LIKE '%at://%/space/%'
	OR "message_rkey" LIKE '%at://%/space/%'
	OR "mention_role" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "notify_registrations" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"space" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "polyfill_actors" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"mode" = regexp_replace("mode", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"pds" = regexp_replace("pds", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "mode" LIKE '%at://%/space/%'
	OR "pds" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "polyfill_blobs" SET
	"author" = regexp_replace("author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"author" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "polyfill_repos" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"author" = regexp_replace("author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"mode" = regexp_replace("mode", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rev" = regexp_replace("rev", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"set_hash" = regexp_replace("set_hash", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"migrated_rev" = regexp_replace("migrated_rev", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"space" LIKE '%at://%/space/%'
	OR "author" LIKE '%at://%/space/%'
	OR "mode" LIKE '%at://%/space/%'
	OR "rev" LIKE '%at://%/space/%'
	OR "set_hash" LIKE '%at://%/space/%'
	OR "migrated_rev" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "presence_connections" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"viewing_channel" = regexp_replace("viewing_channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"active_until" = regexp_replace("active_until", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"node_id" = regexp_replace("node_id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"id" LIKE '%at://%/space/%'
	OR "did" LIKE '%at://%/space/%'
	OR "viewing_channel" LIKE '%at://%/space/%'
	OR "active_until" LIKE '%at://%/space/%'
	OR "node_id" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "profile_cache" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"colibri" = regexp_replace("colibri"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"bsky" = regexp_replace("bsky"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"did" LIKE '%at://%/space/%'
	OR "colibri"::text LIKE '%at://%/space/%'
	OR "bsky"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "push_subscriptions" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"actor" = regexp_replace("actor", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"provider" = regexp_replace("provider", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"platform" = regexp_replace("platform", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"environment" = regexp_replace("environment", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"id" LIKE '%at://%/space/%'
	OR "actor" LIKE '%at://%/space/%'
	OR "provider" LIKE '%at://%/space/%'
	OR "platform" LIKE '%at://%/space/%'
	OR "environment" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "reactions" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"author" = regexp_replace("author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"target_author" = regexp_replace("target_author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"target_rkey" = regexp_replace("target_rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"emoji" = regexp_replace("emoji", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"bridged_from" = regexp_replace("bridged_from", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"bridged" = regexp_replace("bridged"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"custom_emoji" = regexp_replace("custom_emoji"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"space" LIKE '%at://%/space/%'
	OR "author" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "target_author" LIKE '%at://%/space/%'
	OR "target_rkey" LIKE '%at://%/space/%'
	OR "emoji" LIKE '%at://%/space/%'
	OR "bridged_from" LIKE '%at://%/space/%'
	OR "bridged"::text LIKE '%at://%/space/%'
	OR "custom_emoji"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "read_cursors" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"channel" = regexp_replace("channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "channel" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "records" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"author" = regexp_replace("author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"collection" = regexp_replace("collection", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"value" = regexp_replace("value"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"space" LIKE '%at://%/space/%'
	OR "author" LIKE '%at://%/space/%'
	OR "collection" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "value"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "roles" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"rkey" = regexp_replace("rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"name" = regexp_replace("name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"color" = regexp_replace("color", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"badge" = regexp_replace("badge"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"permissions" = regexp_replace("permissions"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"channel_overrides" = regexp_replace("channel_overrides"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"community" LIKE '%at://%/space/%'
	OR "rkey" LIKE '%at://%/space/%'
	OR "name" LIKE '%at://%/space/%'
	OR "color" LIKE '%at://%/space/%'
	OR "badge"::text LIKE '%at://%/space/%'
	OR "permissions"::text LIKE '%at://%/space/%'
	OR "channel_overrides"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "service_state" SET
	"key" = regexp_replace("key", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"value" = regexp_replace("value", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"key" LIKE '%at://%/space/%'
	OR "value" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "space_credentials" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"key_did" = regexp_replace("key_did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"space" LIKE '%at://%/space/%'
	OR "key_did" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "space_moderations" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "space_notifications" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"level" = regexp_replace("level", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "level" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "space_repos" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"author" = regexp_replace("author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"applied_rev" = regexp_replace("applied_rev", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"remote_commit_hash" = regexp_replace("remote_commit_hash", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"state" = regexp_replace("state", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"error" = regexp_replace("error", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"retry_after" = regexp_replace("retry_after", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"host" = regexp_replace("host", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"space" LIKE '%at://%/space/%'
	OR "author" LIKE '%at://%/space/%'
	OR "applied_rev" LIKE '%at://%/space/%'
	OR "remote_commit_hash" LIKE '%at://%/space/%'
	OR "state" LIKE '%at://%/space/%'
	OR "error" LIKE '%at://%/space/%'
	OR "retry_after" LIKE '%at://%/space/%'
	OR "host" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "spaces" SET
	"uri" = regexp_replace("uri", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"authority" = regexp_replace("authority", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"space_type" = regexp_replace("space_type", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"skey" = regexp_replace("skey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"host" = regexp_replace("host", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"uri" LIKE '%at://%/space/%'
	OR "authority" LIKE '%at://%/space/%'
	OR "space_type" LIKE '%at://%/space/%'
	OR "skey" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "host" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "telemetry_state" SET
	"id" = regexp_replace("id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"instance_id" = regexp_replace("instance_id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"id" LIKE '%at://%/space/%'
	OR "instance_id" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "thread_follows" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"space" LIKE '%at://%/space/%'
	OR "did" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "threads" SET
	"space" = regexp_replace("space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"channel" = regexp_replace("channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"skey" = regexp_replace("skey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"name" = regexp_replace("name", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"anchor_space" = regexp_replace("anchor_space", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"anchor_author" = regexp_replace("anchor_author", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"anchor_rkey" = regexp_replace("anchor_rkey", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"anchor_cid" = regexp_replace("anchor_cid", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"created_by" = regexp_replace("created_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"visible_to_roles" = regexp_replace("visible_to_roles"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"visible_to_members" = regexp_replace("visible_to_members"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb
WHERE
	"space" LIKE '%at://%/space/%'
	OR "community" LIKE '%at://%/space/%'
	OR "channel" LIKE '%at://%/space/%'
	OR "skey" LIKE '%at://%/space/%'
	OR "name" LIKE '%at://%/space/%'
	OR "anchor_space" LIKE '%at://%/space/%'
	OR "anchor_author" LIKE '%at://%/space/%'
	OR "anchor_rkey" LIKE '%at://%/space/%'
	OR "anchor_cid" LIKE '%at://%/space/%'
	OR "created_by" LIKE '%at://%/space/%'
	OR "visible_to_roles"::text LIKE '%at://%/space/%'
	OR "visible_to_members"::text LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "user_presence" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"derived_state" = regexp_replace("derived_state", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"requested_state" = regexp_replace("requested_state", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"status_text" = regexp_replace("status_text", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"status_emoji" = regexp_replace("status_emoji", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"status_custom_emoji" = regexp_replace("status_custom_emoji"::text, 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')::jsonb,
	"voice_channel" = regexp_replace("voice_channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "derived_state" LIKE '%at://%/space/%'
	OR "requested_state" LIKE '%at://%/space/%'
	OR "status_text" LIKE '%at://%/space/%'
	OR "status_emoji" LIKE '%at://%/space/%'
	OR "status_custom_emoji"::text LIKE '%at://%/space/%'
	OR "voice_channel" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "voice_calls" SET
	"channel" = regexp_replace("channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"node_id" = regexp_replace("node_id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"channel" LIKE '%at://%/space/%'
	OR "node_id" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "voice_moderation" SET
	"community" = regexp_replace("community", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"community" LIKE '%at://%/space/%'
	OR "did" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "voice_move_grants" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"channel" = regexp_replace("channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"granted_by" = regexp_replace("granted_by", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "channel" LIKE '%at://%/space/%'
	OR "granted_by" LIKE '%at://%/space/%';
--> statement-breakpoint
UPDATE "voice_participants" SET
	"did" = regexp_replace("did", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"channel" = regexp_replace("channel", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g'),
	"node_id" = regexp_replace("node_id", 'at://(did:[a-z]+:[^/\"\s]+)/space/', 'at:space/\1/', 'g')
WHERE
	"did" LIKE '%at://%/space/%'
	OR "channel" LIKE '%at://%/space/%'
	OR "node_id" LIKE '%at://%/space/%';
