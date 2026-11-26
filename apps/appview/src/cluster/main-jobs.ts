export type MainJobs = {
	stop: () => Promise<void>;
};

export type MainJobsSlot = {
	start: () => Promise<void>;
	stop: () => Promise<void>;
};

export const mainJobsSlot = (launch: () => Promise<MainJobs>): MainJobsSlot => {
	let jobs: MainJobs | null = null;
	let starting: Promise<void> | null = null;

	const start = async (): Promise<void> => {
		const launched = launch().then((started) => {
			jobs = started;
		});

		starting = launched;

		try {
			await launched;
		} finally {
			if (starting === launched) {
				starting = null;
			}
		}
	};

	const stop = async (): Promise<void> => {
		await starting?.catch(() => undefined);

		const running = jobs;

		jobs = null;
		await running?.stop();
	};

	return { start, stop };
};
