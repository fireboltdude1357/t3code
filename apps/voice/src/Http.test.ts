import { assert, it } from "@effect/vitest";

import { isTrustedUpgrade } from "./Http.ts";

it("accepts the phone's native socket and loopback", () => {
  assert.isTrue(isTrustedUpgrade("stl-wsl.tail1fd0aa.ts.net:3780", undefined));
  assert.isTrue(
    isTrustedUpgrade("stl-wsl.tail1fd0aa.ts.net:3780", "http://stl-wsl.tail1fd0aa.ts.net:3780"),
  );
  assert.isTrue(isTrustedUpgrade("100.115.179.3:3780", undefined));
  assert.isTrue(isTrustedUpgrade("127.0.0.1:3780", undefined));
});

it("refuses web pages and rebound hostnames", () => {
  // A page on an owner device opening the socket cross-site.
  assert.isFalse(isTrustedUpgrade("127.0.0.1:3780", "https://evil.example"));
  assert.isFalse(isTrustedUpgrade("stl-wsl.tail1fd0aa.ts.net:3780", "https://evil.example"));
  // DNS rebinding: evil.example now resolves to the host, Origin matches Host.
  assert.isFalse(isTrustedUpgrade("evil.example:3780", "http://evil.example:3780"));
  assert.isFalse(isTrustedUpgrade(undefined, undefined));
  assert.isFalse(isTrustedUpgrade("100.200.1.1:3780", undefined));
});
