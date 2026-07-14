import React from "react";

// Deliberate syntax error for K5 (broken-cell isolation). This file is a spike
// artifact — their sources are untouched.
export default function BrokenCell() {
  const x = ;   // <- syntax error
  return <div>never renders</div>;
}
