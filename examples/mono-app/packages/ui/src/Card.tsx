export function Card({ title = "Card title" }: { title?: string }) {
  return (
    <div
      style={{
        padding: 16,
        border: "1px solid #ccc",
        borderRadius: 12,
        font: "14px system-ui",
        maxWidth: 280,
      }}
    >
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
      <p style={{ margin: 0, color: "#555" }}>Card body from @mono/ui</p>
    </div>
  );
}
