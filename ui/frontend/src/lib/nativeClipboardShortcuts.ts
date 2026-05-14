/**
 * Helpers so global shortcuts (e.g. sequence editor Ctrl+C/V) do not call
 * preventDefault when the user expects native copy/paste.
 */

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return Boolean(
    el.closest("input, textarea, select, [contenteditable=true], [contenteditable='']")
  );
}

function isInAppCopySafeSurface(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return Boolean(
    el.closest(".app-error-modal-card, [data-native-clipboard-shortcuts]")
  );
}

/**
 * When true, the sequence editor (or similar) should not intercept Ctrl/Cmd+C or Ctrl/Cmd+V.
 */
export function shouldDeferSequenceEditorClipboard(
  ev: KeyboardEvent,
  editorRoot: HTMLElement | null
): boolean {
  if (!(ev.ctrlKey || ev.metaKey)) return false;
  const k = ev.key.toLowerCase();
  if (k !== "c" && k !== "v") return false;

  if (isEditableTarget(ev.target)) return true;
  if (isInAppCopySafeSurface(ev.target)) return true;

  const ae = document.activeElement;
  if (isEditableTarget(ae)) return true;
  if (isInAppCopySafeSurface(ae)) return true;

  const sel = document.getSelection();
  if (sel && sel.rangeCount > 0 && sel.toString().length > 0) {
    const anchor = sel.anchorNode;
    if (anchor && editorRoot && !editorRoot.contains(anchor)) {
      return true;
    }
  }

  return false;
}

/**
 * When true, the sequence editor should not intercept Ctrl/Cmd+Z, Shift+Z, or Ctrl+Y
 * so native undo/redo or in-dialog behavior wins.
 */
export function shouldDeferSequenceEditorUndoRedo(ev: KeyboardEvent): boolean {
  if (!(ev.ctrlKey || ev.metaKey)) return false;
  const k = ev.key.toLowerCase();
  if (k !== "z" && k !== "y") return false;

  if (isEditableTarget(ev.target)) return true;
  if (isInAppCopySafeSurface(ev.target)) return true;

  const ae = document.activeElement;
  if (isEditableTarget(ae)) return true;
  if (isInAppCopySafeSurface(ae)) return true;

  return false;
}
