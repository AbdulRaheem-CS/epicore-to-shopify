"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Stage = "extract" | "normalize" | "push";

const BUTTONS: Array<{ label: string; stages: Stage[]; primary?: boolean }> = [
  { label: "Run full sync", stages: ["extract", "normalize", "push"], primary: true },
  { label: "Fetch from Epicor", stages: ["extract"] },
  { label: "Normalize", stages: ["normalize"] },
  { label: "Push to Shopify", stages: ["push"] },
];

export function RunControls() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  async function run(label: string, stages: Stage[]) {
    setBusy(label);
    setStatus(`${label}…`);
    try {
      const res = await fetch("/api/sync/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stages }),
      });
      const body = await res.json();
      if (!res.ok || body.status === "error") {
        setStatus(body.error ?? `Failed with ${res.status}`);
      } else {
        const c = body.counts ?? {};
        const parts = ["created", "updated", "skipped", "failed"]
          .filter((k) => c[k] !== undefined)
          .map((k) => `${c[k]} ${k}`);
        setStatus(
          `Run #${body.runId} finished in ${body.durationMs}ms` +
            (parts.length ? ` — ${parts.join(", ")}` : ""),
        );
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="controls">
      {BUTTONS.map((b) => (
        <button
          key={b.label}
          type="button"
          data-primary={b.primary ? "true" : undefined}
          disabled={busy !== null || pending}
          onClick={() => run(b.label, b.stages)}
        >
          {busy === b.label ? "Running" : b.label}
        </button>
      ))}
      <span className="status" role="status">
        {status}
      </span>
    </div>
  );
}
