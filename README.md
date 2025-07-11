# connect-valkey

![NPM](https://img.shields.io/npm/l/connect-valkey)
![NPM](https://img.shields.io/npm/v/connect-valkey)
![GitHub Workflow Status](https://github.com/gjuchault/connect-valkey/actions/workflows/typescript-library-starter.yml/badge.svg?branch=main)

Valkey session store for connect-compatible servers (@fastify/session, express, connect, etc.)

Most of it is adapted from [connect-redis](https://github.com/tj/connect-redis)

## Installation

**connect-valkey** requires `express-session` and `@valkey/valkey-glide`[1]:

```sh
npm install @valkey/valkey-glide connect-valkey express-session
```

## API

Full setup:

```js
import { ValkeyStore } from "connect-valkey";
import session from "express-session";
import { GlideClient } from "@valkey/valkey-glide";

// Initialize client.
const client = await GlideClient.createClient({
  addresses: [{ host: "localhost", port: 6379 }],
});

// Initialize store.
let valkeyStore = new ValkeyStore({
  client,
  prefix: "app:",
});

// Initialize session storage.
app.use(
  session({
    store: valkeyStore,
    resave: false, // required: force lightweight session keep alive (touch)
    saveUninitialized: false, // recommended: only save session when data exists
    secret: "keyboard cat",
  })
);
```

### ValkeyStore(options)

#### Options

##### client

An instance of [`@valkey/valkey-glide`][1]

##### prefix

Key prefix in Valkey (default: `sess:`).

**Note**: This prefix appends to whatever prefix you may have set on the `client` itself.

**Note**: You may need unique prefixes for different applications sharing the same Valkey instance. This limits bulk commands exposed in `express-session` (like `length`, `all`, `keys`, and `clear`) to a single application's data.

##### ttl

If the session cookie has a `expires` date, `connect-valkey` will use it as the TTL.

Otherwise, it will expire the session using the `ttl` option (default: `86400` seconds or one day).

```ts
interface ValkeyStoreOptions {
  ...
  ttl?: number | {(sess: SessionData): number}
}
```

`ttl` also has external callback support. You can use it for dynamic TTL generation. It has access to `session` data.

**Note**: The TTL is reset every time a user interacts with the server. You can disable this behavior in _some_ instances by using `disableTouch`.

**Note**: `express-session` does not update `expires` until the end of the request life cycle. _Calling `session.save()` manually beforehand will have the previous value_.

##### disableTouch

Disables resetting the TTL when using `touch` (default: `false`)

The `express-session` package uses `touch` to signal to the store that the user has interacted with the session but hasn't changed anything in its data. Typically, this helps keep the users session alive if session changes are infrequent but you may want to disable it to cut down the extra calls or to prevent users from keeping sessions open too long. Also consider enabling if you store a lot of data on the session.

Ref: <https://github.com/expressjs/session#storetouchsid-session-callback>

##### disableTTL

Disables key expiration completely (default: `false`)

This option disables key expiration requiring the user to manually manage key cleanup outside of `connect-valkey`. Only use if you know what you are doing and have an exceptional case where you need to manage your own expiration in Valkey.

**Note**: This has no effect on `express-session` setting cookie expiration.

##### serializer

Provide a custom encoder/decoder to use when storing and retrieving session data from Valkey (default: `JSON.parse` and `JSON.stringify`).

Optionally `parse` method can be async if need be.

```ts
interface Serializer {
  parse(string): object | Promise<object>;
  stringify(object): string;
}
```

##### scanCount

Value used for _count_ parameter in [Valkey `SCAN` command](https://valkey.io/commands/scan/#the-count-option). Used for `ids()` and `all()` methods (default: `100`).

[1]: https://github.com/valkey-io/valkey-glide
