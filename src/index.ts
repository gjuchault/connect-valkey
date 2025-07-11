import {
	ClusterScanCursor,
	GlideClient,
	GlideClusterClient,
	type GlideString,
	TimeUnit,
} from "@valkey/valkey-glide";
import { type SessionData, Store } from "express-session";
import { glideStringToString } from "./glide-string-to-string.ts";

type Callback<Data = unknown, Err = unknown> = (
	_err: Err | null,
	_data: Data | null,
) => Err extends null ? Data : Err;

function optionalCb<Data, Err = unknown>(
	err: Err | null,
	data: Data | null,
	cb?: Callback<Data>,
): Err extends null ? Data : never {
	if (cb) return cb(err, data) as Err extends null ? Data : never;
	if (err) throw err;
	return data as Err extends null ? Data : never;
}

interface Serializer {
	parse(s: string): SessionData | Promise<SessionData>;
	stringify(s: SessionData): string;
}

interface ValkeyStoreOptions {
	client: GlideClient | GlideClusterClient;
	prefix?: string;
	scanCount?: number;
	serializer?: Serializer;
	ttl?: number | ((sess: SessionData) => number);
	disableTTL?: boolean;
	disableTouch?: boolean;
}

export class ValkeyStore extends Store {
	client: GlideClient | GlideClusterClient;
	prefix: string;
	scanCount: number;
	serializer: Serializer;
	ttl: number | ((sess: SessionData) => number);
	disableTTL: boolean;
	disableTouch: boolean;

	constructor(opts: ValkeyStoreOptions) {
		super();
		this.prefix = opts.prefix == null ? "sess:" : opts.prefix;
		this.scanCount = opts.scanCount || 100;
		this.serializer = opts.serializer || JSON;
		this.ttl = opts.ttl || 86400; // One day in seconds.
		this.disableTTL = opts.disableTTL || false;
		this.disableTouch = opts.disableTouch || false;
		this.client = opts.client;
	}

	async get(sid: string, cb?: Callback<SessionData>): Promise<SessionData> {
		const key = this.prefix + sid;
		try {
			const data = await this.client.get(key);
			if (!data) return optionalCb(null, null, cb);

			const str = glideStringToString(data);

			return optionalCb(null, await this.serializer.parse(str), cb);
		} catch (err) {
			return optionalCb(err, null, cb);
		}
	}

	async set(
		sid: string,
		sess: SessionData,
		cb?: Callback<null>,
	): Promise<null> {
		const key = this.prefix + sid;
		const ttl = this.getTTL(sess);
		try {
			if (ttl > 0) {
				const val = this.serializer.stringify(sess);
				if (this.disableTTL) await this.client.set(key, val);
				else
					await this.client.set(key, val, {
						expiry: { type: TimeUnit.Seconds, count: ttl },
					});
				return optionalCb(null, null, cb);
			}
			return this.destroy(sid, cb);
		} catch (err) {
			return optionalCb(err, null, cb);
		}
	}

	override async touch(
		sid: string,
		sess: SessionData,
		cb?: Callback<null>,
	): Promise<null> {
		const key = this.prefix + sid;
		if (this.disableTouch || this.disableTTL) return optionalCb(null, null, cb);
		try {
			await this.client.expire(key, this.getTTL(sess));
			return optionalCb(null, null, cb);
		} catch (err) {
			return optionalCb(err, null, cb);
		}
	}

	async destroy(sid: string, cb?: Callback<null>): Promise<null> {
		const key = this.prefix + sid;
		try {
			await this.client.del([key]);
			return optionalCb(null, null, cb);
		} catch (err) {
			return optionalCb(err, null, cb);
		}
	}

	override async clear(cb?: Callback<null>): Promise<null> {
		try {
			const keys = await this.getAllKeys();
			if (!keys.length) return optionalCb(null, null, cb);
			await this.client.del(keys);
			return optionalCb(null, null, cb);
		} catch (err) {
			return optionalCb(err, null, cb);
		}
	}

	// FIXME: somehow length in @types/express-session is expecting length to be number | undefined, but we want to return
	// number | null
	override async length(
		cb?: (err: unknown, length?: number | undefined) => void,
	): Promise<number> {
		try {
			const keys = await this.getAllKeys();
			return optionalCb(null, keys.length, cb as Callback<number>);
		} catch (err) {
			return optionalCb(err, null, cb as Callback<number>);
		}
	}

	async ids(cb?: Callback<string[]>): Promise<string[]> {
		const len = this.prefix.length;
		try {
			const keys = await this.getAllKeys();
			return optionalCb(
				null,
				keys.map((k) => k.substring(len)),
				cb,
			);
		} catch (err) {
			return optionalCb(err, null, cb);
		}
	}

	override async all(cb?: Callback<SessionData[]>): Promise<SessionData[]> {
		const len = this.prefix.length;
		try {
			const keys = await this.getAllKeys();
			if (keys.length === 0) return optionalCb(null, [], cb);

			const data = await this.client.mget(keys);
			const results = data.reduce((acc, raw, idx) => {
				if (!raw) return acc;
				const str = glideStringToString(raw);
				const sess = this.serializer.parse(str) as SessionData & { id: string };

				if (!keys[idx]) return acc;

				sess.id = keys[idx].substring(len);
				acc.push(sess);
				return acc;
			}, [] as SessionData[]);
			return optionalCb(null, results, cb);
		} catch (err) {
			return optionalCb(err, null, cb);
		}
	}

	private getTTL(sess: SessionData) {
		if (typeof this.ttl === "function") {
			return this.ttl(sess);
		}

		let ttl: number;
		if (sess?.cookie?.expires) {
			const ms = Number(new Date(sess.cookie.expires)) - Date.now();
			ttl = Math.ceil(ms / 1000);
		} else {
			ttl = this.ttl;
		}
		return ttl;
	}

	private async getAllKeys() {
		const pattern = `${this.prefix}*`;
		const set = new Set<string>();
		for await (const keys of this.scanIterator(pattern, this.scanCount)) {
			for (const key of keys) {
				set.add(glideStringToString(key));
			}
		}
		return set.size > 0 ? Array.from(set) : [];
	}

	private async *scanIterator(match: string, count: number) {
		if (this.client instanceof GlideClusterClient) {
			// For cluster clients, we need to scan each node separately
			yield* this.scanClusterKeys(match, count);
		} else {
			// For standalone clients, use regular SCAN
			yield* this.scanStandaloneKeys(match, count);
		}
	}

	private async *scanStandaloneKeys(match: string, count: number) {
		const client = this.client;

		if (client instanceof GlideClusterClient) {
			throw new Error("Standalone client cannot be used with cluster client");
		}

		let cursor: GlideString = "0";

		do {
			const [newCursor, keys] = await client.scan(cursor, {
				match,
				count,
			});
			cursor = newCursor;

			if (keys && keys.length > 0) {
				yield keys;
			}
		} while (cursor !== "0");
	}

	private async *scanClusterKeys(match: string, count: number) {
		const client = this.client;

		if (client instanceof GlideClient) {
			throw new Error("Cluster client cannot be used with standalone client");
		}

		let cursor = new ClusterScanCursor();

		do {
			const [newCursor, keys] = await client.scan(cursor, {
				match,
				count,
			});
			cursor = newCursor;

			if (keys && keys.length > 0) {
				yield keys;
			}
		} while (cursor.isFinished() === false);
	}
}
