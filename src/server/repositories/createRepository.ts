import type { config as appConfig } from "../config";
import { CandidateRepository } from "./CandidateRepository";
import { MysqlAppDataStore } from "./MysqlAppDataStore";

export function createRecruitmentRepository(input: typeof appConfig): CandidateRepository {
  if (input.dataStore === "mysql") {
    return new CandidateRepository(new MysqlAppDataStore(input.mysql));
  }
  return new CandidateRepository(input.dataFile);
}

