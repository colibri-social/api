import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "turso",
	schema: "./src/schema/sqlite.ts",
	out: "./migrations/sqlite",
	dbCredentials: { url: process.env.DATABASE_URL ?? "file:./data/colibri.db" },
});
