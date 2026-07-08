import { Card } from "./components/Card";
import { Badge } from "./components/Badge";

export function App() {
  return (
    <main className="p-8 bg-surface min-h-screen">
      <h1 className="text-2xl font-display text-brand mb-4">TW4 App</h1>
      <Card />
      <Badge />
    </main>
  );
}
