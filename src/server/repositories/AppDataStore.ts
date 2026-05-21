import type { AppData } from "../../shared/types";

export interface AppDataStore {
  load(): Promise<AppData>;
  save(data: AppData): Promise<void>;
}

