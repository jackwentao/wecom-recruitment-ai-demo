import { MysqlAppDataStore } from "../src/server/repositories/MysqlAppDataStore";
import { config } from "../src/server/config";

async function main() {
  const store = new MysqlAppDataStore(config.mysql);
  await store.ensureSchema();
  await store.close();
  console.log(`MySQL schema ready: ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
}

void main().catch((error) => {
  console.error("MySQL 初始化失败：");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

