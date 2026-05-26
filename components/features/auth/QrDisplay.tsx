"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";

interface Props {
  svg: string;
  secretBase32: string;
}

export function QrDisplay({ svg, secretBase32 }: Props) {
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secretBase32);
      toast.success("密钥已复制");
    } catch {
      toast.error("复制失败,请手动选择密钥文本");
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {/* SVG 由服务端 qrcode 库生成,可信任 */}
      <div
        className="h-60 w-60 rounded-md border border-border bg-background p-2"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="text-xs text-muted-foreground">无法扫码?手动输入密钥:</p>
      <div className="flex items-center gap-2 rounded bg-muted px-3 py-1.5">
        <code
          className="select-all font-mono text-sm tracking-wide"
          // select-all 让双击/单击就能选中整段密钥,避免 <button> 吞掉双击选词
        >
          {secretBase32}
        </code>
        <button
          type="button"
          onClick={copySecret}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label="复制密钥"
        >
          <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
