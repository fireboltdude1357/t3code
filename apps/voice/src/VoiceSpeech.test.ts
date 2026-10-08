import { assert, it } from "@effect/vitest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { describeSpeechFailure } from "./VoiceSpeech.ts";

it("describes an HTTP failure without the request's bearer token", () => {
  const request = HttpClientRequest.post("http://sotto.test/v1/generations").pipe(
    HttpClientRequest.bearerToken("secret-sotto-token"),
  );
  const failure = new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request }),
  });

  const described = describeSpeechFailure(failure);
  assert.deepStrictEqual(described, {
    kind: "TransportError",
    status: undefined,
    url: "http://sotto.test/v1/generations",
  });
  assert.notInclude(JSON.stringify(described), "secret-sotto-token");
});
