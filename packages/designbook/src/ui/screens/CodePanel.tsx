/**
 * The "code" tab: shows the selected component's real source in an editable
 * CodeMirror editor, fetched from the server and scrolled to the
 * component's definition line. Edits can be saved back to disk or
 * discarded.
 *
 * Diff mode (Changes tab MVP): when opened from the Changes list or a canvas
 * change badge, `diffFile` overrides the selection — the panel fetches
 * `GET /api/file-diff` and mounts `unifiedMergeView` with HEAD as the
 * original and the working content as the editable doc (inline green/red
 * chunks, per-chunk revert for free). A Diff/Edit toggle switches to the
 * plain editor; new/untracked files (no HEAD side) open plain; deleted files
 * render read-only, whole file red.
 */

import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { unifiedMergeView } from "@codemirror/merge";
import CodeMirror, {
  Decoration,
  EditorView,
  keymap,
  Prec,
  type Extension,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { RefreshCwIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@designbook-ui/components/ui/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@designbook-ui/components/ui/toggle-group";
import { apiUrl } from "@designbook-ui/designbook";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import { useSelectionModel } from "@designbook-ui/models/selection/SelectionProvider";
import type { CodeLanguage } from "@designbook-ui/models/selection/languageForPath";
import { PanelSection } from "./panels";

const copy = {
  codeEmpty: "Select an element on the canvas to view its source.",
  codeTitle: "Code",
  diffToggle: "Diff",
  discardLabel: "Discard edits",
  editToggle: "Edit",
  loadError: "Unable to load the file.",
  loading: "Loading…",
  refreshLabel: "Reload file",
  saveError: "Unable to save the file.",
  saveLabel: "Save file",
  unsupported: "No preview for this file type.",
};

type FileState = {
  content?: string;
  error?: string;
  loading: boolean;
};

/** Static highlight styling for the component-definition line. */
const targetLineTheme = EditorView.baseTheme({
  ".cm-target-line": {
    backgroundColor:
      "color-mix(in oklch, var(--color-primary) 12%, transparent)",
  },
});

function extensionForLanguage(language: CodeLanguage): Extension {
  switch (language) {
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "javascript":
      return javascript({ jsx: true, typescript: false });
    case "css":
      return css();
    case "json":
      return json();
    case "text":
      return [];
  }
}

function CodePanel({
  selectedNode,
  diffFile,
}: {
  selectedNode?: CanvasNodeSelection;
  /** Changes-tab override: show this file's diff instead of the selection. */
  diffFile?: string;
}) {
  const { definitionLine, usageLine, languageFor } = useSelectionModel();
  const codeTarget = selectedNode?.codeTarget;
  // The Changes-tab diff override wins; otherwise a drilled selection opens
  // its owner's file and highlights the usage line; otherwise the selection's
  // own file and its definition line.
  const path = diffFile || codeTarget?.file || selectedNode?.path || undefined;
  const exportName = selectedNode?.exportName;
  const ctOwner = codeTarget?.ownerExportName;
  const ctName = codeTarget?.name;
  const ctClassName = codeTarget?.className;

  const [file, setFile] = useState<FileState>({ loading: false });
  const [draft, setDraft] = useState<string | undefined>();
  /** HEAD-side content in diff mode: string = diffable, null = no HEAD side
   * (new/untracked file), undefined = not in diff mode. */
  const [head, setHead] = useState<string | null | undefined>();
  /** The working file is gone (deleted) — diff renders read-only. */
  const [deleted, setDeleted] = useState(false);
  const [viewMode, setViewMode] = useState<"diff" | "edit">("diff");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  // Rows always open in diff view (decision #3); re-arm per file.
  useEffect(() => {
    setViewMode("diff");
  }, [diffFile]);

  const load = useCallback(() => {
    if (!path) {
      setFile({ loading: false });
      setDraft(undefined);
      setHead(undefined);
      setDeleted(false);
      return () => {};
    }

    let cancelled = false;
    setFile({ loading: true });
    setSaveError(undefined);

    if (diffFile) {
      void fetch(apiUrl(`/api/file-diff?path=${encodeURIComponent(diffFile)}`))
        .then(async (response) => {
          const payload = (await response.json().catch(() => ({}))) as {
            head?: string | null;
            working?: string | null;
            unsupported?: boolean;
            error?: string;
          };
          if (!response.ok) {
            throw new Error(payload.error ?? copy.loadError);
          }
          if (cancelled) return;
          if (payload.unsupported) {
            setFile({ error: copy.unsupported, loading: false });
            setDraft(undefined);
            setHead(undefined);
            setDeleted(false);
            return;
          }
          const working =
            typeof payload.working === "string" ? payload.working : "";
          setFile({ content: working, loading: false });
          setDraft(working);
          setHead(typeof payload.head === "string" ? payload.head : null);
          setDeleted(payload.working === null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error ? error.message : copy.loadError;
          setFile({ error: message, loading: false });
          setDraft(undefined);
          setHead(undefined);
        });

      return () => {
        cancelled = true;
      };
    }

    setHead(undefined);
    setDeleted(false);
    void fetch(apiUrl(`/api/file?path=${encodeURIComponent(path)}`))
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          content?: string;
          error?: string;
        };
        if (!response.ok || typeof payload.content !== "string") {
          throw new Error(payload.error ?? copy.loadError);
        }
        if (!cancelled) {
          setFile({ content: payload.content, loading: false });
          setDraft(payload.content);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : copy.loadError;
        setFile({ error: message, loading: false });
        setDraft(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [path, diffFile]);

  // Selection changes refetch and discard any unsaved edits in the previous
  // file — there is no per-panel draft persistence across selections.
  useEffect(() => load(), [load]);

  const dirty =
    file.content !== undefined && draft !== undefined && draft !== file.content;

  const handleSave = useCallback(() => {
    if (!path || draft === undefined) return;

    setSaving(true);
    setSaveError(undefined);

    void fetch(apiUrl("/api/file"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content: draft }),
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload.error ?? copy.saveError);
        }
        setFile({ content: draft, loading: false });
        // Announce the write so the Changes tab refreshes (refresh signal #3).
        notifyFileWritten(path);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : copy.saveError;
        setSaveError(message);
      })
      .finally(() => setSaving(false));
  }, [path, draft]);

  // Kept fresh so the stable save keymap always calls the latest save.
  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  const handleDiscard = useCallback(() => {
    setDraft(file.content);
    setSaveError(undefined);
  }, [file.content]);

  const targetLine = useMemo(() => {
    if (diffFile) return undefined;
    if (file.content === undefined) return undefined;
    if (ctOwner && ctName) {
      return usageLine(file.content, ctOwner, ctName, ctClassName);
    }
    return definitionLine(file.content, exportName);
  }, [diffFile, file.content, exportName, ctOwner, ctName, ctClassName, usageLine, definitionLine]);

  // The unified diff: HEAD as the original, the (editable) draft as the doc.
  // Only when a HEAD side exists — new/untracked files open plain (decision
  // #3); the Diff/Edit toggle drops back to the plain editor on demand.
  const diffActive =
    Boolean(diffFile) && viewMode === "diff" && typeof head === "string";
  const diffExtension = useMemo(
    () => (diffActive && typeof head === "string" ? unifiedMergeView({ original: head }) : []),
    [diffActive, head],
  );

  const languageExtension = useMemo(
    () => (path ? extensionForLanguage(languageFor(path)) : []),
    [path, languageFor],
  );

  const saveKeymapExtension = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              handleSaveRef.current();
              return true;
            },
          },
        ]),
      ),
    [],
  );

  const highlightExtension = useMemo(() => {
    if (file.content === undefined || targetLine === undefined) return [];
    const lines = file.content.split("\n");
    const clampedLine = Math.min(Math.max(targetLine, 1), lines.length);
    let offset = 0;
    for (let index = 0; index < clampedLine - 1; index += 1) {
      offset += lines[index].length + 1;
    }
    return [
      EditorView.decorations.of(
        Decoration.set([
          Decoration.line({ attributes: { class: "cm-target-line" } }).range(
            offset,
          ),
        ]),
      ),
    ];
  }, [file.content, targetLine]);

  const extensions = useMemo(
    () => [languageExtension, highlightExtension, saveKeymapExtension, targetLineTheme, diffExtension],
    [languageExtension, highlightExtension, saveKeymapExtension, diffExtension],
  );

  // Centers the target line in `view`. A callback so it can run from two
  // places: the effect below (selection/content changes while the editor is
  // mounted) and CodeMirror's onCreateEditor (fresh mounts — e.g. "Go to
  // component" switching to the code tab — where the effect fires before the
  // editor view exists and would otherwise silently never scroll).
  const scrollToTargetLine = useCallback(
    (view: EditorView) => {
      if (targetLine === undefined || file.content === undefined) return;
      const lineNumber = Math.min(
        Math.max(targetLine, 1),
        view.state.doc.lines,
      );
      const line = view.state.doc.line(lineNumber);
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
    },
    [file.content, targetLine],
  );

  // Re-centers whenever the loaded content or the selection identity changes
  // (path/exportName/codeTarget) — including a same-file navigation whose
  // computed target line happens to be unchanged.
  useEffect(() => {
    const view = editorRef.current?.view;
    if (view) scrollToTargetLine(view);
  }, [scrollToTargetLine, path, exportName, ctOwner, ctName, ctClassName]);

  return (
    // `fill`: the editor owns its scrolling, so the section must span the
    // panel body's height instead of growing with content. The min-w-0 /
    // min-h-0 down this flex chain stop CodeMirror's content from widening
    // the column (flex/grid auto minimum size) — wide lines and tall files
    // scroll INSIDE the editor.
    <PanelSection title={copy.codeTitle} fill>
      {path ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {path}
            </p>
            {diffFile && typeof head === "string" ? (
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(value) => {
                  if (value === "diff" || value === "edit") setViewMode(value);
                }}
                spacing={1}
                className="shrink-0"
              >
                <ToggleGroupItem
                  value="diff"
                  size="sm"
                  aria-label={copy.diffToggle}
                >
                  {copy.diffToggle}
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="edit"
                  size="sm"
                  aria-label={copy.editToggle}
                  disabled={deleted}
                >
                  {copy.editToggle}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            {dirty ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={copy.discardLabel}
                  title={copy.discardLabel}
                  className="size-7"
                  onClick={handleDiscard}
                  disabled={saving}
                >
                  <RotateCcwIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={copy.saveLabel}
                  title={copy.saveLabel}
                  className="size-7"
                  onClick={handleSave}
                  disabled={saving}
                >
                  <SaveIcon />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={copy.refreshLabel}
                title={copy.refreshLabel}
                className="size-7 shrink-0"
                onClick={load}
              >
                <RefreshCwIcon />
              </Button>
            )}
          </div>
          {file.loading ? (
            <p className="text-xs text-muted-foreground">{copy.loading}</p>
          ) : file.error ? (
            <p className="text-xs text-destructive">{file.error}</p>
          ) : draft !== undefined ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border text-xs">
                <CodeMirror
                  ref={editorRef}
                  value={draft}
                  className="h-full"
                  height="100%"
                  theme="light"
                  readOnly={deleted}
                  extensions={extensions}
                  onChange={setDraft}
                  onCreateEditor={scrollToTargetLine}
                />
              </div>
              {saveError ? (
                <p className="text-xs text-destructive">{saveError}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{copy.codeEmpty}</p>
      )}
    </PanelSection>
  );
}

export { CodePanel };
