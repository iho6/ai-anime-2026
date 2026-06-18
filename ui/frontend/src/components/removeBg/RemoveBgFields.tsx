"use client";

import React from "react";
import type { AnimeSegBgOptions, RmbgBgOptions } from "../../lib/api";

export const removeBgLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.7)",
  marginBottom: 4,
};

export const removeBgInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  background: "#1a1a1a",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#eee",
  borderRadius: 4,
  boxSizing: "border-box",
};

export function RemoveBgNumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 1, disabled, onChange } = props;
  return (
    <label style={{ display: "block" }}>
      <div style={removeBgLabelStyle}>{label}</div>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        style={removeBgInputStyle}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export const DEFAULT_RMBG_OPTIONS: RmbgBgOptions = {
  sensitivity: 1,
  mask_offset: 0,
  mask_blur: 0,
  process_res: 1024,
  refine_foreground: false,
};

export const DEFAULT_ANIME_SEG_OPTIONS: AnimeSegBgOptions = {
  net: "isnet_is",
  img_size: 1024,
  mask_threshold: 0.5,
  mask_grow_px: 0,
  mask_blur_px: 0,
  fp32: false,
};

export function RmbgFields(props: {
  value: RmbgBgOptions;
  disabled?: boolean;
  onChange: (next: RmbgBgOptions) => void;
}) {
  const { value, disabled, onChange } = props;
  const set = (patch: Partial<RmbgBgOptions>) => onChange({ ...value, ...patch });
  return (
    <>
      <RemoveBgNumberField
        label="Sensitivity"
        value={value.sensitivity ?? 1}
        min={0.5}
        max={1.5}
        step={0.05}
        disabled={disabled}
        onChange={(sensitivity) => set({ sensitivity })}
      />
      <RemoveBgNumberField
        label="Mask expand (px)"
        value={value.mask_offset ?? 0}
        min={0}
        max={64}
        disabled={disabled}
        onChange={(mask_offset) => set({ mask_offset })}
      />
      <RemoveBgNumberField
        label="Mask blur"
        value={value.mask_blur ?? 0}
        min={0}
        max={20}
        disabled={disabled}
        onChange={(mask_blur) => set({ mask_blur })}
      />
      <RemoveBgNumberField
        label="Process resolution"
        value={value.process_res ?? 1024}
        min={512}
        max={2048}
        step={128}
        disabled={disabled}
        onChange={(process_res) => set({ process_res })}
      />
      <label
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
        }}
      >
        <input
          type="checkbox"
          checked={Boolean(value.refine_foreground)}
          disabled={disabled}
          onChange={(e) => set({ refine_foreground: e.target.checked })}
        />
        Refine foreground
      </label>
    </>
  );
}

export function AnimeSegFields(props: {
  value: AnimeSegBgOptions;
  disabled?: boolean;
  onChange: (next: AnimeSegBgOptions) => void;
}) {
  const { value, disabled, onChange } = props;
  const set = (patch: Partial<AnimeSegBgOptions>) => onChange({ ...value, ...patch });
  return (
    <>
      <label style={{ display: "block" }}>
        <div style={removeBgLabelStyle}>Model</div>
        <select
          value={value.net ?? "isnet_is"}
          disabled={disabled}
          style={removeBgInputStyle}
          onChange={(e) => set({ net: e.target.value })}
        >
          <option value="isnet_is">isnet_is</option>
          <option value="isnet">isnet</option>
          <option value="u2net">u2net</option>
          <option value="u2netl">u2netl</option>
          <option value="modnet">modnet</option>
        </select>
      </label>
      <RemoveBgNumberField
        label="Image size"
        value={value.img_size ?? 1024}
        min={384}
        max={1280}
        step={32}
        disabled={disabled}
        onChange={(img_size) => set({ img_size })}
      />
      <RemoveBgNumberField
        label="Mask threshold"
        value={value.mask_threshold ?? 0.5}
        min={0.1}
        max={0.9}
        step={0.05}
        disabled={disabled}
        onChange={(mask_threshold) => set({ mask_threshold })}
      />
      <RemoveBgNumberField
        label="Mask grow (px)"
        value={value.mask_grow_px ?? 0}
        min={0}
        max={20}
        disabled={disabled}
        onChange={(mask_grow_px) => set({ mask_grow_px })}
      />
      <RemoveBgNumberField
        label="Mask blur"
        value={value.mask_blur_px ?? 0}
        min={0}
        max={20}
        disabled={disabled}
        onChange={(mask_blur_px) => set({ mask_blur_px })}
      />
    </>
  );
}
