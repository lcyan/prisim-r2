"use client";

import { toast } from "sonner";

interface Props {
  svg: string;
  secretBase32: string;
}

export function QrDisplay({ svg, secretBase32 }: Props) {
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secretBase32);
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
      <button
        type="button"
        onClick={copySecret}
        className="font-mono text-sm tracking-wide rounded bg-muted px-3 py-1.5 hover:bg-muted/80"
        aria-label="复制密钥"
      >
        {secretBase32}
      </button>
    </div>
  );
}
