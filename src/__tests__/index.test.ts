import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { GlideClient } from "@valkey/valkey-glide";
import { Cookie, type SessionData } from "express-session";
import { ValkeyStore } from "../index.ts";

async function setup() {
	const client = await GlideClient.createClient({
		addresses: [{ host: "localhost", port: 6379 }],
	});
	const store = new ValkeyStore({ client });

	return { client, store };
}

await test("defaults", async () => {
	const { client, store } = await setup();

	ok(store.client);
	equal(store.prefix, "sess:");
	equal(store.ttl, 86400); // defaults to one day
	equal(store.scanCount, 100);
	equal(store.serializer, JSON);
	equal(store.disableTouch, false);
	equal(store.disableTTL, false);

	client.close();
});

await test("redis", async () => {
	const { client, store } = await setup();
	await lifecycleTest(store, client);
	client.close();
});

async function lifecycleTest(
	store: ValkeyStore,
	client: GlideClient,
): Promise<void> {
	await store.clear();

	const sess = { foo: "bar", cookie: { originalMaxAge: null } };
	await store.set("123", sess);

	deepEqual(await store.get("123"), sess);

	let ttl = await client.ttl("sess:123");
	ok(ttl >= 86399);

	ttl = 60;
	let expires = new Date(Date.now() + ttl * 1000);
	await store.set("456", { cookie: { originalMaxAge: null, expires } });
	ttl = await client.ttl("sess:456");
	ok(ttl <= 60);

	ttl = 90;
	const expires2 = new Date(Date.now() + ttl * 1000);
	await store.touch("456", {
		cookie: { originalMaxAge: null, expires: expires2 },
	});
	ttl = await client.ttl("sess:456");
	ok(ttl > 60);

	equal(await store.length(), 2); // stored two keys length

	deepEqual((await store.ids()).sort(), ["123", "456"]);

	deepEqual(
		((await store.all()) as (SessionData & { id: string })[]).sort((a, b) =>
			a.id > b.id ? 1 : -1,
		),
		[
			{ id: "123", foo: "bar", cookie: { originalMaxAge: null } },
			{
				id: "456",
				cookie: { originalMaxAge: null, expires: expires.toISOString() },
			},
		],
	);

	await store.destroy("456");
	equal(await store.length(), 1); // one key remains

	await store.clear();

	equal(await store.length(), 0); // no keys remain

	const count = 1000;
	await load(store, count);

	equal(await store.length(), count);

	await store.clear();
	equal(await store.length(), 0);

	expires = new Date(Date.now() + ttl * 1000); // expires in the future
	await store.set("789", { cookie: { originalMaxAge: null, expires } });

	equal(await store.length(), 1);

	expires = new Date(Date.now() - ttl * 1000); // expires in the past
	await store.set("789", { cookie: { originalMaxAge: null, expires } });

	equal(await store.length(), 0); // no key remains and that includes session 789
}

async function load(store: ValkeyStore, count: number) {
	const cookie = new Cookie();
	for (let sid = 0; sid < count; sid++) {
		cookie.expires = new Date(Date.now() + 1000);
		await store.set(`s${sid}`, { cookie });
	}
}
