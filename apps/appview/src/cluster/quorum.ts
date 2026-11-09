export const quorumFloor = (counted: number): number => {
	if (counted <= 2) {
		return 0.5;
	}

	if (counted === 3) {
		return 0.66;
	}

	if (counted === 4) {
		return 0.75;
	}

	return 0.8;
};

export const quorumAllows = (counted: number, remaining: number): boolean => {
	if (counted <= 0 || remaining <= 0) {
		return false;
	}

	return remaining / counted >= quorumFloor(counted);
};
