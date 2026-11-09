import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

const subpathAliases = [
	{
		find: "@colibri-social/appview/cluster",
		replacement: join(root, "apps/appview/src/cluster/index.ts"),
	},
	{ find: "@colibri-social/appview/config", replacement: join(root, "apps/appview/src/config.ts") },
	{
		find: "@colibri-social/appview/context",
		replacement: join(root, "apps/appview/src/context.ts"),
	},
];

const workspaceAliases = () => [
	...subpathAliases,
	...["packages", "apps"].flatMap((group) =>
		readdirSync(join(root, group), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => ({
				find: `@colibri-social/${entry.name === "db" ? "appview-db" : entry.name}`,
				replacement: join(root, group, entry.name, "src/index.ts"),
			})),
	),
];

export default defineConfig({
	resolve: { alias: workspaceAliases() },
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["{packages,apps}/*/src/**/*.test.ts"],
				},
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: ["{packages,apps}/*/test/integration/**/*.test.ts"],
					testTimeout: 120_000,
					hookTimeout: 180_000,
					fileParallelism: false,
				},
			},
		],
	},
});
