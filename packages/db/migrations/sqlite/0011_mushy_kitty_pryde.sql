DELETE FROM `space_credentials`;--> statement-breakpoint
ALTER TABLE `space_credentials` DROP COLUMN `bound_key_thumbprint`;--> statement-breakpoint
ALTER TABLE `space_credentials` DROP COLUMN `bound_private_jwk`;