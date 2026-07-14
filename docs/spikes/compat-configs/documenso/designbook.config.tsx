import { defineConfig } from "@designbookapp/designbook/config";
import { linguiAdapter, themeAdapter } from "@designbookapp/designbook/adapters";
import type { ReactNode } from "react";
import { i18n } from "@lingui/core";
import { I18nProvider, Trans } from "@lingui/react";

// Import documenso's OWN theme css for the runtime :root/.dark CSS-var values.
// designbook's Tailwind v3->v4 bridge (a) strips the v3 `@tailwind` directives
// at the top so this imports under v4, and (b) auto-generates the `@theme`
// token mappings that used to live in the hand-written designbook.css.
import "./packages/ui/styles/theme.css";

// --- Primitives (macro-free, plain React + Radix + Tailwind) ---
import { Button } from "./packages/ui/primitives/button";
import { Badge } from "./packages/ui/primitives/badge";
import { Input } from "./packages/ui/primitives/input";
import { Label } from "./packages/ui/primitives/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./packages/ui/primitives/card";
import { Alert, AlertDescription, AlertTitle } from "./packages/ui/primitives/alert";
import { Avatar, AvatarFallback, AvatarImage } from "./packages/ui/primitives/avatar";
import { Checkbox } from "./packages/ui/primitives/checkbox";
import { Switch } from "./packages/ui/primitives/switch";
import { Separator } from "./packages/ui/primitives/separator";
import { Skeleton } from "./packages/ui/primitives/skeleton";
import { Progress } from "./packages/ui/primitives/progress";
import { Textarea } from "./packages/ui/primitives/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./packages/ui/primitives/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./packages/ui/primitives/select";

// Lingui macro probe: dialog.tsx imports { Trans } from '@lingui/react/macro'.
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./packages/ui/primitives/dialog";

// --- Meatier: form primitives (use @lingui/react runtime useLingui) ---
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "./packages/ui/primitives/form/form";

// Lingui runtime context. form.tsx calls useLingui(); without an active i18n
// instance it throws. We activate an empty English catalog so `_()` echoes ids.
i18n.load({ en: {} });
i18n.activate("en");

function Providers({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}

// Lingui text-tool target: runtime <Trans id> (no macro needed). ids are real
// entries in packages/lib/translations/en/web.po, so the text tool can write
// their msgstr. The linguiAdapter patches i18n._/t to mark these on render.
function LinguiText() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 24,
        fontSize: 20,
        fontWeight: 600,
      }}
    >
      <span>
        <Trans id="Close" />
      </span>
      <span>
        <Trans id="Continue" />
      </span>
      <span>
        <Trans id="Settings" />
      </span>
    </div>
  );
}

export default defineConfig({
  title: "Documenso UI",

  providers: [Providers],

  sets: [
    {
      id: "i18n",
      title: "i18n",
      components: { LinguiText },
    },
    {
      id: "primitives",
      title: "Primitives",
      components: {
        Button,
        Badge,
        Input,
        Label,
        Checkbox,
        Switch,
        Separator,
        Skeleton,
        Progress,
        Textarea,
      },
      overrides: {
        Button: {
          matrixAxes: [
            {
              name: "Variant",
              values: [
                "default",
                "secondary",
                "outline",
                "destructive",
                "ghost",
                "link",
              ],
            },
            { name: "Size", values: ["default", "sm", "lg"] },
          ],
        },
      },
    },
    {
      id: "surfaces",
      title: "Surfaces",
      components: {
        Card,
        CardHeader,
        CardTitle,
        CardDescription,
        CardContent,
        CardFooter,
        Alert,
        AlertTitle,
        AlertDescription,
        Avatar,
        AvatarImage,
        AvatarFallback,
      },
    },
    {
      id: "composite",
      title: "Composite",
      components: {
        Tabs,
        TabsList,
        TabsTrigger,
        TabsContent,
        Select,
        SelectTrigger,
        SelectValue,
        SelectContent,
        SelectItem,
        Dialog,
        DialogTrigger,
        DialogContent,
        DialogHeader,
        DialogTitle,
      },
    },
    {
      id: "forms",
      title: "Forms",
      components: {
        Form,
        FormField,
        FormItem,
        FormLabel,
        FormControl,
        FormDescription,
        FormMessage,
      },
    },
  ],

  // Scoped to exactly the registered files. A broad `primitives/*.tsx` glob
  // eager-imports server-only files (document-dropzone -> @documenso/lib ->
  // .prisma/client) and @lingui/react/macro files, both of which break the
  // dep optimizer / transform.
  sourceModules: import.meta.glob(
    [
      "./packages/ui/primitives/button.tsx",
      "./packages/ui/primitives/badge.tsx",
      "./packages/ui/primitives/input.tsx",
      "./packages/ui/primitives/label.tsx",
      "./packages/ui/primitives/card.tsx",
      "./packages/ui/primitives/alert.tsx",
      "./packages/ui/primitives/avatar.tsx",
      "./packages/ui/primitives/checkbox.tsx",
      "./packages/ui/primitives/switch.tsx",
      "./packages/ui/primitives/separator.tsx",
      "./packages/ui/primitives/skeleton.tsx",
      "./packages/ui/primitives/progress.tsx",
      "./packages/ui/primitives/textarea.tsx",
      "./packages/ui/primitives/tabs.tsx",
      "./packages/ui/primitives/select.tsx",
      "./packages/ui/primitives/form/form.tsx",
      "./packages/ui/primitives/dialog.tsx",
    ],
    { eager: true },
  ),

  adapters: [
    linguiAdapter({
      i18n,
      catalogPath: "packages/lib/translations/{locale}/web.po",
      sourceLocale: "en",
    }),
    themeAdapter({
      source: "./packages/ui/styles/theme.css",
      modes: { light: ":root", dark: ".dark" },
    }),
  ],
});
