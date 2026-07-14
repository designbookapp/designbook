import { useEffect, useState } from "react";
import { Button, Card } from "@mono/ui";

export function App() {
  const [health, setHealth] = useState<string>("(loading)");
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j) => setHealth(JSON.stringify(j)))
      .catch(() => setHealth("(failed)"));
  }, []);
  return (
    <div style={{ fontFamily: "system-ui", padding: 40 }}>
      <h1>Mono Web App</h1>
      <p>own /api/health says: <code id="health">{health}</code></p>
      <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
        <Button label="Hello" />
        <Card title="A card" />
      </div>
    </div>
  );
}
