export function Button({ label = "Click me" }: { label?: string }) {
  return (
    <button
      style={{
        padding: "8px 16px",
        background: "#2d6cdf",
        color: "#fff",
        border: "none",
        borderRadius: 8,
        font: "14px system-ui",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
