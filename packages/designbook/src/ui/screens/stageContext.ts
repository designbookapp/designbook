import { createContext, useContext } from "react";

type StageTransform = {
  x: number;
  y: number;
  scale: number;
};

const StageTransformContext = createContext<StageTransform>({
  x: 48,
  y: 48,
  scale: 1,
});

const StageElementContext = createContext<HTMLDivElement | null>(null);

function useStageTransform() {
  return useContext(StageTransformContext);
}

function useStageElement() {
  return useContext(StageElementContext);
}

export {
  StageElementContext,
  StageTransformContext,
  useStageElement,
  useStageTransform,
};
export type { StageTransform };
