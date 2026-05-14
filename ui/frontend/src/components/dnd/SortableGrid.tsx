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
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { computeInsertAfterDragSide } from "./computeInsertAfterDragSide";
import { galleryCollisionDetection } from "./galleryCollisionDetection";

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

export function SortableGrid(props: {
  ids: string[];
  disabled?: boolean;
  onDragStart?: (activeId: string) => void;
  onDragEnd: (args: {
    activeId: string;
    overId: string | null;
    insertAfter: boolean;
  }) => void;
  renderItem: (id: string) => React.ReactNode;
  overlay?: (activeId: string) => React.ReactNode;
  style?: CSSProperties;
}) {
  const { ids, disabled, onDragStart, onDragEnd, renderItem, overlay, style } =
    props;

  const [activeId, setActiveId] = useState<string | null>(null);
  const lastItemOverIdRef = useRef<string | null>(null);
  const lastOverRectRef = useRef<ClientRect | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const { setNodeRef: setContainerRef } = useDroppable({
    id: "__container__",
    data: { containerId: "__container__" },
  });

  const collisionDetection = useMemo(() => galleryCollisionDetection(), []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={(ev: DragStartEvent) => {
        if (disabled) return;
        const id = String(ev.active.id);
        setActiveId(id);
        onDragStart?.(id);
        lastItemOverIdRef.current = null;
        lastOverRectRef.current = null;
      }}
      onDragOver={(ev: DragOverEvent) => {
        if (disabled) return;
        const over = ev.over;
        const aid = String(ev.active.id);
        if (!over) return;
        const oid = String(over.id);
        if (oid === "__container__" || oid === aid) return;
        lastItemOverIdRef.current = oid;
        if (over.rect) lastOverRectRef.current = copyRect(over.rect);
      }}
      onDragEnd={(ev: DragEndEvent) => {
        const lastIdSnap = lastItemOverIdRef.current;
        const lastRectSnap = lastOverRectRef.current;
        lastItemOverIdRef.current = null;
        lastOverRectRef.current = null;

        if (disabled) {
          setActiveId(null);
          return;
        }

        const a = String(ev.active.id);
        const rawEndOver = ev.over ? String(ev.over.id) : null;
        const endItemOver =
          rawEndOver &&
          rawEndOver !== "__container__" &&
          rawEndOver !== a
            ? rawEndOver
            : null;

        let resolvedOverId: string | null = endItemOver;
        if (!resolvedOverId && lastIdSnap && lastIdSnap !== a) {
          resolvedOverId = lastIdSnap;
        }

        setActiveId(null);

        let insertAfter = false;
        if (endItemOver && ev.over) {
          const activeSortable = (ev.active.data.current as any)?.sortable as
            | { containerId: string; index: number } | undefined;
          const overSortable = (ev.over.data.current as any)?.sortable as
            | { containerId: string; index: number } | undefined;
          if (activeSortable && overSortable) {
            insertAfter = activeSortable.index < overSortable.index;
          }
        } else if (resolvedOverId) {
          const activeRect = ev.active.rect.current.translated;
          insertAfter = computeInsertAfterDragSide(activeRect, lastRectSnap);
        }

        onDragEnd({ activeId: a, overId: resolvedOverId, insertAfter });
      }}
      onDragCancel={() => {
        lastItemOverIdRef.current = null;
        lastOverRectRef.current = null;
        setActiveId(null);
      }}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div ref={setContainerRef} style={style}>
          {ids.map((id) => (
            <React.Fragment key={id}>{renderItem(id)}</React.Fragment>
          ))}
        </div>
      </SortableContext>

      {overlay && activeId ? (
        <DragOverlay>{overlay(activeId)}</DragOverlay>
      ) : null}
    </DndContext>
  );
}

export function SortableItem(props: {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  const { id, disabled, children, style } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });

  const s: CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition: "none",
    opacity: isDragging ? 0.7 : style?.opacity,
    position: isDragging ? "relative" : undefined,
    zIndex: isDragging ? 9999 : undefined,
  };

  return (
    <div ref={setNodeRef} style={s} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
