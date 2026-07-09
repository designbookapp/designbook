/** flex-justify-align — column of rows exercising justify (start/center/end/
 * space-between) and align-items (center). Tier H P. */
function Box({ color }: { color: string }) {
  return <div style={{ width: 40, height: 40, backgroundColor: color }} />;
}

function Row({ justify }: { justify: "flex-start" | "center" | "flex-end" | "space-between" }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        gap: 8,
        justifyContent: justify,
        alignItems: "center",
        width: 240,
        height: 56,
        padding: 8,
        backgroundColor: "#f1f5f9",
      }}
    >
      <Box color="#ef4444" />
      <Box color="#22c55e" />
    </div>
  );
}

export function FlexJustifyAlign() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Row justify="flex-start" />
      <Row justify="center" />
      <Row justify="flex-end" />
      <Row justify="space-between" />
    </div>
  );
}
