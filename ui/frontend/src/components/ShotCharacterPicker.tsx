"use client";

import React, { useCallback } from "react";
import {
  apiExpressionGallerySplit,
  apiHubCharacters,
  apiPoseGallerySplit,
} from "../lib/api";
import {
  ShotPickerIcon,
  ShotPickerSection,
  ShotTwoStagePicker,
} from "./ShotTwoStagePicker";

/**
 * Character picker: stage 1 = character icons, stage 2 = that character's gallery
 * (Pose + Expression). Picking an image adds/replaces a character layer.
 *
 * When ``initialKey`` is set the modal opens straight into that character's
 * gallery (used by the composer's right-click "Change View").
 */
export function ShotCharacterPicker(props: {
  open: boolean;
  initialKey?: string | null;
  onPick: (charKey: string, relPath: string) => void;
  onCancel: () => void;
}) {
  const loadIcons = useCallback(async (): Promise<ShotPickerIcon[]> => {
    const items = await apiHubCharacters();
    return items.map((it) => ({
      key: it.charKey,
      label: it.charKey,
      coverRelPath: it.coverRelPath,
    }));
  }, []);

  const loadSections = useCallback(
    async (charKey: string): Promise<ShotPickerSection[]> => {
      const [poses, exprs] = await Promise.all([
        apiPoseGallerySplit(charKey),
        apiExpressionGallerySplit(charKey),
      ]);
      return [
        {
          title: "Pose",
          images: (poses.visible ?? []).map((x) => ({ relPath: x.relPath })),
        },
        {
          title: "Expression",
          images: (exprs.visible ?? []).map((x) => ({ relPath: x.relPath })),
        },
      ];
    },
    []
  );

  return (
    <ShotTwoStagePicker
      open={props.open}
      title="Add Character"
      loadIcons={loadIcons}
      loadSections={loadSections}
      initialKey={props.initialKey ?? null}
      onPick={props.onPick}
      onCancel={props.onCancel}
    />
  );
}
