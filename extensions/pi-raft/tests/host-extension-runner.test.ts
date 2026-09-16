import { describe, expect, it } from "vitest";
import {
  observeHostExtensionRunner,
  registeredToolNames,
} from "../src/core/host-extension-runner.js";

describe("registeredToolNames", () => {
  it("returns an empty list when the host runner is missing", () => {
    expect(registeredToolNames(undefined)).toEqual([]);
  });

  it("reads definition names from the live runner", () => {
    expect(
      registeredToolNames({
        getAllRegisteredTools: () => [
          { definition: { name: "read" } },
          { definition: { name: "browser" } },
          { definition: { name: "" } },
        ],
      }),
    ).toEqual(["read", "browser"]);
  });
});

describe("observeHostExtensionRunner", () => {
  it("stays empty without host package discovery instead of importing the host", async () => {
    const handle = await observeHostExtensionRunner();
    expect(handle.current()).toBeUndefined();
    expect(registeredToolNames(handle.current())).toEqual([]);
  });
});
