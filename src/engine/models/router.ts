import type { ModelProvider, ModelRole } from "./types";

export interface ModelBinding {
  provider: ModelProvider;
  model: string;
}

export class ModelRouter {
  constructor(private readonly resolveBinding: (role: ModelRole) => ModelBinding) {}

  resolve(role: ModelRole): ModelBinding {
    return this.resolveBinding(role);
  }
}
