"use client";

import { useCallback, useMemo, useState } from "react";
import {
  apiSequenceGet,
  apiSequencePut,
  assetUrlFromRelPath,
  runDetailWsJob,
} from "../lib/api";
import type { BeginSessionOpts } from "./useJobRunSession";

export type CharacterGalleryGenType = "pose" | "expression";

type UseCharacterGalleryAiEditParams = {
  charKey: string | null | undefined;
  refreshSections: () => Promise<void>;
  beginSession: (opts: BeginSessionOpts) => void;
  endSession: () => void;
  failSession: (err: unknown, userMessage: string) => void;
  onJobLogLine: (line: string) => void;
  showError: (opts: { message: string }) => void;
  busy?: boolean;
};

export function useCharacterGalleryAiEdit({
  charKey,
  refreshSections,
  beginSession,
  endSession,
  failSession,
  onJobLogLine,
  showError,
  busy = false,
}: UseCharacterGalleryAiEditParams) {
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditType, setAiEditType] = useState<CharacterGalleryGenType>("pose");
  const [aiEditPoseKey, setAiEditPoseKey] = useState("");
  const [aiEditSourceRelPath, setAiEditSourceRelPath] = useState("");
  const [aiEditSeqCtx, setAiEditSeqCtx] = useState<{
    seqName: string;
    galleryItemId: string;
  } | null>(null);

  const closeAiEdit = useCallback(() => {
    setAiEditOpen(false);
    setAiEditSeqCtx(null);
  }, []);

  const openAiEditForGallery = useCallback(
    (opts: {
      sourceRelPath: string;
      type: CharacterGalleryGenType;
      poseFolderKey: string;
    }) => {
      const rel = (opts.sourceRelPath || "").trim();
      if (!rel) {
        showError({ message: "AI Edit: source image not found." });
        return;
      }
      setAiEditSeqCtx(null);
      setAiEditType(opts.type);
      setAiEditPoseKey(opts.poseFolderKey);
      setAiEditSourceRelPath(rel);
      setAiEditOpen(true);
    },
    [showError]
  );

  const openAiEditSequenceGallery = useCallback(
    (opts: { sourceRelPath: string; galleryItemId: string; sequenceName: string }) => {
      const seqName = (opts.sequenceName || "").trim();
      if (!seqName) {
        showError({ message: "AI Edit: sequence name missing." });
        return;
      }
      const rel = (opts.sourceRelPath || "").trim();
      if (!rel) {
        showError({ message: "AI Edit: source image not found." });
        return;
      }
      setAiEditSeqCtx({ seqName, galleryItemId: opts.galleryItemId });
      setAiEditPoseKey("");
      setAiEditSourceRelPath(rel);
      setAiEditOpen(true);
    },
    [showError]
  );

  const onAiEditGenerate = useCallback(
    async (promptText: string, maskPngBase64?: string) => {
      if (!charKey || !aiEditSourceRelPath) {
        showError({ message: "AI Edit: source image not found." });
        return;
      }

      if (aiEditSeqCtx) {
        const { seqName, galleryItemId } = aiEditSeqCtx;
        setAiEditOpen(false);
        beginSession({
          title: "AI Editing sequence frame",
          clearLog: true,
          runningStatus: "AI editing…",
        });
        await Promise.resolve();
        onJobLogLine("AI editing…");
        try {
          const done = await runDetailWsJob<{ fileRelPath: string }>({
            charKey,
            pathSuffix: "/dataset/ws",
            payload: {
              job: "ai_edit_sequence_gallery_image",
              sequenceName: seqName,
              sourceRelPath: aiEditSourceRelPath,
              promptText,
              ...(maskPngBase64 ? { maskPngBase64 } : {}),
            },
            onLogLine: onJobLogLine,
          });
          if (!done.ok || !done.result?.fileRelPath) {
            throw new Error(done.error ?? "AI Edit sequence frame failed");
          }
          const manifest = await apiSequenceGet(charKey, seqName);
          const gi = manifest.gallery.findIndex((g) => g.id === galleryItemId);
          if (gi < 0) throw new Error("AI Edit: sequence gallery item no longer exists");
          const nextGallery = manifest.gallery.map((g, i) =>
            i === gi ? { ...g, relPath: done.result!.fileRelPath } : g
          );
          await apiSequencePut(charKey, seqName, { ...manifest, gallery: nextGallery });
          await refreshSections();
          endSession();
        } catch (err) {
          failSession(err, "AI Edit sequence frame failed.");
        } finally {
          setAiEditSeqCtx(null);
        }
        return;
      }

      if (!aiEditPoseKey) {
        showError({ message: "AI Edit: gallery item not found." });
        return;
      }

      const aiPose = aiEditType === "pose";
      setAiEditOpen(false);
      beginSession({
        title: aiPose ? "AI Editing pose" : "AI Editing expression",
        clearLog: true,
        runningStatus: "AI editing…",
      });
      await Promise.resolve();
      onJobLogLine("AI editing…");
      try {
        const done = await runDetailWsJob<{ newRelPath: string }>({
          charKey,
          pathSuffix: aiPose ? "/pose/ws" : "/expression/ws",
          payload: {
            job: aiPose ? "ai_edit_pose" : "ai_edit_expression",
            [aiPose ? "poseKey" : "exprKey"]: aiEditPoseKey,
            sourceRelPath: aiEditSourceRelPath,
            promptText,
            ...(maskPngBase64 ? { maskPngBase64 } : {}),
          },
          onLogLine: onJobLogLine,
        });
        if (!done.ok) {
          throw new Error(done.error ?? "AI Edit failed");
        }
        await refreshSections();
        endSession();
      } catch (err) {
        failSession(err, "AI Edit failed.");
      }
    },
    [
      aiEditPoseKey,
      aiEditSourceRelPath,
      aiEditType,
      aiEditSeqCtx,
      beginSession,
      charKey,
      endSession,
      failSession,
      onJobLogLine,
      refreshSections,
      showError,
    ]
  );

  const aiEditModalProps = useMemo(
    () => ({
      open: aiEditOpen,
      title: "AI Edit" as const,
      imageSrc: aiEditSourceRelPath ? assetUrlFromRelPath(aiEditSourceRelPath) : "",
      busy,
      onCancel: closeAiEdit,
      onGenerate: (promptText: string, maskPngBase64?: string) =>
        void onAiEditGenerate(promptText, maskPngBase64),
    }),
    [aiEditOpen, aiEditSourceRelPath, busy, closeAiEdit, onAiEditGenerate]
  );

  return {
    aiEditOpen,
    openAiEditForGallery,
    openAiEditSequenceGallery,
    aiEditModalProps,
  };
}
