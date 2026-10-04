import { useEffect, useRef } from "react";

/** Generic in-app replacement for window.confirm() (#328): native confirm() clashes with the
 *  app's design language and blocks agentic/automated testing since it can't be dismissed
 *  programmatically. Nests on top of whatever dialog opened it, matching TemplateSyncDialog
 *  and PortEditConflictDialog (#306). */
interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Escape cancels, like the native confirm() this replaces. Listen on the document in
  // the capture phase: the opener's own shortcuts sit on an ANCESTOR wrapper, so a React
  // handler here would always lose the race to them.
  // Mount-only: callers pass inline arrows, so re-running this would re-steal focus on
  // every render of the opener.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onCancel}
    >
      <div
        className="bg-white border border-[var(--color-border)] rounded-lg shadow-2xl w-[420px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <span className="text-sm font-semibold text-[var(--color-text-heading)]">{title}</span>
          <button
            onClick={onCancel}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg leading-none cursor-pointer"
          >
            &times;
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs text-[var(--color-text)]">{message}</p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)]">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer text-[var(--color-text)]"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
