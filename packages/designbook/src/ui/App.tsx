import { useEffect } from "react";
import { FullView } from "@designbook-ui/screens";

/** Retired prototype route — redirect to the default (the full view IS the
 * app now), so old `#/proto/full-view` links/muscle memory don't strand a
 * stale hash in the URL. */
const LEGACY_PROTO_HASH = "#/proto/full-view";

function App() {
  useEffect(() => {
    if (window.location.hash === LEGACY_PROTO_HASH) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, []);
  return <FullView />;
}

export { App };
