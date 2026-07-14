import { defineConfig } from "@designbookapp/designbook/config";
import "./designbook.css";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { Button } from "@calcom/ui/components/button";
import { Badge } from "@calcom/ui/components/badge";
import { Avatar } from "@calcom/ui/components/avatar";
import { Tooltip } from "@calcom/ui/components/tooltip";
import {
  Skeleton,
  SkeletonText,
  SkeletonAvatar,
  SkeletonButton,
} from "@calcom/ui/components/skeleton";
import { TextField, Select, Switch } from "@calcom/ui/components/form";
import { Dialog, DialogContent } from "@calcom/ui/components/dialog";
import {
  Dropdown,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@calcom/ui/components/dropdown";
import { Alert } from "@calcom/ui/components/alert";
import { List, ListItem } from "@calcom/ui/components/list";
import { EmptyScreen } from "@calcom/ui/components/empty-screen";
import { TopBanner } from "@calcom/ui/components/top-banner";

/** Tooltip needs a Radix TooltipProvider ancestor + content/children. */
const TooltipDemo = () => (
  <TooltipProvider>
    <Tooltip content="Copy link to event">
      <Button color="secondary">Hover me</Button>
    </Tooltip>
  </TooltipProvider>
);

/** Skeleton renders its `as` element while loading. */
const SkeletonDemo = () => (
  <Skeleton as="div" loadingClassName="h-6 w-40" loading>
    <span>Loaded content</span>
  </Skeleton>
);

export default defineConfig({
  title: "cal.com / @calcom/ui (compat spike)",

  // Maps registered components to repo files so the code panel shows source.
  sourceModules: import.meta.glob(
    [
      "./packages/ui/components/{button,badge,avatar,tooltip,skeleton,alert,list,empty-screen,top-banner,toast}/*.tsx",
      "./packages/ui/components/{form,dialog,dropdown}/**/*.tsx",
      "!**/*.test.tsx",
      "!**/*.stories.tsx",
      "!**/*.spec.tsx",
    ],
    { eager: true },
  ),

  sets: [
    {
      id: "primitives",
      title: "Primitives",
      components: {
        Button,
        Badge,
        Avatar,
        Tooltip: TooltipDemo,
        Skeleton: SkeletonDemo,
        SkeletonText,
        SkeletonAvatar,
        SkeletonButton,
      },
      overrides: {
        Tooltip: { sourcePath: "packages/ui/components/tooltip/Tooltip.tsx" },
        Skeleton: { sourcePath: "packages/ui/components/skeleton/Skeleton.tsx" },
      },
    },
    {
      id: "form",
      title: "Form",
      components: { TextField, Select, Switch },
    },
    {
      id: "overlay",
      title: "Overlay",
      components: { Dialog, DialogContent, Dropdown, DropdownMenuContent, DropdownMenuItem },
    },
    {
      id: "feedback",
      title: "Feedback",
      components: { Alert, EmptyScreen, TopBanner, List, ListItem },
    },
  ],
});
