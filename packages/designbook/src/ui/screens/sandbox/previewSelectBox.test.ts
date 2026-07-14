import { describe, expect, it } from "vitest";
import {
  anchoredPromptBoxPosition,
  relativeToLayer,
} from "./previewSelectBox";

const layerRect = { x: 100, y: 200, width: 400, height: 300 };

describe("relativeToLayer", () => {
  it("translates viewport rects into layer coordinates", () => {
    expect(
      relativeToLayer({ x: 150, y: 260, width: 40, height: 20 }, layerRect),
    ).toEqual({ x: 50, y: 60, width: 40, height: 20 });
  });
});

describe("anchoredPromptBoxPosition", () => {
  it("sits just below the selection when there is room", () => {
    const position = anchoredPromptBoxPosition({
      rect: { x: 150, y: 220, width: 60, height: 30 },
      layerRect,
      boxWidth: 256,
      boxHeight: 100,
    });
    expect(position).toEqual({ left: 50, top: 56 });
  });

  it("clamps into the layer when the selection hugs the edges", () => {
    const position = anchoredPromptBoxPosition({
      rect: { x: 480, y: 470, width: 60, height: 30 },
      layerRect,
      boxWidth: 256,
      boxHeight: 100,
    });
    expect(position.left).toBe(400 - 256 - 4);
    expect(position.top).toBe(300 - 100 - 4);
  });

  it("degrades to the margin in a layer smaller than the box", () => {
    const position = anchoredPromptBoxPosition({
      rect: { x: 0, y: 0, width: 10, height: 10 },
      layerRect: { x: 0, y: 0, width: 120, height: 60 },
      boxWidth: 256,
      boxHeight: 100,
    });
    expect(position).toEqual({ left: 4, top: 4 });
  });
});
