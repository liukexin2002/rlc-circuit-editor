/**
 * RLC editor shell: toolbar, part palette, properties panel, canvas, status bar.
 *
 * This is the editor's whole UI surface. Everything it shows comes from `useRlcStore`,
 * so the canvas, the properties panel and the status bar can never disagree about what
 * the document contains.
 */

import { useCallback, useRef, useState } from "react";
import { RlcEditorCanvas } from "./RlcEditorCanvas";
import { useRlcStore } from "./rlcStore";
import { KIND_DEFAULT_VALUE, KIND_LABEL, type RlcKind, type RlcRotation } from "./rlcModel";
import { symbolGeometry } from "./rlcSymbols";
import { GRID } from "./rlcConstants";
import "./rlcEditorStyles.css";

/** Tiny inline symbol thumbnail for the palette (same geometry as the canvas). */
function PaletteGlyph({ kind }: { kind: RlcKind }) {
  const geo = symbolGeometry(kind);
  return (
    <svg width="46" height="24" viewBox="-34 -14 68 28" aria-hidden="true">
      <path d={geo.leadIn} stroke="#cbd5e1" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d={geo.leadOut} stroke="#cbd5e1" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d={geo.body} stroke="#cbd5e1" strokeWidth="2" fill="none" strokeLinejoin="round" />
      {geo.extras.map((d, i) => (
        <path key={i} d={d} stroke="#cbd5e1" strokeWidth="2" fill="none" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

const KINDS: RlcKind[] = ["resistor", "inductor", "capacitor"];

export function RlcEditorApp() {
  const doc = useRlcStore((s) => s.doc);
  const selected = useRlcStore((s) => s.selected);
  const selectedId = useRlcStore((s) => s.selectedId);
  const pendingPin = useRlcStore((s) => s.pendingPin);
  const degradedCount = useRlcStore((s) => s.degradedCount);
  const avoidWires = useRlcStore((s) => s.avoidWires);
  const showGrid = useRlcStore((s) => s.showGrid);
  const canUndo = useRlcStore((s) => s.past.length > 0);
  const canRedo = useRlcStore((s) => s.future.length > 0);

  const placePart = useRlcStore((s) => s.requestPlace);
  const rotateComponent = useRlcStore((s) => s.rotateComponent);
  const deleteSelection = useRlcStore((s) => s.deleteSelection);
  const setValue = useRlcStore((s) => s.setValue);
  const setLabel = useRlcStore((s) => s.setLabel);
  const undo = useRlcStore((s) => s.undo);
  const redo = useRlcStore((s) => s.redo);
  const clearAll = useRlcStore((s) => s.clearAll);
  const exportDoc = useRlcStore((s) => s.exportDoc);
  const importDoc = useRlcStore((s) => s.importDoc);
  const setAvoidWires = useRlcStore((s) => s.setAvoidWires);
  const setShowGrid = useRlcStore((s) => s.setShowGrid);

  const [toast, setToast] = useState<{ msg: string; ok?: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((msg: string, ok = false) => {
    setToast({ msg, ok });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  // The autosaved document is restored by the store when it is created; there is nothing
  // to hydrate on mount.

  const doExport = useCallback(() => {
    const json = exportDoc();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rlc-schematic.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 JSON（${doc.components.length} 个元件 / ${doc.edges.length} 条连线）`, true);
  }, [doc.components.length, doc.edges.length, exportDoc, showToast]);

  const doExportClipboard = useCallback(async () => {
    const json = exportDoc();
    try {
      await navigator.clipboard.writeText(json);
      showToast("JSON 已复制到剪贴板", true);
    } catch {
      showToast("剪贴板不可用，请改用「导出 JSON」");
    }
  }, [exportDoc, showToast]);

  const doImportFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      const res = importDoc(text);
      if (res.ok) showToast("导入成功", true);
      else showToast(`导入失败：${res.error}`);
    },
    [importDoc, showToast],
  );

  const onDropPart = useCallback(
    (kind: RlcKind) => (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData("application/x-rlc-kind", kind);
      e.dataTransfer.effectAllowed = "copy";
    },
    [],
  );

  /** Click-to-place: the canvas owns the screen→world mapping, so just raise a request. */
  const placeAtCenter = useCallback(
    (kind: RlcKind) => {
      placePart(kind);
      showToast(`已放置 ${KIND_LABEL[kind]}（可拖动到任意位置）`, true);
    },
    [placePart, showToast],
  );

  const selComp =
    selected === "component" && selectedId
      ? doc.components.find((c) => c.id === selectedId) ?? null
      : null;
  const selEdge =
    selected === "edge" && selectedId ? doc.edges.find((e) => e.id === selectedId) ?? null : null;
  const selEdgeRoute = selEdge ? useRlcStore.getState().routes[selEdge.id] : undefined;

  return (
    <div className="rlc-root">
      <div className="rlc-toolbar">
        <span className="rlc-toolbar-title">
          RLC 电路图编辑器
          <small>电阻 / 电感 / 电容 · 自动正交避障布线</small>
        </span>
        <div className="rlc-sep" />
        <button className="rlc-btn" onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
          ↶ 撤销
        </button>
        <button className="rlc-btn" onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)">
          ↷ 重做
        </button>
        <div className="rlc-sep" />
        <button
          className="rlc-btn"
          onClick={() => {
            if (doc.components.length === 0) return;
            if (window.confirm("清空全部元件与连线？此操作可撤销。")) {
              clearAll();
              showToast("已清空", true);
            }
          }}
          disabled={doc.components.length === 0}
        >
          🗑 清空
        </button>
        <button className="rlc-btn" onClick={doExport}>
          ⤓ 导出 JSON
        </button>
        <button className="rlc-btn" onClick={doExportClipboard}>
          ⧉ 复制 JSON
        </button>
        <button className="rlc-btn" onClick={() => fileRef.current?.click()}>
          ⤒ 导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImportFile(f);
            e.target.value = "";
          }}
        />
        <div className="rlc-sep" />
        <label className="rlc-check" title="关闭后布线更快，但连线之间可能重叠">
          <input
            type="checkbox"
            checked={avoidWires}
            onChange={(e) => setAvoidWires(e.target.checked)}
          />
          连线间避让
        </label>
        <label className="rlc-check">
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
          网格
        </label>
      </div>

      <div className="rlc-main">
        <div className="rlc-palette">
          <h3>元件</h3>
          {KINDS.map((kind) => (
            <div
              key={kind}
              className="rlc-part"
              draggable
              onDragStart={onDropPart(kind)}
              onClick={() => placeAtCenter(kind)}
              title="拖到画布，或点击放置"
            >
              <PaletteGlyph kind={kind} />
              <span className="rlc-part-name">
                <b>{KIND_LABEL[kind]}</b>
                <span>{KIND_DEFAULT_VALUE[kind]}</span>
              </span>
            </div>
          ))}
          <div className="rlc-hintbox" style={{ marginTop: 4 }}>
            <b style={{ color: "var(--rlc-text)" }}>操作提示</b>
            <br />
            拖动元件 = 移动（自动吸附网格）
            <br />
            点引脚 → 点另一引脚 = 连线
            <br />
            <kbd>R</kbd> / <kbd>Shift</kbd>+<kbd>R</kbd> = 旋转选中元件
            <br />
            <kbd>Delete</kbd> = 删除选中
            <br />
            <kbd>Esc</kbd> = 取消连线
            <br />
            滚轮缩放 · 空白处拖动平移 · <kbd>F</kbd> 适配视图
          </div>
        </div>

        <div className="rlc-canvas-wrap" ref={canvasWrapRef}>
          <RlcEditorCanvas />
          {toast && (
            <div className={`rlc-toast${toast.ok ? " rlc-toast-ok" : ""}`}>{toast.msg}</div>
          )}
        </div>

        <div className="rlc-side">
          <h3>属性</h3>
          {selComp && (
            <>
              <div className="rlc-field">
                <label>位号</label>
                <input
                  type="text"
                  value={selComp.label}
                  onChange={(e) => setLabel(selComp.id, e.target.value)}
                />
              </div>
              <div className="rlc-field">
                <label>参数值</label>
                <input
                  type="text"
                  value={selComp.value}
                  onChange={(e) => setValue(selComp.id, e.target.value)}
                  placeholder="如 10k / 100uH / 100nF"
                />
              </div>
              <div className="rlc-field">
                <label>旋转角</label>
                <select
                  value={selComp.rotation}
                  onChange={(e) => {
                    const target = Number(e.target.value) as RlcRotation;
                    const delta = (((target - selComp.rotation) % 360) + 360) % 360;
                    if (delta !== 0) rotateComponent(selComp.id, delta as 90 | 180 | 270);
                  }}
                >
                  <option value={0}>0°</option>
                  <option value={90}>90°</option>
                  <option value={180}>180°</option>
                  <option value={270}>270°</option>
                </select>
              </div>
              <button className="rlc-btn" onClick={() => rotateComponent(selComp.id, 90)}>
                ↻ 顺时针旋转 90°
              </button>
              <button className="rlc-btn" onClick={deleteSelection}>
                🗑 删除元件（连同连线）
              </button>
            </>
          )}
          {selEdge && (
            <>
              <div className="rlc-field">
                <label>连线</label>
                <input type="text" readOnly value={selEdge.id} />
              </div>
              <div className="rlc-hintbox">
                起点：{selEdge.from.componentId} / {selEdge.from.pinId}
                <br />
                终点：{selEdge.to.componentId} / {selEdge.to.pinId}
                <br />
                拐弯数：{selEdgeRoute?.turns ?? "-"}
                <br />
                路径质量：
                {selEdgeRoute ? (selEdgeRoute.degraded ? "降级（有阻挡）" : "正常（完全避障）") : "-"}
              </div>
              <button className="rlc-btn" onClick={deleteSelection}>
                🗑 删除连线
              </button>
            </>
          )}
          {!selComp && !selEdge && (
            <div className="rlc-hintbox">
              {pendingPin ? (
                <>
                  <b style={{ color: "var(--rlc-accent)" }}>正在连线…</b>
                  <br />
                  点击目标引脚完成连线，按 <kbd>Esc</kbd> 取消。
                </>
              ) : (
                <>
                  未选中对象。
                  <br />
                  点击画布上的元件或连线查看属性。
                </>
              )}
            </div>
          )}

          <h3 style={{ marginTop: 6 }}>图例</h3>
          <div className="rlc-hintbox">
            <span className="rlc-swatch" style={{ background: "#38bdf8" }} />
            完全避障（避开元件与已布走线）
            <br />
            <span className="rlc-swatch" style={{ background: "#a78bfa" }} />
            紧凑避障（避开元件本体，间距不足）
            <br />
            <span className="rlc-swatch" style={{ background: "#fbbf24" }} />
            受限路径（引脚被围死，仍保持正交与引脚方向）
            <br />
            <span className="rlc-swatch" style={{ background: "#f97316" }} />
            选中对象
          </div>
        </div>
      </div>

      <div className="rlc-status">
        <span>
          元件 <b>{doc.components.length}</b>
        </span>
        <span>
          连线 <b>{doc.edges.length}</b>
        </span>
        <span>
          降级连线 <b>{degradedCount}</b>
        </span>        <span>
          网格 <b>{GRID}px</b>
        </span>
        <span>
          避障 <b>{avoidWires ? "开" : "关"}</b>
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.75 }}>
          自动保存至浏览器本地存储 · 刷新不丢失
        </span>
      </div>
    </div>
  );
}
