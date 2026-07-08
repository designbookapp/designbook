export function Card() {
  return (
    <div
      data-testid="tw4-card"
      className="p-4 rounded-xl bg-surface text-brand font-display border border-brand max-w-sm"
    >
      <div data-testid="tw4-card-title" className="text-lg font-display text-brand">
        Styled Card
      </div>
      <p className="text-sm">
        Padding from <code>--spacing</code>, radius from <code>--radius-xl</code>,
        color from <code>--color-brand</code>, font from <code>--font-display</code>.
      </p>
    </div>
  );
}
