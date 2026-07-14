import { describe, expect, it } from "vitest";

import type { TimelineClip } from "../../lib/api";

import { trajectoryTransformAt } from "./trajectoryMotion";

import {

  applyGlideEase,

  effectiveHoldSec,

  holdTEnd,

  holdTFromPct,

  normalizeHoldSec,

  pauseHoldSecSliderMax,

  PAUSE_HOLD_SEC_UI_MAX,

} from "./trajectoryWaypoint";



function sampleClip(overrides?: Partial<TimelineClip>): TimelineClip {

  return {

    id: "c1",

    type: "image",

    start: 0,

    duration: 4,

    inPoint: 0,

    outPoint: 4,

    speed: 1,

    srcRelPath: "x.png",

    trajectory: {

      motion: "none",

      motionAmount: 50,

      waypoints: [

        { t: 0, x: -0.1, y: 0, scale: 1 },

        { t: 1, x: 0.1, y: 0, scale: 1.2 },

      ],

    },

    ...overrides,

  };

}



describe("trajectoryTransformAt defaults", () => {

  it("matches linear midpoint when holdSec and blendEase are missing", () => {

    const clip = sampleClip();

    const tf = trajectoryTransformAt(clip, 2);

    expect(tf).not.toBeNull();

    expect(tf!.x).toBeCloseTo(0, 9);

    expect(tf!.scale).toBeCloseTo(1.1, 9);

  });

});



describe("holdSec", () => {

  it("holds at waypoint for holdSec seconds", () => {

    const clip = sampleClip();

    clip.trajectory!.waypoints[0].holdSec = 2;

    const tf = trajectoryTransformAt(clip, 1);

    expect(tf!.x).toBeCloseTo(-0.1, 9);

    expect(tf!.y).toBeCloseTo(0, 9);

    expect(tf!.scale).toBeCloseTo(1, 9);

  });



  it("holdTEnd uses absolute seconds", () => {

    const wp = { t: 0, x: 0, y: 0, scale: 1, holdSec: 2 };

    expect(holdTEnd(wp, 0, 1, 4)).toBeCloseTo(0.5, 9);

  });



  it("normalizes holdSec to segment max", () => {

    expect(normalizeHoldSec(5, 2)).toBe(2);

    expect(normalizeHoldSec(-1, 2)).toBe(0);

  });



  it("migrates legacy holdPct to holdSec", () => {

    const wp = { t: 0, x: 0, y: 0, scale: 1, holdPct: 50 };

    expect(effectiveHoldSec(wp, 0, 1, 4)).toBeCloseTo(2, 9);

  });



  it("holdSec is stable when segment span shrinks (unlike holdPct)", () => {

    const wp = { t: 0, x: 0, y: 0, scale: 1, holdSec: 1.5 };

    expect(effectiveHoldSec(wp, 0, 1, 4)).toBe(1.5);

    expect(effectiveHoldSec(wp, 0, 0.5, 4)).toBe(1.5);

    const pctWp = { t: 0, x: 0, y: 0, scale: 1, holdPct: 50 };

    expect(effectiveHoldSec(pctWp, 0, 0.5, 4)).toBeCloseTo(1, 9);

  });



  it("legacy holdTFromPct still works for migration", () => {

    expect(holdTFromPct(50, 0, 1)).toBeCloseTo(0.5, 9);

  });



  it("pauseHoldSecSliderMax caps UI at 2s but respects short segments", () => {

    expect(pauseHoldSecSliderMax(10)).toBe(PAUSE_HOLD_SEC_UI_MAX);

    expect(pauseHoldSecSliderMax(0.5)).toBe(0.5);

    expect(pauseHoldSecSliderMax(0)).toBe(0);

  });

});



describe("glide ease temporal", () => {

  it("ease-out arrival is ahead of linear mid-segment (decel near end)", () => {

    const linear = 0.5;

    const eased = applyGlideEase(linear, 100, "arrival");

    expect(eased).toBeGreaterThan(linear);

    expect(applyGlideEase(1, 100, "arrival")).toBeCloseTo(1, 9);

  });



  it("ease-in departure slows progress near start", () => {

    const linear = 0.2;

    const eased = applyGlideEase(linear, 100, "departure");

    expect(eased).toBeLessThan(linear);

  });



  it("glide ease yields less displacement at same wall-clock time vs linear", () => {

    const waypoints = [

      { t: 0, x: 0, y: 0, scale: 1, holdSec: 1, blendEase: 0 },

      { t: 1, x: 0.2, y: 0, scale: 1, holdSec: 0.5, blendEase: 100 },

    ];

    const linearClip = sampleClip({

      trajectory: { motion: "none", motionAmount: 50, waypoints },

    });

    const glideClip = sampleClip({

      trajectory: {

        motion: "none",

        motionAmount: 50,

        waypoints: waypoints.map((w) => ({ ...w, blendEase: 100 })),

      },

    });

    const linear = trajectoryTransformAt(linearClip, 3.5)!;

    const glide = trajectoryTransformAt(glideClip, 3.5)!;

    expect(glide.x).toBeLessThan(linear.x);

  });



  it("applies arrival glide ease on the final waypoint without a pause", () => {

    const linearClip = sampleClip({

      duration: 4,

      trajectory: {

        motion: "none",

        motionAmount: 50,

        waypoints: [

          { t: 0, x: 0, y: 0, scale: 1 },

          { t: 1, x: 1, y: 0, scale: 1, blendEase: 0 },

        ],

      },

    });

    const glideClip = sampleClip({

      duration: 4,

      trajectory: {

        motion: "none",

        motionAmount: 50,

        waypoints: [

          { t: 0, x: 0, y: 0, scale: 1 },

          { t: 1, x: 1, y: 0, scale: 1, blendEase: 100 },

        ],

      },

    });

    const linear = trajectoryTransformAt(linearClip, 2)!;

    const glide = trajectoryTransformAt(glideClip, 2)!;

    // Arrival ease-out is ahead of linear mid-segment (decel near end).

    expect(glide.x).toBeGreaterThan(linear.x);

  });

});


