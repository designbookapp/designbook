/** token-colors — bg/text/border bound to theme tokens via CSS vars, so the
 * serializer attributes them (data-token-background/color/border-color) and the
 * pull reads them back. The gap + radius vars additionally exercise dimension
 * tokens. Tier H P. */
export function TokenColors() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--fidelity-gap)",
        width: 200,
        padding: 16,
        backgroundColor: "var(--fidelity-bg)",
        borderStyle: "solid",
        borderWidth: 2,
        borderColor: "var(--fidelity-border)",
        borderRadius: "var(--fidelity-radius)",
      }}
    >
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 16,
          color: "var(--fidelity-fg)",
        }}
      >
        Tokenized
      </span>
    </div>
  );
}
