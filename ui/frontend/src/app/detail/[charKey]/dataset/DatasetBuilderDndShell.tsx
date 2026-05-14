"use client";

import type { ClientRect } from "@dnd-kit/core";
import React, { CSSProperties, useMemo, useRef, useState } from "react";
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
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { computeInsertAfterDragSide } from "../../../../components/dnd/computeInsertAfterDragSide";
import { builderSurfaceCollisionDetection } from "../../../../components/dnd/builderSurfaceCollisionDetection";
import type { ContainerKey, DragOverlayArgs } from "../../../../components/dnd/SortableMultiGrid";
import { UseDragOverlayCloneContext } from "../../../../components/dnd/SortableMultiGrid";

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

/**
 * Builder-only dual-section sortable surface: no onDragOver list mutation (no preview churn).
 * Cross-section drag uses DragOverlay + commit on drop only.
 */
export function DatasetBuilderDndShell(props: {
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
  renderDragOverlay?: (args: DragOverlayArgs) => React.ReactNode;
  style?: CSSProperties;
}) {
  const {
    containers,
    disabled,
    onDragEnd,
    renderContainer,
    renderItem,
    renderDragOverlay,
    style,
  } = props;

  const [overContainerId, setOverContainerId] = useState<ContainerKey | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragOverlayArgs | null>(null);

  const lastItemOverIdRef = useRef<string | null>(null);
  const lastItemTargetContainerIdRef = useRef<ContainerKey | null>(null);
  const lastOverRectRef = useRef<ClientRect | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const collisionDetection = useMemo(() => builderSurfaceCollisionDetection(), []);

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
            if (!over) return;

            const oid = String(over.id);
            const aid = String(ev.active.id);

            if (oid === "__container__" || oid === aid) return;

            if (oid.startsWith("container:")) return;

            lastItemOverIdRef.current = oid;
            lastItemTargetContainerIdRef.current = String(
              (over.data.current as { containerId?: string } | null)?.containerId ?? ""
            );
            if (over.rect) lastOverRectRef.current = copyRect(over.rect);
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
              rawEndOver !== activeId
                ? rawEndOver
                : null;

            let resolvedOverId: string | null = endItemOver;
            if (!resolvedOverId && lastIdSnap && lastIdSnap !== activeId) {
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
              const activeSortable = (ev.active.data.current as { sortable?: { containerId: string; index: number } })
                ?.sortable;
              const overSortable = (ev.over.data.current as { sortable?: { containerId: string; index: number } })
                ?.sortable;
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
            lastItemOverIdRef.current = null;
            lastItemTargetContainerIdRef.current = null;
            lastOverRectRef.current = null;
          }}
        >
          {containers.map((c) => (
            <DroppableContainer
              key={c.id}
              containerId={c.id}
              renderContainer={renderContainer}
            >
              <SortableContext items={c.ids} strategy={rectSortingStrategy}>
                {c.ids.map((id) => (
                  <React.Fragment key={`${String(c.id)}:${id}`}>
                    {renderItem({ id, containerId: c.id })}
                  </React.Fragment>
                ))}
              </SortableContext>
            </DroppableContainer>
          ))}
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
