"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { PauseBarsIcon, SquareIconButton, TimelinePlayIcon } from "./IconPrimitives";

const MODAL_BTN: React.CSSProperties = {
  color: "#eee",
  borderColor: "rgba(238,238,238,0.9)",
  background: "rgba(238,238,238,0.15)",
};

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function StylizedAudioPlayer(props: {
  src: string;
  autoPlay?: boolean;
  label?: string;
  tone?: "light" | "dark";
}) {
  const { src, autoPlay = false, label, tone = "light" } = props;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  const seekFromClientX = useCallback((clientX: number) => {
    const audio = audioRef.current;
    const track = trackRef.current;
    if (!audio || !track || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const t = ratio * audio.duration;
    try {
      audio.currentTime = t;
      setCurrent(t);
    } catch {
      /* not seekable yet */
    }
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onLoaded = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onTime = () => setCurrent(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrent(0);
    };

    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("durationchange", onLoaded);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    setPlaying(!audio.paused);
    setCurrent(audio.currentTime);
    onLoaded();

    if (autoPlay) {
      void audio.play().catch(() => setPlaying(false));
    }

    return () => {
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("durationchange", onLoaded);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [src, autoPlay]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      seekFromClientX(e.clientX);
    };
    const onUp = () => {
      dragRef.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [seekFromClientX]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }

  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const btnStyle = tone === "light" ? MODAL_BTN : undefined;

  return (
    <div
      style={{
        background: "#111",
        border: "1px solid rgba(255,255,255,0.2)",
        padding: 14,
        minWidth: 320,
        boxSizing: "border-box",
      }}
    >
      <audio ref={audioRef} src={src} preload="auto" style={{ display: "none" }} />

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <SquareIconButton
          size={36}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
          tone={tone}
          style={btnStyle}
          icon={playing ? <PauseBarsIcon /> : <TimelinePlayIcon />}
          onClick={togglePlay}
        />

        <div
          ref={trackRef}
          role="slider"
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={current}
          tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            dragRef.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            seekFromClientX(e.clientX);
          }}
          onKeyDown={(e) => {
            const audio = audioRef.current;
            if (!audio || duration <= 0) return;
            const step = e.shiftKey ? 5 : 1;
            if (e.key === "ArrowRight") {
              e.preventDefault();
              audio.currentTime = Math.min(duration, audio.currentTime + step);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              audio.currentTime = Math.max(0, audio.currentTime - step);
            }
          }}
          style={{
            flex: 1,
            height: 12,
            border: "1px solid rgba(255,255,255,0.35)",
            background: "rgba(0,0,0,0.35)",
            boxSizing: "border-box",
            cursor: "pointer",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${progress}%`,
              background: "rgba(255,255,255,0.55)",
              pointerEvents: "none",
            }}
          />
        </div>

        <span
          style={{
            fontSize: 11,
            color: "#aaa",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            minWidth: 72,
            textAlign: "right",
          }}
        >
          {formatTime(current)} / {formatTime(duration)}
        </span>
      </div>

      {label ? (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8, color: "#eee" }}>{label}</div>
      ) : null}
    </div>
  );
}
