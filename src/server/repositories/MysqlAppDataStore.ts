import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { AppData } from "../../shared/types";
import type { AppDataStore } from "./AppDataStore";

const emptyData = (): AppData => ({
  messages: [],
  candidates: [],
  tasks: [],
  jobs: [],
  pendingTasks: []
});

export interface MysqlStoreConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
}

type AppStateRow = RowDataPacket & {
  data: string | AppData;
};

export class MysqlAppDataStore implements AppDataStore {
  private pool: Pool | undefined;
  private schemaReady = false;

  constructor(private readonly config: MysqlStoreConfig) {}

  async load(): Promise<AppData> {
    await this.ensureSchema();
    const [rows] = await this.getPool().query<AppStateRow[]>("select data from recruitment_app_state where id = 1");
    const raw = rows[0]?.data;
    if (!raw) return emptyData();
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      messages: parsed.messages ?? [],
      candidates: parsed.candidates ?? [],
      tasks: parsed.tasks ?? [],
      jobs: parsed.jobs ?? [],
      pendingTasks: parsed.pendingTasks ?? []
    };
  }

  async save(data: AppData): Promise<void> {
    await this.ensureSchema();
    await this.getPool().execute(
      [
        "insert into recruitment_app_state (id, data, updated_at)",
        "values (1, cast(? as json), current_timestamp)",
        "on duplicate key update data = values(data), updated_at = current_timestamp"
      ].join(" "),
      [JSON.stringify(data)]
    );
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.getPool().execute(`
      create table if not exists recruitment_app_state (
        id tinyint primary key,
        data json not null,
        updated_at timestamp not null default current_timestamp on update current_timestamp
      ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci
    `);
    this.schemaReady = true;
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = undefined;
    this.schemaReady = false;
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        connectionLimit: this.config.connectionLimit,
        charset: "utf8mb4"
      });
    }
    return this.pool;
  }
}

