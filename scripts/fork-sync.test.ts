import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  forkVersion,
  formatForkManifest,
  latestNightlyTag,
  parseForkManifest,
  parsePatchList,
} from "./fork-sync.ts";

it.effect("parses patch lines in order, with an optional tracked upstream PR", () =>
  Effect.gen(function* () {
    const patches = yield* parsePatchList(
      [
        "# name  branch  tracks",
        "release patch/release",
        "",
        "home    patch/home    pingdotgg/t3code#15975  # Theo's PR",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      patches.map(({ name, branch, tracks }) => [name, branch, Option.getOrUndefined(tracks)]),
      [
        ["release", "patch/release", undefined],
        ["home", "patch/home", { repo: "pingdotgg/t3code", number: 15975 }],
      ],
    );
  }),
);

it.effect("rejects duplicate patch names", () =>
  Effect.gen(function* () {
    const error = yield* parsePatchList("voice patch/voice\nvoice patch/other").pipe(Effect.flip);
    assert.equal(error.reason, "duplicate patch name 'voice'");
  }),
);

it("picks the newest nightly by version, date, then run number", () => {
  assert.equal(
    Option.getOrUndefined(
      latestNightlyTag([
        "v0.0.46-nightly.20261011.2980",
        "v0.0.46-preview.20261012.3000",
        "v0.0.46-nightly.20261011.2994",
        "v0.0.46-nightly.20261010.2999",
        "android-nightly",
      ]),
    ),
    "v0.0.46-nightly.20261011.2994",
  );
  assert.equal(
    Option.getOrUndefined(
      latestNightlyTag(["v0.0.46-nightly.20261011.2994", "v0.0.47-nightly.20261012.3"]),
    ),
    "v0.0.47-nightly.20261012.3",
  );
});

it.effect("numbers fork builds per nightly and round-trips the manifest", () =>
  Effect.gen(function* () {
    const base = "v0.0.46-nightly.20261011.2994";
    const first = {
      version: yield* forkVersion(base, Option.none()),
      base,
      patches: [{ name: "home", sha: "b5d05a6ebf" }],
    };
    assert.equal(first.version, "0.0.46-nightly.20261011.299401");

    const parsed = parseForkManifest(formatForkManifest(first));
    assert.deepStrictEqual(Option.getOrUndefined(parsed), first);
    assert.equal(yield* forkVersion(base, parsed), "0.0.46-nightly.20261011.299402");
    assert.equal(
      yield* forkVersion("v0.0.46-nightly.20261012.3001", parsed),
      "0.0.46-nightly.20261012.300101",
    );
    assert.isTrue(Option.isNone(parseForkManifest("Merge pull request #13")));
  }),
);
