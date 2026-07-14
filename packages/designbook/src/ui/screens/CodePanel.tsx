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
 *
 * Proto full-view extensions (all opt-in props — the old expanded workbench
 * passes none of them and behaves exactly as before):
 *   - `appearance="dark"`: dark CodeMirror theme for the `.dbproto` embed.
 *   - `selectionDiff`: the SELECTED file also loads via `/api/file-diff`, so
 *     a Diff/Edit toggle appears whenever a HEAD side exists (labeled
 *     "vs HEAD"). Selections still open in Edit view.
 *   - `layer`: the selection's file is overridden by an ACTIVE changeset
 *     layer — the panel loads/edits the RESOLVED layer alternative instead
 *     (save writes the LAYER file, never the real source) and the diff
 *     compares the layer content against the real file (labeled with the
 *     changeset). Resolution happens in the caller from the client sandbox
 *     store; this panel only consumes the resolved target.
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
import { LayersIcon, RefreshCwIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
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
  diffHeadLabel: "Diff: working tree vs HEAD",
  diffLayerLabel: "Diff: changeset layer vs real file",
  diffToggle: "Diff",
  discardLabel: "Discard edits",
  editToggle: "Edit",
  layerBadge: "layer",
  layerEditHint: "Edits save to the changeset layer — the real file is untouched.",
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

/** The selection's ACTIVE changeset-layer override, resolved by the caller:
 * the repo-relative path of the layer's SELECTED alternative + a display
 * label for the owning changeset. */
type CodePanelLayerTarget = {
  file: string;
  label: string;
};

/** Static highlight styling for the component-definition line. The dark
 * editor gets a fixed accent wash — the token-derived color-mix resolves to
 * a near-black 12% overlay there (invisible on the dark background). */
const targetLineTheme = EditorView.baseTheme({
  "&light .cm-target-line": {
    backgroundColor:
      "color-mix(in oklch, var(--color-primary) 12%, transparent)",
  },
  "&dark .cm-target-line": {
    backgroundColor: "rgba(76, 141, 255, 0.16)",
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

/** GET a source file's content via `/api/file`; throws on any failure. */
async function fetchFileContent(path: string): Promise<string> {
  const response = await fetch(
    apiUrl(`/api/file?path=${encodeURIComponent(path)}`),
  );
  const payload = (await response.json().catch(() => ({}))) as {
    content?: string;
    error?: string;
  };
  if (!response.ok || typeof payload.content !== "string") {
    throw new Error(payload.error ?? copy.loadError);
  }
  return payload.content;
}

function CodePanel({
  selectedNode,
  diffFile,
  appearance = "light",
  selectionDiff = false,
  layer,
}: {
  selectedNode?: CanvasNodeSelection;
  /** Changes-tab override: show this file's diff instead of the selection. */
  diffFile?: string;
  /** Editor theme — "dark" for the proto `.dbproto` embed. */
  appearance?: "light" | "dark";
  /** Load selections via `/api/file-diff` so the Diff toggle is available
   * for the selected file too (not only Changes-row opens). */
  selectionDiff?: boolean;
  /** The selection's active layer override (see CodePanelLayerTarget). The
   * Changes-tab `diffFile` override still wins when both are present. */
  layer?: CodePanelLayerTarget;
}) {
  const { definitionLine, usageLine, languageFor } = useSelectionModel();
  const codeTarget = selectedNode?.codeTarget;
  // The Changes-tab diff override wins; otherwise a drilled selection opens
  // its owner's file and highlights the usage line; otherwise the selection's
  // own file and its definition line.
  const sourcePath =
    diffFile || codeTarget?.file || selectedNode?.path || undefined;
  // Layer redirect (never under the Changes-tab override): the file the
  // editor LOADS and SAVES is the resolved layer alternative.
  const layerTarget = !diffFile && sourcePath ? layer : undefined;
  const layerFile = layerTarget?.file;
  const docPath = layerFile ?? sourcePath;
  const exportName = selectedNode?.exportName;
  const ctOwner = codeTarget?.ownerExportName;
  const ctName = codeTarget?.name;
  const ctClassName = codeTarget?.className;

  const [file, setFile] = useState<FileState>({ loading: false });
  const [draft, setDraft] = useState<string | undefined>();
  /** The diff BASE: HEAD content (git modes) or the REAL file (layer mode).
   * string = diffable, null = no base side (new/untracked file), undefined =
   * no diff source loaded. */
  const [original, setOriginal] = useState<string | null | undefined>();
  /** The working file is gone (deleted) — diff renders read-only. */
  const [deleted, setDeleted] = useState(false);
  const [viewMode, setViewMode] = useState<"diff" | "edit">("diff");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  // Changes rows always open in diff view (decision #3); selections open in
  // the editor. Re-arm per target.
  useEffect(() => {
    setViewMode(diffFile ? "diff" : "edit");
  }, [diffFile, sourcePath, layerFile]);

  const load = useCallback(() => {
    if (!sourcePath || !docPath) {
      setFile({ loading: false });
      setDraft(undefined);
      setOriginal(undefined);
      setDeleted(false);
      return () => {};
    }

    let cancelled = false;
    setFile({ loading: true });
    setSaveError(undefined);

    const fail = (error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : copy.loadError;
      setFile({ error: message, loading: false });
      setDraft(undefined);
      setOriginal(undefined);
    };

    if (layerFile) {
      // Layer mode: the doc is the layer alternative; the diff base is the
      // REAL file (both plain /api/file reads — no git involved).
      setDeleted(false);
      void Promise.all([
        fetchFileContent(layerFile),
        fetchFileContent(sourcePath).catch(() => null),
      ])
        .then(([layerContent, realContent]) => {
          if (cancelled) return;
          setFile({ content: layerContent, loading: false });
          setDraft(layerContent);
          setOriginal(realContent);
        })
        .catch(fail);
      return () => {
        cancelled = true;
      };
    }

    if (diffFile || selectionDiff) {
      void fetch(
        apiUrl(`/api/file-diff?path=${encodeURIComponent(sourcePath)}`),
      )
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
            setOriginal(undefined);
            setDeleted(false);
            return;
          }
          const working =
            typeof payload.working === "string" ? payload.working : "";
          setFile({ content: working, loading: false });
          setDraft(working);
          setOriginal(typeof payload.head === "string" ? payload.head : null);
          setDeleted(payload.working === null);
        })
        .catch(fail);

      return () => {
        cancelled = true;
      };
    }

    setOriginal(undefined);
    setDeleted(false);
    void fetchFileContent(sourcePath)
      .then((content) => {
        if (cancelled) return;
        setFile({ content, loading: false });
        setDraft(content);
      })
      .catch(fail);

    return () => {
      cancelled = true;
    };
  }, [sourcePath, docPath, diffFile, selectionDiff, layerFile]);

  // Selection changes refetch and discard any unsaved edits in the previous
  // file — there is no per-panel draft persistence across selections.
  useEffect(() => load(), [load]);

  const dirty =
    file.content !== undefined && draft !== undefined && draft !== file.content;

  const handleSave = useCallback(() => {
    if (!docPath || draft === undefined) return;

    setSaving(true);
    setSaveError(undefined);

    void fetch(apiUrl("/api/file"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: docPath, content: draft }),
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
        notifyFileWritten(docPath);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : copy.saveError;
        setSaveError(message);
      })
      .finally(() => setSaving(false));
  }, [docPath, draft]);

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

  // The unified diff: the base (HEAD or the real file) as the original, the
  // (editable) draft as the doc. Only when a base side exists —
  // new/untracked files open plain (decision #3); the Diff/Edit toggle drops
  // back to the plain editor on demand.
  const diffAvailable = typeof original === "string";
  const diffActive = diffAvailable && viewMode === "diff";
  const diffExtension = useMemo(
    () =>
      diffActive && typeof original === "string"
        ? unifiedMergeView({ original })
        : [],
    [diffActive, original],
  );

  const languageExtension = useMemo(
    () => (docPath ? extensionForLanguage(languageFor(docPath)) : []),
    [docPath, languageFor],
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
  }, [scrollToTargetLine, sourcePath, exportName, ctOwner, ctName, ctClassName]);

  return (
    // `fill`: the editor owns its scrolling, so the section must span the
    // panel body's height instead of growing with content. The min-w-0 /
    // min-h-0 down this flex chain stop CodeMirror's content from widening
    // the column (flex/grid auto minimum size) — wide lines and tall files
    // scroll INSIDE the editor.
    <PanelSection title={copy.codeTitle} fill>
      {sourcePath ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {sourcePath}
              </p>
              {layerTarget ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                  title={`${copy.layerEditHint}\n${layerTarget.file}`}
                >
                  <LayersIcon className="size-3" />
                  {copy.layerBadge}: {layerTarget.label}
                </span>
              ) : null}
            </div>
            {diffAvailable ? (
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
          {diffActive ? (
            <p className="text-[10px] text-muted-foreground">
              {layerTarget ? copy.diffLayerLabel : copy.diffHeadLabel}
            </p>
          ) : null}
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
                  theme={appearance}
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
export type { CodePanelLayerTarget };
