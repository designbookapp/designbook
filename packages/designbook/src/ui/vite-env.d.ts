/// <reference types="vite/client" />

declare module "virtual:designbook-config" {
  export const config: import("@designbookapp/designbook/config").DesignbookConfig;
  /** Directory of the config file, relative to the project root. */
  export const configDir: string;
}

declare module "virtual:designbook-tailwind-bridge.css";
