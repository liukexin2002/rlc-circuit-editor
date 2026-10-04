import { memo, useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, useReactFlow, type NodeProps } from "@xyflow/react";
import type { NoteNode as NoteNodeType } from "../types";
import { useSchematicStore } from "../store";
import { sanitizeNoteHtml } from "../sanitizeHtml";

const FORMATS = [
  { cmd: "bold", label: "B", style: "font-bold" },
  { cmd: "italic", label: "I", style: "italic" },
  { cmd: "underline", label: "U", style: "underline" },
] as const;

const SIZES = [
  { label: "S", size: "2" },
  { label: "M", size: "3" },
  { label: "L", size: "5" },
] as const;

// Preset swatches for the note background. The empty entry clears the color,
// falling back to the default amber note style. Mirrors AnnotationEditor's
// FILL_PRESETS pattern (swatch buttons + a free color input).
const COLOR_PRESETS: Array<{ value: string; label: string }> = [
  { value: "", label: "Default" },
  { value: "#fde68a", label: "Yellow" },
  { value: "#fecaca", label: "Red" },
  { value: "#fed7aa", label: "Orange" },
  { value: "#bbf7d0", label: "Green" },
  { value: "#bfdbfe", label: "Blue" },
  { value: "#e9d5ff", label: "Purple" },
  { value: "#e5e7eb", label: "Gray" },
];

function NoteNodeComponent({ id, data, selected }: NodeProps<NoteNodeType>) {
  const updateNoteHtml = useSchematicStore((s) => s.updateNoteHtml);
  const pushSnapshot = useSchematicStore((s) => s.pushSnapshot);
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const snapshotPushed = useRef(false);

  // Populate on mount + sync external data changes when not editing
  useEffect(() => {
    if (editorRef.current && !editing) {
      editorRef.current.innerHTML = sanitizeNoteHtml(data.html);
    }
  }, [data.html, editing]);

  const startEditing = useCallback(() => {
    setEditing(true);
    requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(el);
        sel.collapseToEnd();
      }
    });
  }, []);

  const commit = useCallback(() => {
    const html = editorRef.current?.innerHTML ?? "";
    if (html !== data.html) {
      updateNoteHtml(id, html);
    }
    setEditing(false);
    snapshotPushed.current = false;
  }, [id, data.html, updateNoteHtml]);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (containerRef.current?.contains(e.relatedTarget as Node)) return;
      commit();
    },
    [commit],
  );

  const onInput = useCallback(() => {
    if (!snapshotPushed.current) {
      pushSnapshot();
      snapshotPushed.current = true;
    }
  }, [pushSnapshot]);

  const refreshFormats = useCallback(() => {
    const active = new Set<string>();
    for (const { cmd } of FORMATS) {
      if (document.queryCommandState(cmd)) active.add(cmd);
    }
    setActiveFormats(active);
  }, []);

  // Listen for selection changes to update active format buttons
  useEffect(() => {
    if (!editing) return;
    const handler = () => {
      // Only update if selection is inside our editor
      const sel = window.getSelection();
      if (sel && editorRef.current?.contains(sel.anchorNode)) {
        refreshFormats();
      }
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [editing, refreshFormats]);

  const execCmd = useCallback((cmd: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    refreshFormats();
  }, [refreshFormats]);

  // Update the note background color. Uses React Flow's updateNodeData, which
  // dispatches through the store's onNodesChange (and its saveToLocalStorage),
  // so we don't add a new store action. An empty value clears the override.
  const setColor = useCallback(
    (value: string) => {
      pushSnapshot();
      updateNodeData(id, { color: value || undefined });
    },
    [id, pushSnapshot, updateNodeData],
  );

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={60}
        lineStyle={{ borderColor: "var(--color-border)" }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, backgroundColor: "var(--color-border)" }}
      />
      {/* nodrag + nowheel on the whole container when editing so React Flow doesn't intercept */}
      <div
        ref={containerRef}
        className={`w-full h-full rounded border bg-amber-50 flex flex-col ${
          editing ? "nodrag nowheel" : ""
        } ${
          selected ? "border-amber-400 shadow-md shadow-amber-200/40" : "border-amber-300/60"
        }`}
        style={data.color ? { backgroundColor: data.color } : undefined}
      >
        {/* Formatting toolbar — visible only when editing */}
        {editing && (
          <div
            className="flex items-center gap-0.5 px-1.5 py-0.5 border-b border-amber-300/40 bg-amber-100/60 rounded-t"
            onMouseDown={(e) => e.preventDefault()}
          >
            {FORMATS.map(({ cmd, label, style }) => (
              <button
                key={cmd}
                onMouseDown={(e) => {
                  e.preventDefault();
                  execCmd(cmd);
                }}
                className={`w-5 h-5 flex items-center justify-center rounded text-[10px] ${style} transition-colors ${
                  activeFormats.has(cmd)
                    ? "bg-amber-300/80 text-amber-950"
                    : "text-amber-800 hover:bg-amber-200/60"
                }`}
                title={cmd}
              >
                {label}
              </button>
            ))}
            <div className="w-px h-3 bg-amber-300/60 mx-0.5" />
            {SIZES.map(({ label, size }) => (
              <button
                key={size}
                onMouseDown={(e) => {
                  e.preventDefault();
                  execCmd("fontSize", size);
                }}
                className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-amber-800 hover:bg-amber-200/60 transition-colors"
                title={`Size ${label}`}
              >
                {label}
              </button>
            ))}
            <div className="w-px h-3 bg-amber-300/60 mx-0.5" />
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                execCmd("insertUnorderedList");
              }}
              className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-amber-800 hover:bg-amber-200/60 transition-colors"
              title="Bullet list"
            >
              &bull;
            </button>
          </div>
        )}
        {/* Color picker — visible when selected and not editing. Mirrors
            AnnotationEditor's fill-color control: preset swatches plus a free
            color input. Rendered as a small popover anchored to the note. */}
        {selected && !editing && (
          <div className="nodrag absolute -top-2 right-1 z-10">
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setShowColors((v) => !v);
              }}
              className="w-5 h-5 flex items-center justify-center rounded-full border border-amber-400 bg-amber-50 shadow-sm cursor-pointer hover:bg-amber-100"
              title="Note color"
            >
              <span
                className="w-3 h-3 rounded-full border border-amber-300"
                style={{ background: data.color || "#fde68a" }}
              />
            </button>
            {showColors && (
              <div
                className="absolute top-6 right-0 flex items-center gap-1.5 flex-wrap w-[150px] p-1.5 rounded border border-[var(--color-border)] bg-white shadow-lg"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {COLOR_PRESETS.map((p) => (
                  <button
                    key={p.value || "default"}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setColor(p.value);
                    }}
                    className={`w-5 h-5 rounded border cursor-pointer transition-all ${
                      (p.value || "") === (data.color || "")
                        ? "ring-2 ring-amber-500 ring-offset-1"
                        : "hover:scale-110"
                    }`}
                    style={{
                      background:
                        p.value ||
                        "repeating-conic-gradient(#ccc 0% 25%, white 0% 50%) 0 0 / 8px 8px",
                      borderColor: p.value ? "transparent" : "var(--color-border)",
                    }}
                    title={p.label}
                  />
                ))}
                <input
                  type="color"
                  value={data.color || "#fde68a"}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-5 h-5 cursor-pointer border-0 p-0"
                  title="Custom note color"
                />
              </div>
            )}
          </div>
        )}
        {/* Editable content area */}
        <div
          ref={editorRef}
          contentEditable={editing}
          suppressContentEditableWarning
          onDoubleClick={!editing ? startEditing : undefined}
          onBlur={handleBlur}
          onInput={onInput}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Tab") {
              e.preventDefault();
              execCmd(e.shiftKey ? "outdent" : "indent");
            }
          }}
          className={`flex-1 px-2 py-1 text-[11px] text-amber-950 outline-none overflow-auto whitespace-pre-wrap break-words ${
            editing ? "cursor-text" : "cursor-default select-none"
          }`}
          style={{ minHeight: 0 }}
        />
      </div>
    </>
  );
}

export default memo(NoteNodeComponent);
