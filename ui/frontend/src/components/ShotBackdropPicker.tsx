"use client";

import React, { useCallback } from "react";
import {
  apiLocationGallerySplit,
  apiLocationHubItems,
} from "../lib/api";
import {
  ShotPickerIcon,
  ShotPickerSection,
  ShotTwoStagePicker,
} from "./ShotTwoStagePicker";

/**
 * Backdrop picker: stage 1 = location icons, stage 2 = that location's gallery
 * (Angles + Lighting). Picking an image sets it as the shot backdrop.
 */
export function ShotBackdropPicker(props: {
  open: boolean;
  onPick: (locationKey: string, relPath: string) => void;
  onCancel: () => void;
}) {
  const loadIcons = useCallback(async (): Promise<ShotPickerIcon[]> => {
    const items = await apiLocationHubItems();
    return items.map((it) => ({
      key: it.locationKey,
      label: it.locationKey,
      coverRelPath: it.coverRelPath,
    }));
  }, []);

  const loadSections = useCallback(
    async (locationKey: string): Promise<ShotPickerSection[]> => {
      const split = await apiLocationGallerySplit(locationKey);
      const sections: ShotPickerSection[] = [];
      if (split.baseRelPath) {
        sections.push({
          title: "Base",
          images: [{ relPath: split.baseRelPath }],
        });
      }
      sections.push({
        title: "Angles",
        images: (split.view ?? []).map((x) => ({ relPath: x.relPath })),
      });
      sections.push({
        title: "Lighting",
        images: (split.lighting ?? []).map((x) => ({ relPath: x.relPath })),
      });
      return sections;
    },
    []
  );

  return (
    <ShotTwoStagePicker
      open={props.open}
      title="Add Backdrop"
      loadIcons={loadIcons}
      loadSections={loadSections}
      onPick={props.onPick}
      onCancel={props.onCancel}
    />
  );
}
