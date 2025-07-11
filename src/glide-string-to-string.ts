import type { GlideString } from "@valkey/valkey-glide";

export function glideStringToString(input: GlideString): string {
	if (typeof input === "string") {
		return input;
	}

	return Buffer.from(input).toString("utf-8");
}
