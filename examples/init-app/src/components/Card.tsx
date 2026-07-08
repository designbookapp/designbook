export function Card({
  title = "Card title",
  body = "Some descriptive body text for the card.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, maxWidth: 280, fontFamily: "system-ui" }}>
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
      <p style={{ margin: 0, color: "#6b7280" }}>{body}</p>
    </div>
  );
}
