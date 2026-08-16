"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CloudUpload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { knowledgeApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { ACCEPT_ATTRIBUTE, MAX_UPLOAD_BYTES, formatBytes, partitionUploads } from "@/lib/knowledge";
import { cn } from "@/lib/utils";

/**
 * Drag-and-drop upload for one knowledge base.
 *
 * Two behaviours worth knowing:
 *
 * **Uploads run sequentially, not in parallel.** Each file is read fully into
 * memory server-side to hash and store it, and a dozen concurrent 20 MB PUTs
 * from one browser is the easiest way to make ingestion look broken. Sequential
 * also means the progress line can name the file it is actually on.
 *
 * **A deduplicated upload is reported, not hidden.** The API answers 200 rather
 * than 202 when an identical file is already indexed, storing nothing and
 * embedding nothing. Silently showing "uploaded" would teach a user that
 * re-uploading costs money when it does not — and the cost-control only works
 * if people trust it.
 */
export function DocumentDropzone({ kbId }: { kbId: string }) {
  const queryClient = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [progress, setProgress] = React.useState<{ current: number; total: number; name: string } | null>(null);
  // A drag over nested children fires dragleave on every boundary crossing, so
  // a boolean flag flickers. Counting enter/leave pairs is the standard fix.
  const dragDepth = React.useRef(0);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      let queued = 0;
      let deduplicated = 0;
      const failures: string[] = [];

      for (const [index, file] of files.entries()) {
        setProgress({ current: index + 1, total: files.length, name: file.name });
        try {
          const result = await knowledgeApi.upload(kbId, file);
          if (result.deduplicated) deduplicated += 1;
          else queued += 1;
        } catch (error) {
          failures.push(`${file.name}: ${getApiErrorMessage(error, "upload failed")}`);
        }
      }
      return { queued, deduplicated, failures };
    },
    onSuccess: async ({ queued, deduplicated, failures }) => {
      await queryClient.invalidateQueries({ queryKey: ["kb-documents", kbId] });
      if (queued) toast.success(`${queued} ${queued === 1 ? "document" : "documents"} queued for indexing`);
      if (deduplicated) {
        toast.info(`${deduplicated} already indexed`, {
          description: "Identical content — nothing was stored and no embedding was charged.",
        });
      }
      for (const failure of failures) toast.error(failure);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Upload failed")),
    onSettled: () => setProgress(null),
  });

  const handleFiles = React.useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return;
      const { accepted, rejected } = partitionUploads(Array.from(fileList));
      for (const rejection of rejected) toast.error(`${rejection.file} — ${rejection.reason}`);
      if (accepted.length) upload.mutate(accepted);
    },
    [upload],
  );

  const busy = upload.isPending;

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center transition-colors duration-200",
        dragging ? "border-foreground/40 bg-muted/60" : "border-border bg-muted/20",
        busy && "pointer-events-none opacity-70",
      )}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        handleFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        onChange={(event) => {
          handleFiles(event.target.files);
          // Clear it, or re-selecting the same file fires no change event.
          event.target.value = "";
        }}
      />

      {busy ? (
        <>
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm font-medium">
            Uploading {progress?.current} of {progress?.total}
          </p>
          <p className="max-w-full truncate text-xs text-muted-foreground">{progress?.name}</p>
        </>
      ) : (
        <>
          <span className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
            <CloudUpload className="size-4" />
          </span>
          <p className="text-sm font-medium">Drop documents here</p>
          <p className="text-xs text-muted-foreground">
            PDF, DOCX, TXT or Markdown · up to {formatBytes(MAX_UPLOAD_BYTES)} each
          </p>
          <button
            type="button"
            className="mt-1 text-xs font-medium underline underline-offset-4 hover:text-foreground"
            onClick={() => inputRef.current?.click()}
          >
            or choose files
          </button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Scanned images are not supported — text must be extractable.
          </p>
        </>
      )}
    </div>
  );
}
