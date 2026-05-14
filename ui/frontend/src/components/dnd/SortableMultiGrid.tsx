"use client";

import type { ClientRect } from "@dnd-kit/core";
import React, {
  CSSProperties,
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragOverEvent,
  DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { builderSurfaceCollisionDetection } from "./builderSurfaceCollisionDetection";
import { computeInsertAfterDragSide } from "./computeInsertAfterDragSide";
import { galleryCollisionDetection } from "./galleryCollisionDetection";

export type ContainerKey = string;

export type DragOverlayArgs = { id: string; containerId: ContainerKey };

export const UseDragOverlayCloneContext = createContext(false);
const PREVIEW_PLACEHOLDER = "__preview_placeholder__";
const PLACEHOLDER_SIZE = 120;

function copyRect(r: ClientRect): ClientRect {
  return {
    width: r.width,
    height: r.height,
    top: r.top,
    left: r.left,
    bottom: r.bottom,
    right: r.right,
  };
}

/** Skip setState when preview lists are unchanged (avoids onDragOver re-render loops). */
function previewItemsEqual(
  a: Record<ContainerKey, string[]> | null,
  b: Record<ContainerKey, string[]> | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const aa = a[k];
    const bb = b[k];
    if (aa === undefined && bb === undefined) continue;
    if (!aa || !bb || aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== bb[i]) return false;
    }
  }
  return true;
}

function setPreviewItemsIfChanged(
  setter: React.Dispatch<
    React.SetStateAction<Record<ContainerKey, string[]> | null>
  >,
  next: Record<ContainerKey, string[]> | null
) {
  setter((prev) => {
    if (next === null) return prev === null ? prev : null;
    return previewItemsEqual(prev, next) ? prev : next;
  });
}

export function SortableMultiGrid(props: {
  containers: { id: ContainerKey; ids: string[] }[];
  disabled?: boolean;
  onDragEnd: (args: {
    activeId: string;
    overId: string | null;
    insertAfter: boolean;
    sourceContainerId: ContainerKey;
    targetContainerId: ContainerKey;
  }) => void;
  renderContainer: (args: {
    containerId: ContainerKey;
    children: React.ReactNode;
    setContainerRef: (el: HTMLElement | null) => void;
  }) => React.ReactNode;
  renderItem: (args: { id: string; containerId: ContainerKey }) => React.ReactNode;
  /** When set, dragged item is shown in a portal (`DragOverlay`) so it follows the pointer across sections. */
  renderDragOverlay?: (args: DragOverlayArgs) => React.ReactNode;
  /**
   * When false, skip cross-container list preview on dragOver (avoids layout/collision feedback loops),
   * matching DatasetBuilderDndShell. Use for visible/hidden gallery splits.
   */
  crossContainerPreview?: boolean;
  style?: CSSProperties;
}) {
  const {
    containers,
    disabled,
    onDragEnd,
    renderContainer,
    renderItem,
    renderDragOverlay,
    crossContainerPreview = true,
    style,
  } = props;
  const [overContainerId, setOverContainerId] = useState<ContainerKey | null>(
    null
  );
  const [activeDrag, setActiveDrag] = useState<DragOverlayArgs | null>(null);
  const [previewItems, setPreviewItems] = useState<Record<ContainerKey, string[]> | null>(
    null
  );

  const containersRef = useRef(containers);
  containersRef.current = containers;

  const lastItemOverIdRef = useRef<string | null>(null);
  const lastItemTargetContainerIdRef = useRef<ContainerKey | null>(null);
  const lastOverRectRef = useRef<ClientRect | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const collisionDetection = useMemo(
    () =>
      crossContainerPreview
        ? galleryCollisionDetection()
        : builderSurfaceCollisionDetection(),
    [crossContainerPreview]
  );

  const useOverlayClone = Boolean(renderDragOverlay);

  return (
    <UseDragOverlayCloneContext.Provider value={useOverlayClone}>
      <div style={style}>
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={(ev: DragStartEvent) => {
            if (disabled) return;
            const sourceContainerId = String(
              (ev.active.data.current as { containerId?: string } | null)?.containerId ?? ""
            );
            if (crossContainerPreview) {
              setPreviewItemsIfChanged(setPreviewItems, null);
            }
            setOverContainerId(sourceContainerId || null);
            lastItemOverIdRef.current = null;
            lastItemTargetContainerIdRef.current = null;
            lastOverRectRef.current = null;
            if (renderDragOverlay) {
              setActiveDrag({
                id: String(ev.active.id),
                containerId: sourceContainerId,
              });
            }
          }}
          onDragOver={(ev: DragOverEvent) => {
            if (disabled) return;
            const oc = ev.over
              ? String(
                  (ev.over.data.current as { containerId?: string } | null)?.containerId ?? ""
                )
              : "";
            if (oc) setOverContainerId(oc);

            const over = ev.over;
            const aid = String(ev.active.id);
            const activeContainerId = String(
              (ev.active.data.current as { containerId?: string } | null)?.containerId ?? ""
            );

            if (!crossContainerPreview) {
              if (!over) return;
              const oid = String(over.id);
              if (oid === "__container__" || oid === aid) return;
              if (oid.startsWith("container:")) return;
              lastItemOverIdRef.current = oid;
              lastItemTargetContainerIdRef.current = String(
                (over.data.current as { containerId?: string } | null)?.containerId ?? ""
              );
              if (over.rect) lastOverRectRef.current = copyRect(over.rect);
              return;
            }

            const applyCrossContainerPreview = (
              overContainerKey: ContainerKey,
              overItemId: string | null,
            ) => {
              if (!activeContainerId || overContainerKey === activeContainerId) {
                setPreviewItemsIfChanged(setPreviewItems, null);
                return;
              }
              const latest = containersRef.current;
              const map: Record<ContainerKey, string[]> = {};
              for (const c of latest) {
                map[c.id] = c.ids.filter((id) => id !== PREVIEW_PLACEHOLDER);
              }
              const targetList = map[overContainerKey];
              if (!targetList) {
                setPreviewItemsIfChanged(setPreviewItems, null);
                return;
              }
              let insertAt = targetList.length;
              if (overItemId && overItemId !== PREVIEW_PLACEHOLDER) {
                const idx = targetList.indexOf(overItemId);
                if (idx >= 0) {
                  insertAt = idx;
                }
              }
              targetList.splice(insertAt, 0, PREVIEW_PLACEHOLDER);
              setPreviewItemsIfChanged(setPreviewItems, map);
            };

            if (!over) {
              setPreviewItemsIfChanged(setPreviewItems, null);
              return;
            }
            const oid = String(over.id);

            if (oid === "__container__" || oid === aid) {
              setPreviewItemsIfChanged(setPreviewItems, null);
              return;
            }

            if (oid.startsWith("container:")) {
              const containerKey = oid.slice("container:".length);
              applyCrossContainerPreview(containerKey, null);
              return;
            }

            if (oid !== PREVIEW_PLACEHOLDER) {
              lastItemOverIdRef.current = oid;
              lastItemTargetContainerIdRef.current = String(
                (over.data.current as { containerId?: string } | null)?.containerId ?? ""
              );
              if (over.rect) lastOverRectRef.current = copyRect(over.rect);
            }

            const itemOverContainer = String(
              (over.data.current as { containerId?: string } | null)?.containerId ?? ""
            );
            if (itemOverContainer) {
              applyCrossContainerPreview(itemOverContainer, oid);
            }
          }}
          onDragEnd={(ev: DragEndEvent) => {
            const activeId = String(ev.active.id);
            const lastIdSnap = lastItemOverIdRef.current;
            const lastCidSnap = lastItemTargetContainerIdRef.current;
            const lastRectSnap = lastOverRectRef.current;
            lastItemOverIdRef.current = null;
            lastItemTargetContainerIdRef.current = null;
            lastOverRectRef.current = null;
            setActiveDrag(null);
            if (crossContainerPreview) {
              setPreviewItemsIfChanged(setPreviewItems, null);
            }

            if (disabled) {
              setOverContainerId(null);
              return;
            }

            const sourceContainerId = String(
              (ev.active.data.current as { containerId?: string } | null)?.containerId ?? ""
            );

            const rawEndOver = ev.over ? String(ev.over.id) : null;
            const endItemOver =
              rawEndOver &&
              !rawEndOver.startsWith("container:") &&
              rawEndOver !== "__container__" &&
              rawEndOver !== activeId &&
              rawEndOver !== PREVIEW_PLACEHOLDER
                ? rawEndOver
                : null;

            let resolvedOverId: string | null = endItemOver;
            if (!resolvedOverId && lastIdSnap && lastIdSnap !== activeId && lastIdSnap !== PREVIEW_PLACEHOLDER) {
              resolvedOverId = lastIdSnap;
            }

            let targetContainerId =
              (ev.over
                ? String(
                    (ev.over.data.current as { containerId?: string } | null)?.containerId ?? ""
                  )
                : "") ||
              overContainerId ||
              sourceContainerId;

            if (resolvedOverId && !endItemOver && lastCidSnap) {
              targetContainerId = lastCidSnap;
            }

            setOverContainerId(null);

            let insertAfter = false;
            if (endItemOver && ev.over) {
              const activeSortable = (ev.active.data.current as any)?.sortable as
                | { containerId: string; index: number } | undefined;
              const overSortable = (ev.over.data.current as any)?.sortable as
                | { containerId: string; index: number } | undefined;
              if (activeSortable && overSortable) {
                if (activeSortable.containerId === overSortable.containerId) {
                  insertAfter = activeSortable.index < overSortable.index;
                }
              }
            } else if (resolvedOverId) {
              const activeRect = ev.active.rect.current.translated;
              insertAfter = computeInsertAfterDragSide(activeRect, lastRectSnap);
            }

            onDragEnd({
              activeId,
              overId: resolvedOverId,
              insertAfter,
              sourceContainerId,
              targetContainerId,
            });
          }}
          onDragCancel={() => {
            setOverContainerId(null);
            setActiveDrag(null);
            if (crossContainerPreview) {
              setPreviewItemsIfChanged(setPreviewItems, null);
            }
            lastItemOverIdRef.current = null;
            lastItemTargetContainerIdRef.current = null;
            lastOverRectRef.current = null;
          }}
        >
          {containers.map((c) => {
            const items = crossContainerPreview
              ? previewItems?.[c.id] ?? c.ids
              : c.ids;
            return (
            <DroppableContainer
              key={c.id}
              containerId={c.id}
              renderContainer={renderContainer}
            >
              <SortableContext items={items} strategy={rectSortingStrategy}>
                {items.map((id) => (
                  <React.Fragment key={`${String(c.id)}:${id}`}>
                    {id === PREVIEW_PLACEHOLDER
                      ? <PreviewPlaceholder containerId={c.id} />
                      : renderItem({ id, containerId: c.id })}
                  </React.Fragment>
                ))}
              </SortableContext>
            </DroppableContainer>
            );
          })}
          {renderDragOverlay && activeDrag ? (
            <DragOverlay dropAnimation={null}>
              {renderDragOverlay(activeDrag)}
            </DragOverlay>
          ) : null}
        </DndContext>
      </div>
    </UseDragOverlayCloneContext.Provider>
  );
}

function PreviewPlaceholder({ containerId }: { containerId: ContainerKey }) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({
      id: PREVIEW_PLACEHOLDER,
      disabled: true,
      data: { containerId },
    });
  const s: CSSProperties = {
    width: PLACEHOLDER_SIZE,
    height: PLACEHOLDER_SIZE,
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    pointerEvents: "none",
  };
  return <div ref={setNodeRef} style={s} {...attributes} {...listeners} />;
}

function DroppableContainer(props: {
  containerId: ContainerKey;
  children: React.ReactNode;
  renderContainer: (args: {
    containerId: ContainerKey;
    children: React.ReactNode;
    setContainerRef: (el: HTMLElement | null) => void;
  }) => React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: `container:${props.containerId}`,
    data: { containerId: props.containerId },
  });
  return props.renderContainer({
    containerId: props.containerId,
    children: props.children,
    setContainerRef: setNodeRef,
  });
}

export function SortableItemInContainer(props: {
  id: string;
  containerId: ContainerKey;
  disabled?: boolean;
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  const useOverlayClone = useContext(UseDragOverlayCloneContext);
  const { id, containerId, disabled, children, style } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled, data: { containerId } });

  const s: CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? "none" : transition,
    opacity: isDragging
      ? useOverlayClone
        ? 0
        : 0.7
      : style?.opacity,
    position: isDragging && !useOverlayClone ? "relative" : undefined,
    zIndex: isDragging && !useOverlayClone ? 9999 : undefined,
  };
  return (
    <div ref={setNodeRef} style={s} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
