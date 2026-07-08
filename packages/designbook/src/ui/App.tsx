import { Workbench } from "@designbook-ui/screens";

const skipToContentLabel = "Skip to content";

function App() {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:shadow-lg"
      >
        {skipToContentLabel}
      </a>
      <div id="main-content">
        <Workbench />
      </div>
    </>
  );
}

export { App };
