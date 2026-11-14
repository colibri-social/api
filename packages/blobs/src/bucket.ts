import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

export type BlobBucketConfig = {
	endpoint?: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
};

export type BlobByteRange = {
	start: number;
	end: number;
};

export type BlobBucketObject = {
	stream: AsyncIterable<Uint8Array>;
	length: number | null;
};

export type BlobBucket = {
	put: (key: string, bytes: Uint8Array, mimeType: string) => Promise<void>;
	get: (key: string, range?: BlobByteRange) => Promise<BlobBucketObject | null>;
	delete: (key: string) => Promise<void>;
};

export type BlobBucketClient = Pick<S3Client, "send">;

const MISSING_ERRORS = new Set(["NoSuchKey", "NotFound"]);

export const blobBucketKey = (author: string, cid: string): string => {
	return `polyfill/${author}/${cid}`;
};

const isMissing = (error: unknown): boolean => {
	const candidate = error as {
		name?: unknown;
		$metadata?: { httpStatusCode?: unknown };
	} | null;

	return (
		MISSING_ERRORS.has(String(candidate?.name)) || candidate?.$metadata?.httpStatusCode === 404
	);
};

const isMissingBucket = (error: unknown): boolean => {
	return (error as { name?: unknown } | null)?.name === "NoSuchBucket";
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<Uint8Array> => {
	return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
};

const emptyStream = async function* (): AsyncGenerator<Uint8Array> {};

export class S3BlobBucket implements BlobBucket {
	private readonly client: BlobBucketClient;
	private readonly bucket: string;

	constructor(config: BlobBucketConfig, client?: BlobBucketClient) {
		this.bucket = config.bucket;
		this.client =
			client ??
			new S3Client({
				region: config.region,
				forcePathStyle: config.forcePathStyle,
				credentials: {
					accessKeyId: config.accessKeyId,
					secretAccessKey: config.secretAccessKey,
				},
				...(config.endpoint ? { endpoint: config.endpoint } : {}),
			});
	}

	async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
		const command = new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			Body: bytes,
			ContentType: mimeType,
			ContentLength: bytes.byteLength,
		});

		try {
			await this.client.send(command);
		} catch (error) {
			if (!isMissingBucket(error)) {
				throw error;
			}

			await this.createBucket();
			await this.client.send(command);
		}
	}

	private async createBucket(): Promise<void> {
		try {
			await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
		} catch (error) {
			const name = (error as { name?: unknown } | null)?.name;

			if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
				throw error;
			}
		}
	}

	async get(key: string, range?: BlobByteRange): Promise<BlobBucketObject | null> {
		try {
			const output = await this.client.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: key,
					...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
				}),
			);
			const body = output.Body;

			return {
				stream: isAsyncIterable(body) ? body : emptyStream(),
				length: output.ContentLength ?? null,
			};
		} catch (error) {
			if (isMissing(error)) {
				return null;
			}

			throw error;
		}
	}

	async delete(key: string): Promise<void> {
		await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
	}
}

export class MemoryBlobBucket implements BlobBucket {
	private readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

	async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
		this.objects.set(key, { bytes: bytes.slice(), mimeType });
	}

	async get(key: string, range?: BlobByteRange): Promise<BlobBucketObject | null> {
		const stored = this.objects.get(key);

		if (!stored) {
			return null;
		}

		const bytes = range ? stored.bytes.subarray(range.start, range.end + 1) : stored.bytes;

		return {
			stream: (async function* () {
				yield bytes;
			})(),
			length: bytes.byteLength,
		};
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}

	has(key: string): boolean {
		return this.objects.has(key);
	}
}
