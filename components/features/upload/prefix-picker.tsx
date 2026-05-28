"use client";

// components/features/upload/prefix-picker.tsx
//
// Path picker popover for the confirm-upload modal. Mixed mode:
//   * breadcrumb at top, click any segment to jump
//   * folder list of the current prefix (from useObjects; objects ignored)
//   * inline "+ 新建文件夹" — adds a CLIENT-SIDE ghost prefix, no API call.
//     Real R2 "directory" creation happens implicitly when the upload's
//     PUT lands in the chosen prefix; an empty placeholder is unnecessary
//     for picking a target.
//   * manual-input box — Enter to select that prefix verbatim.
//
// Returns the selected prefix via `onSelect(prefix)`. Prefix is "" or
// ends with "/".

import { useMemo, useState } from "react";
import { FolderPlus, ChevronRight } from "lucide-react";

import { useObjects, useObjectsItems } from "@/hooks/use-objects";
import {
  validateFolderName,
  describeFolderNameError,
} from "@/lib/r2/folder-name";
import {
  prefixToSegments,
  segmentsToPrefix,
  joinPrefix,
} from "@/lib/r2/prefix";

const T = {
  manualPlaceholder: "手动输入路径(以 / 结尾)",
  bucket: "bucket",
  newFolder: "+ 新建文件夹",
  newFolderPlaceholder: "输入文件夹名,Enter 提交",
  pickHere: "选择此处",
  cancel: "取消",
  invalidLead: '路径不能以 "/" 开头',
  invalidTrail: '路径必须以 "/" 结尾或为空',
  empty: "(此前缀下没有子文件夹)",
} as const;

export interface PrefixPickerProps {
  cid: string;
  bucket: string;
  /** Starting prefix to display ("" = root). */
  initialPrefix: string;
  onSelect: (prefix: string) => void;
  onCancel: () => void;
}

export function PrefixPicker({
  cid,
  bucket,
  initialPrefix,
  onSelect,
  onCancel,
}: PrefixPickerProps) {
  const [prefix, setPrefix] = useState(initialPrefix);
  // Ghost folder keys per prefix. A ghost is a client-side only "folder
  // we plan to create when the upload PUT lands in it" — never sent to
  // R2 from this component.
  const [ghostByPrefix, setGhostByPrefix] = useState<Record<string, string[]>>(
    {},
  );
  const [manualInput, setManualInput] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newError, setNewError] = useState<string | null>(null);

  const query = useObjects({ cid, bucket, prefix });
  const view = useObjectsItems(query, prefix);

  const folders = useMemo(() => {
    const fromList = view.items
      .filter((i) => i.kind === "prefix")
      .map((i) => i.key);
    const ghosts = ghostByPrefix[prefix] ?? [];
    // Dedup + sort so the list is deterministic and a ghost that matches
    // a now-loaded real folder doesn't show twice.
    return [...new Set([...fromList, ...ghosts])].sort();
  }, [view.items, ghostByPrefix, prefix]);

  const segments = prefixToSegments(prefix);

  const handleManualSubmit = () => {
    const v = manualInput.trim();
    if (v.startsWith("/")) {
      setManualError(T.invalidLead);
      return;
    }
    if (v !== "" && !v.endsWith("/")) {
      setManualError(T.invalidTrail);
      return;
    }
    setManualError(null);
    onSelect(v);
  };

  const handleNewSubmit = () => {
    const result = validateFolderName(newName);
    if (!result.ok) {
      setNewError(describeFolderNameError(result.reason));
      return;
    }
    const ghostKey = `${result.name}/`;
    setGhostByPrefix((prev) => ({
      ...prev,
      [prefix]: [...(prev[prefix] ?? []), ghostKey],
    }));
    setNewName("");
    setNewError(null);
    setAdding(false);
    // Intentionally do NOT setPrefix(...) here — leave the user at the
    // parent so the freshly-added ghost row is visible in the current
    // listing. They can click it to drill in if they want.
  };

  return (
    <div className="w-80 rounded-md border border-border bg-popover p-3 shadow-md">
      {/* Manual entry */}
      <div className="mb-2">
        <input
          type="text"
          value={manualInput}
          onChange={(e) => {
            setManualInput(e.target.value);
            setManualError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleManualSubmit();
          }}
          placeholder={T.manualPlaceholder}
          className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
        />
        {manualError && (
          <div className="mt-1 text-xs text-destructive">{manualError}</div>
        )}
      </div>

      {/* Breadcrumb */}
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setPrefix("")}
          className="hover:text-foreground"
        >
          {T.bucket}
        </button>
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex items-center gap-1">
            <ChevronRight className="size-3" />
            <button
              type="button"
              onClick={() =>
                setPrefix(segmentsToPrefix(segments.slice(0, i + 1)))
              }
              className="hover:text-foreground"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {/* Folder list */}
      <div className="mb-2 max-h-64 overflow-y-auto rounded border border-border">
        {folders.length === 0 && !adding && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {T.empty}
          </div>
        )}
        {folders.map((f) => {
          const name = f.replace(/\/+$/u, "");
          return (
            <button
              key={f}
              type="button"
              onClick={() => setPrefix(joinPrefix(prefix, name))}
              className="block w-full px-2 py-1 text-left text-sm hover:bg-accent"
            >
              📁 {f}
            </button>
          );
        })}
      </div>

      {/* New folder */}
      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mb-2 flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <FolderPlus className="size-3" />
          {T.newFolder}
        </button>
      ) : (
        <div className="mb-2 space-y-1">
          <input
            type="text"
            autoFocus
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setNewError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNewSubmit();
              if (e.key === "Escape") {
                setAdding(false);
                setNewName("");
                setNewError(null);
              }
            }}
            placeholder={T.newFolderPlaceholder}
            className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
          />
          {newError && (
            <div className="text-xs text-destructive">{newError}</div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {T.cancel}
        </button>
        <button
          type="button"
          onClick={() => onSelect(prefix)}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          {T.pickHere}
        </button>
      </div>
    </div>
  );
}
