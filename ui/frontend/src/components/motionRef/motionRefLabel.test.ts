import { describe, expect, it } from "vitest";
import {
  motionRefAutoNameFromSegment,
  motionRefDisplayLabel,
  stripMotionPersonIsPrefix,
} from "./motionRefLabel";

describe("motionRefLabel", () => {
  it("strips A person is prefix case-insensitively", () => {
    expect(stripMotionPersonIsPrefix("A person is walking")).toBe("walking");
    expect(stripMotionPersonIsPrefix("a person is  jumping")).toBe("jumping");
    expect(stripMotionPersonIsPrefix("A PERSON IS dancing")).toBe("dancing");
  });

  it("leaves text without the prefix unchanged", () => {
    expect(stripMotionPersonIsPrefix("running fast")).toBe("running fast");
  });

  it("falls back for empty strip results", () => {
    expect(motionRefAutoNameFromSegment("A person is ")).toBe("motion");
    expect(motionRefDisplayLabel("A person is ", "my_key")).toBe("my_key");
  });

  it("truncates auto names and labels", () => {
    const long = "A person is " + "x".repeat(50);
    expect(motionRefAutoNameFromSegment(long, 10)).toBe("x".repeat(10));
    expect(motionRefDisplayLabel(long, "key", 5)).toBe("xxxxx");
  });
});
