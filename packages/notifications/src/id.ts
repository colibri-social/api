const ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 13;
const TIMESTAMP_CHARS = 11;
const CLOCK_CHARS = 2;

const encode = (value: number, length: number): string => {
	let remaining = value;
	let out = "";
	for (let i = 0; i < length; i++) {
		out = ALPHABET[remaining % 32] + out;
		remaining = Math.floor(remaining / 32);
	}
	return out;
};

export const CLOCK_IDS = 32 ** CLOCK_CHARS;

let clockId = Math.floor(Math.random() * CLOCK_IDS);

export const setClockId = (value: number): void => {
	if (!Number.isInteger(value) || value < 0 || value >= CLOCK_IDS) {
		throw new RangeError(`clock id must be an integer from 0 to ${CLOCK_IDS - 1}`);
	}

	clockId = value;
};

let lastTimestamp = 0;
let counter = 0;

export const nextId = (): string => {
	const now = Date.now();
	if (now > lastTimestamp) {
		lastTimestamp = now;
		counter = 0;
	} else {
		counter++;
	}
	const value = lastTimestamp * 1000 + counter;
	return `${encode(value, TIMESTAMP_CHARS)}${encode(clockId, CLOCK_CHARS)}`;
};

export const isId = (value: string): boolean => value.length === ID_LENGTH;

export const idAt = (date: Date) => {
	return `${encode(date.getTime() * 1000, TIMESTAMP_CHARS)}${encode(0, CLOCK_CHARS)}`;
};
