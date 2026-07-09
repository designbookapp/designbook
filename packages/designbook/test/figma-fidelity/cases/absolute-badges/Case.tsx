/** absolute-badges — relative wrapper + two absolute corner badges (the
 * ProductCard overlay pattern). A plain colored div stands in for the base
 * <img> so P1 avoids image-fill; the point here is the absolute-position
 * readback (NONE-layout parent, child x/y). Tier H P V. */
export function AbsoluteBadges() {
  return (
    <div style={{ position: "relative", width: 160, height: 120 }}>
      <div
        style={{
          width: 160,
          height: 120,
          backgroundColor: "#e2e8f0",
          borderRadius: 8,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          width: 32,
          height: 20,
          backgroundColor: "#ef4444",
          borderRadius: 4,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          width: 40,
          height: 20,
          backgroundColor: "#22c55e",
          borderRadius: 4,
        }}
      />
    </div>
  );
}
