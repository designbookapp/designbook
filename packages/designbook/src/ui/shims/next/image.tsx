/**
 * Stand-in for `next/image`: a plain <img>, no optimization/loader pipeline.
 * Auto-aliased when the target repo depends on `next` (see src/node/userVite.ts).
 */
import type { CSSProperties, ImgHTMLAttributes } from "react";

export type ImageProps = {
  src: string;
  alt: string;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  loader?: unknown;
  unoptimized?: boolean;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">;

function Image({
  src,
  alt,
  fill,
  priority: _priority,
  quality: _quality,
  loader: _loader,
  unoptimized: _unoptimized,
  style,
  ...rest
}: ImageProps) {
  const fillStyle: CSSProperties | undefined = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style }
    : style;
  return <img src={src} alt={alt} style={fillStyle} {...rest} />;
}

export default Image;
