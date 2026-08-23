import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema/pg.ts",
	out: "./migrations/pg",
	dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/colibri" },
});
