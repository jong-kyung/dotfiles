import { describe, expect, test } from "bun:test";
import { isUnsafeGhApi } from "../readonly-gh-api";

describe("readonly gh api", () => {
	test("blocks mutating requests and allows reads", () => {
		expect(isUnsafeGhApi("gh api repos/acme/app")).toBeFalse();
		expect(isUnsafeGhApi("gh api repos/acme/app -X DELETE")).toBeTrue();
		expect(isUnsafeGhApi("gh api repos/acme/app -f state=closed")).toBeTrue();
		expect(isUnsafeGhApi("gh api graphql -f query='{ viewer { login } }'")).toBeTrue();
	});
});
