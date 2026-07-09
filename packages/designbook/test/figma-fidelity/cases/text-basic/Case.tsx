/** text-basic — font family/size/weight/italic/color/line-height/letter-spacing
 * /align in one stack. Tier H P V. */
export function TextBasic() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: 260,
        padding: 16,
        backgroundColor: "#ffffff",
      }}
    >
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 20,
          fontWeight: 700,
          color: "#111827",
          lineHeight: "28px",
          letterSpacing: "0.5px",
        }}
      >
        Heading bold
      </span>
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 14,
          fontWeight: 400,
          fontStyle: "italic",
          color: "#6b7280",
          textAlign: "center",
        }}
      >
        Body italic centered
      </span>
    </div>
  );
}
