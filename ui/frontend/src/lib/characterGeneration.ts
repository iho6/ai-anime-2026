import { runDetailWsJob, type WsDoneMessage } from "./api";
import type { KeypointRefEntry } from "./keypointRefGeneration";

export type GenKind = "pose" | "expression";

export type CharacterGenOptions = {
  skipCloseup?: boolean;
  cropPadding?: number;
  qwenCfg?: number;
};

export type CharacterGenKeypointRef =
  | { kind: "single"; keypointRelPath: string }
  | { kind: "folder"; folderId: string }
  | { kind: "video"; videoRefId: string }
  | null;

export function keypointRefToGenRef(
  ref: KeypointRefEntry | null | undefined
): CharacterGenKeypointRef {
  if (!ref) return null;
  if (ref.kind === "single") {
    const keypointRelPath = (ref.ref.keypointRelPath || "").trim();
    return keypointRelPath ? { kind: "single", keypointRelPath } : null;
  }
  if (ref.kind === "folder") return { kind: "folder", folderId: ref.folderId };
  return { kind: "video", videoRefId: ref.ref.id };
}

export async function runCharacterGeneration<T = unknown>(params: {
  charKey: string;
  kind: GenKind;
  baseRelPath: string;
  rawPrompts: string[];
  keypointRef?: CharacterGenKeypointRef;
  options?: CharacterGenOptions;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<T>> {
  const {
    charKey,
    kind,
    baseRelPath,
    rawPrompts,
    keypointRef = null,
    options = {},
    onLogLine,
  } = params;
  const pathSuffix = kind === "pose" ? "/pose/ws" : "/expression/ws";
  const prompts = rawPrompts.map((p) => p.trim()).filter(Boolean);

  const optPayload: Record<string, unknown> = {};
  if (options.skipCloseup !== undefined) optPayload.skipCloseup = options.skipCloseup;
  if (options.cropPadding !== undefined) optPayload.cropPadding = options.cropPadding;
  if (options.qwenCfg !== undefined) optPayload.qwenCfg = options.qwenCfg;

  if (kind === "pose" && keypointRef?.kind === "folder") {
    return runDetailWsJob<T>({
      charKey,
      pathSuffix,
      payload: {
        job: "generate_folder_ref_sequence",
        folderId: keypointRef.folderId,
        baseRelPath,
        prompts,
        ...optPayload,
      },
      onLogLine,
    });
  }

  if (kind === "pose" && keypointRef?.kind === "video") {
    return runDetailWsJob<T>({
      charKey,
      pathSuffix,
      payload: {
        job: "generate_video_ref_sequence",
        videoRefId: keypointRef.videoRefId,
        baseRelPath,
        prompts,
        ...optPayload,
      },
      onLogLine,
    });
  }

  const payload: Record<string, unknown> = {
    job: "generate_prompts",
    baseRelPath,
    prompts,
    ...optPayload,
  };
  if (kind === "pose" && keypointRef?.kind === "single") {
    payload.keypointRelPath = keypointRef.keypointRelPath;
  }

  return runDetailWsJob<T>({
    charKey,
    pathSuffix,
    payload,
    onLogLine,
  });
}
