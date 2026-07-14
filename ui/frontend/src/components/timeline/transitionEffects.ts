import type {
  TimelineClip,
  TimelineTransitionOut,
  TransitionDirection,
  TimelineTransitionType,
} from "../../lib/api";

export type TransitionActiveLayer = {
  clip: TimelineClip;
  opacity: number;
  role: "outgoing" | "incoming" | "solo";
  progress: number;
  /** Mounted cold (opacity 0) to warm decode before a hard cut. */
  preload?: boolean;
  transitionType?: TimelineTransitionType;
  direction?: TransitionDirection;
  slideOffsetX?: number;
  slideOffsetY?: number;
  clipPath?: string;
};

export function smoothstep(p: number): number {
  const t = Math.max(0, Math.min(1, p));
  return t * t * (3 - 2 * t);
}

export function defaultDirection(
  type: TimelineTransitionType
): TransitionDirection {
  if (type === "wipe" || type === "slide") return "left";
  return "left";
}

export function resolveDirection(
  transition: TimelineTransitionOut
): TransitionDirection {
  return transition.direction ?? defaultDirection(transition.type);
}

/** CSS clip-path inset() for incoming wipe reveal (progress 0–1). */
export function computeWipeClipPath(
  direction: TransitionDirection,
  progress: number
): string {
  const p = Math.max(0, Math.min(1, progress));
  const hidden = (1 - p) * 100;
  switch (direction) {
    case "left":
      return `inset(0 ${hidden}% 0 0)`;
    case "right":
      return `inset(0 0 0 ${hidden}%)`;
    case "up":
      return `inset(0 0 ${hidden}% 0)`;
    case "down":
      return `inset(${hidden}% 0 0 0)`;
  }
}

/** Slide offset as fraction of layer width/height. */
export function computeSlideOffsets(
  direction: TransitionDirection,
  progress: number,
  role: "outgoing" | "incoming"
): { slideOffsetX: number; slideOffsetY: number } {
  const p = Math.max(0, Math.min(1, progress));
  let slideOffsetX = 0;
  let slideOffsetY = 0;

  if (direction === "left") {
    slideOffsetX = role === "incoming" ? -(1 - p) : -p;
  } else if (direction === "right") {
    slideOffsetX = role === "incoming" ? 1 - p : p;
  } else if (direction === "up") {
    slideOffsetY = role === "incoming" ? -(1 - p) : -p;
  } else if (direction === "down") {
    slideOffsetY = role === "incoming" ? 1 - p : p;
  }

  return { slideOffsetX, slideOffsetY };
}

export function layersForTransition(
  outgoing: TimelineClip,
  incoming: TimelineClip,
  progress: number,
  transition: TimelineTransitionOut
): TransitionActiveLayer[] {
  const type = transition.type;
  const direction = resolveDirection(transition);
  const p = Math.max(0, Math.min(1, progress));

  const base = {
    progress: p,
    transitionType: type,
    direction,
  };

  if (type === "fade") {
    return [
      {
        clip: outgoing,
        opacity: 1 - p,
        role: "outgoing",
        ...base,
      },
      {
        clip: incoming,
        opacity: p,
        role: "incoming",
        ...base,
      },
    ];
  }

  if (type === "dissolve") {
    const sp = smoothstep(p);
    return [
      {
        clip: outgoing,
        opacity: 1 - sp,
        role: "outgoing",
        ...base,
      },
      {
        clip: incoming,
        opacity: sp,
        role: "incoming",
        ...base,
      },
    ];
  }

  if (type === "wipe") {
    return [
      {
        clip: outgoing,
        opacity: 1,
        role: "outgoing",
        ...base,
      },
      {
        clip: incoming,
        opacity: 1,
        role: "incoming",
        clipPath: computeWipeClipPath(direction, p),
        ...base,
      },
    ];
  }

  // slide
  const outOff = computeSlideOffsets(direction, p, "outgoing");
  const inOff = computeSlideOffsets(direction, p, "incoming");
  return [
    {
      clip: outgoing,
      opacity: 1,
      role: "outgoing",
      slideOffsetX: outOff.slideOffsetX,
      slideOffsetY: outOff.slideOffsetY,
      ...base,
    },
    {
      clip: incoming,
      opacity: 1,
      role: "incoming",
      slideOffsetX: inOff.slideOffsetX,
      slideOffsetY: inOff.slideOffsetY,
      ...base,
    },
  ];
}

export function transitionBadge(type: TimelineTransitionType): string {
  switch (type) {
    case "fade":
    case "dissolve":
      return "◐";
    case "wipe":
      return "▸";
    case "slide":
      return "⇄";
  }
}
