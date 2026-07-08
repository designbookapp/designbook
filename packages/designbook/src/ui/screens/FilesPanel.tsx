import { useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  MonitorIcon,
} from "lucide-react";
import { cn } from "@designbook-ui/lib/utils";
import { flows, type Flow } from "@designbook-ui/models/catalog/flows";
import { routing, sets as componentSets } from "@designbook-ui/designbook";
import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";
import { useCatalogModel } from "@designbook-ui/models/catalog/CatalogProvider";

const copy = {
  appHeading: "App",
  appLabel: "App",
  componentsHeading: "Components",
  flowsHeading: "Flows",
};

type FilesNavigate = (nodeIds: string[], flowId?: string) => void;

type FolderNode = {
  name: string;
  flows: Flow[];
  sets: Array<{ setId: string; setLeaf: string }>;
  children: Map<string, FolderNode>;
};

function getOrCreateChild(parent: FolderNode, seg: string): FolderNode {
  const existing = parent.children.get(seg);
  if (existing) return existing;
  const child: FolderNode = {
    name: seg,
    flows: [],
    sets: [],
    children: new Map(),
  };
  parent.children.set(seg, child);
  return child;
}

function buildFlowTree(): FolderNode {
  const root: FolderNode = {
    name: "",
    flows: [],
    sets: [],
    children: new Map(),
  };
  for (const flow of flows) {
    const segments = flow.title.split("/");
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      node = getOrCreateChild(node, segments[i]);
    }
    node.flows.push(flow);
  }
  return root;
}

function buildComponentTree(): FolderNode {
  const root: FolderNode = {
    name: "",
    flows: [],
    sets: [],
    children: new Map(),
  };
  for (const set of componentSets) {
    const segments = set.title.split("/");
    const leaf = segments[segments.length - 1];
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      node = getOrCreateChild(node, segments[i]);
    }
    node.sets.push({ setId: set.id, setLeaf: leaf });
  }
  return root;
}

const flowTree = buildFlowTree();
const componentTree = buildComponentTree();

function FlowItem({
  active,
  flow,
  navigate,
}: {
  active: boolean;
  flow: Flow;
  navigate: FilesNavigate;
}) {
  const label = flow.title.split("/").pop() ?? flow.title;
  return (
    <button
      type="button"
      onClick={() => navigate([], flow.id)}
      className={cn(
        "w-full truncate rounded px-2 py-1 text-left text-sm",
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

function FlowFolder({
  activeFlowId,
  navigate,
  node,
}: {
  activeFlowId: string | undefined;
  navigate: FilesNavigate;
  node: FolderNode;
}) {
  return (
    <>
      {Array.from(node.children.values()).map((child) => (
        <div key={child.name} className="grid gap-0.5">
          <span className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground">
            <FolderIcon className="size-3.5" />
            {child.name}
          </span>
          <div className="grid gap-0.5 pl-4">
            <FlowFolder
              node={child}
              activeFlowId={activeFlowId}
              navigate={navigate}
            />
          </div>
        </div>
      ))}
      {node.flows.map((flow) => (
        <FlowItem
          key={flow.id}
          flow={flow}
          active={activeFlowId === flow.id}
          navigate={navigate}
        />
      ))}
    </>
  );
}

function SetNode({
  activeEntryId,
  expanded,
  navigate,
  onToggle,
  setId,
  setLeaf,
}: {
  activeEntryId: string | undefined;
  expanded: boolean;
  navigate: FilesNavigate;
  onToggle: () => void;
  setId: string;
  setLeaf: string;
}) {
  const { getSetEntries } = useCatalogModel();
  const entries: RegistryEntry[] = expanded ? getSetEntries(setId) : [];

  return (
    <div className="grid gap-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-muted"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{setLeaf}</span>
      </button>
      {expanded ? (
        <div className="grid gap-0.5 pl-6">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => navigate([entry.id])}
              className={cn(
                "w-full truncate rounded px-2 py-1 text-left text-sm",
                activeEntryId === entry.id
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-foreground hover:bg-muted",
              )}
            >
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ComponentFolder({
  activeEntryId,
  expandedSets,
  navigate,
  node,
  onToggleSet,
}: {
  activeEntryId: string | undefined;
  expandedSets: Set<string>;
  navigate: FilesNavigate;
  node: FolderNode;
  onToggleSet: (setId: string) => void;
}) {
  return (
    <>
      {Array.from(node.children.values()).map((child) => (
        <div key={child.name} className="grid gap-0.5">
          <span className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground">
            <FolderIcon className="size-3.5" />
            {child.name}
          </span>
          <div className="grid gap-0.5 pl-4">
            <ComponentFolder
              node={child}
              activeEntryId={activeEntryId}
              expandedSets={expandedSets}
              navigate={navigate}
              onToggleSet={onToggleSet}
            />
          </div>
        </div>
      ))}
      {node.sets.map(({ setId, setLeaf }) => (
        <SetNode
          key={setId}
          setId={setId}
          setLeaf={setLeaf}
          expanded={expandedSets.has(setId)}
          activeEntryId={activeEntryId}
          navigate={navigate}
          onToggle={() => onToggleSet(setId)}
        />
      ))}
    </>
  );
}

function FilesPanel({
  activeEntryId,
  activeFlowId,
  appActive = false,
  onOpenApp,
}: {
  activeEntryId: string | undefined;
  activeFlowId: string | undefined;
  /** Whether the App page is the current route. */
  appActive?: boolean;
  /** Open the App page (injected mode only — omit to hide the nav entry). */
  onOpenApp?: () => void;
}) {
  // Navigation is a catalog action: read it from the model
  // rather than threading it in as a prop.
  const { navigate } = useCatalogModel();
  const [expandedSets, setExpandedSets] = useState<Set<string>>(new Set());

  function handleToggleSet(setId: string) {
    setExpandedSets((current) => {
      const next = new Set(current);
      if (next.has(setId)) {
        next.delete(setId);
      } else {
        next.add(setId);
      }
      return next;
    });
  }

  return (
    <div className="grid content-start gap-3 p-4">
      {/* App page: a live frame of the running app. Injected mode
          only — host mode has no running app to iframe, so the nav entry is
          omitted rather than shown disabled. */}
      {routing === "memory" && onOpenApp ? (
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">{copy.appHeading}</h2>
          <div className="grid gap-0.5">
            <button
              type="button"
              onClick={onOpenApp}
              className={cn(
                "flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-sm",
                appActive
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-foreground hover:bg-muted",
              )}
            >
              <MonitorIcon className="size-3.5 shrink-0" />
              {copy.appLabel}
            </button>
          </div>
        </div>
      ) : null}
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">{copy.flowsHeading}</h2>
        <div className="grid gap-0.5">
          <FlowFolder
            node={flowTree}
            activeFlowId={activeFlowId}
            navigate={navigate}
          />
        </div>
      </div>
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">{copy.componentsHeading}</h2>
        <div className="grid gap-0.5">
          <ComponentFolder
            node={componentTree}
            activeEntryId={activeEntryId}
            expandedSets={expandedSets}
            navigate={navigate}
            onToggleSet={handleToggleSet}
          />
        </div>
      </div>
    </div>
  );
}

export { FilesPanel };
