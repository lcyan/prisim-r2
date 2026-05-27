"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";

interface Props {
  codes: string[];
}

export function RecoveryCodeGrid({ codes }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("复制失败,请手动选择并复制恢复码");
    }
  }

  function download() {
    const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "prisim-r2-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {codes.map((c) => (
          <code
            key={c}
            className="rounded bg-muted px-3 py-2 text-center font-mono text-sm tracking-wider"
          >
            {c}
          </code>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={copyAll}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {copied ? "已复制" : "复制全部"}
        </button>
        <button
          type="button"
          onClick={download}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <Download className="h-4 w-4" />
          下载为 .txt
        </button>
      </div>
    </div>
  );
}
