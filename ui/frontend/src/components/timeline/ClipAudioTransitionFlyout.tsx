"use client";

import React, { useState } from "react";
import type { VolumeAutomationPoint } from "./volumeAutomation";
import {
  AUDIO_EDGE_DURATION_MIN,
  buildAudioEdgeVolumePoints,
  clampAudioEdgeDurationSec,
  defaultAudioEdgeDurationSec,
  inferAudioEdgeTransitions,
  type AudioEdgeTransitions,
} from "./volumeAutomation";

function EdgeRow(props: {
  label: string;
  checked: boolean;
  durationSec: number;
  maxSec: number;
  onToggle: (on: boolean) => void;
  onDuration: (sec: number) => void;
  onCommit: () => void;
}) {
  const { label, checked, durationSec, maxSec, onToggle, onDuration, onCommit } =
    props;
  const sliderMax = Math.max(AUDIO_EDGE_DURATION_MIN, maxSec);
  const sliderValue = Math.min(
    sliderMax,
    Math.max(AUDIO_EDGE_DURATION_MIN, durationSec)
  );

  return (
    <div style={{ marginBottom: 10 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: "#ddd",
          cursor: "pointer",
          marginBottom: 4,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            onToggle(e.target.checked);
            onCommit();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        {label}
      </label>
      {checked ? (
        <label
          style={{
            display: "block",
            fontSize: 11,
            color: "#aaa",
          }}
        >
          <div style={{ marginBottom: 4 }}>Duration</div>
          <input
            type="range"
            className="ui-square-range"
            min={AUDIO_EDGE_DURATION_MIN}
            max={sliderMax}
            step={0.05}
            value={sliderValue}
            disabled={maxSec < AUDIO_EDGE_DURATION_MIN}
            onChange={(e) => onDuration(Number(e.target.value))}
            onPointerUp={onCommit}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ borderTop: "none", width: "100%" }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 2,
              fontSize: 10,
              color: "#888",
              fontFamily: "monospace",
            }}
          >
            <span>{AUDIO_EDGE_DURATION_MIN.toFixed(2)}s</span>
            <span style={{ color: "#bbb" }}>{sliderValue.toFixed(2)}s</span>
            <span>{sliderMax.toFixed(2)}s</span>
          </div>
        </label>
      ) : null}
    </div>
  );
}

export function ClipAudioTransitionFlyout(props: {
  durationSec: number;
  points: VolumeAutomationPoint[] | undefined;
  onChange: (points: VolumeAutomationPoint[]) => void;
  onCommit: () => void;
}) {
  const { durationSec, points, onChange, onCommit } = props;
  const [edges, setEdges] = useState<AudioEdgeTransitions>(() =>
    inferAudioEdgeTransitions(durationSec, points)
  );

  const maxEdge = Math.min(3, Math.max(0, durationSec) * 0.49);
  const defaultDur = defaultAudioEdgeDurationSec(durationSec);

  function emit(next: AudioEdgeTransitions) {
    // Enforce exit exclusivity.
    const normalized: AudioEdgeTransitions = {
      fadeInSec: next.fadeInSec,
      fadeOutSec: next.crescendoSec != null ? null : next.fadeOutSec,
      crescendoSec: next.crescendoSec,
    };
    setEdges(normalized);
    onChange(buildAudioEdgeVolumePoints(durationSec, normalized));
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        padding: "8px 10px",
        minWidth: 200,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "#888",
          marginBottom: 8,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        Audio edges
      </div>
      <EdgeRow
        label="Fade in"
        checked={edges.fadeInSec != null}
        durationSec={edges.fadeInSec ?? defaultDur}
        maxSec={maxEdge}
        onToggle={(on) =>
          emit({
            ...edges,
            fadeInSec: on ? defaultDur : null,
          })
        }
        onDuration={(sec) =>
          emit({
            ...edges,
            fadeInSec: clampAudioEdgeDurationSec(durationSec, sec),
          })
        }
        onCommit={onCommit}
      />
      <EdgeRow
        label="Fade out"
        checked={edges.fadeOutSec != null}
        durationSec={edges.fadeOutSec ?? defaultDur}
        maxSec={maxEdge}
        onToggle={(on) =>
          emit({
            ...edges,
            fadeOutSec: on ? defaultDur : null,
            crescendoSec: on ? null : edges.crescendoSec,
          })
        }
        onDuration={(sec) =>
          emit({
            ...edges,
            fadeOutSec: clampAudioEdgeDurationSec(durationSec, sec),
            crescendoSec: null,
          })
        }
        onCommit={onCommit}
      />
      <EdgeRow
        label="Crescendo"
        checked={edges.crescendoSec != null}
        durationSec={edges.crescendoSec ?? defaultDur}
        maxSec={maxEdge}
        onToggle={(on) =>
          emit({
            ...edges,
            crescendoSec: on ? defaultDur : null,
            fadeOutSec: on ? null : edges.fadeOutSec,
          })
        }
        onDuration={(sec) =>
          emit({
            ...edges,
            crescendoSec: clampAudioEdgeDurationSec(durationSec, sec),
            fadeOutSec: null,
          })
        }
        onCommit={onCommit}
      />
    </div>
  );
}
