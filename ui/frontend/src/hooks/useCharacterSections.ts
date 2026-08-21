import { useState, useCallback, useEffect } from "react";
import {
  apiPoseGallerySplit,
  apiExpressionGallerySplit,
  apiSequenceFolderNames,
  apiSequenceGet,
  type GallerySplit,
  type SequenceManifest,
} from "../lib/api";
import { resolveSequenceImportGalleryItemId } from "../lib/sequenceImport";

export type CharacterSequenceEntry = {
  name: string;
  coverRelPath: string;
  galleryItemId?: string;
};

export type CharacterSectionsData = {
  poseSplit: GallerySplit;
  exprSplit: GallerySplit;
  sequences: CharacterSequenceEntry[];
};

export function useCharacterSections(charKey: string | null | undefined) {
  const [data, setData] = useState<CharacterSectionsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!charKey) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [poses, exprs, seqNames] = await Promise.all([
        apiPoseGallerySplit(charKey),
        apiExpressionGallerySplit(charKey),
        apiSequenceFolderNames(charKey),
      ]);
      const manifests: SequenceManifest[] = seqNames.length
        ? await Promise.all(
            seqNames.map((name) =>
              apiSequenceGet(charKey, name).catch(
                (): SequenceManifest => ({ version: 1, fps: 24, gallery: [], frames: [] })
              )
            )
          )
        : [];
      const sequences: CharacterSequenceEntry[] = seqNames.map((name, i) => {
        const m = manifests[i]!;
        return {
          name,
          coverRelPath: m.frames?.[0]?.relPath ?? m.gallery?.[0]?.relPath ?? "",
          galleryItemId: resolveSequenceImportGalleryItemId(m),
        };
      });
      setData({ poseSplit: poses, exprSplit: exprs, sequences });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [charKey]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
