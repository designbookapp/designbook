export function Button({
  label = "Click me",
  variant = "primary",
}: {
  label?: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const bg =
    variant === "primary" ? "#4f46e5" : variant === "danger" ? "#dc2626" : "#e5e7eb";
  const color = variant === "secondary" ? "#111827" : "white";
  return (
    <button style={{ background: bg, color, border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, cursor: "pointer" }}>
      {label}
    </button>
  );
}
