import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";

export function CodeBlock({
  code,
  filename,
  language = "toml",
}: {
  code: string;
  filename?: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1500);
  }

  function download() {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? "config.toml";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="relative rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{filename ?? language}</span>
        <div className="flex gap-1">
          {filename && (
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={download}>
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
